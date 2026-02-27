// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// FIXED: charset ISO-8859-1, create-order logging, phone format
// ==========================================
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ Firebase Initialized");
} catch (error) {
    console.error("❌ Firebase init failed:", error);
}

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

// ─── CUSTOM PARSER: Force UTF-8 for bad charsets ───
app.use((req, res, next) => {
    if (req.method !== 'POST') return next();

    const ct = (req.headers['content-type'] || '').toLowerCase();
    console.log(`[IN] ${req.method} ${req.url} | Content-Type: ${req.headers['content-type'] || 'none'}`);

    if (ct.includes('application/json') || ct.includes('json')) {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', chunk => raw += chunk);
        req.on('end', () => {
            console.log('[RAW BODY]', raw.substring(0, 500) + (raw.length > 500 ? '...' : ''));
            try {
                req.body = JSON.parse(raw);
                console.log('[PARSED BODY]', JSON.stringify(req.body, null, 2));
            } catch (e) {
                console.error('[PARSE FAIL]', e.message);
                req.body = {};
            }
            next();
        });
        return;
    }
    next();
});

app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

const PORT = process.env.PORT || 10000;

// Helpers
function formatPhone(phone) {
    let p = (phone || '').replace(/\D/g, '');
    if (!p) return '';
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (!p.startsWith('254')) p = '254' + p;
    if (p.length !== 12) console.warn(`[WARN] Phone might be invalid: ${p}`);
    return p;
}

async function getAuthToken() {
    try {
        console.log('[AUTH] Attempting login...');
        const res = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        }, { timeout: 10000 });
        console.log('[AUTH] Success');
        return res.data.access_token;
    } catch (err) {
        console.error('[AUTH FAIL]', err.message, err.response?.data || '');
        throw err;
    }
}

// Email function (unchanged, but with better catch)
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        // ... (your existing code) ...
        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[EMAIL FAIL]', err.message);
        await orderRef.update({ emailStatus: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
}

// ─── CREATE ORDER ───
app.post('/api/create-order', async (req, res) => {
    console.log('[CREATE-ORDER] Body received:', JSON.stringify(req.body, null, 2));
    const { payerName, payerEmail, payerPhone, amount, eventName } = req.body || {};

    if (!payerName || !payerEmail || !payerPhone || !amount) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName,
            payerEmail,
            payerPhone,
            amount: Number(amount),
            eventName: eventName || 'Sarami Lens 2026',
            status: 'INITIATED',
            emailStatus: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('[ORDER CREATED]', orderRef.id);

        const token = await getAuthToken();

        const merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;
        const formattedPhone = formatPhone(payerPhone);

        const payload = {
            transactionId: merchantTxId,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: formattedPhone,
            narration: `Sarami Lens: ${payerName}`,
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        console.log('[STK PAYLOAD]', JSON.stringify(payload, null, 2));

        const stkRes = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL,
            payload,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );

        console.log('[STK RESPONSE]', stkRes.data);

        await orderRef.update({
            merchantRequestID: merchantTxId,
            status: 'STK_SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error('[CREATE-ORDER ERROR]', err.message, err.stack?.substring(0, 300));
        const errMsg = err.response?.data || err.message || 'Unknown error';

        if (orderRef) {
            await orderRef.update({
                status: 'FAILED',
                reason: errMsg,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
        }

        res.status(500).json({ success: false, error: errMsg });
    }
});

// ─── CALLBACK (with forced utf-8 already handled above) ───
app.post('/api/payment-callback', async (req, res) => {
    console.log('[CALLBACK] Headers:', req.headers);
    console.log('[CALLBACK] Body:', JSON.stringify(req.body, null, 2));

    let data = req.body || {};

    if (data.Body?.stkCallback) {
        data = data.Body.stkCallback;
    }

    // Wide ID search (add more if needed after seeing logs)
    const mReqId = data.transactionId || data.TransactionId ||
                   data.merchantRequestId || data.MerchantRequestID ||
                   data.checkoutRequestId || data.CheckoutRequestID ||
                   data.reference || data.transactionReference;

    if (!mReqId) {
        console.error('[CALLBACK] No ID found. Keys:', Object.keys(data));
        return res.status(200).send('OK');
    }

    const resultCode = data.ResultCode ?? -1;
    const isSuccess = resultCode === 0 || resultCode === '0' ||
                      data.status?.toLowerCase?.().includes('success') ||
                      data.message?.toLowerCase?.().includes('success');

    const reason = data.ResultDesc || data.message || 'No reason';

    try {
        const snap = await db.collection('orders')
            .where('merchantRequestID', '==', mReqId)
            .limit(1).get();

        if (snap.empty) {
            console.log('[CALLBACK] Order not found:', mReqId);
            return res.status(200).send('OK');
        }

        const doc = snap.docs[0];
        const ref = doc.ref;

        await ref.update({
            status: isSuccess ? 'PAID' : 'CANCELLED',
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            reason,
            mpesaReceipt: data.MpesaReceiptNumber || 'N/A',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rawCallback: data
        });

        console.log(`[UPDATED] ${doc.id} → ${isSuccess ? 'PAID' : 'CANCELLED'}`);

        if (isSuccess) {
            sendConfirmationEmail(doc.data(), doc.id, ref).catch(console.error);
        }
    } catch (e) {
        console.error('[DB ERROR]', e.message);
    }

    res.status(200).send('OK');
});

// Status endpoint (unchanged)
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).json({ status: 'NOT_FOUND' });
        res.json(doc.data());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
