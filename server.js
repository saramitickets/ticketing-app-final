// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V15.4 (STABLE & REINFORCED)
// FEATURES: Firestore Undefined Fix, Price Display Fix, Full Logging
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

// --- BYPASS SETTING ---
const PAYMENT_BYPASS_MODE = false; 

// --- 1. FIREBASE & BREVO SETUP ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    
    // CRITICAL FIX: Prevents the "Cannot use undefined as a Firestore value" crash
    db.settings({ ignoreUndefinedProperties: true });
    
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
            color: "#6b0f0f", bg: "#120202", accent: "#D4AF37", 
            packages: { 'ETERNAL': { name: "Eternal Lakeside Embrace" }, 'MOONLIT': { name: "Moonlit Lakeside Spark" }, 'SUNRISE': { name: "Sunrise Lakeside Whisper" } } 
        },
        'ELDORET': { 
            venue: "Marura Gardens, Eldoret", 
            history: "The Highland's Premier Sanctuary of Serenity",
            color: "#004d40", bg: "#002b25", accent: "#E2C275", 
            packages: { 'FLAME': { name: "Eternal Flame Dinner" }, 'SPARK': { name: "Sunset Spark" } } 
        },
        'NAIROBI': { 
            venue: "Sagret Gardens, Nairobi", 
            history: "An Enchanted Garden Oasis in the Heart of the City",
            color: "#4b0082", bg: "#1a0033", accent: "#D4AF37", 
            packages: { 'CITYGLOW': { name: "City Glow Romance" } } 
        }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    const pKey = (packageTier || 'LUXURY').toUpperCase();
    const pkg = event.packages[pKey] || { name: "Luxury Entry" };
    return { ...event, ...pkg, date: "February 14, 2026" };
}

// --- 3. EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    console.log(`📩 [LOG] Dispatching Email for Order: ${orderId}`);
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `
                <div style="background-color: #ffffff; padding: 40px; border: 4px solid ${meta.accent}; font-family: 'Georgia', serif; text-align: center; max-width: 600px; margin: auto;">
                    <h1 style="color: ${meta.color}; text-transform: uppercase;">RESERVATION CONFIRMED</h1>
                    <p>Dear <strong>${orderData.payerName}</strong>, your seat at <strong>${meta.venue}</strong> is reserved.</p>
                    <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                       style="background-color: ${meta.color}; color: white; padding: 15px 25px; text-decoration: none; border-radius: 50px; font-weight: bold; display: inline-block; margin-top: 20px;">
                        DOWNLOAD YOUR TICKET
                    </a>
                </div>`
        });
        console.log(`✅ [LOG] Email successfully sent to ${orderData.payerEmail}`);
    } catch (err) {
        console.error("❌ [LOG] Email Error:", err.message);
    }
}

