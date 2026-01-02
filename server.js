// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V5.2
// FIXED: Romantic Background + Multi-Venue Logic
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
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#8B0000" }, // Deep Red
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },  // Royal Blue
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#4B0082" }   // Indigo
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎟️ Your Valentine's Ticket: ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: sans-serif; padding: 20px; border: 2px solid #D4AF37; border-radius: 15px;">
                    <h1 style="color: ${meta.color};">Ticket Confirmed! ❤️</h1>
                    <p>Hi ${orderData.payerName}, your ticket for <b>${orderData.eventName}</b> is ready.</p>
                    <p><b>Download Your PDF Ticket:</b> <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}">Click Here</a></p>
                </div>`
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
        // ... Astra Logic ...
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

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID GUEST: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <style>
                    body { margin: 0; padding: 0; }
                    .ticket {
                        width: 175mm; height: 110mm; margin: 10mm auto; position: relative;
                        background: url('https://images.unsplash.com/photo-1516589174184-c6852b514b48?q=80&w=1000&auto=format&fit=crop'); /* NEW FIXED BACKGROUND */
                        background-size: cover; border-radius: 20px; border: 5px solid #D4AF37; overflow: hidden; display: flex;
                    }
                    .overlay { background: rgba(255, 255, 255, 0.88); flex: 1; margin: 15px; border-radius: 12px; padding: 25px; display: flex; flex-direction: column; justify-content: space-between; }
                    .event-title { font-size: 26px; font-weight: bold; color: ${meta.color}; text-transform: uppercase; text-align: center; font-family: 'Georgia', serif; }
                    .value { font-size: 22px; color: #222; font-weight: bold; font-family: 'Arial', sans-serif; }
                    .footer { display: flex; justify-content: space-between; align-items: flex-end; }
                </style>
            </head>
            <body>
                <div class="ticket">
                    <div class="overlay">
                        <div>
                            <div class="event-title">${data.eventName}</div>
                            <div style="text-align:center; color:#D4AF37; font-style:italic; font-size:12px;">Official Invitation</div>
                        </div>
                        <div>
                            <div style="font-size:10px; color:#888;">ESTEEMED GUEST</div>
                            <div class="value">${data.payerName}</div>
                            <div style="font-size:14px; color:#444;"><strong>Venue:</strong> ${meta.venue}<br><strong>Date:</strong> ${meta.date}</div>
                        </div>
                        <div class="footer">
                            <div style="font-size:9px; color:#ccc;">REF: ${req.params.orderId}</div>
                            <div style="text-align:center;">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="110">
                                <div style="font-size:8px; color:#D4AF37; font-weight:bold; margin-top:3px;">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename=SaramiTicket.pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V5.2 live`));
