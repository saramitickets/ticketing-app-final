// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V5.9
// STYLED SHAPES + ALIGNED MULTI-PAGE PDF
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

const BYPASS_PAYMENT = true; 

// --- FIREBASE & BREVO SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) { console.error("Firebase Auth Error:", error.message); }

const db = admin.firestore();
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

// Historic Venue Metadata
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

// --- UPDATED EMAIL (Vertical Footer) ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Ticket: ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: 'Times New Roman', serif; border: 2px solid #D4AF37; padding: 40px; border-radius: 20px; background: #fffdf9; max-width: 600px; margin: auto;">
                    <h1 style="color: ${meta.color}; text-align: center; font-size: 28px;">Invitation Confirmed! ❤️</h1>
                    <p style="text-align: center; font-size: 16px;">Hi <b>${orderData.payerName}</b>, your reservation for <b>${meta.packageName}</b> at ${meta.venue} is secured.</p>
                    
                    <div style="text-align: center; margin: 40px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background: ${meta.color}; color: white; padding: 18px 35px; text-decoration: none; border-radius: 8px; font-weight: bold; font-family: Arial, sans-serif; letter-spacing: 1px;">
                           DOWNLOAD PDF TICKET
                        </a>
                    </div>

                    <div style="border-top: 1px solid #D4AF37; padding-top: 20px; text-align: center; font-family: Arial, sans-serif; font-size: 12px; color: #444; line-height: 1.8;">
                        <strong style="font-size: 14px; color: ${meta.color};">Sarami Events</strong><br>
                        1st Ngong Avenue, Bishop Gardens Tower, Upperhill<br>
                        www.saramievents.co.ke | +254 104 410 892
                    </div>
                </div>`
        });
    } catch (err) { console.error("Email Error:", err.message); }
}

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

// --- STYLED SHAPES PDF GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID GUEST: ${data.payerName} | PKG: ${meta.packageName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; background-color: #f4f4f4; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; background: white; page-break-after: always; }
                    .ticket-border {
                        position: absolute; top: 10mm; left: 10mm; right: 10mm; bottom: 10mm;
                        border: 2px solid #D4AF37; border-radius: 20px; background: white;
                        box-shadow: 0 0 20px rgba(0,0,0,0.05);
                    }
                    .header-pill {
                        background: ${meta.color}; width: 100%; height: 60px;
                        border-top-left-radius: 18px; border-top-right-radius: 18px;
                        display: flex; align-items: center; justify-content: center;
                    }
                    .header-pill h1 { color: #D4AF37; font-family: 'Playfair Display', serif; margin: 0; letter-spacing: 4px; font-size: 28px; }
                    
                    .body-content { padding: 25px; display: flex; flex-direction: column; height: 350px; justify-content: space-between; }
                    
                    /* Luxury Information Shapes */
                    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                    .shape-box {
                        background: #fffcf0; border-left: 5px solid ${meta.color};
                        padding: 15px; border-radius: 10px; position: relative;
                    }
                    .label { font-family: 'Montserrat', sans-serif; font-size: 9px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
                    .value { font-family: 'Playfair Display', serif; font-size: 18px; color: #111; }

                    .name-shape {
                        background: linear-gradient(to right, #fff9e6, #fff);
                        padding: 20px; border-radius: 15px; border: 1px solid #D4AF37; margin: 15px 0;
                    }
                    .qr-container { position: absolute; bottom: 25px; right: 25px; text-align: center; }
                    .footer-vertical {
                        position: absolute; bottom: 15px; left: 25px;
                        font-family: 'Montserrat', sans-serif; font-size: 9px; line-height: 1.6; color: #666;
                    }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="ticket-border">
                        <div class="header-pill"><h1>SARAMI EVENTS</h1></div>
                        <div class="body-content">
                            <div>
                                <div style="font-family: 'Playfair Display', serif; font-size: 22px; color: ${meta.color};">${meta.venue}</div>
                                <div style="font-family: 'Montserrat', sans-serif; font-size: 10px; font-style: italic; color: #999; margin-top: 3px;">${meta.history}</div>
                            </div>

                            <div class="name-shape">
                                <div class="label">Esteemed Guest</div>
                                <div style="font-family: 'Playfair Display', serif; font-size: 28px; color: #000;">${data.payerName}</div>
                            </div>

                            <div class="info-grid">
                                <div class="shape-box">
                                    <div class="label">Date & Time</div>
                                    <div class="value">${meta.date} | ${meta.time}</div>
                                </div>
                                <div class="shape-box">
                                    <div class="label">Experience Tier</div>
                                    <div class="value" style="color: ${meta.color}">${meta.packageName}</div>
                                </div>
                            </div>

                            <div style="margin-top: 20px;">
                                <div class="label" style="color: #D4AF37">Total Payment Verified</div>
                                <div style="font-family: 'Playfair Display', serif; font-size: 32px; color: ${meta.color};">KES ${data.amount.toLocaleString()}</div>
                            </div>
                        </div>

                        <div class="qr-container">
                            <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="120">
                            <div class="label" style="margin-top: 5px; font-weight: bold; color: #D4AF37;">SCAN ADMISSION</div>
                        </div>

                        <div class="footer-vertical">
                            <strong>Sarami Events</strong><br>
                            Bishop Gardens Tower, Upperhill<br>
                            REF: ${req.params.orderId}
                        </div>
                    </div>
                </div>

                <div class="page" style="page-break-after: auto;">
                    <div class="ticket-border">
                        <div class="header-pill"><h1>THE PROGRAM</h1></div>
                        <div class="body-content" style="justify-content: flex-start; padding: 40px;">
                            <div style="margin-bottom: 25px; display: flex; align-items: flex-start;">
                                <div style="width: 70px; font-weight: bold; color: #D4AF37; font-family: 'Montserrat';">18:30</div>
                                <div style="flex: 1; border-left: 1px solid #eee; padding-left: 15px;">
                                    <b style="font-family: 'Playfair Display'; font-size: 18px;">Welcoming Cocktails</b><br>
                                    <span style="font-size: 12px; color: #666;">Chilled glasses & ambient music upon arrival.</span>
                                </div>
                            </div>
                            <div style="margin-bottom: 25px; display: flex; align-items: flex-start;">
                                <div style="width: 70px; font-weight: bold; color: #D4AF37; font-family: 'Montserrat';">19:00</div>
                                <div style="flex: 1; border-left: 1px solid #eee; padding-left: 15px;">
                                    <b style="font-family: 'Playfair Display'; font-size: 18px;">Ice-Breaking & Games</b><br>
                                    <span style="font-size: 12px; color: #666;">Couples karaoke & bonding sessions.</span>
                                </div>
                            </div>
                            <div style="margin-bottom: 25px; display: flex; align-items: flex-start;">
                                <div style="width: 70px; font-weight: bold; color: #D4AF37; font-family: 'Montserrat';">20:00</div>
                                <div style="flex: 1; border-left: 1px solid #eee; padding-left: 15px;">
                                    <b style="font-family: 'Playfair Display'; font-size: 18px;">Grand Banquet</b><br>
                                    <span style="font-size: 12px; color: #666;">A luxury 3-course romantic dinner experience.</span>
                                </div>
                            </div>
                            <div style="display: flex; align-items: flex-start;">
                                <div style="width: 70px; font-weight: bold; color: #D4AF37; font-family: 'Montserrat';">21:30</div>
                                <div style="flex: 1; border-left: 1px solid #eee; padding-left: 15px;">
                                    <b style="font-family: 'Playfair Display'; font-size: 18px;">Celebrations</b><br>
                                    <span style="font-size: 12px; color: #666;">The night continues until late.</span>
                                </div>
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

app.listen(PORT, () => console.log(`Sarami V5.9 Styled Live`));
