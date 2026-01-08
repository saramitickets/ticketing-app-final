// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V11.00
// MASTER: LUXURY ENHANCED + LOGGING + HISTORY
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
            color: "#6b0f0f", // Brighter deep red
            accent: "#D4AF37", // Gold
            packages: {
                'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000", quote: "Where time stops and love begins… forever." },
                'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000", quote: "A night where every glance feels like forever." },
                'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000", quote: "A gentle escape where love speaks softly." }
            }
        },
        'ELDORET': {
            venue: "Marura Gardens, Eldoret",
            history: "The Highland's Premier Sanctuary of Serenity",
            color: "#1a472a", // Emerald Green Luxury
            accent: "#D4AF37",
            packages: {
                'FLAME': { name: "Eternal Flame Dinner", price: "10,000", quote: "One night, one flame, one forever memory." },
                'SPARK': { name: "Sunset Spark", price: "7,000", quote: "Simple, sweet, and unforgettable." }
            }
        },
        'NAIROBI': {
            venue: "Sagret Gardens, Nairobi",
            history: "An Enchanted Garden Oasis in the Heart of the City",
            color: "#4b0082", // Royal Purple
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
    console.log(`📩 [EMAIL] Preparing to send ticket for Order: ${orderId}`);
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
                           style="background:${meta.color}; color:#fff; padding:18px 35px; text-decoration:none; border-radius:50px; font-weight:bold; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                           DOWNLOAD DIGITAL TICKET
                        </a>
                    </div>
                    <p style="font-style:italic;">"${meta.quote}"</p>
                </div>`
        });
        console.log(`✅ [EMAIL] Sent successfully to ${orderData.payerEmail}`);
    } catch (err) { console.error("❌ [EMAIL ERROR]:", err.message); }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [ORDER] New booking request received for ${payerName} (${eventId})`);
    
    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`💾 [FIRESTORE] Order created with ID: ${orderRef.id}`);

        if (BYPASS_PAYMENT) {
            console.log(`⏩ [PAYMENT] BYPASS ACTIVE: Marking Order ${orderRef.id} as PAID`);
            await orderRef.update({ status: 'PAID' });
            await sendTicketEmail(req.body, orderRef.id);
            return res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            console.log(`💳 [PAYMENT] Requesting STK Push for ${payerPhone}`);
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
            console.log(`📲 [STK] Push Sent Successfully. Payment ID: ${bankId}`);
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
    console.log(`📡 [CALLBACK] Received update for Order ${orderId}: ${status}`);

    try {
        if (orderId) {
            const orderDoc = await db.collection('orders').doc(orderId).get();
            if (orderDoc.exists) {
                const data = orderDoc.data();
                if (status === "COMPLETED" || status === "SUCCESS") {
                    if (data.status !== 'PAID') {
                        console.log(`💰 [PAYMENT] Successful! Updating Order ${orderId} and sending ticket.`);
                        await orderDoc.ref.update({ status: 'PAID', bankFinalData: req.body });
                        await sendTicketEmail(data, orderId);
                    }
                } else {
                    console.log(`⚠️ [PAYMENT] Failed or Cancelled for ${orderId}`);
                    await orderDoc.ref.update({ status: 'FAILED', errorMessage: status });
                }
            }
        }
        res.status(200).send("OK");
    } catch (err) { console.error("❌ [CALLBACK ERROR]:", err.message); res.status(500).send("Error"); }
});

