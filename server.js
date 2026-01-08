// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V11.1
// MASTER: EXACT ITINERARY + LARGE QR + LOGS
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

const BYPASS_PAYMENT = true; 

// --- 1. FIREBASE & BREVO SETUP ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ [SYSTEM] Firebase Initialized Successfully");
} catch (error) { console.error("❌ Firebase Error:", error.message); }

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 2. HELPERS & ACCURATE LUXURY DATA ---
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
                'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000", quote: "Where time stops and love begins… forever." },
                'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000", quote: "A night where every glance feels like forever." },
                'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000", quote: "A gentle escape where love speaks softly." }
            }
        },
        'ELDORET': {
            venue: "Marura Gardens, Eldoret",
            history: "The Highland's Premier Sanctuary of Serenity",
            color: "#1a472a", 
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

// --- 3. LUXURY EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    console.log(`📩 [LOG] Step 3: Preparing email for Order: ${orderId}`);
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎫 Your VIP Invitation: ${meta.name}`,
            htmlContent: `
                <div style="padding:40px; background:#fafafa; border:4px solid ${meta.accent}; font-family:serif; text-align:center;">
                    <h1 style="color:${meta.color}; text-transform:uppercase;">Reservation Confirmed</h1>
                    <p style="font-size:18px;">Dear ${orderData.payerName}, your seat at <strong>${meta.venue}</strong> is reserved.</p>
                    <p style="color:#666;">${meta.history}</p>
                    <div style="margin:40px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background:${meta.color}; color:#fff; padding:18px 35px; text-decoration:none; border-radius:50px; font-weight:bold;">
                           DOWNLOAD DIGITAL TICKET
                        </a>
                    </div>
                </div>`
        });
        console.log(`✅ [LOG] Step 4: Email sent to ${orderData.payerEmail}`);
    } catch (err) { console.error("❌ [EMAIL ERROR]:", err.message); }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] Step 1: Initiating booking for ${payerName}`);
    
    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`💾 [LOG] Step 2: Firestore Doc Created: ${orderRef.id}`);

        if (BYPASS_PAYMENT) {
            console.log(`⏩ [LOG] Payment Bypass: Marking Order ${orderRef.id} as PAID`);
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
                promptDisplayAccount: "Sarami Events",
                callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
                ptyId: 1 
            };
            const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });
            const bankId = stkRes.data.results?.paymentId || "SUCCESS";
            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: bankId });
            console.log(`📲 [LOG] STK Push Triggered for ${payerPhone}`);
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) { 
        console.error(`❌ [ORDER ERROR]: ${err.message}`);
        res.status(500).json({ success: false, debug: err.message }); 
    }
});

// --- 5. CALLBACK ROUTE ---
app.post('/api/payment-callback', async (req, res) => {
    const orderId = req.body.transactionReference || req.body.externalReference;
    const status = req.body.statusMessage || req.body.status;
    console.log(`📡 [LOG] Callback received for ${orderId}: ${status}`);

    try {
        if (orderId) {
            const orderDoc = await db.collection('orders').doc(orderId).get();
            if (orderDoc.exists) {
                const data = orderDoc.data();
                if (status === "COMPLETED" || status === "SUCCESS") {
                    if (data.status !== 'PAID') {
                        console.log(`💰 [LOG] Payment Confirmed. Finalizing Order.`);
                        await orderDoc.ref.update({ status: 'PAID', bankFinalData: req.body });
                        await sendTicketEmail(data, orderId);
                    }
                }
            }
        }
        res.status(200).send("OK");
    } catch (err) { res.status(500).send("Error"); }
});

