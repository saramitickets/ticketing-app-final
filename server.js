// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.17
// MASTER: SOCKET TIMEOUT + TYPE STABILIZATION
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE & BREVO SETUP (OMITTED FOR BREVITY) ---
// ... (Keep your existing Firebase and Brevo initialization here)

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
    // Adding timeout to auth too
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

            // V10.17: Forcing strict Number types for IDs to prevent socket hang ups
            const payload = {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: process.env.INFINITIPAY_MERCHANT_ID, 
                ptyId: Number(process.env.INFINITIPAY_PTY_ID), // FORCE TO NUMBER
                reference: orderRef.id,
                description: `Sarami: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            };

            // Adding a 30-second timeout to prevent the 'socket hang up'
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
        // Log deep error to see if it's a timeout
        if (err.code === 'ECONNABORTED') console.error("!!! BANK CONNECTION TIMED OUT !!!");
        
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

app.listen(PORT, () => console.log(`Sarami V10.17 Master Live`));