// --- 6. TWO-PAGE ENHANCED PDF TICKET ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    console.log(`📄 [PDF] Generating ticket for ${req.params.orderId}`);
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
                        box-shadow: 0 0 40px rgba(0,0,0,0.05);
                    }
                    .header { 
                        background: linear-gradient(90deg, ${meta.color}, #333); 
                        height: 60px; display: flex; align-items: center; justify-content: center; 
                        color: ${meta.accent}; font-family: 'Montserrat'; font-weight: 900; letter-spacing: 8px; font-size: 24px;
                    }
                    .content { padding: 30px; flex: 1; position: relative; }
                    
                    .pricing-shape {
                        display: inline-block;
                        background: ${meta.color};
                        color: white;
                        padding: 10px 25px;
                        border-radius: 50px 5px 50px 5px;
                        font-family: 'Montserrat';
                        font-weight: 700;
                        margin-top: 10px;
                        border: 2px solid ${meta.accent};
                    }

                    .venue-title { font-family: 'Playfair Display'; font-size: 28px; color: ${meta.color}; margin-bottom: 2px; }
                    .venue-history { font-family: 'Montserrat'; font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 15px; }
                    
                    .guest-box { margin-top: 20px; border-left: 5px solid ${meta.accent}; padding-left: 20px; }
                    .label { font-family: 'Montserrat'; font-size: 9px; color: #999; text-transform: uppercase; letter-spacing: 2px; }
                    .guest-name { font-family: 'Playfair Display'; font-size: 32px; color: #222; }

                    .qr-container { position: absolute; bottom: 30px; right: 30px; text-align: center; }
                    .itinerary-item { margin-bottom: 20px; border-bottom: 1px solid #f0f0f0; padding-bottom: 10px; }
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
                            
                            <div class="guest-box">
                                <div class="label">Esteemed Guest</div>
                                <div class="guest-name">${data.payerName}</div>
                            </div>

                            <div style="display: flex; gap: 50px; margin-top: 25px;">
                                <div>
                                    <div class="label">Date</div>
                                    <div style="font-family: 'Montserrat'; font-weight:700;">${meta.date}</div>
                                </div>
                                <div>
                                    <div class="label">Package</div>
                                    <div style="font-family: 'Montserrat'; font-weight:700;">${meta.name}</div>
                                </div>
                            </div>

                            <div class="pricing-shape">
                                KES ${meta.price} <span style="font-weight: 400; font-size: 12px; margin-left: 5px;">| PAID</span>
                            </div>

                            <p style="font-style:italic; font-family:'Playfair Display'; color:${meta.color}; font-size:16px; margin-top:20px;">
                                "${meta.quote}"
                            </p>

                            <div class="qr-container">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="110">
                                <div style="color: ${meta.accent}; font-weight: bold; font-family: Montserrat; font-size: 8px; margin-top:5px;">OFFICIAL ENTRY QR</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="page">
                    <div class="bg-overlay"></div>
                    <div class="border-frame">
                        <div class="header" style="background: #222;">EVENING ITINERARY</div>
                        <div class="content">
                            <div class="itinerary-item">
                                <div style="font-weight: bold; color: ${meta.accent}; font-family: Montserrat;">18:30</div>
                                <div style="font-family: 'Playfair Display'; font-size: 18px;">Welcome & Photo Ops</div>
                                <div style="font-size:11px; color:#777;">Capture the magic at our luxury photo booths.</div>
                            </div>
                            <div class="itinerary-item">
                                <div style="font-weight: bold; color: ${meta.accent}; font-family: Montserrat;">19:15</div>
                                <div style="font-family: 'Playfair Display'; font-size: 18px;">Unveiling the Evening</div>
                                <div style="font-size:11px; color:#777;">Interactive games designed for two.</div>
                            </div>
                            <div class="itinerary-item">
                                <div style="font-weight: bold; color: ${meta.accent}; font-family: Montserrat;">20:30</div>
                                <div style="font-family: 'Playfair Display'; font-size: 18px;">Gourmet Dinner & Live Band</div>
                                <div style="font-size:11px; color:#777;">A culinary journey curated by our top chefs.</div>
                            </div>
                            
                            <div style="margin-top: 40px; text-align: center;">
                                <div style="display:inline-block; border: 1px solid ${meta.accent}; padding: 15px 40px; border-radius: 50px;">
                                    <span style="font-family: 'Playfair Display'; font-style: italic; color: ${meta.color};">
                                        "Love is the only gold."
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        console.log(`✅ [PDF] Generation complete for ${data.payerName}`);
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { 
        console.error(`❌ [PDF ERROR]: ${e.message}`);
        res.status(500).send(e.message); 
    } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V11 ULTIMATE - PORT ${PORT} - READY`));
