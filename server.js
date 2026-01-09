// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V15.5
// UPDATED: Fixed "Merchant ID Not Found" by cleaning raw body strings
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

        if (PAYMENT_BYPASS_MODE) {
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await sendTicketEmail(req.body, orderRef.id);
            return res.status(200).json({ success: true, orderId: orderRef.id });
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
        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. CALLBACK ROUTE (ULTRA-ROBUST) ---
app.post('/api/payment-callback', express.raw({ type: '*/*' }), async (req, res) => {
    console.log("📥 [LOG] Callback received from Payment Gateway");

    let rawBody = req.body.toString('utf8').trim();
    console.log("📥 [LOG] Raw body received:", rawBody);

    let payload = {};

    try {
        // CLEANING LOGIC: InfinitiPay sometimes sends JSON with a trailing ":" or ":\"\""
        // If it starts with { and doesn't end with }, we clip it.
        if (rawBody.startsWith('{')) {
            const lastBrace = rawBody.lastIndexOf('}');
            if (lastBrace !== -1) {
                rawBody = rawBody.substring(0, lastBrace + 1);
            }
            payload = JSON.parse(rawBody);
        } else {
            // Standard Form-Encoded
            const params = new URLSearchParams(rawBody);
            for (const [key, value] of params) {
                try { payload[key] = JSON.parse(value); } 
                catch { payload[key] = value; }
            }
        }
    } catch (err) {
        console.error("❌ [LOG] Parsing failed:", err.message);
        return res.sendStatus(200); // Stop retry
    }

    // Extraction with deep fallback
    const results = payload.results || payload.Result || payload; 
    const mReqId = results.merchantTxnId || results.MerchantRequestID || results.merchantTxId || payload.merchantTxnId;
    const statusCode = payload.statusCode !== undefined ? payload.statusCode : results.statusCode;
    const message = payload.message || results.message || "No message";

    if (!mReqId) {
        console.error("❌ [LOG] CALLBACK ERROR: Merchant ID still missing from payload:", JSON.stringify(payload));
        return res.sendStatus(200);
    }

    console.log(`🔍 [LOG] Processed Ref: ${mReqId} | Status: ${statusCode}`);

    try {
        const querySnapshot = await db.collection('orders')
            .where('merchantRequestID', '==', mReqId)
            .limit(1).get();

        if (querySnapshot.empty) {
            console.error(`⚠️ [LOG] No order found for ${mReqId}`);
            return res.sendStatus(200);
        }

        const orderDoc = querySnapshot.docs[0];
        const orderRef = db.collection('orders').doc(orderDoc.id);
        const isSuccess = (statusCode == 0 || statusCode == "0" || statusCode == 200 || statusCode == "200");

        if (isSuccess) {
            console.log("💰 [LOG] SUCCESS");
            await orderRef.update({ status: 'PAID', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            await sendTicketEmail(orderDoc.data(), orderDoc.id);
        } else {
            console.log(`🛑 [LOG] FAILED: ${message}`);
            await orderRef.update({ status: 'CANCELLED', cancelReason: message, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
    } catch (e) {
        console.error("❌ [LOG] DB Error:", e.message);
    }

    res.sendStatus(200);
});

// --- 6. PDF GENERATION ---
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
            <body style="background:${meta.bg}; color:white; font-family:sans-serif; text-align:center; padding:50px;">
                <h1 style="color:${meta.accent}">${meta.venue}</h1>
                <hr style="border-color:${meta.accent}">
                <h2>${data.payerName}</h2>
                <p>${meta.name}</p>
                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" style="width:150px; background:white; padding:10px;">
                <p>REF: ${req.params.orderId}</p>
            </body>
            </html>`);
        
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) {
        res.status(500).send(e.message);
    } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V15.5 - ONLINE`));
