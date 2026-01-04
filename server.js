// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V6.0
// FINAL STYLED & ALIGNED MULTI-PAGE PDF
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

const BYPASS_PAYMENT = true; 

// --- 1. FIREBASE SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) { console.error("Firebase Error:", error.message); }

const db = admin.firestore();

// --- 2. BREVO SETUP ---
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Dynamic Metadata with History
function getEventDetails(eventId, packageTier = 'BRONZE') {
    const eventMap = {
        'NAIVASHA': {
            venue: "Elsamere Resort, Naivasha",
            history: "Former home of Joy & George Adamson",
            color: "#4a0404",
            packages: { 'GOLD': "Gold Luxury", 'SILVER': "Silver Suite", 'BRONZE': "Bronze Walk-in" }
        },
        'ELDORET': {
            venue: "Marura Gardens, Eldoret",
            history: "A historic and majestic garden experience",
            color: "#5c0505",
            packages: { 'GOLD': "Gold Package", 'BRONZE': "Bronze Package" }
        },
        'NAIROBI': {
            venue: "Sagret Gardens, Nairobi",
            history: "An ambient oasis of serenity and romance",
            color: "#800000",
            packages: { 'STANDARD': "Premium Couple" }
        }
    };
    const event = eventMap[eventId] || eventMap['NAIROBI'];
    return {
        ...event,
        packageName: event.packages[packageTier] || "Standard Entry",
        date: "Feb 14, 2026",
        time: "6:30 PM - Late"
    };
}

// --- 3. UPDATED EMAIL (Vertical Footer & Removed Spam Note) ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Invitation: ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: serif; border: 2px solid #D4AF37; padding: 40px; border-radius: 20px; background: #fffdf9; max-width: 600px; margin: auto;">
                    <h1 style="color: ${meta.color}; text-align: center;">Invitation Confirmed! ❤️</h1>
                    <p style="text-align: center;">Hi <b>${orderData.payerName}</b>, your reservation for <b>${meta.packageName}</b> at ${meta.venue} is ready.</p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background: ${meta.color}; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold;">
                           DOWNLOAD PDF TICKET
                        </a>
                    </div>

                    <div style="border-top: 1px solid #D4AF37; padding-top: 20px; text-align: center; font-size: 13px; line-height: 1.6; color: #444;">
                        <b style="font-size: 15px; color: ${meta.color};">Sarami Events</b><br>
                        1st Ngong Avenue, Bishop Gardens Tower, Upperhill<br>
                        www.saramievents.co.ke | +254 104 410 892
                    </div>
                </div>`
        });
    } catch (err) { console.error("Email Error:", err.message); }
}

// --- 4. CREATE ORDER ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            await sendTicketEmail(req.body, orderRef.id); 
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) { res.status(500).json({ success: false, debug: err.message }); }
});

// --- 5. STYLED MULTI-PAGE PDF GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`GUEST: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; background: #fff; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; }
                    .border { position: absolute; inset: 10mm; border: 3px solid #D4AF37; border-radius: 25px; background: #fff; }
                    .header { background: ${meta.color}; height: 65px; border-radius: 22px 22px 0 0; display: flex; align-items: center; justify-content: center; }
                    .header h1 { color: #D4AF37; font-family: 'Playfair Display', serif; letter-spacing: 5px; margin: 0; }
                    
                    .content { padding: 30px; display: flex; flex-direction: column; height: 340px; justify-content: space-between; }
                    .venue-box { border-left: 5px solid ${meta.color}; padding-left: 15px; }
                    .name-shape { background: #fffcf0; padding: 20px; border-radius: 15px; border: 1px solid #D4AF37; margin: 15px 0; }
                    
                    .label { font-family: 'Montserrat', sans-serif; font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 5px; }
                    .val { font-family: 'Playfair Display', serif; font-size: 20px; color: #111; }
                    
                    .qr-pos { position: absolute; bottom: 30px; right: 30px; text-align: center; }
                    .footer-v { position: absolute; bottom: 20px; left: 30px; font-family: 'Montserrat'; font-size: 9px; line-height: 1.6; color: #444; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="border">
                        <div class="header"><h1>SARAMI EVENTS</h1></div>
                        <div class="content">
                            <div class="venue-box">
                                <div style="font-family: 'Playfair Display', serif; font-size: 24px;">${meta.venue}</div>
                                <div style="font-family: 'Montserrat'; font-size: 10px; color: #999; font-style: italic;">${meta.history}</div>
                                <div style="margin-top: 5px; display: inline-block; padding: 4px 12px; background: #fff9e6; border-radius: 20px; font-family: 'Montserrat'; font-size: 10px; font-weight: bold; color: ${meta.color}; border: 1px solid #D4AF37;">${meta.packageName}</div>
                            </div>
                            <div class="name-shape">
                                <div class="label">Esteemed Guest</div>
                                <div style="font-family: 'Playfair Display', serif; font-size: 30px;">${data.payerName}</div>
                            </div>
                            <div style="display: flex; gap: 40px;">
                                <div><div class="label">Date & Time</div><div class="val">${meta.date} | ${meta.time}</div></div>
                                <div><div class="label">Fee Paid</div><div class="val" style="color: ${meta.color}">KES ${data.amount.toLocaleString()}</div></div>
                            </div>
                        </div>
                        <div class="qr-pos">
                            <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="120">
                            <div class="label" style="font-weight: bold; color: #D4AF37;">SCAN ADMISSION</div>
                        </div>
                        <div class="footer-vertical">
                            <b style="color: ${meta.color}">Sarami Events</b><br>
                            Bishop Gardens Tower, Upperhill<br>
                            REF: ${req.params.orderId}
                        </div>
                    </div>
                </div>

                <div class="page">
                    <div class="border">
                        <div class="header"><h1>THE PROGRAM</h1></div>
                        <div class="content" style="justify-content: flex-start; padding-top: 40px;">
                            <div style="margin-bottom: 25px; display: flex; gap: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; width: 60px;">18:30</div>
                                <div><b style="font-family: 'Playfair Display';">Welcoming Cocktails</b><br><small style="color: #666;">Chilled glasses upon arrival.</small></div>
                            </div>
                            <div style="margin-bottom: 25px; display: flex; gap: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; width: 60px;">19:00</div>
                                <div><b style="font-family: 'Playfair Display';">Ice-Breaking & Karaoke</b><br><small style="color: #666;">Fun games and melody.</small></div>
                            </div>
                            <div style="margin-bottom: 25px; display: flex; gap: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; width: 60px;">20:00</div>
                                <div><b style="font-family: 'Playfair Display';">Grand Banquet</b><br><small style="color: #666;">A luxury 3-course romantic dinner.</small></div>
                            </div>
                            <div style="display: flex; gap: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; width: 60px;">21:30</div>
                                <div><b style="font-family: 'Playfair Display';">Celebrations</b><br><small style="color: #666;">The night continues until late.</small></div>
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

app.listen(PORT, () => console.log(`Sarami V6.0 Live`));
