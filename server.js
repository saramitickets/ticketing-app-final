// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.25
// MASTER: FINAL LUXURY TICKETS + ACCURATE DATA
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
} catch (error) { console.error("Firebase Error:", error.message); }

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
            color: "#4a0404",
            packages: {
                'ETERNAL': { name: "Eternal Lakeside Embrace", price: "32,000", quote: "Where time stops and love begins… forever." },
                'MOONLIT': { name: "Moonlit Lakeside Spark", price: "18,000", quote: "A night where every glance feels like forever." },
                'SUNRISE': { name: "Sunrise Lakeside Whisper", price: "14,000", quote: "A gentle escape where love speaks softly." }
            }
        },
        'ELDORET': {
            venue: "Marura Gardens, Eldoret",
            color: "#5c0505",
            packages: {
                'FLAME': { name: "Eternal Flame Dinner", price: "10,000", quote: "One night, one flame, one forever memory." },
                'SPARK': { name: "Sunset Spark", price: "7,000", quote: "Simple, sweet, and unforgettable." }
            }
        },
        'NAIROBI': {
            venue: "Sagret Gardens, Nairobi",
            color: "#800000",
            packages: {
                'CITYGLOW': { name: "City Glow Romance", price: "9,000", quote: "City lights, your love, one perfect night." }
            }
        }
    };
    
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    const pKey = packageTier.toUpperCase();
    const pkg = event.packages[pKey] || { name: "Luxury Entry", price: "Varies", quote: "A perfect night of love." };

    return { ...event, ...pkg, date: "Feb 14, 2026" };
}

// --- 3. LUXURY EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Invitation: ${meta.name}`,
            htmlContent: `
                <div style="padding:40px; background:#fffdf9; border:2px solid #D4AF37; font-family:serif; text-align:center;">
                    <h1 style="color:${meta.color};">Invitation Confirmed! ❤️</h1>
                    <p>Dear ${orderData.payerName}, your reservation for <strong>${meta.name}</strong> at ${meta.venue} is ready.</p>
                    <p style="font-style:italic; color:#777;">"${meta.quote}"</p>
                    <div style="margin:30px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background:${meta.color}; color:#fff; padding:15px 30px; text-decoration:none; border-radius:5px; font-weight:bold;">
                           DOWNLOAD YOUR LUXURY TICKET
                        </a>
                    </div>
                </div>`
        });
    } catch (err) { console.error("Email Error:", err.message); }
}

// --- 4. MAIN BOOKING ROUTE ---
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
                promptDisplayAccount: "Sarami Events",
                callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
                ptyId: 1 
            };
            const stkRes = await axios.post(process.env.INFINITIPAY_STKPUSH_URL, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });
            const bankId = stkRes.data.results?.paymentId || "SUCCESS";
            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: bankId });
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) { res.status(500).json({ success: false, debug: err.message }); }
});

// --- 5. CALLBACK ROUTE ---
app.post('/api/payment-callback', async (req, res) => {
    const orderId = req.body.transactionReference || req.body.externalReference;
    const status = req.body.statusMessage || req.body.status;
    const resultCode = req.body.resultCode;
    try {
        if (orderId) {
            const orderDoc = await db.collection('orders').doc(orderId).get();
            if (orderDoc.exists) {
                const data = orderDoc.data();
                if (status === "COMPLETED" || status === "SUCCESS" || resultCode === 0) {
                    if (data.status !== 'PAID') {
                        await orderDoc.ref.update({ status: 'PAID', bankFinalData: req.body });
                        await sendTicketEmail(data, orderId);
                    }
                } else {
                    const failStatus = (resultCode === 1032 || status === "CANCELLED") ? 'CANCELLED' : 'FAILED';
                    await orderDoc.ref.update({ status: failStatus, errorMessage: status || "Declined." });
                }
            }
        }
        res.status(200).send("OK");
    } catch (err) { res.status(500).send("Error"); }
});

