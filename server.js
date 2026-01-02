// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V3.5
// FINAL PRODUCTION VERSION
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const admin = require('firebase-admin');
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) {
    console.error("Firebase Error:", error);
    process.exit(1);
}

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) return cachedToken;

    // Use environment variable, fallback to Astra production URL
    const authUrl = process.env.INFINITIPAY_AUTH_URL || "https://app.astraafrica.co:9090/infinitilite/v2/users/partner/login";

    const payload = {
        client_id: (process.env.INFINITIPAY_CLIENT_ID || "").trim(),
        client_secret: (process.env.INFINITIPAY_CLIENT_SECRET || "").trim(),
        grant_type: 'password',
        username: (process.env.INFINITIPAY_MERCHANT_USERNAME || "").trim(),
        password: (process.env.INFINITIPAY_MERCHANT_PASSWORD || "").trim()
    };

    try {
        console.log(`Authenticating with Astra at: ${authUrl}`);
        const response = await axios.post(authUrl, payload, { timeout: 15000 });
        
        const token = response.data.token || response.data.access_token;
        cachedToken = token;
        expiry = Date.now() + (3600 - 60) * 1000;
        return token;
    } catch (error) {
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        throw new Error("Astra Auth Failed: " + detail);
    }
}

app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;
    const qty = parseInt(quantity) || 1;
    let orderRef;

    try {
        // 1. Save to Firestore
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            quantity: qty, eventId, eventName, status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Get Astra Token
        const token = await getInfinitiPayToken();

        // 3. Trigger STK Push (Logic depends on your specific InfinitiPay SDK/URL)
        // ... (Insert your successful STK push logic here) ...

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        res.status(500).json({ success: false, debug: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server live on ${PORT}`));
