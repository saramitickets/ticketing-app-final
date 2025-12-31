// ==========================================
// SARAMI EVENTS TICKETING BACKEND
// VERSION: 2.5 (Valentine's Parallel & Render Optimized)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config(); 

// Toggle for ticket sales
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
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

// --- Middleware Setup ---
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
            callback(new Error('CORS policy error'), false);
        }
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// --- DYNAMIC EVENT METADATA HELPER ---
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': {
            date: "February 14, 2026",
            time: "6:30 PM",
            venue: "Elsamere Resort, Naivasha",
            slogan: "A Lakeside Romantic Experience",
            headerColor: "#004d40"
        },
        'VAL26-NAIROBI': {
            date: "February 14, 2026",
            time: "6:30 PM",
            venue: "Premium Garden Venue, Nairobi",
            slogan: "City Lights & Starry Nights",
            headerColor: "#1e3a8a"
        },
        'VAL26-ELDORET': {
            date: "February 14, 2026",
            time: "6:30 PM",
            venue: "Sirikwa Hotel, Eldoret",
            slogan: "Elegance in the Heart of Eldoret",
            headerColor: "#800020"
        }
    };
    return eventMap[eventId] || {
        date: "September 25, 2025",
        time: "6:30 PM",
        venue: "Lions Service Centre, Loresho",
        slogan: "A Special Gala Event",
        headerColor: "#000000"
    };
}

// --- InfinitiPay Authentication ---
let infinitiPayAccessToken = null;
let tokenExpiryTime = null;

async function getInfinitiPayToken() {
    if (infinitiPayAccessToken && tokenExpiryTime && Date.now() < tokenExpiryTime) {
        return infinitiPayAccessToken;
    }
    try {
        const authPayload = {
            client_id: process.env.INFINITIPAY_CLIENT_ID,
            client_secret: process.env.INFINITIPAY_CLIENT_SECRET,
            grant_type: 'password',
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        };
        const response = await axios.post(process.env.INFINITIPAY_AUTH_URL, authPayload);
        const accessToken = response.data.token || response.data.access_token;
        infinitiPayAccessToken = accessToken;
        tokenExpiryTime = Date.now() + (response.data.expires_in - 60) * 1000;
        return infinitiPayAccessToken;
    } catch (error) {
        throw new Error('InfinitiPay Authentication Failed');
    }
}

