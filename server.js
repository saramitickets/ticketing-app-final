// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V5.1
// THEME: ROMANTIC VALENTINE LUXURY
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
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#6d0505" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#4a0404" }
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

// --- EMAIL SENDING FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `🎟️ Your Valentine's Ticket: ${orderData.eventName}`,
            htmlContent: `
                <div style="font-family: sans-serif; padding: 20px; border: 2px solid #D4AF37; border-radius: 15px; background-color: #fff9f9;">
                    <h1 style="color: ${meta.color}; text-align: center;">Ticket Confirmed! ❤️</h1>
                    <p>Hi ${orderData.payerName}, your romantic getaway for <b>${orderData.eventName}</b> is confirmed.</p>
                    <p><b>Venue:</b> ${meta.venue}</p>
                    <p><b>Download Your Ticket:</b> <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}">Click Here</a></p>
                    <hr style="border: 0.5px solid #D4AF37;">
                    <p style="font-size: 11px; text-align: center;">Carry this digital ticket for entry. See you at 6:30 PM!</p>
                </div>`
        });
        console.log("Email sent successfully!");
    } catch (err) {
        console.error("BREVO ERROR:", err.response ? err.response.body : err.message);
    }
}

// --- 3. INFINITIPAY AUTH ---
let cachedToken = null;
let expiry = null;

async function getInfinitiPayToken() {
    if (cachedToken && expiry && Date.now() < expiry) return cachedToken;
    const authUrl = "https://app.astraafrica.co:9090/infinitilite/v2/users/partner/login";
    const payload = {
        client_id: process.env.INFINITIPAY_CLIENT_ID.trim(),
        client_secret: process.env.INFINITIPAY_CLIENT_SECRET.trim(),
        grant_type: 'password',
        username: process.env.INFINITIPAY_MERCHANT_USERNAME.trim(),
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD.trim()
    };
    const response = await axios.post(authUrl, payload, { timeout: 15000 });
    cachedToken = response.data.token || response.data.access_token;
    expiry = Date.now() + (3600 - 60) * 1000;
    return cachedToken;
}

// --- 4. MAIN ORDER ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;
    const qty = parseInt(quantity) || 1;
    let orderRef;

    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            quantity: qty, eventId, eventName, status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            await sendTicketEmail(req.body, orderRef.id); 
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }

        const token = await getInfinitiPayToken();
        const cleanedPhone = payerPhone.replace(/\D/g, '').replace(/^0/, '254');
        const stkPayload = {
            transactionId: orderRef.id,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: (process.env.INFINITIPAY_MERCHANT_ID || "").trim().slice(-3),
            transactionTypeId: 1,
            payerAccount: cleanedPhone,
            narration: `Sarami ${eventName}`,
            callbackURL: (process.env.YOUR_APP_CALLBACK_URL || "").trim(),
            ptyId: 1
        };

        const result = await axios.post(process.env.INFINITIPAY_STKPUSH_URL.trim(), stkPayload, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (result.data.statusCode === 200 || result.data.success) {
            await orderRef.update({ status: 'STK_SENT' });
            res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            throw new Error(result.data.message);
        }
    } catch (err) {
        if (orderRef) await orderRef.update({ status: 'FAILED', error: err.message });
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- 5. LUXURY ROMANTIC PDF GENERATOR ---
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
        const qrContent = encodeURIComponent(`VALID GUEST: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <style>
                    body { font-family: 'Georgia', serif; background-color: #fff; margin: 0; padding: 0; }
                    .ticket-wrapper {
                        width: 175mm; height: 110mm;
                        margin: 10mm auto;
                        position: relative;
                        background: url('https://images.unsplash.com/photo-1518133910546-b6c2fb7d79e3?q=80&w=1000&auto=format&fit=crop'); /* Romantic Backdrop */
                        background-size: cover;
                        background-position: center;
                        border-radius: 25px;
                        border: 6px solid #D4AF37;
                        overflow: hidden;
                        display: flex;
                        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
                    }
                    .overlay {
                        background: rgba(255, 255, 255, 0.85); /* Frosted glass effect */
                        flex: 1;
                        margin: 20px;
                        border-radius: 15px;
                        padding: 30px;
                        display: flex;
                        flex-direction: column;
                        justify-content: space-between;
                        border: 1px solid rgba(212, 175, 55, 0.3);
                    }
                    .header { text-align: center; }
                    .event-title { font-size: 28px; font-weight: bold; color: ${meta.color}; margin: 0; text-transform: uppercase; letter-spacing: 1px; }
                    .tagline { color: #D4AF37; font-size: 14px; font-style: italic; margin-top: 5px; }
                    .main-info { margin-top: 25px; }
                    .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 2px; }
                    .value { font-size: 22px; color: #222; font-weight: bold; margin-bottom: 15px; }
                    .footer-grid { display: flex; justify-content: space-between; align-items: flex-end; }
                    .qr-container { text-align: center; }
                    .qr-container img { border: 3px solid #fff; border-radius: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
                    .qr-footer { font-size: 9px; font-weight: bold; color: #D4AF37; margin-top: 5px; }
                    .venue-info { font-size: 14px; color: #444; line-height: 1.5; }
                </style>
            </head>
            <body>
                <div class="ticket-wrapper">
                    <div class="overlay">
                        <div class="header">
                            <h1 class="event-title">${data.eventName}</h1>
                            <div class="tagline">A Night of Elegance and Romance</div>
                        </div>

                        <div class="main-info">
                            <div class="label">Esteemed Guest</div>
                            <div class="value">${data.payerName}</div>
                            
                            <div class="venue-info">
                                <strong>Date:</strong> ${meta.date} at 6:30 PM<br>
                                <strong>Venue:</strong> ${meta.venue}
                            </div>
                        </div>

                        <div class="footer-grid">
                            <div style="font-size: 10px; color: #aaa;">Ref: ${req.params.orderId}</div>
                            <div class="qr-container">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="120">
                                <div class="qr-footer">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `, { waitUntil: 'networkidle0' });

        const pdf = await page.pdf({ 
            width: '210mm', height: '148mm', 
            printBackground: true
        });
        
        res.set({ 
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename=Sarami_Valentine_Ticket.pdf'
        }).send(pdf);

    } catch (e) { 
        console.error("PDF ERROR:", e.message);
        res.status(500).send("PDF Error: " + e.message); 
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => console.log(`Sarami V5.1 live on ${PORT}`));
