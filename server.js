// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V5.4
// THEME: EMBEDDED LUXURY (No-Fail Background)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

const BYPASS_PAYMENT = true; 

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) {
    console.error("Firebase Auth Error:", error.message);
}
const db = admin.firestore();

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#8B0000" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#4B0082" }
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

async function sendTicketEmail(orderData, orderId) {
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎟️ Your Premium Ticket: ${orderData.eventName}`,
            htmlContent: `<p>Hi ${orderData.payerName}, your luxury experience is confirmed. <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}">Download Ticket</a></p>`
        });
    } catch (err) {
        console.error("BREVO ERROR:", err.message);
    }
}

app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;
    try {
        const orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            quantity: parseInt(quantity) || 1, eventId, eventName, status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            await sendTicketEmail(req.body, orderRef.id); 
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }
    } catch (err) {
        res.status(500).json({ success: false, debug: err.message });
    }
});

app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Ticket not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId);

        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] 
        });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID GUEST: ${data.payerName} | PAID: KES ${data.amount} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <style>
                    body { margin: 0; padding: 0; font-family: 'Times New Roman', serif; background-color: #fcfaf2; }
                    .ticket-canvas {
                        width: 190mm; height: 135mm; margin: 5mm auto;
                        border: 10px solid #D4AF37; border-radius: 30px;
                        background-color: #fff;
                        /* Subtle Floral Watermark Pattern */
                        background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M11 18c3.866 0 7-3.134 7-7s-3.134-7-7-7-7 3.134-7 7 3.134 7 7 7zm48 25c3.866 0 7-3.134 7-7s-3.134-7-7-7-7 3.134-7 7 3.134 7 7 7zm-43-7c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zm63 31c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zM34 90c1.657 0 3-1.343 3-3s-1.343-3-3-3-3 1.343-3 3 1.343 3 3 3zm56-76c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM12 86c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm66 3c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-46-45c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm54 24c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM57 6c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM45 4c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM15 30c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm60 15c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM35 36c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM25 62c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm44 5c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM9 55c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm29 34c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm54-62c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM66 80c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM31 24c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm57 41c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM24 36c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm7 51c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM67 18c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM75 80c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM48 20c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM20 73c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm40 7c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM15 87c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm65 0c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM30 61c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm57 26c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM32 16c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM82 30c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm17 40c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM80 60c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-5-17c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM28 26c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm9 19c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm40 2c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm9 42c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM25 80c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm71 6c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM37 18c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm44 33c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zM27 8c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm61 82c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-7-67c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-22 10c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-10 10c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-10 10c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2zm-10 10c1.105 0 2-.895 2-2s-.895-2-2-2-2 .895-2 2 .895 2 2 2z' fill='%23d4af37' fill-opacity='0.05' fill-rule='evenodd'/%3E%3C/svg%3E");
                        display: flex; flex-direction: column; overflow: hidden;
                    }
                    .top-logo { text-align: center; background-color: ${meta.color}; padding: 15px; }
                    .top-logo h1 { color: #D4AF37; margin: 0; font-size: 32px; letter-spacing: 5px; font-weight: 800; }
                    .content-inner { flex: 1; padding: 30px; position: relative; display: flex; flex-direction: column; justify-content: space-between; }
                    .event-header { text-align: center; border-bottom: 1px solid #D4AF37; padding-bottom: 10px; margin-bottom: 15px; }
                    .event-name { font-size: 24px; color: #333; font-weight: bold; text-transform: uppercase; }
                    .romantic-blurb { font-style: italic; color: #c2185b; font-size: 14px; text-align: center; margin: 5px 0 15px 0; line-height: 1.4; padding: 0 40px; }
                    .main-data { display: flex; justify-content: space-between; }
                    .info-column { width: 60%; }
                    .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
                    .value { font-size: 18px; color: #111; font-weight: bold; margin-bottom: 15px; border-left: 3px solid ${meta.color}; padding-left: 10px; }
                    .price-section { margin-top: 10px; padding: 10px; background-color: #fff9e6; border-radius: 10px; border: 1px dashed #D4AF37; display: inline-block; }
                    .qr-section { text-align: center; padding-top: 10px; }
                    .qr-label { font-size: 10px; font-weight: bold; color: #D4AF37; margin-top: 5px; }
                    .bottom-bar { border-top: 2px solid #D4AF37; padding: 15px 30px; font-size: 10px; color: #444; background: #fffdf5; display: flex; justify-content: space-between; align-items: flex-end; }
                    .contact-grid { line-height: 1.6; }
                </style>
            </head>
            <body>
                <div class="ticket-canvas">
                    <div class="top-logo"><h1>SARAMI EVENTS</h1></div>
                    
                    <div class="content-inner">
                        <div class="event-header">
                            <div class="event-name">${data.eventName}</div>
                            <div style="font-size: 12px; color: #D4AF37; font-weight: bold; letter-spacing: 1px;">OFFICIAL INVITATION</div>
                        </div>

                        <div class="romantic-blurb">
                            "May your love blossom and this evening be the start of a lifetime of beautiful memories together."
                        </div>

                        <div class="main-data">
                            <div class="info-column">
                                <div class="label">Esteemed Guest</div>
                                <div class="value">${data.payerName}</div>

                                <div class="label">Venue & Date</div>
                                <div class="value" style="font-size: 15px;">${meta.venue}<br>${meta.date} @ 6:30 PM</div>

                                <div class="price-section">
                                    <div class="label" style="color:#D4AF37">Total Payment Verified</div>
                                    <div style="font-size: 24px; font-weight: bold; color: ${meta.color};">KES ${data.amount.toLocaleString()}</div>
                                </div>
                            </div>

                            <div class="qr-section">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="180">
                                <div class="qr-label">SECURE SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>

                    <div class="bottom-bar">
                        <div class="contact-grid">
                            <strong>Contact:</strong> +254 708 711 624 | <strong>Web:</strong> saramievents.co.ke<br>
                            <strong>Location:</strong> Nairobi, Kenya | <strong>Email:</strong> info@saramievents.co.ke
                        </div>
                        <div style="text-align: right; color: #bbb;">Ticket ID: ${req.params.orderId}</div>
                    </div>
                </div>
            </body>
            </html>
        `, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename=Sarami_Official_Ticket.pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami Luxury V5.4 live`));
