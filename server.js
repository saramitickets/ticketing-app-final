// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.12
// MASTER: FULL MERCHANT STRING (ILMXXXX)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE & BREVO SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) { console.error("Firebase Error:", error.message); }

const db = admin.firestore();
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 2. HELPERS ---
function formatPhone(phone) {
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (p.startsWith('254')) return p;
    return '254' + p; 
}

async function getAuthToken() {
    const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
    });
    return authRes.data.access_token;
}

// --- 3. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    let orderRef;
    
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            return res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            const token = await getAuthToken();
            const stkUrl = process.env.INFINITIPAY_STKPUSH_URL;

            // V10.12 FIX: Using the FULL merchant string format (e.g., ILM0000139)
            // Peter previously asked to "maintain the original payload"
            const fullMerchantCode = "ILM0000139"; 

            const payload = {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: fullMerchantCode, 
                ptyId: fullMerchantCode,        // Sending the full string to clear "Invalid ptyId"
                reference: orderRef.id,
                description: `Sarami Ticket: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            };

            const stkRes = await axios.post(stkUrl, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } 
            });

            console.log(`[BANK_RAW]`, JSON.stringify(stkRes.data));

            const bankId = stkRes.data.requestId || stkRes.data.conversationId || "MISSING";
            
            await orderRef.update({ 
                status: bankId === "MISSING" ? 'BANK_REJECTED' : 'STK_PUSH_SENT', 
                bankRequestId: bankId 
            });
            
            console.log(`[STK_SENT] Order: ${orderRef.id} | BankID: ${bankId}`);
            return res.status(200).json({ success: true, message: "M-Pesa prompt sent!", orderId: orderRef.id });
        }
    } catch (err) {
        const errorDetail = err.response?.data?.message || err.message;
        console.error(`[BOOKING_ERROR] - ${errorDetail}`);
        console.error(`[BOOKING_DEBUG] -`, JSON.stringify(err.response?.data || {}));
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

// Status Query and PDF Ticket logic remain unchanged...

app.listen(PORT, () => console.log(`Sarami V10.12 Master Live`));
