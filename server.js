// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// FIXED: Bulletproof CORS for local files (null origin), Callback lookup logic, broader success status checks
// IMPROVED: Direct Document ID querying for faster, reliable lookups
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

// ─── Bulletproof CORS Middleware ───
app.use((req, res, next) => {
  // Grab the origin, default to '*' if missing
  const origin = req.headers.origin || '*';

  // Reflect the exact origin back to satisfy 'credentials: true' requirements,
  // even if the origin is 'null' (like when opening local HTML files)
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  // Handle preflight requests instantly
  if (req.method === 'OPTIONS') {
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

async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        // ... your Brevo / Sendinblue email sending code ...
        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[EMAIL FAIL]', err.message);
        await orderRef.update({ emailStatus: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
}

// ─── CREATE ORDER ───
app.post('/api/create-order', async (req, res) => {
    console.log('[CREATE-ORDER] Incoming request from origin:', req.headers.origin);
    
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
        console.error('[CREATE-ORDER ERROR]', err.message);
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
    console.log('[CALLBACK] Parsed Body:', JSON.stringify(req.body, null, 2));

    let data = req.body || {};
    if (data.Body?.stkCallback) {
        data = data.Body.stkCallback; // Unwrap standard Safaricom callback
    }

    try {
        let orderDoc = null;
        let ref = null;

        // 1. Try to find by exact Firestore Document ID first
        const docId = data.transactionReference || data.reference;
        if (docId && typeof docId === 'string') {
            const docSnap = await db.collection('orders').doc(docId).get();
            if (docSnap.exists) {
                orderDoc = docSnap.data();
                ref = docSnap.ref;
                console.log('[CALLBACK] Found order by Document ID:', docSnap.id);
            }
        }

        // 2. Fallback: Try to find by merchantRequestID if Document ID lookup failed
        if (!ref) {
            const possibleIds = [
                data.transactionId, data.TransactionId,
                data.merchantRequestId, data.MerchantRequestID, data.merchantRequestID,
                data.checkoutRequestId, data.CheckoutRequestID
            ];
            
            const mReqId = possibleIds.find(id => id && typeof id === 'string' && id.trim());
            
            if (mReqId) {
                const snap = await db.collection('orders')
                    .where('merchantRequestID', '==', mReqId)
                    .limit(1)
                    .get();

                if (!snap.empty) {
                    ref = snap.docs[0].ref;
                    orderDoc = snap.docs[0].data();
                    console.log('[CALLBACK] Found order by merchantRequestID:', mReqId);
                }
            }
        }

        // If we still can't find it, log and acknowledge to prevent gateway retries
        if (!ref) {
            console.error('[CALLBACK] Order not found for incoming payload.');
            return res.status(200).send('OK');
        }

        // Determine Success via multiple common gateway fields
        const resultCode = data.ResultCode ?? data.resultCode ?? data.statusCode;
        const statusStr = (data.status || data.Status || '').toUpperCase();
        
        const isSuccess = 
            resultCode === 0 || 
            resultCode === '0' || 
            statusStr === 'SUCCESS' || 
            statusStr === 'COMPLETED' || 
            statusStr === 'PAID';

        const reason = data.ResultDesc || data.resultDesc || data.message || data.ResultDescription || 'No reason provided';

        // Update Database
        await ref.update({
            status: isSuccess ? 'PAID' : 'CANCELLED',
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            reason: reason,
            mpesaReceipt: data.MpesaReceiptNumber || data.receiptNumber || data.transactionId || 'N/A',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rawCallback: data,
            resultCode: resultCode || statusStr || -1
        });

        console.log(`[UPDATED] Order ${ref.id} → ${isSuccess ? 'PAID' : 'CANCELLED'} (Reason: ${reason})`);

        // Trigger email if successful
        if (isSuccess) {
            sendConfirmationEmail(orderDoc, ref.id, ref).catch(console.error);
        }

    } catch (e) {
        console.error('[DB UPDATE ERROR]', e.message);
    }

    // Always return 200 OK so the payment gateway stops retrying
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
