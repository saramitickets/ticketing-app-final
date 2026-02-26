// ==========================================
// THE SARAMI LENS 2026 - SECURE BACKEND
// UPDATED: Removed Valentine's / Optimized for Photography Competition
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
    console.log("✅ [SYSTEM] Firebase Initialized for Sarami Lens");
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
    const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
    });
    return authRes.data.access_token;
}

// --- 3. RE-DESIGNED CONFIRMATION EMAIL ---
async function sendConfirmationEmail(orderData, orderId) {
    console.log(`📩 [EMAIL] Sending confirmation for Order: ${orderId}`);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "awards@saramievents.com", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `📸 Entry Verified: The Sarami Lens 2026`,
            htmlContent: `
                <div style="background-color: #0a0a0a; padding: 50px 20px; font-family: 'Helvetica', Arial, sans-serif; text-align: center; color: #ffffff;">
                    <div style="max-width: 600px; margin: auto; background: #111; border: 1px solid #d4af37; border-radius: 20px; padding: 40px;">
                        <h1 style="color: #d4af37; letter-spacing: 2px; text-transform: uppercase; font-size: 22px;">Payment Verified</h1>
                        <p style="font-size: 16px; color: #ccc; line-height: 1.6;">Dear <strong>${orderData.payerName}</strong>,</p>
                        <p style="font-size: 16px; color: #ccc; line-height: 1.6;">Your entry fee for <strong>The Sarami Lens 2026</strong> has been successfully received and verified.</p>
                        
                        <div style="margin: 30px 0; padding: 20px; background: rgba(212, 175, 55, 0.1); border-radius: 12px;">
                            <p style="margin: 0; color: #d4af37; font-size: 12px; text-transform: uppercase; font-weight: bold; letter-spacing: 1px;">Unique Payment ID</p>
                            <p style="margin: 5px 0; font-size: 20px; font-weight: bold; color: #fff;">${orderId}</p>
                        </div>

                        <p style="font-size: 14px; color: #888;">Our judges are excited to review your perspective. We will notify you via this email address if your work is shortlisted for the national exhibition.</p>
                        
                        <hr style="border: 0; border-top: 1px solid #333; margin: 30px 0;">
                        <p style="font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 2px;">Sarami Events | Capture the Heart of Kenya</p>
                    </div>
                </div>`
        });
        console.log(`✅ [EMAIL] Successfully sent to ${orderData.payerEmail}`);
    } catch (err) {
        console.error("❌ [EMAIL] FAILED:", err.message);
    }
}

// --- 4. CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventName } = req.body;
    // Set fixed values for the competition to prevent 'undefined' errors
    const eventId = "SL2026";
    const packageTier = "Standard Entry"; 

    console.log(`🚀 [ENTRY START] New request from ${payerName}`);
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName: eventName || "The Sarami Lens", 
            status: 'INITIATED',
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
            promptDisplayAccount: "Sarami Events",
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        await orderRef.update({ merchantRequestID: merchantTxId });
        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("❌ [ENTRY ERROR]:", err.message);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. STATUS POLLING ---
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) return res.status(404).json({ status: 'NOT_FOUND' });
        const data = orderDoc.data();
        res.json({ status: data.status, cancelReason: data.cancelReason || "" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 6. CALLBACK ROUTE ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("📥 [CALLBACK] Received");
    const results = req.body.results || req.body.Result || req.body; 
    const mReqId = results.merchantTxnId || results.MerchantRequestID || results.merchantTxId;
    const statusCode = (req.body.statusCode !== undefined) ? req.body.statusCode : (results.statusCode || req.body.ResultCode);
    const message = req.body.message || results.message || req.body.ResultDesc || "No reason";

    if (!mReqId) return res.sendStatus(200);

    try {
        const querySnapshot = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
        if (!querySnapshot.empty) {
            const orderDoc = querySnapshot.docs[0];
            const orderRef = db.collection('orders').doc(orderDoc.id);
            
            if (statusCode == 0 || statusCode == 200) {
                await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                // Trigger the new clean confirmation email
                await sendConfirmationEmail(orderDoc.data(), orderDoc.id);
            } else {
                await orderRef.update({ status: 'CANCELLED', cancelReason: message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
        }
    } catch (e) { console.error("❌ [CALLBACK DB ERROR]:", e.message); }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 SARAMI LENS BACKEND ONLINE - PORT ${PORT}`));