// --- 6. TWO-PAGE LUXURY PDF TICKET ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; }
                    .bg-hearts {
                        position: absolute; inset: 0;
                        background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M50 80c-10-10-30-20-30-40 0-10 10-15 15-15 5 0 10 5 15 10 5-5 10-10 15-10 5 0 15 5 15 15 0 20-20 30-30 40z' fill='%23${meta.color.replace('#','')}' fill-opacity='0.05'/%3E%3C/svg%3E");
                        z-index: 1;
                    }
                    .border-frame { position: absolute; inset: 10mm; border: 3px solid #D4AF37; border-radius: 25px; background: rgba(255,255,255,0.96); z-index: 2; display: flex; flex-direction: column; overflow: hidden; }
                    .header { background: ${meta.color}; height: 50px; display: flex; align-items: center; justify-content: center; color: #D4AF37; font-family: 'Playfair Display'; letter-spacing: 5px; font-size: 22px; }
                    .content { padding: 25px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; position: relative; }
                    .name-shape { background: #fffcf0; padding: 15px; border-radius: 12px; border-left: 6px solid ${meta.color}; margin: 10px 0; }
                    .qr-area { position: absolute; bottom: 25px; right: 25px; text-align: center; }
                    .label { font-family: 'Montserrat'; font-size: 8px; color: #aaa; text-transform: uppercase; }
                    .itinerary-item { margin-bottom: 15px; border-left: 2px solid #eee; padding-left: 15px; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="bg-hearts"></div>
                    <div class="border-frame">
                        <div class="header">SARAMI EVENTS</div>
                        <div class="content">
                            <div>
                                <div style="font-family: 'Playfair Display'; font-size: 22px; color: ${meta.color};">${meta.venue}</div>
                                <div style="font-family: 'Montserrat'; font-size: 10px; color: #999;">${meta.date} | 6:30 PM Onwards</div>
                            </div>
                            <div class="name-shape">
                                <div class="label">Esteemed Guest</div>
                                <div style="font-family: 'Playfair Display'; font-size: 26px;">${data.payerName}</div>
                            </div>
                            <div style="display: flex; gap: 40px;">
                                <div><div class="label">Package</div><div style="font-family: 'Playfair Display'; font-size: 16px;">${meta.name}</div></div>
                                <div><div class="label">Amount Paid</div><div style="font-family: 'Playfair Display'; font-size: 16px;">KES ${meta.price}</div></div>
                            </div>
                            <p style="font-style:italic; font-family:serif; color:${meta.color}; font-size:14px; margin:0;">"${meta.quote}"</p>
                            <div class="qr-area">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="120">
                                <div style="color: #D4AF37; font-weight: bold; font-family: Montserrat; font-size: 8px; margin-top:5px;">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="page">
                    <div class="bg-hearts"></div>
                    <div class="border-frame">
                        <div class="header">THE EVENING ITINERARY</div>
                        <div class="content" style="padding-top: 30px;">
                            <div class="itinerary-item">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat;">18:30</div>
                                <div style="font-family: 'Playfair Display'; font-size: 16px;">Welcoming Cocktails</div>
                                <div style="font-size:10px; color:#999;">Chilled signature cocktails upon arrival.</div>
                            </div>
                            <div class="itinerary-item">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat;">19:00</div>
                                <div style="font-family: 'Playfair Display'; font-size: 16px;">Couples Games & Karaoke</div>
                                <div style="font-size:10px; color:#999;">An hour of laughter, bonding, and melody.</div>
                            </div>
                            <div class="itinerary-item">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat;">20:00</div>
                                <div style="font-family: 'Playfair Display'; font-size: 16px;">3-Course Gourmet Banquet</div>
                                <div style="font-size:10px; color:#999;">Curated culinary excellence for two.</div>
                            </div>
                            <div style="margin-top: 20px; text-align: center; border: 1px dashed #D4AF37; padding: 15px; border-radius: 20px; background: #fffcf9;">
                                <p style="font-family: 'Playfair Display'; font-size: 14px; color: ${meta.color}; margin: 0;">"Happy Valentine's to you and yours."</p>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);
        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V10.25 Ultimate Live`));
