// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V3.2
// FINAL AUTH & QUANTITY SYNC
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config(); 

const admin = require('firebase-admin');
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (error) { process.exit(1); }

const db = admin.firestore();
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

// Dynamic Metadata
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { venue: "Elsamere Resort", color: "#004d40" },
        'VAL26-NAIROBI': { venue: "Premium Garden", color: "#1e3a8a" },
        'VAL26-ELDORET': { venue: "Sirikwa Hotel", color: "#800020" }
    };
    return eventMap[eventId] || { venue: "Sarami Venue", color: "#000000" };
}

// --- FIXED AUTH LOGIC ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) return cachedToken;

    const authUrl = "https://app.astraafrica.co:9090/infinitilite/v2/users/partner/login";
    
    // Ensure all variables are trimmed to remove accidental spaces
    const payload = {
        client_id: process.env.INFINITIPAY_CLIENT_ID.trim(),
        client_secret: process.env.INFINITIPAY_CLIENT_SECRET.trim(),
        grant_type: 'password',
        username: process.env.INFINITIPAY_MERCHANT_USERNAME.trim(),
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD.trim()
    };

    try {
        console.log("Requesting Token from Astra Africa...");
        const response = await axios({
            method: 'post',
            url: authUrl,
            data: payload,
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000 
        });

        const token = response.data.token || response.data.access_token;
        if (!token) throw new Error("No token in response");

        cachedToken = token;
        expiry = Date.now() + (3600 - 60) * 1000;
        return token;
    } catch (error) {
        const detail = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("AUTH ERROR:", detail);
        throw new Error("Authentication Failed: " + detail);
    }
}

app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName } = req.body;
    
    // FIX: Ensure quantity is a number and not undefined
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
            merchantId: process.env.INFINITIPAY_MERCHANT_ID.trim().slice(-3),
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Sarami ${eventName}`,
            callbackURL: process.env.YOUR_APP_CALLBACK_URL.trim(),
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

app.listen(PORT, () => console.log(`Live on ${PORT}`));
