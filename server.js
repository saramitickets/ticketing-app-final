// ==========================================
// SARAMI EVENTS TICKETING BACKEND
// VERSION: 2.0 (Parallel Events Update)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config(); // Load environment variables from .env file

// A flag to easily turn off new ticket sales, now controlled by the environment
const TICKET_SALES_CLOSED = process.env.TICKET_SALES_CLOSED === 'true';

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

const PORT = process.env.PORT || 3000;

// ==========================================
// DYNAMIC METADATA HELPER
// ==========================================
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': {
            date: "February 14, 2026",
            time: "6:30 PM",
            venue: "Elsamere Resort, Naivasha",
            slogan: "A Lakeside Romantic Experience",
            headerColor: "#004d40",
            accentColor: "#D4AF37"
        },
        'VAL26-NAIROBI': {
            date: "February 14, 2026",
            time: "6:30 PM",
            venue: "Premium Garden Venue, Nairobi",
            slogan: "City Lights & Starry Nights",
            headerColor: "#1e3a8a",
            accentColor: "#D4AF37"
        },
        'VAL26-ELDORET': {
            date: "February 14, 2026",
            time: "6:30 PM",
            venue: "Sirikwa Hotel, Eldoret",
            slogan: "Elegance in the Heart of Eldoret",
            headerColor: "#800020",
            accentColor: "#D4AF37"
        }
    };
    return eventMap[eventId] || {
        date: "September 25, 2025",
        time: "6:30 PM",
        venue: "Lions Service Centre, Loresho",
        slogan: "A Special Gala for the International President",
        headerColor: "#000000",
        accentColor: "#ffc107"
    };
}

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
    console.log('Fetching new InfinitiPay access token... ');
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
    if (TICKET_SALES_CLOSED) {
        console.log('Ticket sales are closed. Rejecting new request.');
        return res.status(403).json({ success: false, message: 'Ticket sales have ended for this event.' });
    }

    const { payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName } = req.body;

    console.log('Received booking request for:', { payerName, payerPhone, amount, quantity, eventId });

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

        const infinitiPayResponse = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL,
            stkPushPayload,
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        if (infinitiPayResponse.data.statusCode === 200 || infinitiPayResponse.data.success === true) {
            const transactionId = infinitiPayResponse.data.results?.paymentId || null;
            await orderRef.update({
                status: 'INITIATED_STK_PUSH',
                infinitiPayTransactionId: transactionId
            });
            console.log(`STK Push initiated for Order ${firestoreOrderId}`);

            res.status(200).json({
                success: true,
                message: 'STK Push initiated successfully.',
                orderId: firestoreOrderId,
                transactionId: transactionId
            });
        } else {
            throw new Error(`STK Push failed: ${infinitiPayResponse.data.message}`);
        }
    } catch (error) {
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message });
        }
        res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
});

