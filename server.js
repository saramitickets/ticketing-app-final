// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.5
// MASTER: STK PUSH + STATUS QUERY LOGIC
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

// --- 3. NEW: AUTH TOKEN FETCH (REUSABLE) ---
async function getAuthToken() {
    const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
    });
    return authRes.data.access_token;
}

// --- 4. MAIN BOOKING ROUTE ---
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
            const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: process.env.INFINITIPAY_MERCHANT_ID,
                reference: orderRef.id,
                description: `Sarami Ticket: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });

            // CRITICAL: We store the requestId from the bank for future queries
            const requestId = stkRes.data.requestId || "PENDING";
            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: requestId });
            
            console.log(`[STK_SENT] Order: ${orderRef.id} | BankID: ${requestId}`);
            return res.status(200).json({ success: true, message: "M-Pesa prompt sent!", orderId: orderRef.id });
        }
    } catch (err) {
        console.error(`[BOOKING_ERROR] - ${err.message}`);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. NEW: STATUS QUERY ROUTE ---
// Call this from your frontend or Postman to check a "stuck" payment
app.get('/api/query-status/:orderId', async (req, res) => {
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) return res.status(404).json({ error: "Order not found" });
        
        const orderData = orderDoc.data();
        if (!orderData.bankRequestId || orderData.bankRequestId === "PENDING") {
            return res.json({ status: orderData.status, message: "No bank ID found to query yet." });
        }

        const token = await getAuthToken();
        
        // This is the bank's "check status" endpoint
        // Note: Peter might need to confirm if this specific URL is correct for Moja
        const queryUrl = `https://moja.dtbafrica.com/api/infinitiPay/v2/payments/status/${orderData.bankRequestId}`;
        
        const queryRes = await axios.get(queryUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // Update database with latest status from bank
        const bankStatus = queryRes.data.status; // e.g., "COMPLETED", "FAILED", "PENDING"
        await orderDoc.ref.update({ status: bankStatus, lastChecked: new Date() });

        return res.json({ 
            orderId: req.params.orderId,
            bankStatus: bankStatus,
            fullBankResponse: queryRes.data 
        });

    } catch (err) {
        console.error(`[QUERY_ERROR] - ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// PDF Generator stays the same...
app.listen(PORT, () => console.log(`Sarami V10.5 Query Master Live`));
