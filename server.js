// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V9.9
// PRODUCTION MASTER: FINAL HEADER REFINEMENT
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

function getEventDetails(eventId, packageTier = 'BRONZE') {
    const eventMap = {
        'NAIVASHA': { venue: "Elsamere Resort, Naivasha", color: "#4a0404", packages: { 'GOLD': "Gold Luxury", 'BRONZE': "Bronze Walk-in" } },
        'ELDORET': { venue: "Marura Gardens, Eldoret", color: "#5c0505", packages: { 'GOLD': "Gold Package", 'BRONZE': "Bronze Package" } },
        'NAIROBI': { venue: "Sagret Gardens, Nairobi", color: "#800000", packages: { 'STANDARD': "Premium Couple" } }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    return { ...event, packageName: event.packages[packageTier] || "Standard Entry", date: "Feb 14, 2026", time: "6:30 PM" };
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
            // STEP 1: LOGIN (Successful)
            const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
                username: process.env.INFINITIPAY_MERCHANT_USERNAME,
                password: process.env.INFINITIPAY_MERCHANT_PASSWORD
            });
            const token = authRes.data.access_token;
            console.log(`[AUTH_SUCCESS] - Secure token received.`);

            // STEP 2: STK PUSH (Astra Port 9090)
            const stkUrl = process.env.INFINITIPAY_STKPUSH_URL;
            const basicAuth = Buffer.from(`${process.env.INFINITIPAY_CLIENT_ID}:${process.env.INFINITIPAY_CLIENT_SECRET}`).toString('base64');

            try {
                const stkRes = await axios.post(stkUrl, {
                    amount: Number(amount),
                    phoneNumber: formatPhone(payerPhone),
                    merchantCode: "ILM0000139", 
                    reference: orderRef.id,
                    description: `Ticket: ${eventName}`,
                    callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
                }, { 
                    headers: { 
                        'Authorization': `Bearer ${token}`,
                        'X-Authorization': `Basic ${basicAuth}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'User-Agent': 'SaramiTicketing/1.0',
                        'apiKey': process.env.INFINITIPAY_CLIENT_SECRET 
                    } 
                });
                
                await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: stkRes.data.requestId });
                return res.status(200).json({ success: true, message: "M-Pesa prompt sent!" });

            } catch (stkError) {
                console.error(`[ASTRA_REJECTION] Status: ${stkError.response?.status}`);
                console.error(`[ASTRA_BODY]`, JSON.stringify(stkError.response?.data || "No Body"));
                throw stkError; 
            }
        }
    } catch (err) {
        const errorDetail = err.response?.data?.message || err.message;
        console.error(`[BOOKING_ERROR] - ${errorDetail}`);
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

// --- 4. PDF GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        await page.setContent(`<html><body style="padding:40px; border:5px solid #D4AF37; font-family:serif;"><h1>SARAMI EVENTS</h1><h2>${data.payerName}</h2><p>${meta.venue}</p></body></html>`);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V9.9 Production Live`));