// --- 6. TWO-PAGE ENHANCED PDF TICKET ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    console.log(`📄 [LOG] Step 5: Generating PDF for ${req.params.orderId}`);
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=Montserrat:wght@400;700;900&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; background: #fff; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; }
                    .bg-overlay {
                        position: absolute; inset: 0;
                        background: radial-gradient(circle at top right, ${meta.color}0A, transparent),
                                    radial-gradient(circle at bottom left, ${meta.color}0A, transparent);
                        z-index: 1;
                    }
                    .border-frame { 
                        position: absolute; inset: 8mm; 
                        border: 2px solid ${meta.accent}; 
                        background: white; z-index: 2; 
                        display: flex; flex-direction: column; 
                    }
                    .header { 
                        background: linear-gradient(90deg, ${meta.color}, #333); 
                        height: 60px; display: flex; align-items: center; justify-content: center; 
                        color: ${meta.accent}; font-family: 'Montserrat'; font-weight: 900; letter-spacing: 8px; font-size: 24px;
                    }
                    .content { padding: 30px; flex: 1; position: relative; }
                    
                    .pricing-shape {
                        display: inline-block; background: ${meta.color}; color: white;
                        padding: 10px 25px; border-radius: 50px 5px 50px 5px;
                        font-family: 'Montserrat'; font-weight: 700; margin-top: 10px; border: 2px solid ${meta.accent};
                    }

                    .venue-title { font-family: 'Playfair Display'; font-size: 28px; color: ${meta.color}; margin-bottom: 2px; }
                    .venue-history { font-family: 'Montserrat'; font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 15px; }
                    .guest-name { font-family: 'Playfair Display'; font-size: 32px; color: #222; }

                    /* LARGE QR CODE STYLING */
                    .qr-container { position: absolute; bottom: 20px; right: 20px; text-align: center; }
                    .qr-img { width: 145px; height: 145px; border: 1px solid #eee; padding: 5px; }

                    .itinerary-item { margin-bottom: 25px; display: flex; align-items: flex-start; }
                    .itinerary-time { font-family: 'Montserrat'; font-weight: 900; font-size: 18px; width: 80px; color: #222; }
                    .itinerary-info { flex: 1; border-left: 2px solid #eee; padding-left: 20px; }
                    .itinerary-title { font-family: 'Montserrat'; font-weight: 700; font-size: 18px; color: #222; }
                    .itinerary-desc { font-family: 'Montserrat'; font-size: 12px; color: #666; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="bg-overlay"></div>
                    <div class="border-frame">
                        <div class="header">SARAMI EVENTS</div>
                        <div class="content">
                            <div class="venue-title">${meta.venue}</div>
                            <div class="venue-history">${meta.history}</div>
                            <div style="margin-top: 20px;">
                                <div style="font-size: 9px; text-transform: uppercase; letter-spacing: 2px; color: #999;">Esteemed Guest</div>
                                <div class="guest-name">${data.payerName}</div>
                            </div>
                            <div style="display: flex; gap: 50px; margin-top: 20px;">
                                <div><div style="font-size: 9px; color: #999;">DATE</div><div style="font-family: 'Montserrat'; font-weight:700;">${meta.date}</div></div>
                                <div><div style="font-size: 9px; color: #999;">PACKAGE</div><div style="font-family: 'Montserrat'; font-weight:700;">${meta.name}</div></div>
                            </div>
                            <div class="pricing-shape">KES ${meta.price} | PAID</div>
                            <p style="font-style:italic; font-family:'Playfair Display'; color:${meta.color}; font-size:16px; margin-top:20px;">"${meta.quote}"</p>
                            <div class="qr-container">
                                <img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode">
                                <div style="color: ${meta.accent}; font-weight: bold; font-family: Montserrat; font-size: 8px; margin-top:5px;">OFFICIAL ENTRY QR</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="page">
                    <div class="bg-overlay"></div>
                    <div class="border-frame">
                        <div class="header" style="background: #111;">THE EVENING ITINERARY</div>
                        <div class="content" style="padding-top: 40px;">
                            <div class="itinerary-item">
                                <div class="itinerary-time">18:30</div>
                                <div class="itinerary-info">
                                    <div class="itinerary-title">Welcoming Cocktails</div>
                                    <div class="itinerary-desc">Chilled signature cocktails upon arrival.</div>
                                </div>
                            </div>
                            <div class="itinerary-item">
                                <div class="itinerary-time">19:00</div>
                                <div class="itinerary-info" style="border-left: 2px solid ${meta.accent};">
                                    <div class="itinerary-title" style="color:${meta.accent};">Couples Games & Karaoke</div>
                                    <div class="itinerary-desc">An hour of laughter, bonding, and melody.</div>
                                </div>
                            </div>
                            <div class="itinerary-item">
                                <div class="itinerary-time">20:00</div>
                                <div class="itinerary-info">
                                    <div class="itinerary-title">3-Course Gourmet Banquet</div>
                                    <div class="itinerary-desc">Curated culinary excellence for two.</div>
                                </div>
                            </div>
                            <div style="margin-top: 30px; text-align: center; font-family: 'Playfair Display'; font-style: italic; color: ${meta.color}; border-top: 1px solid #f0f0f0; padding-top: 20px;">
                                "Happy Valentine's to you and yours."
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        console.log(`✅ [LOG] Step 6: PDF Sent to Guest.`);
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V11.1 - PORT ${PORT} - READY`));
