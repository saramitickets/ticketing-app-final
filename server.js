// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// UPDATED: Firestore Status Logic (PAID/CANCELLED) with Reasons
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

// Brevo (formerly Sendinblue) Configuration
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
        console.log("✅ [AUTH] Token acquired successfully");
        return authRes.data.access_token;
    } catch (err) {
        console.error("❌ [AUTH ERROR] Failed to get token:", err.message);
        throw err;
    }
}

// --- 3. MAILING ENGINE ---
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    console.log(`📩 [EMAIL PROCESS] Preparing dispatch for: ${orderData.payerEmail}`);
    
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "awards@saramievents.com", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `📸 Entry Verified: The Sarami Lens 2026`,
            htmlContent: `
                <div style="background-color: #0a0a0a; padding: 50px 20px; font-family: 'Helvetica', sans-serif; text-align: center; color: #ffffff;">
                    <div style="max-width: 600px; margin: auto; background: #111; border: 1px solid #d4af37; border-radius: 20px; padding: 40px;">
                        <h1 style="color: #d4af37; letter-spacing: 2px; text-transform: uppercase; font-size: 22px;">Payment Verified</h1>
                        <p style="font-size: 16px; color: #ccc;">Dear <strong>${orderData.payerName}</strong>,</p>
                        <p style="font-size: 16px; color: #ccc;">Your entry fee for <strong>The Sarami Lens 2026</strong> has been verified.</p>
                        
                        <div style="margin: 30px 0; padding: 20px; background: rgba(212, 175, 55, 0.1); border-radius: 12px;">
                            <p style="margin: 0; color: #d4af37; font-size: 11px; text-transform: uppercase; font-weight: bold; letter-spacing: 1px;">Unique Payment ID</p>
                            <p style="margin: 5px 0; font-size: 20px; font-weight: bold; color: #fff;">${orderId}</p>
                        </div>
                        <p style="font-size: 14px; color: #888;">Our judges look forward to reviewing your vision of Kenya. Good luck!</p>
                        <hr style="border: 0; border-top: 1px solid #333; margin: 30px 0;">
                        <p style="font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 2px;">Sarami Events | Capture the Heart of Kenya</p>
                    </div>
                </div>`
        });
        console.log(`✅ [EMAIL] Successfully sent to ${orderData.payerEmail}`);
        await orderRef.update({
            emailStatus: 'SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) {
        console.error(`❌ [EMAIL ERROR] Failed to send to ${orderData.payerEmail}: ${err.message}`);
        await orderRef.update({
            emailStatus: `FAILED: ${err.message}`,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
}

// --- 4. CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventName } = req.body;
    const eventId = "SL2026";
    const packageTier = "Standard Entry";
    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName: eventName || "The Sarami Lens 2026",
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
            promptDisplayAccount: "Sarami Events",
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        const stkResponse = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (stkResponse.data.statusCode === 0 || stkResponse.data.success === true || stkResponse.status === 200) {
            await orderRef.update({
                merchantRequestID: merchantTxId,
                status: 'STK_SENT',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ [STK] Push sent for Order: ${orderRef.id}`);
        } else {
            throw new Error(`STK push failed: ${JSON.stringify(stkResponse.data)}`);
        }

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error(`❌ [ORDER ERROR]: ${err.message}`);
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

// --- 5. CALLBACK ROUTE ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("📥 [CALLBACK] Received payload:", JSON.stringify(req.body, null, 2));
    
    if (!req.body || Object.keys(req.body).length === 0) return res.sendStatus(200);

    let results = req.body;
    if (req.body.Body && req.body.Body.stkCallback) {
        results = req.body.Body.stkCallback;
    } else if (req.body.results || req.body.Result) {
        results = req.body.results || req.body.Result;
    }

    const mReqId = results.merchant_request_id || results.MerchantRequestID || results.merchantTxnId || 
                   results.transactionId || results.MerchantTxnId || results.merchantTxId;

    if (!mReqId) {
        console.warn("⚠️ [CALLBACK] No Merchant ID found");
        return res.sendStatus(200);
    }

    const statusCode = results.ResultCode || results.statusCode || (results.status === 'completed' ? 0 : 1);
    const message = results.ResultDesc || results.message || results.errorMessage || "No specific reason provided";

    try {
        const querySnapshot = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
        
        if (!querySnapshot.empty) {
            const orderDoc = querySnapshot.docs[0];
            const orderRef = db.collection('orders').doc(orderDoc.id);
            const orderId = orderDoc.id;
            
            // Success: ResultCode 0 or status 'completed'
            if (statusCode === 0 || results.status === 'completed') {
                await orderRef.update({
                    status: 'PAID',
                    reason: "Payment verified successfully.",
                    mpesaReceipt: results.mpesa_receipt_number || results.CallbackMetadata?.Item?.find(item => item.Name === 'MpesaReceiptNumber')?.Value || "N/A",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ [SUCCESS] Order ${orderId} updated to PAID`);
                await sendConfirmationEmail(orderDoc.data(), orderId, orderRef);
            } else {
                // Failure/Cancellation
                await orderRef.update({
                    status: 'CANCELLED',
                    reason: message,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`❌ [CANCELLED] Order ${orderId} - Reason: ${message}`);
            }
        }
    } catch (e) { 
        console.error(`❌ [DB ERROR] Callback processing failed: ${e.message}`); 
    }
    res.sendStatus(200);
});

// --- 6. STATUS POLLING ---
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) return res.status(404).json({ status: 'NOT_FOUND' });
        
        const data = orderDoc.data();
        res.json({
            status: data.status ? data.status.trim() : "",
            emailStatus: data.emailStatus || "PENDING",
            reason: data.reason || "", // Unified field for both paid/cancelled reasons
            mpesaReceipt: data.mpesaReceipt || ""
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 SARAMI LENS 2026 - BACKEND READY`));
