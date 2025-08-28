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

// --- MAILERSEND EMAIL SETUP ---
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
const mailerSend = new MailerSend({
    apiKey: process.env.MAILERSEND_API_KEY,
});
console.log('MailerSend client initialized.');

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
        res.status(500).json({ success: false, message: error.message || 'An unexpected error occurred.' });
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
        console.error('Callback received without a valid transaction identifier.');
        return res.status(400).json({ success: false, message: 'Missing transaction identifier.' });
    }

    try {
        const orderRef = db.collection('orders').doc(firestoreOrderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            console.error(`Order ID ${firestoreOrderId} not found for callback.`);
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

            const emailHtml = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>Your Ticket for ${orderData.eventName}</title>
                    <style>
                        body { font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f7; margin: 0; padding: 20px; }
                        .email-wrapper { max-width: 600px; margin: auto; }
                        .greeting { font-size: 18px; color: #333; }
                        .ticket-container { margin-top: 20px; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
                        .ticket-header { background-color: #004d40; color: #d4af37; padding: 25px; text-align: center; }
                        .ticket-header h1 { margin: 0; font-size: 26px; font-weight: 700; }
                        .ticket-body { padding: 30px; }
                        .detail-item { padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
                        .detail-item:last-child { border-bottom: none; }
                        .detail-item p { margin: 0; color: #6b7280; font-size: 12px; text-transform: uppercase; }
                        .detail-item strong { color: #111827; font-size: 15px; display: block; }
                        .ticket-footer { background-color: #f8f9fa; padding: 15px 30px; text-align: center; font-size: 12px; color: #6b7280; border-top: 1px solid #e5e7eb; }
                        .footer-text { margin-top: 30px; text-align: center; font-size: 12px; color: #9ca3af; }
                    </style>
                </head>
                <body>
                    <div class="email-wrapper">
                        <p class="greeting">Hi ${orderData.payerName},</p>
                        <p style="color: #555;">Your payment was successful! Your ticket for the event is confirmed.</p>
                        <div class="ticket-container">
                            <div class="ticket-header"><h1>${orderData.eventName}</h1></div>
                            <div class="ticket-body">
                                <div class="detail-item"><p>Attendee</p><strong>${orderData.payerName}</strong></div>
                                <div class="detail-item"><p>Date & Time</p><strong>${eventDetails.date} at ${eventDetails.time}</strong></div>
                                <div class="detail-item"><p>Venue</p><strong>${eventDetails.venue}</strong></div>
                                <div class="detail-item"><p>Quantity</p><strong>${orderData.quantity} Ticket(s)</strong></div>
                            </div>
                            <div class="ticket-footer">Order ID: ${firestoreOrderId}</div>
                        </div>
                        <div class="footer-text"><p>&copy; Sarami Events</p></div>
                    </div>
                </body>
                </html>`;

            // --- MAILERSEND EMAIL SENDING LOGIC ---
            const sentFrom = new Sender(process.env.MAILERSEND_FROM_EMAIL, "Sarami Events");
            const recipients = [
                new Recipient(orderData.payerEmail, orderData.payerName)
            ];

            const emailParams = new EmailParams()
                .setFrom(sentFrom)
                .setTo(recipients)
                .setSubject(`🎟️ Your Ticket to ${orderData.eventName} is Confirmed!`)
                .setHtml(emailHtml);

            try {
                await mailerSend.email.send(emailParams);
                console.log(`Confirmation email sent to ${orderData.payerEmail} for order ${firestoreOrderId}`);
            } catch (emailError) {
                console.error(`Error sending email with MailerSend for order ${firestoreOrderId}:`, emailError);
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
