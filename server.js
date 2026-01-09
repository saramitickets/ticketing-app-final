// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V11.9 (FIXED CALLBACK ORDER LOOKUP)
// CRITICAL FIX: InfinitiPay uses non-standard callback format without stkCallback wrapper
// ADDED: Better handling for direct results + statusCode/ResultCode + MerchantRequestID fallback
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

const BYPASS_PAYMENT = false;

// --- 1. FIREBASE & BREVO SETUP ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ [SYSTEM] Firebase Initialized Successfully");
} catch (error) {
    console.error("❌ Firebase Error:", error.message);
}

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: '*/*' }));

const PORT = process.env.PORT || 10000;

// --- 2. HELPERS ---
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
    return authRes.data.access_token;
}

function getEventDetails(eventId, packageTier) {
    const eventMap = {
        'NAIVASHA': { venue: "Elsamere Resort, Naivasha", color: "#6b0f0f", accent: "#D4AF37", packages: { 'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000" }, 'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000" }, 'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000" } } },
        'ELDORET': { venue: "Marura Gardens, Eldoret", color: "#006064", accent: "#D4AF37", packages: { 'FLAME': { name: "Eternal Flame Dinner", price: "10,000" }, 'SPARK': { name: "Sunset Spark", price: "7,000" } } },
        'NAIROBI': { venue: "Sagret Gardens, Nairobi", color: "#4b0082", accent: "#D4AF37", packages: { 'CITYGLOW': { name: "City Glow Romance", price: "9,000" } } }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    const pKey = packageTier.toUpperCase();
    const pkg = event.packages[pKey] || { name: "Luxury Entry", price: "Varies" };
    return { ...event, ...pkg, date: "February 14, 2026", history: event.history || "Luxury Event" };
}

