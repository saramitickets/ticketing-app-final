// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// UPDATED: Enhanced Callback Parsing & Firestore Sync
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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        await orderRef.update({ emailStatus: `FAILED: ${err.message}` });
    }
}

// --- 4. CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventName } = req.body;
    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
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
        if (orderRef) await orderRef.update({ status: 'STK_FAILED', reason: err.message });
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. CALLBACK ROUTE (FIXED) ---
app.post('/api/payment-callback', async (req, res) => {
    // Log exactly what is coming in to debug the "Empty Payload" issue
    console.log("📥 [CALLBACK] Received Body:", JSON.stringify(req.body, null, 2));

    const data = req.body;
    
    // Deep search for Merchant ID in various formats
    const mReqId = data.merchant_request_id || 
                   data.MerchantRequestID || 
                   data.transactionId || 
                   (data.Body && data.Body.stkCallback && data.Body.stkCallback.MerchantRequestID);

    if (!mReqId) {
        console.error("❌ [CALLBACK ERROR] Could not extract Merchant ID from payload.");
        return res.sendStatus(200); // Always respond 200 to the provider
    }

    // Determine Success
    const resultCode = data.ResultCode ?? (data.Body?.stkCallback?.ResultCode);
    const resultDesc = data.ResultDesc || data.message || data.Body?.stkCallback?.ResultDesc || "No reason provided";
    const isSuccess = resultCode === 0 || data.status === 'completed' || data.status === 'success';

    try {
        const query = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
        
        if (!query.empty) {
            const doc = query.docs[0];
            const orderRef = db.collection('orders').doc(doc.id);
            const orderData = doc.data();

            if (isSuccess) {
                await orderRef.update({
                    status: 'PAID',
                    reason: 'Payment Successful',
                    mpesaReceipt: data.MpesaReceiptNumber || "VERIFIED",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ [UPDATED] Order ${doc.id} is now PAID`);
                await sendConfirmationEmail(orderData, doc.id, orderRef);
            } else {
                await orderRef.update({
                    status: 'CANCELLED',
                    reason: resultDesc,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`❌ [UPDATED] Order ${doc.id} is CANCELLED: ${resultDesc}`);
            }
        } else {
            console.warn(`⚠️ [NOT FOUND] No order in DB for ID: ${mReqId}`);
        }
    } catch (e) {
        console.error("❌ [DB UPDATE ERROR]:", e.message);
    }

    res.status(200).send("Callback Processed");
});

// --- 6. STATUS POLLING ---
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).json({ status: 'NOT_FOUND' });
        const data = doc.data();
        res.json({
            status: data.status,
            reason: data.reason || "",
            mpesaReceipt: data.mpesaReceipt || ""
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 SARAMI LENS 2026 - BACKEND READY`));
