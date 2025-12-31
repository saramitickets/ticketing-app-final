// ==========================================
// SARAMI EVENTS TICKETING BACKEND
// VERSION: 2.8 (Auth Debugging & Quantity Fix)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config(); 

const TICKET_SALES_CLOSED = process.env.TICKET_SALES_CLOSED === 'true';

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

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

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

const PORT = process.env.PORT || 10000;

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
        
        console.log("Attempting InfinitiPay Auth...");
        const response = await axios.post(process.env.INFINITIPAY_AUTH_URL, authPayload);
        
        const accessToken = response.data.token || response.data.access_token;
        if (!accessToken) throw new Error("Token missing in response");
        
        infinitiPayAccessToken = accessToken;
        tokenExpiryTime = Date.now() + (response.data.expires_in - 60) * 1000;
        return infinitiPayAccessToken;
    } catch (error) {
        // DETAILED AUTH ERROR LOGGING
        const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("INFINITIPAY AUTH FAILED:", errorMsg);
        throw new Error('InfinitiPay Authentication Failed: ' + errorMsg);
    }
}

app.post('/api/create-order', async (req, res) => {
    if (TICKET_SALES_CLOSED) {
        return res.status(403).json({ success: false, message: 'Sales are closed.' });
    }

    const { payerName, payerEmail, payerPhone, amount, eventId, eventName } = req.body;
    
    // Quantity fix from previous step
    const quantity = parseInt(req.body.quantity) || 1; 

    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId || !eventName) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    let orderRef;
    try {
        const orderData = {
            payerName, payerEmail, payerPhone, amount, 
            quantity: quantity,
            eventId, eventName,
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
            throw new Error('STK Push Request Failed');
        }
    } catch (error) {
        if (orderRef) await orderRef.update({ status: 'FAILED', errorDetail: error.message });
        console.error("DETAILED ERROR:", error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Internal Server Error',
            debug: error.message 
        });
    }
});

// ... (Rest of code: Callback and PDF routes remain same as version 2.7)

app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    let callbackData;
    try {
        callbackData = JSON.parse(req.body.toString());
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
            const emailHtml = `<div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
                <div style="background: ${eventMeta.headerColor}; color: white; padding: 20px; text-align: center;"><h1 style="color: #D4AF37;">${orderData.eventName}</h1></div>
                <div style="padding: 20px;"><p>Dear ${orderData.payerName}, your ticket is confirmed!</p><p><strong>Venue:</strong> ${eventMeta.venue}</p><p><strong>Date:</strong> ${eventMeta.date}</p>
                <div style="text-align: center; margin-top: 20px;"><img src="https://barcode.tec-it.com/barcode.ashx?data=${firestoreOrderId}&code=QRCode&size=10" width="150"></div></div></div>`;
            const sendSmtpEmail = { sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" }, to: [{ email: orderData.payerEmail, name: orderData.payerName }], subject: `🎟️ Ticket Confirmed: ${orderData.eventName}`, htmlContent: emailHtml };
            await apiInstance.sendTransacEmail(sendSmtpEmail);
        }
        res.status(200).send('OK');
    } catch (error) { res.status(500).send('Error'); }
});

app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    const { orderId } = req.params;
    try {
        const orderDoc = await db.collection('orders').doc(orderId).get();
        if (!orderDoc.exists) return res.status(404).send('Not Found');
        const orderData = orderDoc.data();
        const eventMeta = getEventDetails(orderData.eventId);
        const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        const page = await browser.newPage();
        const pdfHtml = `<div style="padding: 50px; border: 10px solid ${eventMeta.headerColor}; border-radius: 20px; text-align: center;"><h1 style="color: ${eventMeta.headerColor};">SARAMI EVENTS</h1><h2>${orderData.eventName}</h2><p>Attendee: ${orderData.payerName}</p><p>Venue: ${eventMeta.venue}</p><img src="https://barcode.tec-it.com/barcode.ashx?data=${orderId}&code=QRCode" width="200"></div>`;
        await page.setContent(pdfHtml);
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="ticket-${orderId}.pdf"` });
        res.send(pdfBuffer);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.listen(PORT, () => console.log(`Sarami Backend Running on Port ${PORT}`));
