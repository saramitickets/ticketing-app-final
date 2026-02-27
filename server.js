// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// UPDATED: Fixed ISO-8859-1 charset + Robust Callback + Detailed Logging
// ==========================================
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

// --- 1. FIREBASE & BREVO SETUP ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ [SYSTEM] Firebase Initialized");
} catch (error) {
    console.error("❌ Firebase Error:", error.message);
}

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

// ────────────────────────────────────────────────
// CUSTOM BODY PARSER: Handle ISO-8859-1 charset issue
// ────────────────────────────────────────────────
app.use((req, res, next) => {
    if (req.method !== 'POST') return next();

    const contentType = (req.headers['content-type'] || '').toLowerCase();
    console.log("=".repeat(70));
    console.log("[INCOMING]", new Date().toISOString());
    console.log("Content-Type:", req.headers['content-type']);
    console.log("Content-Length:", req.headers['content-length']);

    if (contentType.includes('application/json')) {
        let rawData = '';
        req.setEncoding('utf-8'); // Force UTF-8 read regardless of declared charset

        req.on('data', (chunk) => {
            rawData += chunk;
        });

        req.on('end', () => {
            console.log("Raw body received (utf-8 forced):", rawData || "[empty]");

            try {
                req.body = JSON.parse(rawData);
                console.log("Successfully parsed JSON:", JSON.stringify(req.body, null, 2));
            } catch (parseErr) {
                console.error("JSON parse failed:", parseErr.message);
                req.body = {};
            }
            next();
        });
        return; // Don't continue to other parsers yet
    }

    // Fallback for non-JSON or after custom handling
    next();
});

// Standard parsers as fallback/safety
app.use(express.json({ type: ['application/json', '*/*'] }));
app.use(express.urlencoded({ extended: true }));

app.use(cors());

const PORT = process.env.PORT || 10000;

// --- 2. HELPERS ---
function formatPhone(phone) {
    let p = phone.replace(/\D/g, '');
    if (p.startsWith('0')) p = '254' + p.slice(1);
    return p.startsWith('254') ? p : '254' + p;
}

async function getAuthToken() {
    try {
        const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        });
        return authRes.data.access_token;
    } catch (err) {
        console.error("❌ [AUTH ERROR]:", err.message);
        throw err;
    }
}

// --- 3. MAILING ENGINE ---
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "awards@saramievents.com", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `📸 Entry Verified: The Sarami Lens 2026`,
            htmlContent: `<div style="background-color: #0a0a0a; padding: 50px 20px; color: #fff;">
                <h1>Payment Verified</h1>
                <p>Dear ${orderData.payerName}, your entry fee has been received.</p>
                <p><strong>Order ID:</strong> ${orderId}</p>
            </div>`
        });
        await orderRef.update({ 
            emailStatus: 'SENT', 
            updatedAt: admin.firestore.FieldValue.serverTimestamp() 
        });
        console.log(`📧 Email sent for ${orderId}`);
    } catch (err) {
        console.error("Email failed:", err.message);
        await orderRef.update({ 
            emailStatus: `FAILED: ${err.message.slice(0, 150)}`,
            updatedAt: admin.firestore.FieldValue.serverTimestamp() 
        });
    }
}

// --- 4. CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventName } = req.body;
    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, 
            amount: Number(amount),
            status: 'INITIATED',
            emailStatus: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const token = await getAuthToken();
        const merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;

        const payload = {
            transactionId: merchantTxId,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: formatPhone(payerPhone),
            narration: `Sarami Lens: ${payerName}`,
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        console.log("STK Push payload sent:", JSON.stringify(payload, null, 2));

        const stkResponse = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL, 
            payload, 
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        await orderRef.update({
            merchantRequestID: merchantTxId,
            status: 'STK_SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("Create order error:", err.message);
        if (orderRef) {
            await orderRef.update({ 
                status: 'STK_FAILED', 
                reason: err.message,
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 5. CALLBACK ROUTE ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("=".repeat(80));
    console.log("[CALLBACK RECEIVED]", new Date().toISOString());
    console.log("Headers:", JSON.stringify(req.headers, null, 2));
    console.log("req.body:", req.body);

    let data = req.body || {};

    // Handle possible nested structure (common in Daraja proxies)
    if (data.Body && data.Body.stkCallback) {
        data = data.Body.stkCallback;
        console.log("→ Using nested stkCallback data");
    }

    console.log("Working data:", JSON.stringify(data, null, 2));

    // Wide search for transaction/merchant ID (you used transactionId when initiating)
    const possibleMerchantIds = [
        data.transactionId, data.TransactionId, data.transaction_id,
        data.merchantRequestId, data.MerchantRequestID, data.merchant_request_id,
        data.checkoutRequestId, data.CheckoutRequestID,
        data.reference, data.transactionReference, data.merchantTxId,
        data.transaction_ref
    ];

    const mReqId = possibleMerchantIds.find(id => 
        id && typeof id === 'string' && id.trim().length >= 8
    );

    if (!mReqId) {
        console.error("No usable merchant/transaction ID found");
        console.error("Top-level keys:", Object.keys(data));
        return res.status(200).json({ received: true });
    }

    console.log(`→ Matched ID: ${mReqId}`);

    // Success detection
    let resultCode = data.ResultCode ?? data.resultCode ?? data.statusCode ?? -1;
    const description = data.ResultDesc || data.message || data.reason || data.status || "No desc";

    const isSuccess = (
        resultCode === 0 || resultCode === '0' ||
        description.toLowerCase().includes('success') ||
        data.status === 'completed' || data.status === 'success' || data.status === 'PAID'
    );

    try {
        const snap = await db.collection('orders')
            .where('merchantRequestID', '==', mReqId)
            .limit(1)
            .get();

        if (snap.empty) {
            console.warn(`Order not found for ID: ${mReqId}`);
            return res.status(200).json({ received: true });
        }

        const doc = snap.docs[0];
        const orderRef = doc.ref;
        const orderData = doc.data();

        if (isSuccess) {
            await orderRef.update({
                status: 'PAID',
                paymentStatus: 'PAID',
                reason: 'Payment Successful',
                mpesaReceipt: data.MpesaReceiptNumber || data.receipt || "VERIFIED",
                callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
                rawCallbackPayload: data,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`PAID → Order ${doc.id}`);

            sendConfirmationEmail(orderData, doc.id, orderRef).catch(err => {
                console.error("Email failed (payment OK):", err.message);
            });
        } else {
            await orderRef.update({
                status: 'CANCELLED',
                paymentStatus: 'FAILED',
                reason: description || 'Failed/Cancelled',
                callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
                rawCallbackPayload: data,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`CANCELLED → Order ${doc.id} (${description})`);
        }
    } catch (dbErr) {
        console.error("Firestore error:", dbErr.message);
    }

    res.status(200).json({ received: true, message: "OK" });
});

// --- 6. STATUS POLLING ---
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).json({ status: 'NOT_FOUND' });

        const d = doc.data();
        res.json({
            status: d.status,
            paymentStatus: d.paymentStatus || d.status,
            reason: d.reason || "",
            mpesaReceipt: d.mpesaReceipt || ""
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
