// Import necessary modules
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file

// --- FIREBASE DATABASE SETUP ---
const admin = require('firebase-admin');
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error.message);
    process.exit(1);
}
const db = admin.firestore();

// --- BREVO EMAIL SETUP ---
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;

// Configure API key authorization: api-key
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
console.log('Brevo client initialized.');

// --- Initialize Express app ---
const app = express();

// --- Middleware Setup for CORS and Body Parsing ---
const allowedOrigins = [
    'https://saramievents.co.ke',
    'https://www.saramievents.co.ke',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            callback(new Error(msg), false);
        }
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// --- END Middleware Setup ---

const PORT = process.env.PORT || 3000;

// --- Test Route ---
app.get('/', (req, res) => {
    res.status(200).send('Sarami Ticketing Backend is running!');
});

// --- InfinitiPay Authentication Function ---
let infinitiPayAccessToken = null;
let tokenExpiryTime = null;

async function getInfinitiPayToken() {
    if (infinitiPayAccessToken && tokenExpiryTime && Date.now() < tokenExpiryTime) {
        return infinitiPayAccessToken;
    }
    console.log('Fetching new InfinitiPay access token...');
    try {
        const authPayload = {
            client_id: process.env.INFINITIPAY_CLIENT_ID,
            client_secret: process.env.INFINITIPAY_CLIENT_SECRET,
            grant_type: 'password',
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        };
        const response = await axios.post(
            process.env.INFINITIPAY_AUTH_URL,
            authPayload,
            { headers: { 'Content-Type': 'application/json' } }
        );
        const accessToken = response.data.token || response.data.access_token;
        if (!accessToken) throw new Error('Access Token not found in partner login response.');
        infinitiPayAccessToken = accessToken;
        const expiresIn = response.data.expires_in || 3600;
        tokenExpiryTime = Date.now() + (expiresIn - 60) * 1000;
        console.log('InfinitiPay access token fetched and stored.');
        return infinitiPayAccessToken;
    } catch (error) {
        console.error('Error fetching InfinitiPay token:', error.message);
        throw new Error('Could not authenticate with InfinitiPay.');
    }
}

// --- Create Order and Initiate STK Push Endpoint ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName } = req.body;

    console.log('Received booking request for:', { payerName, payerPhone, amount, quantity });

    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId || !eventName || !quantity) {
        console.error('Missing required booking information.');
        return res.status(400).json({ success: false, message: 'Missing required booking information.' });
    }

    let orderRef;
    try {
        const orderData = {
            payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        orderRef = await db.collection('orders').add(orderData);
        const firestoreOrderId = orderRef.id;
        console.log(`New order created in Firestore with ID: ${firestoreOrderId}`);

        const token = await getInfinitiPayToken();
        const cleanedPhoneNumber = payerPhone.startsWith('0') ? '254' + payerPhone.substring(1) : payerPhone;
        const fullMerchantId = process.env.INFINITIPAY_MERCHANT_ID;
        const shortMerchantId = fullMerchantId ? fullMerchantId.slice(-3) : '';

        const stkPushPayload = {
            transactionId: firestoreOrderId,
            transactionReference: firestoreOrderId,
            amount,
            merchantId: shortMerchantId,
            transactionTypeId: 1,
            payerAccount: cleanedPhoneNumber,
            narration: `Tickets for ${eventName}`,
            callbackURL: process.env.YOUR_APP_CALLBACK_URL,
            ptyId: 1
        };

        console.log('Initiating STK Push with payload:', stkPushPayload);

        const infinitiPayResponse = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL,
            stkPushPayload,
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        console.log('InfinitiPay response:', infinitiPayResponse.data);

        if (infinitiPayResponse.data.statusCode === 200 || infinitiPayResponse.data.success === true) {
            const transactionId = infinitiPayResponse.data.results?.paymentId || null;
            const updateData = {
                status: 'INITIATED_STK_PUSH',
                infinitiPayTransactionId: transactionId
            };
            await orderRef.update(updateData);
            console.log(`Order ${firestoreOrderId} updated to INITIATED_STK_PUSH. InfinitiPay Transaction ID: ${transactionId}`);

            res.status(200).json({
                success: true,
                message: 'STK Push initiated successfully.',
                orderId: firestoreOrderId,
                transactionId: transactionId
            });
        } else {
            console.error('STK Push failed with status:', infinitiPayResponse.data.statusCode, 'and message:', infinitiPayResponse.data.message);
            throw new Error(`STK Push failed. Response: ${JSON.stringify(infinitiPayResponse.data)}`);
        }
    } catch (error) {
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message || 'Unknown error' });
        }
        console.error('Error in /api/create-order:', error.message);
        res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
});

