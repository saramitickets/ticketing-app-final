// ==========================================
// SARAMI EVENTS TICKETING BACKEND
// VERSION: 3.1 (Fixed Auth URL & Payload)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config(); 

const TICKET_SALES_CLOSED = process.env.TICKET_SALES_CLOSED === 'true';

// --- FIREBASE SETUP ---
const admin = require('firebase-admin');
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) {
    console.error('Firebase Error:', error.message);
    process.exit(1);
}
const db = admin.firestore();

// --- BREVO SETUP ---
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// --- EVENT METADATA ---
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort", color: "#004d40" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel", color: "#800020" }
    };
    return eventMap[eventId] || { date: "TBD", venue: "Sarami Venue", color: "#000000" };
}

// --- INFINITIPAY AUTH ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) return cachedToken;

    const authUrl = "https://app.astraafrica.co:9090/infinitilite/v2/users/partner/login";
    
    const payload = {
        client_id: (process.env.INFINITIPAY_CLIENT_ID || "").trim(),
        client_secret: (process.env.INFINITIPAY_CLIENT_SECRET || "").trim(),
        grant_type: 'password',
        username: (process.env.INFINITIPAY_MERCHANT_USERNAME || "").trim(),
        password: (process.env.INFINITIPAY_MERCHANT_PASSWORD || "").trim()
    };

    try {
        console.log("Requesting Token from Astra Africa...");
        const response = await axios.post(authUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000 
        });

        const token = response.data.token || response.data.access_token;
        if (!token) throw new Error("No token returned");

        cachedToken = token;
        expiry = Date.now() + (3600 - 60) * 1000;
        return token;
    } catch (error) {
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("AUTH ERROR:", detail);
        throw new Error("Auth Failed: " + detail);
    }
}

// --- CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    if (TICKET_SALES_CLOSED) return res.status(403).json({ success: false });

    const { payerName, payerEmail, payerPhone, amount, eventId, eventName } = req.body;
    const quantity = parseInt(req.body.quantity) || 1;

    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const token = await getInfinitiPayToken();
        const cleanedPhone = payerPhone.startsWith('0') ? '254' + payerPhone.substring(1) : payerPhone;
        
        const stkPayload = {
            transactionId: orderRef.id,
            transactionReference: orderRef.id,
            amount: amount,
            merchantId: (process.env.INFINITIPAY_MERCHANT_ID || "").trim().slice(-3),
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Sarami ${eventName}`,
            callbackURL: (process.env.YOUR_APP_CALLBACK_URL || "").trim(),
            ptyId: 1
        };

        const result = await axios.post(process.env.INFINITIPAY_STKPUSH_URL.trim(), stkPayload, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });

        if (result.data.statusCode === 200 || result.data.success) {
            await orderRef.update({ status: 'STK_SENT', infinitiPayId: result.data.results?.paymentId });
            res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            throw new Error(result.data.message);
        }
    } catch (err) {
        if (orderRef) await orderRef.update({ status: 'FAILED', error: err.message });
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- CALLBACK ---
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    try {
        const data = JSON.parse(req.body.toString());
        const orderId = data.results?.ref || data.results?.merchantTxnId;
        const orderRef = db.collection('orders').doc(orderId);
        const order = await orderRef.get();

        if (order.exists && data.statusCode === 200) {
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            
            // Trigger Email (simplified for brevity)
            const meta = getEventDetails(order.data().eventId);
            console.log(`Sending Ticket Email to ${order.data().payerEmail} for ${meta.venue}`);
        }
        res.status(200).send('OK');
    } catch (e) { res.status(500).send('Error'); }
});

// --- PDF ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    try {
        const order = await db.collection('orders').doc(req.params.orderId).get();
        const meta = getEventDetails(order.data().eventId);
        const browser = await puppeteer.launch({ 
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, 
            args: ['--no-sandbox'] 
        });
        const page = await browser.newPage();
        await page.setContent(`<h1 style="color:${meta.color}">Sarami Ticket</h1><p>Venue: ${meta.venue}</p>`);
        const pdf = await page.pdf({ format: 'A4' });
        await browser.close();
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => console.log(`Live on port ${PORT}`));
