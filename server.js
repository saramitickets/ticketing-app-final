// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V15.7 (CALLBACK FIXED)
// FEATURES: Restored Logs, Eldoret Luxury Theme, Itinerary Design, Robust Callback
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
    // Critical: prevents crashes on undefined values
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
    const pKey = (packageTier || '').toUpperCase();
    const pkg = event.packages[pKey] || { name: "Luxury Entry" };
    return { ...event, ...pkg, date: "February 14, 2026" };
}

// --- 3. EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    console.log(`📩 [LOG] Dispatching Confirmation Email for Order: ${orderId}`);
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `<div style="padding: 40px; border: 4px solid ${meta.accent}; text-align: center;">
                <h1 style="color: ${meta.color};">RESERVATION CONFIRMED</h1>
                <p>Dear <strong>${orderData.payerName}</strong>, your seat at ${meta.venue} is reserved.</p>
                <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" style="display:inline-block; padding: 15px 25px; background:${meta.color}; color:white; text-decoration:none; border-radius:50px;">DOWNLOAD TICKET</a>
            </div>`
        });
        console.log(`✅ [LOG] Email delivered to ${orderData.payerEmail}`);
    } catch (err) {
        console.error("❌ [EMAIL ERROR]:", err.message);
    }
}

// --- 4. CREATE ORDER ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] NEW BOOKING INITIATED: ${payerName} | Amount: ${amount} | Event: ${eventId}`);

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

        await orderRef.update({ merchantRequestID: merchantTxId });
        console.log(`📲 [LOG] STK Push sent to ${payerPhone}. MerchantRef: ${merchantTxId}`);

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error("❌ [CREATE ERROR]:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 5. IMPROVED CALLBACK ROUTE ---
app.post('/api/payment-callback', async (req, res) => {
    console.log("📥 [LOG] Payment Callback Received");
    
    // Very helpful for debugging - log the full raw payload
    console.log("Raw callback body:", JSON.stringify(req.body, null, 2));

    let body = req.body;

    // Handle common nesting patterns
    if (body.Body?.stkCallback) {
        body = body.Body.stkCallback;
    } else if (body.results) {
        body = body.results;
    } else if (body.result) {
        body = body.result;
    }

    // Try to find merchant ID with many possible field names
    const possibleMerchantFields = [
        body.MerchantRequestID,
        body.merchantRequestID,
        body.merchantRequestId,
        body.merchantTxnId,
        body.merchantTransactionId,
        body.transactionId,
        body.TransactionID,
        body.transactionReference,
        body.checkoutRequestID,
        body.CheckoutRequestID,
        body.reference,
        body.Reference
    ];

    const mReqId = possibleMerchantFields.find(id => 
        id && typeof id === 'string' && id.trim().length >= 6
    );

    if (!mReqId) {
        console.error("❌ [LOG] CALLBACK ERROR: Could not find any merchant transaction ID");
        console.error("Available top-level fields:", Object.keys(body));
        return res.sendStatus(200);
    }

    console.log(`🔍 [CALLBACK] Found merchant ref: ${mReqId}`);

    try {
        const querySnapshot = await db.collection('orders')
            .where('merchantRequestID', '==', mReqId)
            .limit(1)
            .get();

        if (querySnapshot.empty) {
            console.error(`⚠️ [LOG] No order found for merchant ref: ${mReqId}`);
            return res.sendStatus(200);
        }

        const orderDoc = querySnapshot.docs[0];
        const orderId = orderDoc.id;

        // Flexible success detection
        const resultCode = 
            body.ResultCode ??
            body.resultCode ??
            body.statusCode ??
            (body.status === 'SUCCESS' || body.status === 'success' ? 0 : 1);

        const isSuccess = resultCode === 0 || resultCode === 200;

        if (isSuccess) {
            console.log(`💰 [LOG] PAID: Order ${orderId} verified.`);
            await orderDoc.ref.update({ 
                status: 'PAID',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                paymentResult: body,
                paymentCompletedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            await sendTicketEmail(orderDoc.data(), orderId);
        } else {
            console.log(`❌ [LOG] FAILED/CANCELLED: Order ${orderId} - Code: ${resultCode}`);
            await orderDoc.ref.update({ 
                status: 'CANCELLED',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                paymentResult: body,
                failureReason: body.ResultDesc || body.message || 'Unknown'
            });
        }
    } catch (e) {
        console.error("❌ [CALLBACK PROCESSING ERROR]:", e.message);
    }

    // ALWAYS acknowledge to prevent provider retries
    res.sendStatus(200);
});

// --- 6. PDF TICKET GENERATION ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    console.log(`🖨️ [LOG] Generating PDF for Order: ${req.params.orderId}`);

    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) {
            return res.status(404).send("Order not found");
        }

        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);
        const displayPrice = data.amount ? data.amount.toLocaleString() : "Varies";

        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true
        });
        
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`<html><head>
            <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Montserrat:wght@400;700;900&display=swap" rel="stylesheet">
            <style>
                body { margin: 0; background: #000; }
                .page { width: 210mm; height: 148mm; position: relative; background: ${meta.bg}; overflow: hidden; page-break-after: always; }
                .frame { position: absolute; inset: 12mm; border: 1px solid ${meta.accent}; background: linear-gradient(145deg, ${meta.bg}, #000); border-radius: 4px; display: flex; flex-direction: column; }
                .header { height: 70px; display: flex; align-items: center; justify-content: center; color: ${meta.accent}; font-family: 'Playfair Display'; font-weight: 700; letter-spacing: 5px; text-transform: uppercase; border-bottom: 0.5px solid rgba(226, 194, 117, 0.2); margin: 0 50px; }
                .content { padding: 30px 60px; color: white; flex: 1; }
                .guest-name { font-family: 'Playfair Display'; font-size: 42px; margin: 30px 0 20px 0; font-style: italic; }
                .info-grid { display: flex; gap: 50px; }
                .label { font-family: 'Montserrat'; color: ${meta.accent}; font-size: 9px; font-weight: 700; letter-spacing: 2px; }
                .info-val { font-family: 'Montserrat'; font-weight: 700; font-size: 16px; }
                .qr-container { position: absolute; bottom: 40px; right: 60px; text-align: center; }
                .qr-img { width: 120px; height: 120px; background: white; padding: 10px; border: 3px solid ${meta.accent}; }
                .itin-container { padding: 40px 80px; }
                .itin-row { display: flex; margin-bottom: 30px; }
                .itin-time { width: 80px; font-family: 'Montserrat'; font-weight: 900; font-size: 20px; color: #fff; }
                .itin-divider { width: 2px; height: 45px; background: rgba(255,255,255,0.3); margin: 0 25px; }
                .itin-divider.active { background: ${meta.accent}; width: 3px; }
            </style></head><body>
            <div class="page"><div class="frame">
                <div class="header">Sarami Events</div>
                <div class="content">
                    <div style="font-family:'Playfair Display'; font-size:34px; color:${meta.accent};">${meta.venue}</div>
                    <div class="label" style="margin-top:30px;">INVITATION FOR</div>
                    <div class="guest-name">${data.payerName}</div>
                    <div class="info-grid">
                        <div><div class="label">DATE</div><div class="info-val">${meta.date}</div></div>
                        <div><div class="label">TIER</div><div class="info-val" style="color:${meta.accent}">${meta.name}</div></div>
                    </div>
                    <div style="margin-top: 40px; font-family:'Montserrat'; font-weight:900; font-size:20px;">KES ${displayPrice} [ CONFIRMED ]</div>
                    <div class="qr-container"><img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode"><div style="color:${meta.accent}; font-size:8px; margin-top:5px;">SECURE ADMIT</div></div>
                </div>
            </div></div>
            <div class="page"><div class="frame"><div class="itin-container">
                <div style="text-align:center; font-family:'Playfair Display'; font-size:32px; font-style:italic; color:${meta.accent}; margin-bottom:40px;">The Evening Itinerary</div>
                <div class="itin-row"><div class="itin-time">18:30</div><div class="itin-divider"></div><div><div style="font-family:'Montserrat'; font-weight:700; font-size:22px;">Welcoming Cocktails</div><div style="color:#888;">Chilled signature cocktails upon arrival.</div></div></div>
                <div class="itin-row"><div class="itin-time">19:00</div><div class="itin-divider active"></div><div><div style="font-family:'Montserrat'; font-weight:700; font-size:22px; color:${meta.accent}">Couples Games & Karaoke</div><div style="color:#888;">An hour of laughter, bonding, and melody.</div></div></div>
                <div class="itin-row"><div class="itin-time">20:00</div><div class="itin-divider"></div><div><div style="font-family:'Montserrat'; font-weight:700; font-size:22px;">3-Course Gourmet Banquet</div><div style="color:#888;">Curated culinary excellence for two.</div></div></div>
                <div style="text-align:center; margin-top:40px; font-family:'Playfair Display'; color:${meta.accent}; font-size:24px;">"Happy Valentine's to you and yours."</div>
            </div></div></div>
            </body></html>`);

        const pdf = await page.pdf({ 
            width: '210mm', 
            height: '148mm', 
            printBackground: true,
            margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
        });

        console.log(`✅ [LOG] PDF Generated for ${data.payerName}`);
        res.set('Content-Type', 'application/pdf');
        res.send(pdf);
    } catch (e) {
        console.error("❌ [PDF ERROR]:", e.message);
        res.status(500).send("Error generating ticket PDF");
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`🚀 SARAMI EVENTS TICKETING BACKEND v15.7 - SYSTEM ONLINE on port ${PORT}`);
});
