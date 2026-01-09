// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V14.0 (FINAL MERGED)
// FEATURES: V12 Logging, V13 Email Design, Floral Ticket, Bypass Mode
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

// --- BYPASS SETTING ---
const PAYMENT_BYPASS_MODE = true; 

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
    return authRes.data.access_token;
}

function getEventDetails(eventId, packageTier) {
    const eventMap = {
        'NAIVASHA': { 
            venue: "Elsamere Resort, Naivasha", 
            history: "Former home of Joy & George Adamson (Born Free)",
            color: "#6b0f0f", 
            accent: "#D4AF37", 
            packages: { 
                'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000", quote: "Where time stops and love begins…" }, 
                'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000", quote: "A night where every glance feels like forever." }, 
                'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000", quote: "A gentle escape where love speaks softly." } 
            } 
        },
        'ELDORET': { 
            venue: "Marura Gardens, Eldoret", 
            history: "The Highland's Premier Sanctuary of Serenity",
            color: "#006064", // UPDATED: Luxury Teal for Eldoret
            accent: "#D4AF37", 
            packages: { 
                'FLAME': { name: "Eternal Flame Dinner", price: "10,000", quote: "One night, one flame, one forever memory." }, 
                'SPARK': { name: "Sunset Spark", price: "7,000", quote: "Simple, sweet, and unforgettable." } 
            } 
        },
        'NAIROBI': { 
            venue: "Sagret Gardens, Nairobi", 
            history: "An Enchanted Garden Oasis in the Heart of the City",
            color: "#4b0082", 
            accent: "#D4AF37", 
            packages: { 
                'CITYGLOW': { name: "City Glow Romance", price: "9,000", quote: "City lights, your love, one perfect night." } 
            } 
        }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    const pKey = packageTier.toUpperCase();
    const pkg = event.packages[pKey] || { name: "Luxury Entry", price: "Varies", quote: "A perfect night of love." };
    return { ...event, ...pkg, date: "February 14, 2026" };
}

// --- 3. LUXURY EMAIL FUNCTION (HEART DESIGN) ---
async function sendTicketEmail(orderData, orderId) {
    console.log(`📩 [LOG] Dispatching Confirmation Email for Order: ${orderId}`);
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `
                <div style="background-color: #ffffff; padding: 40px; border: 4px solid #D4AF37; font-family: 'Georgia', serif; text-align: center; max-width: 600px; margin: auto;">
                    <div style="color: #6b0f0f; font-size: 30px; margin-bottom: 20px;">❤️</div>
                    <h1 style="color: #6b0f0f; text-transform: uppercase; letter-spacing: 2px; font-size: 24px; margin-bottom: 20px;">RESERVATION CONFIRMED</h1>
                    <p style="font-size: 18px; color: #333;">Dear <strong>${orderData.payerName}</strong>, your seat at <strong>${meta.venue}</strong> is reserved.</p>
                    <p style="font-size: 14px; color: #888; font-style: italic; margin-bottom: 30px;">${meta.history}</p>
                    <div style="margin: 30px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background-color: #6b0f0f; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 14px; text-transform: uppercase; display: inline-block;">
                            DOWNLOAD DIGITAL TICKET
                        </a>
                    </div>
                    <p style="font-size: 16px; color: #6b0f0f; font-style: italic; margin-top: 30px;">"${meta.quote}"</p>
                </div>`
        });
        console.log(`✅ [LOG] Email delivered to ${orderData.payerEmail}`);
    } catch (err) {
        console.error("❌ [EMAIL ERROR]:", err.message);
    }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] Processing booking for ${payerName}`);
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (PAYMENT_BYPASS_MODE) {
            console.log(`⚠️ [BYPASS] Payment bypassed for Order: ${orderRef.id}`);
            await orderRef.update({ 
                status: 'PAID', 
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                bypass: true 
            });
            await sendTicketEmail(req.body, orderRef.id);
            return res.status(200).json({ success: true, orderId: orderRef.id, bypassed: true });
        }

        const token = await getAuthToken();
        const merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;

        const payload = {
            transactionId: merchantTxId,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: formatPhone(payerPhone),
            narration: `Sarami: ${eventName}`,
            promptDisplayAccount: "Sarami Events",
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1
        };

        const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        await orderRef.update({ 
            merchantRequestID: merchantTxId, 
            gatewayRawId: stkRes.data.transactionId || '' 
        });

        console.log(`📲 [LOG] Payment Request Sent to ${payerPhone}. Waiting...`);
        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("❌ [CREATE ORDER ERROR]:", err.message);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. CALLBACK ROUTE (LOGS INCLUDED) ---
app.post('/api/payment-callback', async (req, res) => {
    let rawData = req.body;
    if (typeof req.body === 'string') {
        try { rawData = JSON.parse(req.body); } catch (e) {
            const params = new URLSearchParams(req.body);
            rawData = Object.fromEntries(params);
        }
    }

    console.log("DEBUG FULL PAYLOAD:", JSON.stringify(rawData, null, 2));
    const results = rawData.results || (rawData.Body && rawData.Body.stkCallback) || rawData;
    const mReqId = results.merchantTxnId || results.MerchantRequestID || results.transactionId;
    
    try {
        const querySnapshot = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
        if (querySnapshot.empty) {
            console.error(`⚠️ [LOG] Callback Error: No order found for ID: ${mReqId}`);
            return res.sendStatus(200);
        }

        const orderDoc = querySnapshot.docs[0];
        const orderId = orderDoc.id;
        const orderRef = db.collection('orders').doc(orderId);
        const statusCode = results.statusCode || rawData.statusCode || rawData.status;
        const isSuccess = (statusCode == 200 || statusCode === 'SUCCESS' || results.ResultCode === 0);

        if (isSuccess) {
            console.log(`💰 [LOG] PAID: Order ${orderId} verified.`);
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await sendTicketEmail(orderDoc.data(), orderId);
        } else {
            const msg = rawData.message || results.message || "Declined/Cancelled";
            console.log(`❌ [LOG] CANCELLED: Order ${orderId}. Message: ${msg}`);
            await orderRef.update({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp(), cancelReason: msg });
        }
    } catch (e) { console.error("❌ [CALLBACK ERROR]:", e.message); }
    res.sendStatus(200);
});

// --- 6. FLORAL PDF GENERATION ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Montserrat:wght@400;700;900&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; background: #000; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; background: #0b0b0b; }
                    .border-frame { position: absolute; inset: 10mm; border: 2px solid ${meta.accent}; background: #0f0f0f; z-index: 2; display: flex; flex-direction: column; border-radius: 20px; }
                    
                    /* FLORAL SHAPES */
                    .flower { position: absolute; width: 40px; height: 40px; opacity: 0.2; filter: brightness(0) saturate(100%) invert(84%) sepia(21%) saturate(952%) hue-rotate(3deg) convert(100%); }
                    
                    .header { height: 65px; display: flex; align-items: center; justify-content: center; color: ${meta.accent}; font-family: 'Playfair Display'; font-style: italic; font-size: 28px; border-bottom: 1px solid rgba(212, 175, 55, 0.3); margin: 0 40px; }
                    .content { padding: 35px 50px; flex: 1; position: relative; color: white; }
                    .venue-title { font-family: 'Playfair Display'; font-size: 32px; color: ${meta.accent}; }
                    .guest-box { position: relative; border: 1px solid rgba(212, 175, 55, 0.2); padding: 15px; margin: 20px 0; border-radius: 10px; }
                    .guest-name { font-family: 'Playfair Display'; font-size: 38px; color: white; }
                    .pricing-badge { display: inline-block; padding: 12px 30px; border-radius: 50px; background: ${meta.color}; border: 1px solid ${meta.accent}; font-family: 'Montserrat'; font-weight: 700; font-size: 18px; }
                    .qr-container { position: absolute; bottom: 35px; right: 50px; text-align: center; }
                    .qr-img { width: 150px; height: 150px; background: white; padding: 8px; border-radius: 10px; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="border-frame">
                        <div class="header">Sarami Events</div>
                        <div class="content">
                            <div class="venue-title">${meta.venue}</div>
                            <div style="font-family: 'Montserrat'; color: #888; text-transform: uppercase; font-size: 11px;">${meta.history}</div>
                            
                            <div class="guest-box">
                                <div style="font-family: 'Montserrat'; color: #666; font-size: 10px;">ESTEEMED GUEST</div>
                                <div class="guest-name">${data.payerName} 🌸</div>
                            </div>

                            <div style="display: flex; gap: 60px;">
                                <div><div style="font-size: 10px; color: #666;">DATE</div><div style="font-family: 'Montserrat'; font-weight:700;">${meta.date}</div></div>
                                <div><div style="font-size: 10px; color: #666;">PACKAGE</div><div style="font-family: 'Montserrat'; font-weight:700;">${meta.name} 🌿</div></div>
                            </div>
                            
                            <div style="margin-top: 30px;" class="pricing-badge">KES ${meta.price} | PAID</div>
                            <div class="qr-container">
                                <img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode">
                                <div style="color: ${meta.accent}; font-family: Montserrat; font-size: 9px; margin-top: 8px;">SCAN FOR ENTRY</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="page">
                    <div class="border-frame">
                        <div class="header">The Evening Itinerary</div>
                        <div class="content" style="padding-top: 40px;">
                            <div style="margin-bottom:20px;"><strong>18:30</strong> - Welcoming Cocktails 🍸</div>
                            <div style="margin-bottom:20px;"><strong>19:00</strong> - Couples Games & Karaoke 🎤</div>
                            <div style="margin-bottom:20px;"><strong>20:00</strong> - 3-Course Gourmet Banquet 🍽️</div>
                            <div style="text-align: center; margin-top: 20px; font-family: 'Playfair Display'; color: ${meta.accent}; font-size: 22px;">"Happy Valentine's 🌹"</div>
                        </div>
                    </div>
                </div>
            </body>
            </html>`);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V14.0 - SYSTEM ONLINE`));
