// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V12.0
// MAJOR FIX ATTEMPT: Handle InfinitiPay's paymentId + extreme fallback logging
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

const PORT = process.env.PORT || 10000;

// Firebase + Brevo setup (unchanged)
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ Firebase Initialized");
} catch (error) {
    console.error("❌ Firebase Error:", error.message);
}

// Brevo setup (unchanged) ...
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// Helpers (formatPhone, getAuthToken, getEventDetails, sendTicketEmail) - unchanged from previous version

// ... (keep your existing helpers here)

// CREATE ORDER (add better logging)
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`[CREATE] Processing: ${payerName} | ${eventName}`);

    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        const orderId = orderRef.id;
        console.log(`[CREATE] Order created: ${orderId}`);

        const token = await getAuthToken();
        const payload = {
            transactionId: `TXN-${crypto.randomBytes(4).toString('hex')}`,
            transactionReference: orderId,
            amount: Number(amount),
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: formatPhone(payerPhone),
            narration: `Sarami: ${eventName}`,
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        console.log(`[STK] Response: ${JSON.stringify(stkRes.data, null, 2)}`);

        // Try to store anything useful
        await orderRef.update({
            stkResponse: stkRes.data,
            merchantRequestID: stkRes.data.MerchantRequestID || stkRes.data.merchantRequestID || ''
        });

        res.status(200).json({ success: true, orderId });
    } catch (err) {
        console.error("[CREATE ERROR]", err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// FIXED CALLBACK - V12.0
app.post('/api/payment-callback', async (req, res) => {
    let rawData = req.body;

    if (typeof rawData === 'string') {
        try { rawData = JSON.parse(rawData); } catch {}
    }

    console.log("=====================================");
    console.log("[CALLBACK RAW] Full payload:", JSON.stringify(rawData, null, 2));
    console.log("=====================================");

    const data = rawData || {};

    // Try every possible field for orderId
    let orderId =
        data.transactionReference ||
        data.transactionId ||
        data.paymentId ||
        data.orderId ||
        data.MerchantRequestID ||
        data.merchantRequestID ||
        data.checkoutRequestID ||
        null;

    // Special handling: InfinitiPay seems to send paymentId like "126422"
    // If it's a number and we have no other match, try prefix 'I' or just use it (risky)
    if (!orderId && data.paymentId && /^\d+$/.test(data.paymentId)) {
        console.log("[WARNING] Using paymentId as potential orderId:", data.paymentId);
        orderId = data.paymentId; // ← temporary – only for debugging
    }

    if (!orderId) {
        console.log("[CRITICAL] NO ORDER ID FOUND IN CALLBACK");
        console.log("Possible keys:", Object.keys(data));
        return res.sendStatus(200);
    }

    console.log(`[CALLBACK] Attempting to update order: ${orderId}`);

    let isSuccess = false;
    if (data.statusCode == 0 || data.statusCode === "0" || data.ResultCode === 0) {
        isSuccess = true;
    } else if (data.message?.toLowerCase().includes('success') || data.message?.toLowerCase().includes('completed')) {
        isSuccess = true;
    }

    try {
        const orderRef = db.collection('orders').doc(orderId);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            console.log(`[ERROR] Order ${orderId} NOT FOUND in Firestore`);
            return res.sendStatus(200);
        }

        if (isSuccess) {
            console.log(`[SUCCESS] Order ${orderId} PAID`);
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await sendTicketEmail(orderSnap.data(), orderId);
        } else {
            console.log(`[CANCEL/FAIL] Order ${orderId} - ${data.message || 'No message'}`);
            await orderRef.update({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
    } catch (e) {
        console.error("[CALLBACK UPDATE ERROR]", e.message);
    }

    res.sendStatus(200);
});

// Keep your /api/order-status/:orderId and PDF routes unchanged

app.listen(PORT, () => console.log(`🚀 SARAMI V12.0 ONLINE on port ${PORT}`));
