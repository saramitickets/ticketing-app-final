// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// UPDATED: Enhanced Callback Parsing, Robust Logging & Firestore Sync
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

// Enhanced logging + more forgiving body parsing
app.use((req, res, next) => {
    if (req.method === 'POST') {
        console.log("=".repeat(60));
        console.log("📥 [INCOMING POST] at", new Date().toISOString());
        console.log("Headers:", req.headers);
        console.log("Content-Type:", req.get('content-type'));
    }
    next();
});

app.use(express.json({ type: "*/*" })); // Very forgiving – catches sloppy providers
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
        console.log(`📧 Email sent for order ${orderId}`);
    } catch (err) {
        console.error("❌ Email failed:", err.message);
        await orderRef.update({ 
            emailStatus: `FAILED: ${err.message.slice(0, 200)}`, 
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
            payerName, 
            payerEmail, 
            payerPhone, 
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

        console.log("→ Sending STK payload to InfinitiPay:", JSON.stringify(payload, null, 2));

        const stkResponse = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        await orderRef.update({
            merchantRequestID: merchantTxId,
            status: 'STK_SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("❌ Create order failed:", err.message);
        if (orderRef) {
            await orderRef.update({ 
                status: 'STK_FAILED', 
                reason: err.message,
                updatedAt: admin.firestore.FieldValue.serverTimestamp() 
            });
        }
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. CALLBACK ROUTE (ROBUST VERSION) ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("=".repeat(60));
    console.log("📥 [CALLBACK] Received at", new Date().toISOString());
    console.log("Headers:", req.headers);

    // Show raw body in case express didn't parse it
    console.log("Raw req.body (as received):", req.body);

    let data = req.body || {};

    // Handle common nested Daraja-style wrapper (very frequent with aggregators)
    if (data.Body && data.Body.stkCallback) {
        data = data.Body.stkCallback;
        console.log("→ Detected nested Daraja structure → using stkCallback");
    }

    console.log("Parsed / Flattened data:", JSON.stringify(data, null, 2));

    // Try many possible merchant/transaction ID field names (case insensitive variations)
    const possibleIds = [
        data.merchant_request_id, data.MerchantRequestID, data.merchantRequestId,
        data.transactionId, data.TransactionID, data.transaction_id,
        data.checkoutRequestId, data.CheckoutRequestID,
        data.reference, data.transactionReference, data.merchantTxId,
        data.MerchantTxId, data.transaction_ref
    ];

    const mReqId = possibleIds.find(id => id && typeof id === 'string' && id.trim().length > 5);

    if (!mReqId) {
        console.error("❌ [CALLBACK ERROR] No merchant/transaction ID found in payload");
        console.error("Available top-level keys:", Object.keys(data));
        return res.status(200).json({ message: "OK – no recognizable ID" });
    }

    console.log(`→ Found merchant ID: ${mReqId}`);

    // Determine success/failure
    let resultCode = data.ResultCode ?? data.resultCode ?? data.statusCode ?? data.Resultcode ?? -1;
    const resultDesc = data.ResultDesc || data.resultDesc || data.message || data.reason || data.status || "No description";

    // Extra success checks (some providers use strings/status)
    const isSuccess = (
        resultCode === 0 || String(resultCode) === "0" ||
        data.status === 'completed' || data.status === 'success' || data.status === 'PAID' ||
        resultDesc.toLowerCase().includes('success') || resultDesc.toLowerCase().includes('accepted')
    );

    try {
        const query = await db.collection('orders')
            .where('merchantRequestID', '==', mReqId)
            .limit(1)
            .get();

        if (query.empty) {
            console.warn(`⚠️ No order found for merchantRequestID: ${mReqId}`);
            return res.status(200).json({ message: "OK – order not found" });
        }

        const doc = query.docs[0];
        const orderRef = doc.ref;
        const orderData = doc.data();

        if (isSuccess) {
            await orderRef.update({
                status: 'PAID',
                paymentStatus: 'PAID',
                reason: 'Payment Successful',
                mpesaReceipt: data.MpesaReceiptNumber || data.receiptNumber || data.transactionRef || `VERIFIED_${Date.now()}`,
                callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
                rawCallback: data, // Save full payload for debugging
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Order ${doc.id} updated to PAID`);

            // Try to send email (non-blocking)
            sendConfirmationEmail(orderData, doc.id, orderRef).catch(e => {
                console.error("Email send failed (payment still recorded):", e.message);
            });
        } else {
            await orderRef.update({
                status: 'CANCELLED',
                paymentStatus: 'FAILED',
                reason: resultDesc || 'Payment Failed / Cancelled',
                callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
                rawCallback: data,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`❌ Order ${doc.id} updated to CANCELLED (${resultDesc})`);
        }
    } catch (e) {
        console.error("❌ [DB UPDATE ERROR]:", e.message);
    }

    // ALWAYS respond 200 quickly – prevents aggregator retries / timeouts
    res.status(200).json({ received: true, message: "Callback processed" });
});

// --- 6. STATUS POLLING ---
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).json({ status: 'NOT_FOUND' });

        const data = doc.data();
        res.json({
            status: data.status,
            paymentStatus: data.paymentStatus || data.status,
            reason: data.reason || "",
            mpesaReceipt: data.mpesaReceipt || ""
        });
    } catch (error) {
        console.error("Status poll error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 SARAMI LENS 2026 - BACKEND READY on port ${PORT}`);
});
