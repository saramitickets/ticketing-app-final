// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V3.5
// FINAL PRODUCTION VERSION (Astra + Firestore Sync)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();

const admin = require('firebase-admin');

// --- FIREBASE INITIALIZATION ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Firebase initialization failed:", error.message);
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Render uses port 10000 by default
const PORT = process.env.PORT || 10000;

// --- DYNAMIC EVENT METADATA ---
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#004d40" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#800020" }
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

// --- INFINITIPAY AUTH TOKEN LOGIC ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) {
        return cachedToken;
    }

    const authUrl = (process.env.INFINITIPAY_AUTH_URL || "").trim();

    const payload = {
        client_id: (process.env.INFINITIPAY_CLIENT_ID || "").trim(),
        client_secret: (process.env.INFINITIPAY_CLIENT_SECRET || "").trim(),
        grant_type: 'password',
        username: (process.env.INFINITIPAY_MERCHANT_USERNAME || "").trim(),
        password: (process.env.INFINITIPAY_MERCHANT_PASSWORD || "").trim()
    };

    try {
        console.log(`Requesting token from Astra Africa at: ${authUrl}`);
        const response = await axios.post(authUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        const token = response.data.token || response.data.access_token;
        if (!token) throw new Error("No token returned in response");

        cachedToken = token;
        expiry = Date.now() + (3600 - 60) * 1000; 
        console.log("InfinitiPay Token acquired successfully");
        return token;
    } catch (error) {
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("INFINITIPAY AUTH FAILED:", detail);
        throw new Error("Authentication Failed: " + detail);
    }
}

// --- MAIN ORDER ENDPOINT ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;

    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId) {
        return res.status(400).json({ success: false, debug: "Missing required fields" });
    }

    // Ensure quantity is numeric to avoid Firestore "undefined" error
    const qty = parseInt(quantity) || 1;
    let orderRef;

    try {
        // 1. Save to Firestore
        orderRef = await db.collection('orders').add({
            payerName,
            payerEmail,
            payerPhone,
            amount: Number(amount),
            quantity: qty,
            eventId,
            eventName: eventName || "Sarami Valentine's Event",
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Get Auth Token
        const token = await getInfinitiPayToken();

        // 3. Format Phone Number (Kenyan Format)
        let cleanedPhone = payerPhone.replace(/\D/g, '');
        if (cleanedPhone.startsWith('0')) {
            cleanedPhone = '254' + cleanedPhone.substring(1);
        } else if (!cleanedPhone.startsWith('254')) {
            cleanedPhone = '254' + cleanedPhone;
        }

        // 4. Send STK Push
        const stkPayload = {
            transactionId: orderRef.id,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: (process.env.INFINITIPAY_MERCHANT_ID || "").trim().slice(-3),
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Sarami ${eventName || 'Ticket'}`,
            callbackURL: (process.env.YOUR_APP_CALLBACK_URL || "").trim(),
            ptyId: 1
        };

        const result = await axios.post(
            (process.env.INFINITIPAY_STKPUSH_URL || "").trim(),
            stkPayload,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 20000
            }
        );

        if (result.data.statusCode === 200 || result.data.success === true) {
            await orderRef.update({ status: 'STK_SENT' });
            res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            throw new Error(result.data.message || "STK Push rejected");
        }
    } catch (err) {
        console.error("Process failed:", err.message);
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', error: err.message }).catch(() => {});
        }
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- PDF TICKET GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    try {
        const order = await db.collection('orders').doc(req.params.orderId).get();
        if (!order.exists) return res.status(404).send('Order not found');
        
        const data = order.data();
        const meta = getEventDetails(data.eventId);

        const browser = await puppeteer.launch({ 
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        });

        const page = await browser.newPage();
        const html = `<div style="border: 10px solid ${meta.color}; padding: 50px; text-align: center; font-family: sans-serif;">
            <h1 style="color: ${meta.color}">SARAMI EVENTS</h1>
            <h2>OFFICIAL TICKET</h2>
            <hr>
            <p><strong>Event:</strong> ${data.eventName}</p>
            <p><strong>Venue:</strong> ${meta.venue}</p>
            <p><strong>Date:</strong> ${meta.date}</p>
            <p><strong>Guest:</strong> ${data.payerName}</p>
            <div style="margin-top: 30px;">
                <img src="https://barcode.tec-it.com/barcode.ashx?data=${order.id}&code=QRCode" width="150">
            </div>
        </div>`;

        await page.setContent(html);
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename=ticket.pdf' }).send(pdf);
    } catch (e) {
        res.status(500).send("PDF Error: " + e.message);
    }
});

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sarami Live on Port ${PORT}`);
});
