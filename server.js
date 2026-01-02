// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V3.4
// DEBUG MODE: Webhook.site Redirection Enabled
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const admin = require('firebase-admin');

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    console.error("Firebase initialization failed:", error);
    process.exit(1);
}

const db = admin.firestore();

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// --- CACHED AUTH TOKEN LOGIC (DEBUG VERSION) ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    // We skip the cache during debugging to ensure every click sends a new request
    
    // DEBUG: Hardcoding your unique Webhook URL to bypass ENV issues
    const authUrl = "https://webhook.site/98e7e273-2415-495e-8cf3-8deb1d2c2d82";

    const payload = {
        client_id: (process.env.INFINITIPAY_CLIENT_ID || "DEBUG_CLIENT_ID").trim(),
        client_secret: (process.env.INFINITIPAY_CLIENT_SECRET || "DEBUG_SECRET").trim(),
        grant_type: 'password',
        username: (process.env.INFINITIPAY_MERCHANT_USERNAME || "DEBUG_USER").trim(),
        password: (process.env.INFINITIPAY_MERCHANT_PASSWORD || "DEBUG_PASS").trim()
    };

    try {
        console.log("DEBUG: Sending test payload to Webhook.site at:", authUrl);
        
        const response = await axios.post(authUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        // Webhook.site will return a 200 OK but no token. 
        // We return a fake token so the code can continue to the next step.
        console.log("DEBUG: Webhook received the request successfully.");
        return "debug_token_12345"; 
        
    } catch (error) {
        console.error("DEBUG AUTH ERROR:", error.message);
        throw new Error("Webhook Redirection Failed: " + error.message);
    }
}

// Main API Endpoint
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;

    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId) {
        return res.status(400).json({ success: false, debug: "Missing required fields" });
    }

    const qty = parseInt(quantity) || 1;
    let orderRef;

    try {
        // 1. Test Firestore Connectivity
        console.log("DEBUG: Attempting to save order to Firestore...");
        orderRef = await db.collection('orders').add({
            payerName,
            payerEmail,
            payerPhone,
            amount: Number(amount),
            quantity: qty,
            eventId,
            eventName: eventName || "Sarami Valentine's Event",
            status: 'DEBUG_MODE',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log("DEBUG: Order saved with ID:", orderRef.id);

        // 2. Trigger the Webhook/Auth Test
        const token = await getInfinitiPayToken();

        // 3. For the purpose of this debug, we stop here. 
        // If you see the request on Webhook.site, your server is working perfectly.
        res.status(200).json({ 
            success: true, 
            message: "Debug request sent to Webhook.site", 
            orderId: orderRef.id 
        });

    } catch (err) {
        console.error("DEBUG CRASH:", err.message);
        res.status(500).json({
            success: false,
            debug: "Debug Step Failed: " + err.message
        });
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server live on port ${PORT}`);
});
