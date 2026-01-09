// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V15.6
// UPDATED: Restored Luxury PDF Design + Robust Callback Cleaning
// ==========================================
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

const PAYMENT_BYPASS_MODE = false;

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
        'NAIVASHA': {
            venue: "Elsamere Resort, Naivasha",
            history: "Former home of Joy & George Adamson (Born Free)",
            color: "#6b0f0f", bg: "#120202", accent: "#D4AF37",
            packages: {
                'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000", quote: "Where time stops and love begins…" },
                'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000", quote: "A night where every glance feels like forever." },
                'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000", quote: "A gentle escape where love speaks softly." }
            }
        },
        'ELDORET': {
            venue: "Marura Gardens, Eldoret",
            history: "The Highland's Premier Sanctuary of Serenity",
            color: "#004d40", bg: "#002b25", accent: "#E2C275",
            packages: {
                'FLAME': { name: "Eternal Flame Dinner", price: "10,000", quote: "One night, one flame, one forever memory." },
                'SPARK': { name: "Sunset Spark", price: "7,000", quote: "Simple, sweet, and unforgettable." }
            }
        },
        'NAIROBI': {
            venue: "Sagret Gardens, Nairobi",
            history: "An Enchanted Garden Oasis in the Heart of the City",
            color: "#4b0082", bg: "#1a0033", accent: "#D4AF37",
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

// --- 3. EMAIL ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `
                <div style="background-color: #ffffff; padding: 40px; border: 4px solid ${meta.accent}; font-family: 'Georgia', serif; text-align: center; max-width: 600px; margin: auto;">
                    <div style="color: ${meta.color}; font-size: 30px; margin-bottom: 20px;">❤️</div>
                    <h1 style="color: ${meta.color}; text-transform: uppercase; letter-spacing: 2px; font-size: 24px; margin-bottom: 20px;">RESERVATION CONFIRMED</h1>
                    <p style="font-size: 18px; color: #333;">Dear <strong>${orderData.payerName}</strong>, your seat at <strong>${meta.venue}</strong> is reserved.</p>
                    <div style="margin: 30px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}"
                           style="background-color: ${meta.color}; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 14px; text-transform: uppercase; display: inline-block;">
                            DOWNLOAD DIGITAL TICKET
                        </a>
                    </div>
                    <p style="font-size: 16px; color: ${meta.color}; font-style: italic; margin-top: 30px;">"${meta.quote}"</p>
                </div>`
        });
        console.log(`✅ [LOG] Email sent to ${orderData.payerEmail}`);
    } catch (err) {
        console.error("❌ [LOG] EMAIL ERROR:", err.message);
    }
}

// --- 4. CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

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

        await orderRef.update({ merchantRequestID: merchantTxId });
        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. CALLBACK ROUTE (ROBUST CLEANING) ---
app.post('/api/payment-callback', express.raw({ type: '*/*' }), async (req, res) => {
    console.log("📥 [LOG] Callback received");
    let rawBody = req.body.toString('utf8').trim();

    // The "Fancy Fix": Strip invalid trailing characters like :"" from the gateway string
    if (rawBody.startsWith('{')) {
        const lastBrace = rawBody.lastIndexOf('}');
        if (lastBrace !== -1) rawBody = rawBody.substring(0, lastBrace + 1);
    }

    let payload = {};
    try {
        payload = JSON.parse(rawBody);
    } catch (err) {
        // Fallback to URL params if not valid JSON
        const params = new URLSearchParams(rawBody);
        for (const [key, value] of params) {
            try { payload[key] = JSON.parse(value); } catch { payload[key] = value; }
        }
    }

    const results = payload.results || payload.Result || payload; 
    const mReqId = results.merchantTxnId || results.MerchantRequestID || results.merchantTxId || payload.merchantTxnId;
    const statusCode = (payload.statusCode !== undefined) ? payload.statusCode : (results.statusCode || payload.ResultCode);

    if (!mReqId) {
        console.error("❌ [LOG] Merchant ID missing in callback");
        return res.sendStatus(200);
    }

    try {
        const querySnapshot = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
        if (!querySnapshot.empty) {
            const orderDoc = querySnapshot.docs[0];
            const orderRef = db.collection('orders').doc(orderDoc.id);
            const isSuccess = (statusCode == 0 || statusCode == "0" || statusCode == 200 || statusCode == "200");

            if (isSuccess) {
                await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
                await sendTicketEmail(orderDoc.data(), orderDoc.id);
            } else {
                await orderRef.update({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
        }
    } catch (e) { console.error("❌ DB Update Error:", e.message); }

    res.sendStatus(200);
});

// --- 6. LUXURY PDF GENERATION (RESTORED DESIGN) ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) throw new Error("Order not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);
        
        browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID: ${data.payerName} | REF: ${req.params.orderId}`);
        
        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Montserrat:wght@300;400;700;900&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; background: #000; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; background: ${meta.bg}; }
                    .border-frame { position: absolute; inset: 12mm; border: 1px solid ${meta.accent}; background: linear-gradient(145deg, ${meta.bg}, #000); z-index: 2; display: flex; flex-direction: column; border-radius: 4px; }
                    .corner { position: absolute; width: 40px; height: 40px; border: 3px solid ${meta.accent}; z-index: 5; }
                    .tl { top: -5px; left: -5px; border-right: 0; border-bottom: 0; }
                    .tr { top: -5px; right: -5px; border-left: 0; border-bottom: 0; }
                    .header { height: 70px; display: flex; align-items: center; justify-content: center; color: ${meta.accent}; font-family: 'Playfair Display'; font-weight: 700; letter-spacing: 5px; text-transform: uppercase; font-size: 22px; margin: 0 50px; border-bottom: 0.5px solid rgba(226, 194, 117, 0.2); }
                    .content { padding: 30px 60px; flex: 1; color: white; position: relative; }
                    .venue-title { font-family: 'Playfair Display'; font-size: 34px; color: ${meta.accent}; margin-bottom: 5px; }
                    .history-sub { font-family: 'Montserrat'; color: #aaa; text-transform: uppercase; font-size: 10px; letter-spacing: 2px; }
                    .guest-section { margin-top: 35px; position: relative; }
                    .label { font-family: 'Montserrat'; color: ${meta.accent}; font-size: 9px; letter-spacing: 3px; margin-bottom: 8px; font-weight: 700; }
                    .guest-name { font-family: 'Playfair Display'; font-size: 42px; color: #fff; line-height: 1; margin-bottom: 25px; font-style: italic; }
                    .info-grid { display: flex; gap: 50px; margin-top: 20px; }
                    .info-item { border-left: 2px solid ${meta.accent}; padding-left: 15px; }
                    .info-val { font-family: 'Montserrat'; font-weight: 700; font-size: 16px; color: #eee; text-transform: uppercase; }
                    .qr-container { position: absolute; bottom: 40px; right: 60px; text-align: center; }
                    .qr-img { width: 120px; height: 120px; background: white; padding: 10px; border-radius: 2px; border: 3px solid ${meta.accent}; }
                    .itinerary-container { padding: 40px 80px; }
                    .itin-title { text-align: center; font-family: 'Playfair Display'; font-size: 32px; font-style: italic; color: ${meta.accent}; margin-bottom: 40px; }
                    .itin-row { display: flex; align-items: flex-start; margin-bottom: 30px; }
                    .itin-time { width: 80px; font-family: 'Montserrat'; font-weight: 900; font-size: 20px; color: #fff; }
                    .itin-divider { width: 2px; height: 45px; background: rgba(255,255,255,0.3); margin: 0 25px; }
                    .itin-divider.active { background: ${meta.accent}; width: 3px; }
                    .itin-details { flex: 1; }
                    .itin-act { font-family: 'Montserrat'; font-weight: 700; font-size: 22px; color: #fff; margin-bottom: 4px; }
                    .itin-desc { font-family: 'Montserrat'; font-size: 13px; color: #888; }
                    .itin-footer { text-align: center; margin-top: 40px; font-family: 'Playfair Display'; color: ${meta.accent}; font-size: 24px; font-style: italic; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="border-frame">
                        <div class="corner tl"></div><div class="corner tr"></div>
                        <div class="header">Sarami Events</div>
                        <div class="content">
                            <div class="venue-title">${meta.venue}</div>
                            <div class="history-sub">${meta.history}</div>
                            <div class="guest-section">
                                <div class="label">INVITATION FOR</div>
                                <div class="guest-name">${data.payerName}</div>
                            </div>
                            <div class="info-grid">
                                <div class="info-item">
                                    <div class="label">DATE</div>
                                    <div class="info-val">${meta.date}</div>
                                </div>
                                <div class="info-item">
                                    <div class="label">TIER</div>
                                    <div class="info-val" style="color: ${meta.accent}">${meta.name}</div>
                                </div>
                            </div>
                            <div style="margin-top: 40px; font-family: 'Montserrat'; font-weight: 900; font-size: 20px; color: #fff; letter-spacing: 2px;">
                                KES ${meta.price} <span style="font-size: 12px; color: ${meta.accent}; margin-left: 10px;">[ CONFIRMED ]</span>
                            </div>
                            <div class="qr-container">
                                <img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode">
                            </div>
                        </div>
                    </div>
                </div>
                <div class="page">
                    <div class="border-frame">
                        <div class="itinerary-container">
                            <div class="itin-title">The Evening Itinerary</div>
                            <div class="itin-row"><div class="itin-time">18:30</div><div class="itin-divider"></div><div class="itin-details"><div class="itin-act">Welcoming Cocktails</div><div class="itin-desc">Chilled signature cocktails upon arrival.</div></div></div>
                            <div class="itin-row"><div class="itin-time">19:00</div><div class="itin-divider active"></div><div class="itin-details"><div class="itin-act" style="color: ${meta.accent}">Couples Games & Karaoke</div><div class="itin-desc">An hour of laughter, bonding, and melody.</div></div></div>
                            <div class="itin-row"><div class="itin-time">20:00</div><div class="itin-divider"></div><div class="itin-details"><div class="itin-act">3-Course Gourmet Banquet</div><div class="itin-desc">Curated culinary excellence for two.</div></div></div>
                            <div class="itin-footer">"Happy Valentine's to you and yours."</div>
                        </div>
                    </div>
                </div>
            </body>
            </html>`);
        
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) {
        res.status(500).send(e.message);
    } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V15.6 - ONLINE`));
