// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.20
// MASTER: PETER'S PRODUCTION PAYLOAD FIX
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto'); // For generating random transaction IDs

// SET TO FALSE TO TRIGGER REAL M-PESA PROMPTS
const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE INITIALIZATION ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
} catch (error) { console.error("Firebase Error:", error.message); }

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

// --- 3. MAIN BOOKING ROUTE (PETER'S PAYLOAD) ---
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

            // Generate a random ID to mimic {{$randomLoremWords}}
            const randomId = crypto.randomBytes(8).toString('hex');

            // V10.20: PETER'S EXACT PAYLOAD STRUCTURE
            const payload = {
                transactionId: `TXN-${randomId}`,
                transactionReference: orderRef.id,
                amount: Number(amount),
                merchantId: "139",          // Peter confirmed last 3 digits
                transactionTypeId: 1,      // As per Peter's JSON
                payerAccount: formatPhone(payerPhone),
                narration: `Sarami: ${eventName}`,
                callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
                ptyId: 1                   // As per Peter's JSON
            };

            const stkRes = await axios.post(stkUrl, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });

            console.log(`[BANK_RAW]`, JSON.stringify(stkRes.data));

            // Bank might return requestId or transactionId
            const bankId = stkRes.data.requestId || stkRes.data.transactionId || "SUCCESS";
            
            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: bankId });
            return res.status(200).json({ success: true, message: "M-Pesa prompt sent!", orderId: orderRef.id });
        }
    } catch (err) {
        const bankError = err.response?.data || err.message;
        console.error(`[BANK_REJECTION]`, JSON.stringify(bankError));
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: JSON.stringify(bankError) });
        res.status(500).json({ success: false, debug: bankError });
    }
});

// ... (PDF and Query logic remains same)

app.listen(PORT, () => console.log(`Sarami V10.20 Moja Final Live`));
