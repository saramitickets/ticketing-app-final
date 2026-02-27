// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// FIXED: charset, create-order logging, phone format, CORS for null + preflight, Render deploy (0.0.0.0 + /health)
// IMPROVED: more robust CORS with logging + explicit OPTIONS, better callback parsing
// ==========================================
const express = require('express');
const axios = require('axios');
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

// ─── Health check for Render ───
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ─── CORS with explicit OPTIONS handling + logging ───
app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.referer || 'unknown';

  console.log(`[CORS] Request from origin: ${origin} | Method: ${req.method} | Path: ${req.path}`);

  // Allow during dev: null + common local dev origins
  const allowedPatterns = [
    'null',
    'http://localhost',
    'http://127.0.0.1',
    'https://localhost',
  ];

  let corsOrigin = '*'; // fallback (can be tightened in production)

  // Check if origin matches any allowed pattern
  if (origin === 'null' || allowedPatterns.some(pattern => origin?.startsWith(pattern))) {
    corsOrigin = origin === 'null' ? '*' : origin;  // browsers accept * even for null in many cases
  }

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

  if (req.method === 'OPTIONS') {
    console.log('[CORS] Responding to OPTIONS preflight');
    return res.sendStatus(204);
  }

  next();
});

// ─── Custom parser to handle text/plain + JSON for callbacks ───
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  console.log('[INCOMING] Content-Type:', contentType);

  if (contentType.includes('text/plain') || contentType.includes('application/json')) {
    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', () => {
      console.log('[RAW BODY]', rawBody.substring(0, 1000) + (rawBody.length > 1000 ? '...' : ''));

      try {
        req.body = JSON.parse(rawBody.trim());
        console.log('[PARSED BODY]', JSON.stringify(req.body, null, 2));
      } catch (parseErr) {
        console.error('[PARSE ERROR]', parseErr.message);
        req.body = {};
      }
      next();
    });
    return;
  }

  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Email function (placeholder - implement your real email logic here)
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        // ... your Brevo / Sendinblue email sending code ...
        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[EMAIL FAIL]', err.message);
        await orderRef.update({ emailStatus: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
}

// ─── CREATE ORDER ─── (with extra logging)
app.post('/api/create-order', async (req, res) => {
    console.log('[CREATE-ORDER] Incoming request from origin:', req.headers.origin);
    console.log('[CREATE-ORDER] Headers:', req.headers);
    console.log('[CREATE-ORDER] Body:', JSON.stringify(req.body, null, 2));

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

// ─── CALLBACK ───
app.post('/api/payment-callback', async (req, res) => {
    console.log('[CALLBACK] Headers:', req.headers);
    console.log('[CALLBACK] Parsed Body:', JSON.stringify(req.body, null, 2));

    let data = req.body || {};
    if (data.Body?.stkCallback) {
        data = data.Body.stkCallback;
    }

    const possibleIds = [
        data.transactionId, data.TransactionId,
        data.merchantRequestId, data.MerchantRequestID, data.merchantRequestID,
        data.checkoutRequestId, data.CheckoutRequestID,
        data.reference, data.transactionReference
    ];

    const mReqId = possibleIds.find(id => id && typeof id === 'string' && id.trim());

    if (!mReqId) {
        console.error('[CALLBACK] No valid ID found. Keys:', Object.keys(data));
        return res.status(200).send('OK');
    }

    console.log('[CALLBACK] Found merchant ID:', mReqId);

    const resultCode = data.ResultCode ?? data.resultCode ?? -1;
    const isSuccess = resultCode === 0 || resultCode === '0' || String(resultCode) === '0';

    const reason = data.ResultDesc || data.resultDesc || data.message || data.ResultDescription || 'No reason provided';

    try {
        const snap = await db.collection('orders')
            .where('merchantRequestID', '==', mReqId)
            .limit(1)
            .get();

        if (snap.empty) {
            console.log('[CALLBACK] Order not found for ID:', mReqId);
            return res.status(200).send('OK');
        }

        const doc = snap.docs[0];
        const ref = doc.ref;

        await ref.update({
            status: isSuccess ? 'PAID' : 'CANCELLED',
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            reason: reason,
            mpesaReceipt: data.MpesaReceiptNumber || data.receiptNumber || 'N/A',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rawCallback: data,
            resultCode: resultCode
        });

        console.log(`[UPDATED] Order ${doc.id} → ${isSuccess ? 'PAID' : 'CANCELLED'} (Reason: ${reason})`);

        if (isSuccess) {
            sendConfirmationEmail(doc.data(), doc.id, ref).catch(console.error);
        }
    } catch (e) {
        console.error('[DB UPDATE ERROR]', e.message);
    }

    res.status(200).send('OK');
});

// Status endpoint
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).json({ status: 'NOT_FOUND' });
        res.json(doc.data());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Listen with 0.0.0.0 for Render ───
const HOST = '0.0.0.0';
const port = process.env.PORT || 10000;

app.listen(port, HOST, () => {
  console.log(`Server listening on http://${HOST}:${port}`);
  console.log(`Using NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});
