// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V11.8
// FINAL PATCH: RAW BODY PARSING + NESTED FIX
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE & BREVO SETUP ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ [SYSTEM] Firebase Initialized Successfully");
} catch (error) { console.error("❌ Firebase Error:", error.message); }

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());

// CRITICAL: Added diverse parsers to solve the "DEBUG FULL PAYLOAD: {}" issue
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' })); // Catch-all for unusual content types

const PORT = process.env.PORT || 10000;

// --- 2. HELPERS ---
function formatPhone(phone) {
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('0')) p = '254' + p.slice(1);
    return p.startsWith('254') ? p : '254' + p; 
}

async function getAuthToken() {
    const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
    });
    return authRes.data.access_token;
}

function getEventDetails(eventId, packageTier) {
    const eventMap = {
        'NAIVASHA': { venue: "Elsamere Resort, Naivasha", color: "#6b0f0f", accent: "#D4AF37", packages: { 'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000" }, 'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000" }, 'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000" } } },
        'ELDORET': { venue: "Marura Gardens, Eldoret", color: "#006064", accent: "#D4AF37", packages: { 'FLAME': { name: "Eternal Flame Dinner", price: "10,000" }, 'SPARK': { name: "Sunset Spark", price: "7,000" } } },
        'NAIROBI': { venue: "Sagret Gardens, Nairobi", color: "#4b0082", accent: "#D4AF37", packages: { 'CITYGLOW': { name: "City Glow Romance", price: "9,000" } } }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    const pKey = packageTier.toUpperCase();
    const pkg = event.packages[pKey] || { name: "Luxury Entry", price: "Varies" };
    return { ...event, ...pkg, date: "February 14, 2026", history: event.history || "Luxury Event" };
}

// --- 3. LUXURY EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    console.log(`📩 [LOG] Step 3: Dispatching Confirmation Email for Order: ${orderId}`);
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `<div style="padding:40px; background:#fafafa; border:4px solid ${meta.accent}; text-align:center;">
                <h1 style="color:${meta.color};">Reservation Confirmed</h1>
                <p>Dear ${orderData.payerName}, your seat at <strong>${meta.venue}</strong> is reserved.</p>
                <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" style="background:${meta.color}; color:#fff; padding:15px; text-decoration:none; border-radius:50px;">Download Ticket</a>
            </div>`
        });
        console.log(`✅ [LOG] Step 4: Email delivered to ${orderData.payerEmail}`);
    } catch (err) { console.error("❌ [EMAIL ERROR]:", err.message); }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] Step 1: Processing booking for ${payerName}`);
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`💾 [LOG] Step 2: Firestore Document Created [ID: ${orderRef.id}]`);
        const token = await getAuthToken();
        const payload = {
            transactionId: `TXN-${crypto.randomBytes(4).toString('hex')}`,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: "139", 
            transactionTypeId: 1, 
            payerAccount: formatPhone(payerPhone),
            narration: `Sarami: ${eventName}`,
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1 
        };
        await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, { headers: { 'Authorization': `Bearer ${token}` } });
        console.log(`📲 [LOG] Payment Request Sent to ${payerPhone}.`);
        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) { res.status(500).json({ success: false, debug: err.message }); }
});

// --- 5. UPDATED CALLBACK (SOLVES "undefined" & "{}" ISSUES) ---
app.post('/api/payment-callback', async (req, res) => {
    let rawData = req.body;

    // Handle cases where body comes as a string
    if (typeof req.body === 'string') {
        try { rawData = JSON.parse(req.body); } catch (e) { 
            // If it's not JSON, it might be URL-encoded text
            const params = new URLSearchParams(req.body);
            rawData = Object.fromEntries(params);
        }
    }

    const results = rawData.results || {};
    const orderId = results.transactionReference || rawData.transactionReference || req.query.transactionReference;
    const status = results.status || rawData.status || "";

    if (!orderId) {
        console.log("⚠️ [LOG] Callback Error: Order ID still missing.");
        console.log("DEBUG FULL PAYLOAD:", JSON.stringify(rawData));
        return res.sendStatus(200);
    }

    try {
        const orderRef = db.collection('orders').doc(orderId);
        const orderDoc = await orderRef.get();

        if (status.toUpperCase() === 'SUCCESS' || status.toUpperCase() === 'COMPLETED') {
            console.log(`💰 [LOG] PAID: Order ${orderId} verified.`);
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            if (orderDoc.exists) await sendTicketEmail(orderDoc.data(), orderId);
        } else {
            console.log(`❌ [LOG] CANCELLED: Order ${orderId} declined. Status: ${status}`);
            await orderRef.update({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
    } catch (e) { console.error("❌ [CALLBACK ERROR]:", e.message); }
    res.sendStatus(200);
});

// --- 6. PDF TICKET GENERATION ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);
        browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(`<html><body style="background:#000; color:#fff; text-align:center;">
            <div style="border:2px solid ${meta.accent}; padding:50px;">
                <h1>${meta.venue}</h1>
                <h2>${data.payerName}</h2>
                <p>KES ${meta.price} | PAID</p>
                <img src="https://barcode.tec-it.com/barcode.ashx?data=${req.params.orderId}&code=QRCode">
            </div>
        </body></html>`);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V11.8 - ONLINE`));