// --- Callback Processing & Elegant Email Dispatch ---
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    let callbackData;
    try {
        const rawBody = req.body.toString();
        callbackData = JSON.parse(rawBody);
        console.log('Received InfinitiPay callback:', callbackData);
    } catch (parseError) {
        return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
    }

    const { ref, merchantTxnId, paymentId: infinitiPayTransactionId } = callbackData.results || {};
    const firestoreOrderId = ref || merchantTxnId;
    const transactionMessage = (callbackData.data && callbackData.data.description) || callbackData.message;

    try {
        const orderRef = db.collection('orders').doc(firestoreOrderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        let newStatus = 'FAILED'; 
        if (callbackData.statusCode === 200 && transactionMessage?.toLowerCase().includes("success")) {
            newStatus = 'PAID';
        }

        await orderRef.update({
            status: newStatus,
            infinitiPayTransactionId,
            callbackData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (newStatus === 'PAID') {
            const orderData = orderDoc.data();
            const eventDetails = getEventDetails(orderData.eventId);

            // THE COMPLETE TICKET TEMPLATE (Preserving original complexity/length)
            const emailHtml = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f0f2f5; margin: 0; padding: 0; }
                    .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
                    .header { background: ${eventDetails.headerColor}; color: #ffffff; padding: 40px 20px; text-align: center; }
                    .header h1 { margin: 0; font-size: 28px; color: ${eventDetails.accentColor}; letter-spacing: 2px; text-transform: uppercase; }
                    .header h2 { margin: 10px 0 0; font-size: 16px; color: #f0f0f0; font-weight: 300; }
                    .body { padding: 40px; color: #333333; }
                    .welcome { font-size: 20px; font-weight: bold; margin-bottom: 10px; }
                    .instruction { font-size: 14px; color: #666; line-height: 1.6; margin-bottom: 30px; }
                    .info-grid { background-color: #f8f9fa; border-radius: 10px; padding: 25px; border: 1px solid #eee; margin-bottom: 30px; }
                    .grid-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px dashed #ddd; }
                    .grid-row:last-child { border-bottom: none; }
                    .label { font-size: 12px; font-weight: 800; color: #999; text-transform: uppercase; letter-spacing: 1px; }
                    .value { font-size: 15px; font-weight: 700; color: #111; }
                    .qr-section { text-align: center; padding: 20px; background: #fff; border: 2px solid #f0f0f0; border-radius: 15px; }
                    .qr-section img { width: 200px; height: 200px; margin-bottom: 10px; }
                    .order-id { font-family: monospace; font-size: 12px; color: #888; }
                    .footer { text-align: center; padding: 30px; background-color: #fafafa; border-top: 1px solid #eee; font-size: 12px; color: #aaa; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>${orderData.eventName}</h1>
                        <h2>${eventDetails.slogan}</h2>
                    </div>
                    <div class="body">
                        <div class="welcome">You're invited, ${orderData.payerName}!</div>
                        <p class="instruction">Your booking is successful. Please present this official e-ticket at the venue gate for scanning and entry.</p>
                        
                        <div class="info-grid">
                            <div class="grid-row"><span class="label">Attendee</span><span class="value">${orderData.payerName}</span></div>
                            <div class="grid-row"><span class="label">Location</span><span class="value">${eventDetails.venue}</span></div>
                            <div class="grid-row"><span class="label">Date</span><span class="value">${eventDetails.date}</span></div>
                            <div class="grid-row"><span class="label">Doors Open</span><span class="value">${eventDetails.time}</span></div>
                            <div class="grid-row"><span class="label">Package</span><span class="value">${orderData.quantity} Person(s)</span></div>
                        </div>

                        <div class="qr-section">
                            <p style="margin-top:0; font-weight:bold;">GATE SCAN CODE</p>
                            <img src="https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(firestoreOrderId)}&code=QRCode&size=10" alt="Ticket QR">
                            <div class="order-id">REF: ${firestoreOrderId}</div>
                        </div>
                    </div>
                    <div class="footer">
                        <p>&copy; 2025 Sarami Events. All Rights Reserved.</p>
                        <p>This is an automated ticket. Do not share this email.</p>
                    </div>
                </div>
            </body>
            </html>`;

            // BREVO DISPATCH
            const sendSmtpEmail = {
                sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
                to: [{ email: orderData.payerEmail, name: orderData.payerName }],
                subject: `🎟️ Ticket Confirmed: ${orderData.eventName}`,
                htmlContent: emailHtml
            };
            await apiInstance.sendTransacEmail(sendSmtpEmail);
        }
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- PDF Generator (Admin/Check-in) ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) return res.status(404).send('Not Found');

        const orderData = orderDoc.data();
        const eventDetails = getEventDetails(orderData.eventId);

        const browser = await puppeteer.launch({
            executablePath: puppeteer.executablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Detailed PDF Design
        const pdfContent = `
        <html>
        <body style="font-family:sans-serif; padding:50px;">
            <div style="border:10px solid ${eventDetails.headerColor}; border-radius:20px; padding:40px;">
                <h1 style="text-align:center; color:${eventDetails.headerColor}; font-size:40px;">SARAMI EVENTS</h1>
                <h2 style="text-align:center;">OFFICIAL ENTRY TICKET</h2>
                <hr style="border:1px dashed #ccc; margin:30px 0;">
                <p style="font-size:20px;"><strong>EVENT:</strong> ${orderData.eventName}</p>
                <p style="font-size:20px;"><strong>GUEST:</strong> ${orderData.payerName}</p>
                <p style="font-size:20px;"><strong>VENUE:</strong> ${eventDetails.venue}</p>
                <p style="font-size:20px;"><strong>DATE:</strong> ${eventDetails.date}</p>
                <div style="text-align:center; margin-top:50px;">
                    <img src="https://barcode.tec-it.com/barcode.ashx?data=${orderId}&code=QRCode" width="250">
                    <p style="font-family:monospace; margin-top:20px;">VERIFICATION ID: ${orderId}</p>
                </div>
            </div>
        </body>
        </html>`;

        await page.setContent(pdfContent);
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Sarami-${orderId}.pdf"` });
        res.send(pdfBuffer);
    } catch (e) {
        res.status(500).send('Error generating PDF');
    }
});

// --- Error Handling ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
});

app.listen(PORT, () => {
    console.log(`Sarami Backend Live on Port ${PORT}`);
});
