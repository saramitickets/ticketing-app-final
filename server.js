// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V3.3
// FIXED: Render Port Binding + Robust Startup
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

// CRITICAL FIX: Use Render's assigned port, fallback to safe local port
const PORT = process.env.PORT || 5000;

// Dynamic Metadata
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { venue: "Elsamere Resort", color: "#004d40" },
        'VAL26-NAIROBI': { venue: "Premium Garden", color: "#1e3a8a" },
        'VAL26-ELDORET': { venue: "Sirikwa Hotel", color: "#800020" }
    };
    return eventMap[eventId] || { venue: "Sarami Venue", color: "#000000" };
}

// --- CACHED AUTH TOKEN LOGIC ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) {
        return cachedToken;
    }

    const authUrl = "https://app.astraafrica.co:9090/infinitilite/v2/users/partner/login";

    const payload = {
        client_id: process.env.INFINITIPAY_CLIENT_ID?.trim(),
        client_secret: process.env.INFINITIPAY_CLIENT_SECRET?.trim(),
        grant_type: 'password',
        username: process.env.INFINITIPAY_MERCHANT_USERNAME?.trim(),
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD?.trim()
    };

    try {
        console.log("Requesting new token from Astra Africa...");
        const response = await axios.post(authUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });

        const token = response.data.token || response.data.access_token;
        if (!token) throw new Error("No token returned in response");

        cachedToken = token;
        expiry = Date.now() + (3600 - 60) * 1000; // Refresh 1 min early
        console.log("Token acquired successfully");
        return token;
    } catch (error) {
        const detail = error.response 
            ? JSON.stringify(error.response.data) 
            : error.message;
        console.error("AUTH ERROR:", detail);
        throw new Error("Authentication Failed: " + detail);
    }
}

// Main API Endpoint
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;

    // Validate required fields
    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId) {
        return res.status(400).json({ success: false, debug: "Missing required fields" });
    }

    // Ensure quantity is a valid number
    const qty = parseInt(quantity) || 1;
    if (qty < 1 || qty > 10) { // Reasonable limit
        return res.status(400).json({ success: false, debug: "Invalid quantity" });
    }

    let orderRef;

    try {
        // Save order to Firestore
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

        // Get auth token
        const token = await getInfinitiPayToken();

        // Clean and validate phone number (Kenya format)
        let cleanedPhone = payerPhone.replace(/\D/g, ''); // Remove non-digits
        if (cleanedPhone.startsWith('0')) {
            cleanedPhone = '254' + cleanedPhone.substring(1);
        } else if (!cleanedPhone.startsWith('254')) {
            cleanedPhone = '254' + cleanedPhone;
        }

        if (!/^254[17]\d{8}$/.test(cleanedPhone)) {
            throw new Error("Invalid Kenyan phone number format");
        }

        const stkPayload = {
            transactionId: orderRef.id,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: process.env.INFINITIPAY_MERCHANT_ID?.trim().slice(-3),
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Sarami ${eventName || 'Valentine Ticket'}`,
            callbackURL: process.env.YOUR_APP_CALLBACK_URL?.trim(),
            ptyId: 1
        };

        const result = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL?.trim(),
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
        console.error("Order creation failed:", err.message);
        if (orderRef) {
            await orderRef.update({
                status: 'FAILED',
                error: err.message
            }).catch(() => {});
        }
        res.status(500).json({
            success: false,
            debug: err.message || "Internal server error"
        });
    }
});

// Health check endpoint (good for Render)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Start server with explicit binding
app.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
        console.error('Failed to start server on port', PORT, ':', err);
        process.exit(1);
    }
    console.log(`Server live on port ${PORT}`);
    console.log(`Health check: https://your-service.onrender.com/health`);
});