// --- 4. CREATE ORDER ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] INITIATING: ${payerName} | Amount: ${amount} | Event: ${eventId}`);
    
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (PAYMENT_BYPASS_MODE) {
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp(), bypass: true });
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

        await orderRef.update({ merchantRequestID: merchantTxId });
        console.log(`📲 [LOG] STK Push sent to ${payerPhone}. MerchantRef: ${merchantTxId}`);
        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("❌ [LOG] Create Order Error:", err.message);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. CALLBACK ROUTE (REINFORCED) ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("📥 [LOG] Callback Received");
    let rawData = req.body;
    const results = rawData.results || (rawData.Body && rawData.Body.stkCallback) || rawData;
    
    // Checks multiple fields for the Merchant ID to ensure it's never undefined
    const mReqId = results.merchantTxnId || results.MerchantRequestID || results.transactionId || results.transactionReference;
    
    if (!mReqId) {
        console.error("❌ [LOG] CALLBACK ERROR: Merchant ID is missing from provider response.");
        return res.sendStatus(200);
    }

    try {
        const querySnapshot = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
        if (querySnapshot.empty) {
            console.error(`⚠️ [LOG] Callback: No matching order found for Ref: ${mReqId}`);
            return res.sendStatus(200);
        }

        const orderDoc = querySnapshot.docs[0];
        const orderId = orderDoc.id;
        const statusCode = results.statusCode || rawData.statusCode || rawData.status;
        const isSuccess = (statusCode == 200 || statusCode === 'SUCCESS' || results.ResultCode === 0);

        if (isSuccess) {
            console.log(`💰 [LOG] PAYMENT SUCCESS: Order ${orderId}`);
            await db.collection('orders').doc(orderId).update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await sendTicketEmail(orderDoc.data(), orderId);
        } else {
            console.log(`❌ [LOG] PAYMENT FAILED: Order ${orderId}`);
            await db.collection('orders').doc(orderId).update({ status: 'CANCELLED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
    } catch (e) { console.error("❌ [LOG] Callback Processing Error:", e.message); }
    res.sendStatus(200);
});

// --- 6. PDF GENERATION (FIXED PRICE & ELDORET THEME) ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    console.log(`🖨️ [LOG] Generating PDF for Order: ${req.params.orderId}`);
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) throw new Error("Order not found");
        
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);
        
        // Pulls actual paid amount from database to fix "KES Varies" issue
        const displayPrice = data.amount ? data.amount.toLocaleString() : "10,000";

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
                    .border-frame { position: absolute; inset: 12mm; border: 1px solid ${meta.accent}; background: linear-gradient(145deg, ${meta.bg}, #000); display: flex; flex-direction: column; border-radius: 4px; }
                    .header { height: 70px; display: flex; align-items: center; justify-content: center; color: ${meta.accent}; font-family: 'Playfair Display'; font-weight: 700; letter-spacing: 5px; text-transform: uppercase; font-size: 22px; border-bottom: 0.5px solid rgba(226, 194, 117, 0.2); margin: 0 50px; }
                    .content { padding: 30px 60px; color: white; flex: 1; }
                    .venue-title { font-family: 'Playfair Display'; font-size: 34px; color: ${meta.accent}; margin-bottom: 5px; }
                    .guest-name { font-family: 'Playfair Display'; font-size: 42px; color: #fff; margin: 30px 0 20px 0; font-style: italic; }
                    .info-grid { display: flex; gap: 50px; margin-bottom: 30px; }
                    .label { font-family: 'Montserrat'; color: ${meta.accent}; font-size: 9px; font-weight: 700; letter-spacing: 2px; }
                    .info-val { font-family: 'Montserrat'; font-weight: 700; font-size: 16px; color: #eee; }
                    .qr-container { position: absolute; bottom: 40px; right: 60px; text-align: center; }
                    .qr-img { width: 120px; height: 120px; background: white; padding: 10px; border-radius: 2px; border: 3px solid ${meta.accent}; }
                    
                    /* Itinerary Styling (As per reference image) */
                    .itin-container { padding: 40px 80px; }
                    .itin-row { display: flex; align-items: flex-start; margin-bottom: 30px; }
                    .itin-time { width: 80px; font-family: 'Montserrat'; font-weight: 900; font-size: 20px; color: #fff; }
                    .itin-divider { width: 2px; height: 45px; background: rgba(255,255,255,0.3); margin: 0 25px; }
                    .itin-divider.active { background: ${meta.accent}; width: 3px; }
                    .itin-act { font-family: 'Montserrat'; font-weight: 700; font-size: 22px; color: #fff; }
                    .itin-desc { font-family: 'Montserrat'; font-size: 13px; color: #888; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="border-frame">
                        <div class="header">Sarami Events</div>
                        <div class="content">
                            <div class="venue-title">${meta.venue}</div>
                            <div class="label">INVITATION FOR</div>
                            <div class="guest-name">${data.payerName}</div>
                            <div class="info-grid">
                                <div><div class="label">DATE</div><div class="info-val">${meta.date}</div></div>
                                <div><div class="label">TIER</div><div class="info-val" style="color:${meta.accent}">${meta.name}</div></div>
                            </div>
                            <div style="font-family: 'Montserrat'; font-weight: 900; font-size: 20px;">
                                KES ${displayPrice} <span style="font-size: 12px; color: ${meta.accent}; margin-left: 10px;">[ CONFIRMED ]</span>
                            </div>
                            <div class="qr-container"><img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode"></div>
                        </div>
                    </div>
                </div>
                
                <div class="page">
                    <div class="border-frame">
                        <div class="itin-container">
                            <div style="text-align: center; font-family: 'Playfair Display'; font-size: 32px; font-style: italic; color: ${meta.accent}; margin-bottom: 40px;">The Evening Itinerary</div>
                            <div class="itin-row"><div class="itin-time">18:30</div><div class="itin-divider"></div><div><div class="itin-act">Welcoming Cocktails</div><div class="itin-desc">Chilled signature cocktails upon arrival.</div></div></div>
                            <div class="itin-row"><div class="itin-time">19:00</div><div class="itin-divider active"></div><div><div class="itin-act" style="color:${meta.accent}">Couples Games & Karaoke</div><div class="itin-desc">An hour of laughter, bonding, and melody.</div></div></div>
                            <div class="itin-row"><div class="itin-time">20:00</div><div class="itin-divider"></div><div><div class="itin-act">3-Course Gourmet Banquet</div><div class="itin-desc">Curated culinary excellence for two.</div></div></div>
                            <div style="text-align: center; margin-top: 40px; font-family: 'Playfair Display'; color: ${meta.accent}; font-size: 24px;">"Happy Valentine's to you and yours."</div>
                        </div>
                    </div>
                </div>
            </body>
            </html>`);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        console.log(`✅ [LOG] PDF Successfully Generated for ${data.payerName}`);
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { 
        console.error("❌ [LOG] PDF Generation Error:", e.message);
        res.status(500).send(e.message); 
    } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V15.4 - ONLINE & REINFORCED`));