// --- Create Order and Initiate STK Push ---
app.post('/api/create-order', async (req, res) => {
    if (TICKET_SALES_CLOSED) {
        return res.status(403).json({ success: false, message: 'Sales are closed.' });
    }

    const { payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName } = req.body;

    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId || !eventName) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
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

        const token = await getInfinitiPayToken();
        const cleanedPhone = payerPhone.startsWith('0') ? '254' + payerPhone.substring(1) : payerPhone;
        const shortMerchantId = process.env.INFINITIPAY_MERCHANT_ID ? process.env.INFINITIPAY_MERCHANT_ID.slice(-3) : '';

        const stkPayload = {
            transactionId: firestoreOrderId,
            transactionReference: firestoreOrderId,
            amount,
            merchantId: shortMerchantId,
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Tickets for ${eventName}`,
            callbackURL: process.env.YOUR_APP_CALLBACK_URL,
            ptyId: 1
        };

        const response = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, stkPayload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.data.statusCode === 200 || response.data.success === true) {
            await orderRef.update({ 
                status: 'INITIATED_STK_PUSH', 
                infinitiPayTransactionId: response.data.results?.paymentId 
            });
            res.status(200).json({ success: true, orderId: firestoreOrderId });
        } else {
            throw new Error('STK Push Error');
        }
    } catch (error) {
        if (orderRef) await orderRef.update({ status: 'FAILED' });
        res.status(500).json({ success: false, message: 'Error initiating order' });
    }
});

// --- Callback & Ticket Generation ---
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    let callbackData;
    try {
        callbackData = JSON.parse(req.body.toString());
        console.log("Callback received:", callbackData);
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }

    const { ref, merchantTxnId, paymentId } = callbackData.results || {};
    const firestoreOrderId = ref || merchantTxnId;

    try {
        const orderRef = db.collection('orders').doc(firestoreOrderId);
        const orderDoc = await orderRef.get();
        if (!orderDoc.exists) return res.status(404).send('Not Found');

        const orderData = orderDoc.data();
        let newStatus = (callbackData.statusCode === 200 && callbackData.message?.toLowerCase().includes("success")) ? 'PAID' : 'FAILED';

        await orderRef.update({ status: newStatus, infinitiPayTransactionId: paymentId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        if (newStatus === 'PAID') {
            const eventMeta = getEventDetails(orderData.eventId);
            
            // TICKET EMAIL HTML
            const emailHtml = `
            <!DOCTYPE html>
            <html>
            <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; padding: 20px;">
                <div style="max-width: 600px; margin: auto; background: white; border-radius: 15px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                    <div style="background: ${eventMeta.headerColor}; color: #D4AF37; padding: 30px; text-align: center;">
                        <h1 style="margin: 0; font-size: 24px;">${orderData.eventName}</h1>
                        <p style="color: white; margin: 5px 0 0;">${eventMeta.slogan}</p>
                    </div>
                    <div style="padding: 30px;">
                        <p style="font-size: 18px; font-weight: bold;">Confirmed Reservation</p>
                        <p>Dear ${orderData.payerName}, your payment has been received.</p>
                        <div style="background: #f9f9f9; padding: 20px; border-radius: 10px; border: 1px solid #eee;">
                            <p style="margin: 5px 0;"><strong>Venue:</strong> ${eventMeta.venue}</p>
                            <p style="margin: 5px 0;"><strong>Date:</strong> ${eventMeta.date}</p>
                            <p style="margin: 5px 0;"><strong>Access for:</strong> ${orderData.quantity} Package(s)</p>
                        </div>
                        <div style="text-align: center; margin-top: 30px;">
                            <p style="font-size: 12px; color: #888;">SCAN FOR ENTRY</p>
                            <img src="https://barcode.tec-it.com/barcode.ashx?data=${firestoreOrderId}&code=QRCode&size=10" width="180">
                            <p style="font-family: monospace; font-size: 12px;">ID: ${firestoreOrderId}</p>
                        </div>
                    </div>
                    <div style="background: #eee; padding: 15px; text-align: center; font-size: 11px; color: #777;">
                        &copy; Sarami Events. Please show this at the gate.
                    </div>
                </div>
            </body>
            </html>`;

            const sendSmtpEmail = {
                sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
                to: [{ email: orderData.payerEmail, name: orderData.payerName }],
                subject: `🎟️ Ticket Confirmed: ${orderData.eventName}`,
                htmlContent: emailHtml
            };
            await apiInstance.sendTransacEmail(sendSmtpEmail);
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("Callback processing error:", error);
        res.status(500).send('Error');
    }
});

// --- PDF Generation (Optimized for Render) ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) return res.status(404).send('Not Found');

        const orderData = orderDoc.data();
        const eventMeta = getEventDetails(orderData.eventId);

        // --- PUPPETEER LAUNCH USING RENDER ENV PATH ---
        const browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        const pdfHtml = `
        <html>
        <body style="font-family: sans-serif; padding: 50px; text-align: center;">
            <div style="border: 10px solid ${eventMeta.headerColor}; padding: 40px; border-radius: 25px;">
                <h1 style="color: ${eventMeta.headerColor}; font-size: 35px; margin-bottom: 0;">SARAMI EVENTS</h1>
                <p style="font-size: 18px; margin-top: 5px;">OFFICIAL ENTRY PASS</p>
                <hr style="border: 1px dashed #ccc; margin: 30px 0;">
                <h2 style="font-size: 24px;">${orderData.eventName}</h2>
                <p style="font-size: 20px;"><strong>Guest:</strong> ${orderData.payerName}</p>
                <p style="font-size: 20px;"><strong>Venue:</strong> ${eventMeta.venue}</p>
                <p style="font-size: 20px;"><strong>Date:</strong> ${eventMeta.date}</p>
                <div style="margin-top: 40px;">
                    <img src="https://barcode.tec-it.com/barcode.ashx?data=${orderId}&code=QRCode" width="220">
                    <p style="font-family: monospace; margin-top: 15px;">REF: ${orderId}</p>
                </div>
            </div>
        </body>
        </html>`;

        await page.setContent(pdfHtml);
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        res.set({ 
            'Content-Type': 'application/pdf', 
            'Content-Disposition': `attachment; filename="SaramiTicket-${orderId}.pdf"` 
        });
        res.send(pdfBuffer);
    } catch (e) {
        console.error("PDF generation failed:", e);
        res.status(500).send('PDF Error');
    }
});

// Start Server
app.listen(PORT, () => console.log(`Sarami Backend Running on Port ${PORT}`));