// --- InfinitiPay Callback Endpoint ---
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    let callbackData;
    try {
        const rawBody = req.body.toString();
        callbackData = JSON.parse(rawBody);
        console.log('Received InfinitiPay callback:', callbackData);
    } catch (parseError) {
        console.error('Error parsing InfinitiPay callback JSON:', parseError);
        return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
    }

    const { ref, merchantTxnId, paymentId: infinitiPayTransactionId } = callbackData.results || {};
    const firestoreOrderId = ref || merchantTxnId;
    const transactionMessage = (callbackData.data && callbackData.data.description) || callbackData.message;

    if (!firestoreOrderId) {
        console.log('Callback received without a valid transaction identifier.');
        return res.status(400).json({ success: false, message: 'Missing transaction identifier.' });
    }

    try {
        const orderRef = db.collection('orders').doc(firestoreOrderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            console.log(`Order ID ${firestoreOrderId} not found for callback.`);
            return res.status(404).json({ success: false, message: 'Order not found for callback.' });
        }
        console.log(`Processing callback for Order ID: ${firestoreOrderId}`);

        let newStatus = 'FAILED'; // Default to FAILED
        if (callbackData.statusCode === 200 && transactionMessage?.toLowerCase().includes("success")) {
            newStatus = 'PAID';
        }

        await orderRef.update({
            status: newStatus,
            infinitiPayTransactionId,
            callbackData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Order ${firestoreOrderId} updated to status: ${newStatus}`);

        if (newStatus === 'PAID') {
            const orderData = orderDoc.data();
            const eventDetails = {
                date: "September 25, 2025",
                time: "6:30 PM",
                venue: "Lions Service Centre, Loresho"
            };

            // HTML for the new, elegant ticket design with QR code
            const emailHtml = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Your Exclusive Ticket to ${orderData.eventName}</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                        background-color: #f0f2f5;
                        margin: 0;
                        padding: 0;
                        -webkit-font-smoothing: antialiased;
                        -moz-osx-font-smoothing: grayscale;
                    }
                    .email-container {
                        max-width: 600px;
                        margin: 40px auto;
                        padding: 0;
                        background-color: #ffffff;
                        border-radius: 10px;
                        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
                        overflow: hidden;
                    }
                    .header {
                        background-color: #000000;
                        color: #ffffff;
                        padding: 20px;
                        text-align: center;
                        font-family: 'Times New Roman', Times, serif;
                        position: relative;
                        background: radial-gradient(circle, rgba(230,230,230,0.05) 1px, transparent 1px) 0 0 / 25px 25px,
                                     radial-gradient(circle, rgba(230,230,230,0.05) 1px, transparent 1px) 12.5px 12.5px / 25px 25px,
                                     linear-gradient(to right, #000000 0%, #1e3a8a 100%);
                    }
                    .header h1 {
                        margin: 0;
                        font-size: 28px;
                        font-weight: 700;
                        color: #ffc107;
                        letter-spacing: 1.5px;
                        text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
                    }
                    .header h2 {
                        margin: 5px 0 0;
                        font-size: 18px;
                        font-weight: 400;
                        color: #f0f0f0;
                    }
                    .ticket-body {
                        padding: 30px;
                        color: #333333;
                    }
                    .ticket-info {
                        background-color: #f9f9f9;
                        border-radius: 8px;
                        padding: 20px;
                        margin-bottom: 20px;
                        border: 1px solid #e0e0e0;
                    }
                    .info-row {
                        display: flex;
                        justify-content: space-between;
                        padding: 8px 0;
                        border-bottom: 1px dashed #dcdcdc;
                    }
                    .info-row:last-child {
                        border-bottom: none;
                    }
                    .info-label {
                        font-size: 14px;
                        color: #666666;
                        text-transform: uppercase;
                        letter-spacing: 1px;
                    }
                    .info-value {
                        font-size: 16px;
                        font-weight: bold;
                        color: #111111;
                    }
                    .footer {
                        text-align: center;
                        padding: 20px 30px;
                        background-color: #fafafa;
                        border-top: 1px solid #e0e0e0;
                        font-size: 12px;
                        color: #999999;
                    }
                    .barcode {
                        margin-top: 20px;
                        text-align: center;
                    }
                    .barcode img {
                        width: 200px; /* Adjust size for a good QR code display */
                        height: 200px;
                    }
                </style>
            </head>
            <body>
                <div class="email-container">
                    <div class="header">
                        <h1>${orderData.eventName}</h1>
                        <h2>A Special Gala for the International President</h2>
                    </div>
                    <div class="ticket-body">
                        <p style="font-size: 16px; margin-top: 0;">Dear ${orderData.payerName},</p>
                        <p style="font-size: 14px; line-height: 1.5;">Congratulations! Your reservation for this prestigious event is confirmed. Please present this ticket at the entrance for admission.</p>

                        <div class="ticket-info">
                            <div class="info-row">
                                <span class="info-label">Attendee Name</span>
                                <span class="info-value">${orderData.payerName}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">Date</span>
                                <span class="info-value">${eventDetails.date}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">Time</span>
                                <span class="info-value">${eventDetails.time}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">Venue</span>
                                <span class="info-value">${eventDetails.venue}</span>
                            </div>
                            <div class="info-row">
                                <span class="info-label">Quantity</span>
                                <span class="info-value">${orderData.quantity} Ticket(s)</span>
                            </div>
                        </div>

                        <div class="barcode">
                            <p style="font-size: 12px; margin-bottom: 5px; color: #666;">Scan at the entrance</p>
                            <img src="https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(firestoreOrderId)},${encodeURIComponent(orderData.eventName)},${encodeURIComponent(orderData.payerName)}&code=QRCode&multiplebarcodes=false&unit=cm&dpi=300&imagetype=Gif&bgcolor=%23ffffff&color=%23000000&size=10" alt="Ticket QR Code" />
                            <p style="font-size: 12px; font-family: monospace; color: #333;">${firestoreOrderId}</p>
                        </div>
                    </div>
                    <div class="footer">
                        <p>Order ID: ${firestoreOrderId}</p>
                        <p>&copy; Sarami Events. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>`;

            // --- BREVO EMAIL SENDING LOGIC ---
            const sender = {
                email: "etickets@saramievents.co.ke",
                name: "Sarami Events"
            };
            const recipients = [
                { email: orderData.payerEmail, name: orderData.payerName }
            ];

            const sendSmtpEmail = {
                sender: sender,
                to: recipients,
                subject: `🎟️ Your Ticket to ${orderData.eventName} is Confirmed!`,
                htmlContent: emailHtml
            };

            try {
                await apiInstance.sendTransacEmail(sendSmtpEmail);
                console.log(`Confirmation email sent with Brevo to ${orderData.payerEmail} for order ${firestoreOrderId}`);
            } catch (emailError) {
                console.error(`Error sending email with Brevo for order ${firestoreOrderId}:`, emailError.message);
            }
        }
        res.status(200).json({ success: true, message: 'Callback processed successfully.' });
    } catch (error) {
        console.error(`Error processing callback for order ${firestoreOrderId}:`, error);
        res.status(500).json({ success: false, message: 'Internal server error processing callback.' });
    }
});

// --- Generic Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err.stack);
    res.status(500).json({
        success: false,
        message: 'An unexpected internal server error occurred.'
    });
});

// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Sarami Ticketing Backend server is running on port ${PORT}`);
});
