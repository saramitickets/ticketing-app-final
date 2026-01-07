// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.16
// MASTER: ENV-BASED PTYID + FULL LOGIC
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

// SET TO FALSE TO TRIGGER REAL M-PESA PROMPTS
const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE & BREVO SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) { 
    console.error("Firebase Initialization Error:", error.message); 
}

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
    if (p.length === 9) return '254' + p; 
    return p; 
}

async function getAuthToken() {
    const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
    });
    return authRes.data.access_token;
}

function getEventDetails(eventId, packageTier = 'BRONZE') {
    const eventMap = {
        'NAIVASHA': { venue: "Elsamere Resort, Naivasha", color: "#4a0404", packages: { 'GOLD': "Gold Luxury", 'SILVER': "Silver Suite", 'BRONZE': "Bronze Walk-in" } },
        'ELDORET': { venue: "Marura Gardens, Eldoret", color: "#5c0505", packages: { 'GOLD': "Gold Package", 'BRONZE': "Bronze Package" } },
        'NAIROBI': { venue: "Sagret Gardens, Nairobi", color: "#800000", packages: { 'STANDARD': "Premium Couple" } }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    return { ...event, packageName: event.packages[packageTier] || "Standard Entry", date: "Feb 14, 2026", time: "6:30 PM" };
}

// --- 3. MAIN BOOKING & PAYMENT ROUTE ---
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

            // V10.16: Using environment variables for both IDs
            const payload = {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: process.env.INFINITIPAY_MERCHANT_ID, // Use "139" in env
                ptyId: process.env.INFINITIPAY_PTY_ID,           // Set this to "1" or "139" in Render Dashboard
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
        console.error(`[BANK_REJECTION_DETAILS] -`, JSON.stringify(err.response?.data || "No Body"));
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

// PDF Generator and Status Query logic remain unchanged...

app.listen(PORT, () => console.log(`Sarami V10.16 Master Live`));
