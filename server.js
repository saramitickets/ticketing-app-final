// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V11.5
// MASTER: FINAL LUXURY DESIGN + EXACT ITINERARY
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
    console.log(`📩 [LOG] Step 3: Dispatching Confirmation Email for Order: ${orderId}`);
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
                    <div style="margin:40px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background:${meta.color}; color:#fff; padding:18px 35px; text-decoration:none; border-radius:50px; font-weight:bold; text-transform:uppercase;">
                           Download Your Luxury Ticket
                        </a>
                    </div>
                </div>`
        });
        console.log(`✅ [LOG] Step 4: Email successfully delivered to ${orderData.payerEmail}`);
    } catch (err) { console.error("❌ [EMAIL ERROR]:", err.message); }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`🚀 [LOG] Step 1: Processing new booking for ${payerName} - Package: ${packageTier}`);
    
    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`💾 [LOG] Step 2: Firestore Document Created [ID: ${orderRef.id}]`);

        if (BYPASS_PAYMENT) {
            console.log(`⏩ [LOG] BYPASS ACTIVE: Instantly confirming order ${orderRef.id}`);
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
            await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });
            console.log(`📲 [LOG] Payment Request Sent to ${payerPhone}`);
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) { 
        console.error(`❌ [ORDER ERROR]: ${err.message}`);
        res.status(500).json({ success: false, debug: err.message }); 
    }
});

// --- 5. PDF TICKET GENERATION ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    console.log(`📄 [LOG] Step 5: Rendering Ticket PDF for Order ${req.params.orderId}`);
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
                    body { margin: 0; padding: 0; background: #000; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; background: #0b0b0b; }
                    
                    .border-frame { 
                        position: absolute; inset: 10mm; 
                        border: 2px solid ${meta.accent}; 
                        background: #0f0f0f; z-index: 2; 
                        display: flex; flex-direction: column; 
                        border-radius: 20px;
                    }

                    .header { 
                        height: 65px; display: flex; align-items: center; justify-content: center; 
                        color: ${meta.accent}; font-family: 'Playfair Display'; font-style: italic; font-size: 28px;
                        border-bottom: 1px solid rgba(212, 175, 55, 0.3);
                        margin: 0 40px;
                    }

                    .content { padding: 35px 50px; flex: 1; position: relative; color: white; }
                    
                    .time-label { font-family: 'Montserrat'; font-weight: 700; font-size: 20px; color: white; width: 100px; }
                    .info-block { flex: 1; border-left: 2px solid #333; padding-left: 25px; margin-bottom: 30px; }
                    .itinerary-title { font-family: 'Montserrat'; font-weight: 700; font-size: 22px; color: white; margin-bottom: 5px; }
                    .itinerary-desc { font-family: 'Montserrat'; font-size: 14px; color: #999; }

                    .venue-title { font-family: 'Playfair Display'; font-size: 32px; color: ${meta.accent}; margin-bottom: 5px; }
                    .guest-name { font-family: 'Playfair Display'; font-size: 38px; color: white; margin: 10px 0; }

                    .pricing-badge {
                        display: inline-block; padding: 12px 30px; border-radius: 50px;
                        background: ${meta.color}; border: 1px solid ${meta.accent};
                        font-family: 'Montserrat'; font-weight: 700; font-size: 18px;
                    }

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
                            <div style="font-family: 'Montserrat'; color: #888; text-transform: uppercase; font-size: 11px; letter-spacing: 2px;">${meta.history}</div>
                            
                            <div style="margin-top: 30px;">
                                <div style="font-family: 'Montserrat'; color: #666; font-size: 10px; text-transform: uppercase;">Esteemed Guest</div>
                                <div class="guest-name">${data.payerName}</div>
                            </div>

                            <div style="display: flex; gap: 60px; margin-top: 20px;">
                                <div><div style="font-size: 10px; color: #666;">DATE</div><div style="font-family: 'Montserrat'; font-weight:700;">${meta.date}</div></div>
                                <div><div style="font-size: 10px; color: #666;">PACKAGE</div><div style="font-family: 'Montserrat'; font-weight:700;">${meta.name}</div></div>
                            </div>

                            <div style="margin-top: 30px;" class="pricing-badge">KES ${meta.price} | PAID</div>

                            <div class="qr-container">
                                <img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode">
                                <div style="color: ${meta.accent}; font-weight: bold; font-family: Montserrat; font-size: 9px; margin-top: 8px;">SCAN FOR ENTRY</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="page">
                    <div class="border-frame">
                        <div class="header">The Evening Itinerary</div>
                        <div class="content" style="padding-top: 50px;">
                            
                            <div style="display: flex; align-items: flex-start;">
                                <div class="time-label">18:30</div>
                                <div class="info-block">
                                    <div class="itinerary-title">Welcoming Cocktails</div>
                                    <div class="itinerary-desc">Chilled signature cocktails upon arrival.</div>
                                </div>
                            </div>

                            <div style="display: flex; align-items: flex-start;">
                                <div class="time-label">19:00</div>
                                <div class="info-block" style="border-left-color: ${meta.accent};">
                                    <div class="itinerary-title" style="color: ${meta.accent};">Couples Games & Karaoke</div>
                                    <div class="itinerary-desc">An hour of laughter, bonding, and melody.</div>
                                </div>
                            </div>

                            <div style="display: flex; align-items: flex-start;">
                                <div class="time-label">20:00</div>
                                <div class="info-block">
                                    <div class="itinerary-title">3-Course Gourmet Banquet</div>
                                    <div class="itinerary-desc">Curated culinary excellence for two.</div>
                                </div>
                            </div>

                            <div style="text-align: center; margin-top: 20px; font-family: 'Playfair Display'; font-style: italic; color: ${meta.accent}; font-size: 18px;">
                                "Happy Valentine's to you and yours."
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        console.log(`✅ [LOG] Step 6: PDF generated and sent to browser.`);
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`🚀 SARAMI V11.5 - ONLINE`));
