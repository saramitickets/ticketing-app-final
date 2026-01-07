// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.23
// MASTER: FULL CALLBACK HANDLING + BRANDING
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

// --- TOGGLE BYPASS FOR TESTING EMAILS/PDFs WITHOUT PAYING ---
const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE & BREVO SETUP ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore(); // Global database scope
} catch (error) { 
    console.error("Firebase Error:", error.message); 
}

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json()); // Middleware for bank JSON body

const PORT = process.env.PORT || 10000;

// --- 2. HELPERS & EVENT DATA ---
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
    return authRes.data.access_token; // Token for subsequent calls
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

// --- 3. LUXURY EMAIL TICKET FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Ticket: ${orderData.eventName}`,
            htmlContent: `
                <div style="padding:40px; background:#fffdf9; border:2px solid #D4AF37; font-family:serif; text-align:center;">
                    <h1 style="color:${meta.color};">Reservation Confirmed! ❤️</h1>
                    <p>Dear ${orderData.payerName}, your luxury invitation for ${meta.packageName} is ready.</p>
                    <hr style="border:0; border-top:1px solid #D4AF37; width:50%; margin:20px auto;">
                    <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                       style="background:${meta.color}; color:#fff; padding:15px 30px; text-decoration:none; border-radius:5px; font-weight:bold;">
                       DOWNLOAD TICKET
                    </a>
                </div>`
        });
        console.log(`[EMAIL_SENT] to ${orderData.payerEmail}`);
    } catch (err) { console.error("Email Error:", err.message); }
}

// --- 4. MAIN BOOKING & PAYMENT ROUTE ---
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
            const token = await getAuthToken();
            const randomId = crypto.randomBytes(8).toString('hex');

            const payload = {
                transactionId: `TXN-${randomId}`,
                transactionReference: orderRef.id,
                amount: Number(amount),
                merchantId: "139", 
                transactionTypeId: 1, 
                payerAccount: formatPhone(payerPhone),
                narration: `Sarami: ${eventName}`,
                promptDisplayAccount: "Sarami Events", // Branding confirmed by Peter
                callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
                ptyId: 1 
            };

            const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });

            console.log(`[BANK_RAW]`, JSON.stringify(stkRes.data));
            const bankId = stkRes.data.results?.paymentId || "SUCCESS";
            
            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: bankId });
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) {
        console.error(`[BOOKING_ERROR] - ${err.message}`);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. ENHANCED CALLBACK ROUTE (FIXED FOR CANCELLATIONS) ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("[CALLBACK_RECEIVED]", JSON.stringify(req.body));
    
    // Moja usually provides reference as transactionReference
    const orderId = req.body.transactionReference || req.body.externalReference;
    const status = req.body.statusMessage || req.body.status;
    const resultCode = req.body.resultCode; // 1032 for user cancel

    try {
        if (orderId) {
            const orderDoc = await db.collection('orders').doc(orderId).get();
            if (orderDoc.exists) {
                const data = orderDoc.data();

                // Check for Successful PIN entry
                if (status === "COMPLETED" || status === "SUCCESS" || resultCode === 0) {
                    if (data.status !== 'PAID') {
                        await orderDoc.ref.update({ status: 'PAID', bankFinalData: req.body });
                        await sendTicketEmail(data, orderId);
                    }
                } 
                // Handle Cancellation or Failure
                else {
                    const failStatus = (resultCode === 1032 || status === "CANCELLED") ? 'CANCELLED' : 'FAILED';
                    await orderDoc.ref.update({ 
                        status: failStatus, 
                        errorMessage: status || "Transaction declined/cancelled." 
                    });
                }
            }
        }
        res.status(200).send("OK"); // Acknowledge bank receipt
    } catch (err) {
        console.error("Callback Error:", err.message);
        res.status(500).send("Error");
    }
});

// --- 6. PDF TICKET GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Ticket not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        
        await page.setContent(`
            <html>
            <body style="margin:0; padding:40px; font-family:serif; background:#fffcf0; border:10px solid #D4AF37;">
                <div style="text-align:center; color:${meta.color};">
                    <h1 style="letter-spacing:10px;">SARAMI EVENTS</h1>
                    <hr style="border:1px solid #D4AF37; width:60%; margin:20px auto;">
                    <h2 style="font-size:32px;">${data.payerName}</h2>
                    <p style="font-size:18px;">${meta.venue}</p>
                    <p>${meta.date} | ${meta.time}</p>
                    <div style="margin-top:40px; padding:20px; border:2px dashed ${meta.color}; display:inline-block;">
                        <h3 style="margin:0;">${meta.packageName}</h3>
                    </div>
                </div>
            </body>
            </html>
        `);

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V10.23 Production Live`));
