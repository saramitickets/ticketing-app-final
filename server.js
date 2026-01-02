// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V4.2
// FIXED: Brevo Email Logic Restored
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();

const admin = require('firebase-admin');

// SET TO 'true' only for testing. Set to 'false' for real M-Pesa payments.
const BYPASS_PAYMENT = true; 

// --- 1. FIREBASE SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) {
    console.error("Firebase Auth Error:", error.message);
}
const db = admin.firestore();

// --- 2. BREVO SETUP ---
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Dynamic Metadata
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#004d40" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#800020" }
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

// --- NEW: EMAIL SENDING FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId);
    try {
        await apiInstance.sendTransacEmail({
            // THIS IS THE SENDER YOU MUST VERIFY IN BREVO
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎟️ Your Ticket: ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: sans-serif; padding: 20px;">
                    <h1 style="color: ${meta.color}">Ticket Confirmed!</h1>
                    <p>Hi ${orderData.payerName}, your ticket for <b>${orderData.eventName}</b> is ready.</p>
                    <p><b>Venue:</b> ${meta.venue}</p>
                    <p><b>Download Link:</b> https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}</p>
                </div>`
        });
        console.log("Email sent successfully!");
    } catch (err) {
        console.error("BREVO ERROR:", err.response ? err.response.body : err.message);
    }
}

// --- 3. INFINITIPAY AUTH ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) return cachedToken;
    const authUrl = "https://app.astraafrica.co:9090/infinitilite/v2/users/partner/login";
    const payload = {
        client_id: process.env.INFINITIPAY_CLIENT_ID.trim(),
        client_secret: process.env.INFINITIPAY_CLIENT_SECRET.trim(),
        grant_type: 'password',
        username: process.env.INFINITIPAY_MERCHANT_USERNAME.trim(),
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD.trim()
    };
    const response = await axios.post(authUrl, payload, { timeout: 15000 });
    cachedToken = response.data.token || response.data.access_token;
    expiry = Date.now() + (3600 - 60) * 1000;
    return cachedToken;
}

// --- 4. MAIN ORDER ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;
    const qty = parseInt(quantity) || 1;
    let orderRef;

    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            quantity: qty, eventId, eventName, status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // BYPASS LOGIC
        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            // CALL THE EMAIL FUNCTION HERE
            await sendTicketEmail(req.body, orderRef.id); 
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }

        const token = await getInfinitiPayToken();
        const cleanedPhone = payerPhone.replace(/\D/g, '').replace(/^0/, '254');
        const stkPayload = {
            transactionId: orderRef.id,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: (process.env.INFINITIPAY_MERCHANT_ID || "").trim().slice(-3),
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Sarami ${eventName}`,
            callbackURL: (process.env.YOUR_APP_CALLBACK_URL || "").trim(),
            ptyId: 1
        };

        const result = await axios.post(process.env.INFINITIPAY_STKPUSH_URL.trim(), stkPayload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (result.data.statusCode === 200 || result.data.success) {
            await orderRef.update({ status: 'STK_SENT' });
            res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            throw new Error(result.data.message);
        }
    } catch (err) {
        if (orderRef) await orderRef.update({ status: 'FAILED', error: err.message });
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. PDF GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    try {
        const order = await db.collection('orders').doc(req.params.orderId).get();
        if(!order.exists) return res.status(404).send("Ticket not found");
        
        const data = order.data();
        const meta = getEventDetails(data.eventId);
        const browser = await puppeteer.launch({ 
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const page = await browser.newPage();
        await page.setContent(`
            <div style="border:10px solid ${meta.color}; padding:50px; text-align:center; font-family: sans-serif;">
                <h1 style="color: ${meta.color}">SARAMI EVENTS</h1>
                <hr>
                <h2>${data.eventName}</h2>
                <p>Guest: ${data.payerName}</p>
                <p>Venue: ${meta.venue}</p>
                <img src="https://barcode.tec-it.com/barcode.ashx?data=${order.id}&code=QRCode" width="200">
            </div>`);
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => console.log(`Server live on ${PORT}`));
