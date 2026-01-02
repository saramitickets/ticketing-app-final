// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V5.5
// THEME: UPPERHILL BISHOP GARDENS EDITION
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

// SET TO 'true' only for testing. Set to 'false' for real M-Pesa payments.
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

// Dynamic Metadata
function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#8B0000" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#4B0082" }
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

// --- UPDATED PROFESSIONAL EMAIL FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Ticket for ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: 'Georgia', serif; max-width: 600px; margin: auto; border: 2px solid #D4AF37; border-radius: 20px; padding: 30px; background-color: #fffdf9;">
                    <div style="text-align: center;">
                        <h1 style="color: ${meta.color}; margin-bottom: 10px;">Ticket Confirmed! ❤️</h1>
                        <p style="font-size: 18px; color: #333;">Hello <strong>${orderData.payerName}</strong>,</p>
                    </div>
                    <p style="line-height: 1.6; color: #555; text-align: center;">
                        We are delighted to confirm your reservation for <strong>${orderData.eventName}</strong>. 
                        Get ready for an evening filled with elegance, fine dining, and beautiful memories.
                    </p>
                    <div style="background-color: white; border: 1px dashed #D4AF37; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
                        <p style="margin: 0; color: #888; font-size: 12px; text-transform: uppercase;">Your Admission Ticket</p>
                        <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                           style="display: inline-block; margin-top: 15px; padding: 12px 25px; background-color: ${meta.color}; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                           DOWNLOAD PDF TICKET
                        </a>
                    </div>
                    <p style="font-style: italic; color: #c2185b; text-align: center; font-size: 14px;">
                        "May your love blossom and this evening be the start of a lifetime of beautiful memories."
                    </p>
                    <hr style="border: 0.5px solid #eee; margin: 20px 0;">
                    <div style="font-size: 11px; color: #999; text-align: center;">
                        <strong>Sarami Events Limited</strong><br>
                        Bishop Gardens Tower, Upperhill, Nairobi<br>
                        www.saramievents.co.ke | +254 104 410 892
                    </div>
                </div>`
        });
        console.log("Professional email sent successfully!");
    } catch (err) {
        console.error("BREVO ERROR:", err.message);
    }
}

// --- 4. MAIN ORDER ROUTE ---
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

// --- 5. UPDATED LUXURY PDF GENERATOR ---
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
                    body { margin: 0; padding: 0; font-family: 'Georgia', serif; }
                    .ticket-canvas {
                        width: 195mm; height: 138mm; margin: 5mm auto;
                        border: 12px solid #D4AF37; border-radius: 35px;
                        background-color: #fff;
                        background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M11 18c3.866 0 7-3.134 7-7s-3.134-7-7-7-7 3.134-7 7 3.134 7 7 7zm48 25c3.866 0 7-3.134 7-7s-3.134-7-7-7-7 3.134-7 7 3.134 7 7 7z' fill='%23d4af37' fill-opacity='0.04'/%3E%3C/svg%3E");
                        display: flex; flex-direction: column; overflow: hidden;
                    }
                    .top-banner { text-align: center; background-color: ${meta.color}; padding: 20px; }
                    .top-banner h1 { color: #D4AF37; margin: 0; font-size: 34px; letter-spacing: 6px; font-weight: bold; }
                    .content { flex: 1; padding: 35px; display: flex; flex-direction: column; justify-content: space-between; }
                    .romantic-text { font-style: italic; color: #c2185b; font-size: 15px; text-align: center; margin-bottom: 20px; }
                    .main-info { display: flex; justify-content: space-between; }
                    .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; }
                    .value { font-size: 20px; color: #111; font-weight: bold; margin-bottom: 18px; border-left: 4px solid ${meta.color}; padding-left: 12px; }
                    .price-box { padding: 12px; background-color: #fffcf0; border: 1px dashed #D4AF37; border-radius: 10px; display: inline-block; }
                    .bottom-info { border-top: 2px solid #D4AF37; padding: 20px 35px; background: #fafafa; display: flex; justify-content: space-between; align-items: center; }
                    .contact-col { font-size: 11px; line-height: 1.6; color: #444; }
                </style>
            </head>
            <body>
                <div class="ticket-canvas">
                    <div class="top-banner"><h1>SARAMI EVENTS</h1></div>
                    <div class="content">
                        <div style="text-align: center;">
                            <div style="font-size: 26px; font-weight: bold; color: #333;">${data.eventName}</div>
                            <div style="font-size: 12px; color: #D4AF37; font-weight: bold; margin-top: 5px;">OFFICIAL INVITATION</div>
                        </div>

                        <div class="romantic-text">
                            "May your love blossom and this evening be the start of a lifetime of beautiful memories."
                        </div>

                        <div class="main-info">
                            <div style="width: 55%;">
                                <div class="label">Esteemed Guest</div>
                                <div class="value">${data.payerName}</div>
                                <div class="label">Venue & Date</div>
                                <div class="value" style="font-size: 16px;">${meta.venue}<br>${meta.date} @ 6:30 PM</div>
                                <div class="price-box">
                                    <div class="label" style="color:#D4AF37">Total Verified Payment</div>
                                    <div style="font-size: 26px; font-weight: bold; color: ${meta.color};">KES ${data.amount.toLocaleString()}</div>
                                </div>
                            </div>
                            <div style="text-align: center;">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="190">
                                <div style="font-size: 10px; font-weight: bold; color: #D4AF37; margin-top: 8px;">SECURE SCAN ADMISSION</div>
                            </div>
                        </div>
                    </div>
                    <div class="bottom-info">
                        <div class="contact-col">
                            <strong>Location:</strong> Bishop Gardens Tower, 1st Ngong Avenue, Upperhill<br>
                            <strong>Contact:</strong> +254 104 410 892 | <strong>Web:</strong> www.saramievents.co.ke<br>
                            <strong>Email:</strong> info@saramievents.co.ke
                        </div>
                        <div style="font-size: 10px; color: #ccc;">Ref: ${req.params.orderId}</div>
                    </div>
                </div>
            </body>
            </html>
        `, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename=Sarami_Premium_Ticket.pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami Premium V5.5 Live`));