// --- 3. LUXURY EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    console.log(`📩 [LOG] Step 3: Dispatching Confirmation Email for Order: ${orderId}`);
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `<div style="padding:40px; background:#fafafa; border:4px solid ${meta.accent}; text-align:center;">
                <h1 style="color:${meta.color};">Reservation Confirmed</h1>
                <p>Dear ${orderData.payerName}, your seat at <strong>${meta.venue}</strong> is reserved.</p>
                <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" style="background:${meta.color}; color:#fff; padding:15px; text-decoration:none; border-radius:50px;">Download Ticket</a>
            </div>`
        });
        console.log(`✅ [LOG] Step 4: Email delivered to ${orderData.payerEmail}`);
    } catch (err) {
        console.error("❌ [EMAIL ERROR]:", err.message);
    }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] Step 1: Processing booking for ${payerName}`);
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`💾 [LOG] Step 2: Firestore Document Created [ID: ${orderRef.id}]`);

        const token = await getAuthToken();
        const payload = {
            transactionId: `TXN-${crypto.randomBytes(4).toString('hex')}`,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: formatPhone(payerPhone),
            narration: `Sarami: ${eventName}`,
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        console.log(`📲 [LOG] Payment Request Sent to ${payerPhone}. Response: ${JSON.stringify(stkRes.data)}`);

        // Store any IDs returned (InfinitiPay may return MerchantRequestID or similar)
        const merchantRequestID = stkRes.data.merchantRequestID || stkRes.data.MerchantRequestID || stkRes.data.transactionId || payload.transactionId || '';
        const checkoutRequestID = stkRes.data.checkoutRequestID || stkRes.data.CheckoutRequestID || '';

        await orderRef.update({ merchantRequestID, checkoutRequestID });

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("❌ STK Push Error:", err.response?.data || err.message);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. FIXED CALLBACK ROUTE (Handles InfinitiPay's flat format) ---
app.post('/api/payment-callback', async (req, res) => {
    let rawData = req.body;

    if (typeof req.body === 'string') {
        try { rawData = JSON.parse(req.body); } catch (e) {
            const params = new URLSearchParams(req.body);
            rawData = Object.fromEntries(params);
        }
    }

    console.log("DEBUG FULL PAYLOAD:", JSON.stringify(rawData, null, 2));

    // InfinitiPay seems to send flat { amount, paymentId, statusCode, message, ... }
    const results = rawData.results || rawData;

    let orderId = results.transactionReference || results.paymentId || results.orderId || null;

    // Fallback: Use paymentId or MerchantRequestID to query Firestore
    if (!orderId) {
        const paymentId = results.paymentId || results.MerchantRequestID || results.merchantRequestID || results.transactionId;
        if (paymentId) {
            const querySnapshot = await db.collection('orders')
                .where('merchantRequestID', '==', paymentId)
                .get();

            if (querySnapshot.empty) {
                // Try secondary fields if needed
                const altSnapshot = await db.collection('orders')
                    .where('checkoutRequestID', '==', paymentId)
                    .get();
                if (!altSnapshot.empty) {
                    orderId = altSnapshot.docs[0].id;
                }
            } else {
                orderId = querySnapshot.docs[0].id;
            }
        }
    }

    if (!orderId) {
        console.log("⚠️ [LOG] Callback Error: Order ID still missing. Cannot update status.");
        return res.sendStatus(200); // Still acknowledge to avoid retries
    }

    // Determine success/cancelled
    let isSuccess = false;
    if (results.statusCode !== undefined) {
        isSuccess = results.statusCode == 0 || results.statusCode == "0"; // Common success code
    } else if (results.ResultCode !== undefined) {
        isSuccess = results.ResultCode === 0;
    } else if (results.message && results.message.toLowerCase().includes('success')) {
        isSuccess = true;
    }

    try {
        const orderRef = db.collection('orders').doc(orderId);
        const orderDoc = await orderRef.get();

        if (isSuccess) {
            console.log(`💰 [LOG] PAID: Order ${orderId} verified.`);
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            if (orderDoc.exists) await sendTicketEmail(orderDoc.data(), orderId);
        } else {
            console.log(`❌ [LOG] CANCELLED/FAILED: Order ${orderId} declined. Message: ${results.message || 'Unknown'}`);
            await orderRef.update({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
    } catch (e) {
        console.error("❌ [CALLBACK ERROR]:", e.message);
    }

    res.sendStatus(200);
});

// --- 6. ORDER STATUS CHECK ROUTE ---
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        const data = orderDoc.data();
        res.status(200).json({
            success: true,
            orderId: req.params.orderId,
            status: data.status || 'PENDING',
            payerName: data.payerName,
            amount: data.amount,
            eventName: data.eventName
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 7. PDF TICKET GENERATION ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) throw new Error("Order not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(`
        <html>
            <body style="background:#000; color:#fff; text-align:center; font-family:Arial;">
                <div style="border:2px solid ${meta.accent}; padding:50px; margin:20px;">
                    <h1 style="color:${meta.accent};">SARAMI EVENTS</h1>
                    <h2>${meta.venue}</h2>
                    <h2>${meta.name}</h2>
                    <h3>${data.payerName}</h3>
                    <p>KES ${meta.price} | ${data.status === 'PAID' ? 'PAID' : 'PENDING'}</p>
                    <p>Date: February 14, 2026</p>
                    <img src="https://barcode.tec-it.com/barcode.ashx?data=${req.params.orderId}&code=QRCode&multiplebarcodes=false&translate-esc=false&unit=Fit&dpi=96&imagetype=Gif&rotation=0&color=%23ffffff&bgcolor=%23000000&fontcolor=%23ffffff&qunit=Mm&quiet=10" style="margin-top:30px;">
                    <p style="margin-top:30px; font-size:12px;">Ticket ID: ${req.params.orderId}</p>
                </div>
            </body>
        </html>`);

        const pdf = await page.pdf({ format: 'A5', landscape: true, printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' });
        res.send(pdf);
    } catch (e) {
        res.status(500).send(`Error: ${e.message}`);
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V11.9 - ONLINE on port ${PORT}`));
