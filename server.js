// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.4
// FULL PRODUCTION MASTER: MOJA ENDPOINT + COMPLETE LOGIC
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

// --- 2. PHONE FORMATTING HELPER (STRICT 254 FORMAT) ---
// Formats numbers to: 2547XXXXXXXX
function formatPhone(phone) {
    let p = phone.replace(/\D/g, ''); 
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (p.startsWith('254')) return p;
    if (p.length === 9) return '254' + p; 
    return p; 
}

// --- 3. LUXURY EVENT DATA & PROGRAM ---
function getEventDetails(eventId, packageTier = 'BRONZE') {
    const eventMap = {
        'NAIVASHA': { venue: "Elsamere Resort, Naivasha", color: "#4a0404", packages: { 'GOLD': "Gold Luxury", 'SILVER': "Silver Suite", 'BRONZE': "Bronze Walk-in" } },
        'ELDORET': { venue: "Marura Gardens, Eldoret", color: "#5c0505", packages: { 'GOLD': "Gold Package", 'BRONZE': "Bronze Package" } },
        'NAIROBI': { venue: "Sagret Gardens, Nairobi", color: "#800000", packages: { 'STANDARD': "Premium Couple" } }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    return { ...event, packageName: event.packages[packageTier] || "Standard Entry", date: "Feb 14, 2026", time: "6:30 PM - Late" };
}

// --- 4. EMAIL TICKET FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Ticket: ${orderData.eventName}`,
            htmlContent: `<div style="padding:40px; background:#fffdf9; border:2px solid #D4AF37; font-family:serif;">
                <h1 style="color:${meta.color};">Invitation Confirmed! ❤️</h1>
                <p>Hi ${orderData.payerName}, your reservation for ${meta.packageName} is ready.</p>
                <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" style="background:${meta.color}; color:#fff; padding:15px; text-decoration:none;">DOWNLOAD TICKET</a>
            </div>`
        });
        console.log(`[EMAIL_SENT] to ${orderData.payerEmail}`);
    } catch (err) { console.error("Email Error:", err.message); }
}

// --- 5. MAIN BOOKING & PAYMENT ROUTE ---
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
            await sendTicketEmail(req.body, orderRef.id);
            return res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            // STEP 1: LOGIN TO MOJA
            const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
                username: process.env.INFINITIPAY_MERCHANT_USERNAME,
                password: process.env.INFINITIPAY_MERCHANT_PASSWORD
            });

            const token = authRes.data.access_token;

            // STEP 2: STK PUSH (DYNAMICALLY SOURCED FROM ENV)
            const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: process.env.INFINITIPAY_MERCHANT_ID, // String "139"
                reference: orderRef.id,
                description: `Sarami Ticket: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });

            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: stkRes.data.requestId || "PENDING" });
            return res.status(200).json({ success: true, message: "M-Pesa prompt sent!" });
        }
    } catch (err) {
        console.error(`[BOOKING_ERROR] - ${err.message}`);
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: err.message });
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 6. LUXURY PDF TICKET GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;700&display=swap" rel="stylesheet"><style>body { margin: 0; padding: 0; }.page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; }.border-frame { position: absolute; inset: 10mm; border: 3px solid #D4AF37; border-radius: 25px; background: rgba(255,255,255,0.96); z-index: 2; display: flex; flex-direction: column; overflow: hidden; }.header { background: ${meta.color}; height: 50px; display: flex; align-items: center; justify-content: center; color: #D4AF37; font-family: 'Playfair Display'; letter-spacing: 5px; font-size: 22px; }.content { padding: 25px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; position: relative; }.name-shape { background: #fffcf0; padding: 15px; border-radius: 12px; border-left: 6px solid ${meta.color}; margin: 10px 0; }.qr-area { position: absolute; bottom: 25px; right: 25px; text-align: center; }.label { font-family: 'Montserrat'; font-size: 8px; color: #aaa; text-transform: uppercase; }</style></head>
            <body><div class="page"><div class="border-frame"><div class="header">SARAMI EVENTS</div><div class="content"><div><div style="font-family: 'Playfair Display'; font-size: 20px; color: ${meta.color};">${meta.venue}</div></div><div class="name-shape"><div style="font-family: 'Playfair Display'; font-size: 26px;">${data.payerName}</div></div><div style="display: flex; gap: 40px;"><div><div class="label">Date</div><div style="font-family:'Playfair Display';">${meta.date}</div></div><div><div class="label">Package</div><div style="font-family:'Playfair Display';">${meta.packageName}</div></div></div><div class="qr-area"><img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="130"></div></div></div></div>
            <div class="page"><div class="border-frame"><div class="header">THE PROGRAM</div><div class="content"><ul><li>18:30 Cocktails</li><li>20:00 Banquet</li><li>22:00 Serenade</li></ul></div></div></div></body></html>`);

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V10.4 Final Live`));
