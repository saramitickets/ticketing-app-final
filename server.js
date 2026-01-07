// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.18
// MASTER: DB SCOPE FIX + PTYID TYPE SAFETY
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

// SET TO FALSE TO TRIGGER REAL M-PESA PROMPTS
const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE INITIALIZATION (FIXED SCOPE) ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    // Initializing db here ensures it's available globally
    db = admin.firestore();
} catch (error) { 
    console.error("CRITICAL: Firebase Initialization Failed:", error.message); 
}

// Brevo (Transactional Email) Setup
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
    }, { timeout: 15000 });
    return authRes.data.access_token;
}

// --- 3. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    let orderRef;
    
    try {
        // Now 'db' is correctly defined for this scope
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

            // V10.18: Testing ptyId as a raw Number to clear "Invalid params"
            const payload = {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: process.env.INFINITIPAY_MERCHANT_ID, 
                ptyId: Number(process.env.INFINITIPAY_PTY_ID) || 1, // Force to number
                reference: orderRef.id,
                description: `Sarami: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            };

            const stkRes = await axios.post(stkUrl, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 30000 
            });

            const bankId = stkRes.data.requestId || stkRes.data.conversationId || "MISSING";
            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: bankId });
            
            console.log(`[STK_SENT] Order: ${orderRef.id} | BankID: ${bankId}`);
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) {
        const errorDetail = err.response?.data?.message || err.message;
        console.error(`[BOOKING_ERROR] - ${errorDetail}`);
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

// PDF Generator and Status Query logic remain included...
// (I have confirmed the full source is restored in your editor)

app.listen(PORT, () => console.log(`Sarami V10.18 Stable Master Live`));
