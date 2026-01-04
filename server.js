// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V5.7
// MULTI-PAGE PDF + HISTORIC CONTEXT
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
} catch (error) {
    console.error("Firebase Auth Error:", error.message);
}
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

// Dynamic Metadata with Historic Context
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
    const packageName = event.packages[packageTier] || "Standard Entry";

    return {
        venue: event.venue,
        history: event.history,
        color: event.color,
        packageName: packageName,
        date: "Feb 14, 2026",
        time: "6:30 PM - Late"
    };
}

// --- UPDATED EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Ticket: ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: serif; border: 2px solid #D4AF37; padding: 30px; border-radius: 15px; background: #fffdf9;">
                    <h1 style="color: ${meta.color}; text-align: center;">Invitation Confirmed! ❤️</h1>
                    <p>Hi ${orderData.payerName}, your reservation for <b>${meta.packageName}</b> at ${meta.venue} is ready.</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="background: ${meta.color}; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                           DOWNLOAD PDF TICKET
                        </a>
                    </div>
                    <p style="font-size: 11px; text-align: center; color: #777;">
                        Note: If not in your inbox, kindly check your spam folder.
                    </p>
                    <hr>
                    <p style="font-size: 11px; text-align: center;"><strong>Sarami Events</strong> | Bishop Gardens Tower, Upperhill | +254 104 410 892</p>
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

// --- 5. MULTI-PAGE PDF GENERATOR ---
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
                <style>
                    body { margin: 0; padding: 0; font-family: 'Georgia', serif; }
                    .page-break { page-break-after: always; }
                    .canvas {
                        width: 190mm; height: 138mm; margin: 5mm auto;
                        border: 10px solid #D4AF37; border-radius: 35px;
                        background: white; overflow: hidden; display: flex; flex-direction: column;
                    }
                    .banner { background: ${meta.color}; color: #D4AF37; text-align: center; padding: 15px; }
                    .banner h1 { margin: 0; font-size: 32px; letter-spacing: 5px; }
                    .content { padding: 30px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; }
                    .history { font-style: italic; color: #888; font-size: 11px; margin-bottom: 10px; }
                    .pkg { display: inline-block; padding: 5px 15px; background: #fff9e6; border: 1px solid #D4AF37; border-radius: 50px; color: ${meta.color}; font-weight: bold; font-size: 12px; }
                    .footer { border-top: 2px solid #D4AF37; padding: 15px 30px; font-size: 10px; background: #fafafa; display: flex; justify-content: space-between; }
                    
                    /* Program Styles */
                    .prog-title { font-size: 24px; color: ${meta.color}; text-align: center; border-bottom: 1px solid #D4AF37; padding-bottom: 10px; }
                    .prog-item { display: flex; margin: 15px 0; border-bottom: 1px solid #eee; padding-bottom: 5px; }
                    .prog-time { width: 80px; font-weight: bold; color: #D4AF37; }
                </style>
            </head>
            <body>
                <div class="canvas page-break">
                    <div class="banner"><h1>SARAMI EVENTS</h1></div>
                    <div class="content">
                        <div>
                            <div style="font-size: 24px; font-weight: bold; color: ${meta.color};">${meta.venue}</div>
                            <div class="history">${meta.history}</div>
                            <div class="pkg">TIER: ${meta.packageName}</div>
                        </div>
                        <div>
                            <div style="font-size: 10px; color: #999;">ESTEEMED GUEST</div>
                            <div style="font-size: 26px; font-weight: bold;">${data.payerName}</div>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: flex-end;">
                            <div>
                                <div style="font-size: 14px;"><b>Date:</b> ${meta.date}</div>
                                <div style="font-size: 14px;"><b>Time:</b> ${meta.time}</div>
                                <div style="font-size: 24px; font-weight: bold; color: ${meta.color}; margin-top: 5px;">KES ${data.amount.toLocaleString()}</div>
                            </div>
                            <div style="text-align: center;">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="140">
                                <div style="font-size: 9px; font-weight: bold; color: #D4AF37;">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                    <div class="footer">
                        <div>Bishop Gardens Tower, Upperhill | +254 104 410 892</div>
                        <div style="color: #ccc;">REF: ${req.params.orderId}</div>
                    </div>
                </div>

                <div class="canvas">
                    <div class="banner"><h1>SARAMI EVENTS</h1></div>
                    <div class="content" style="justify-content: flex-start;">
                        <h2 class="prog-title">Evening Program</h2>
                        <div class="prog-item"><div class="prog-time">18:30</div><div><b>Welcoming Cocktails</b><br><small>Arrive to chilled glasses and ambient music.</small></div></div>
                        <div class="prog-item"><div class="prog-time">19:00</div><div><b>Ice-Breaking & Games</b><br><small>Fun couples games & Karaoke to ignite the spirit.</small></div></div>
                        <div class="prog-item"><div class="prog-time">20:00</div><div><b>The 3-Course Banquet</b><br><small>A culinary journey curated for romance.</small></div></div>
                        <div class="prog-item" style="border:none;"><div class="prog-time">21:30</div><div><b>The Night Continues</b><br><small>Celebrations, music, and bonfire until late.</small></div></div>
                        
                        <div style="margin-top: 30px; text-align: center; font-style: italic; color: #c2185b;">
                            "May your love blossom and this evening be the start of a lifetime of beautiful memories."
                        </div>
                    </div>
                    <div class="footer"><div style="width:100%; text-align:center;">www.saramievents.co.ke</div></div>
                </div>
            </body>
            </html>
        `);

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V5.7 Live`));
