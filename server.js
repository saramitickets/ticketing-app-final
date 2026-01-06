// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V7.0
// PRODUCTION: REAL M-PESA + FIRESTORE + PDF
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

// SET TO FALSE TO ENABLE REAL M-PESA PROMPTS
const BYPASS_PAYMENT = false; 

// --- FIREBASE & BREVO SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) { console.error("Firebase Error:", error.message); }

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

// --- EMAIL TICKET FUNCTION ---
async function sendTicketEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId, orderData.packageTier);
    try {
        await apiInstance.sendTransacEmail({
            sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
            to: [{ email: orderData.payerEmail, name: orderData.payerName }],
            subject: `💌 Your Official Ticket: ${orderData.eventName}`,
            htmlContent: `
                <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f4f4; padding: 20px;">
                    <tr><td align="center">
                        <table width="600" border="0" cellspacing="0" cellpadding="40" style="background-color: #fffdf9; border: 2px solid #D4AF37; border-radius: 20px; font-family: 'Georgia', serif;">
                            <tr><td align="center">
                                <h1 style="color: ${meta.color};">Invitation Confirmed! ❤️</h1>
                                <p>Hi <strong>${orderData.payerName}</strong>, your reservation for <strong>${meta.packageName}</strong> at ${meta.venue} is ready.</p>
                                <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                                   style="background-color: ${meta.color}; color: #ffffff; padding: 18px 35px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                                   DOWNLOAD PDF TICKET
                                </a>
                            </td></tr>
                        </table>
                    </td></tr>
                </table>`
        });
    } catch (err) { console.error("Email Error:", err.message); }
}

// --- PRODUCTION BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    console.log(`[BOOKING_INITIATED] - ${payerName} for ${eventName}`);

    let orderRef;
    try {
        // Step 1: Log the attempt in Firestore
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
            console.log(`[GATEWAY_ATTEMPT] - Triggering M-Pesa push for ${payerName}`);
            
            // Step 2: Login to Bank Gateway
            const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
                merchantId: "139", // YOUR MERCHANT ID
                password: "Rod@6321"
            }, { timeout: 15000 });

            const token = authRes.data.access_token;

            // Step 3: Trigger STK Push (M-Pesa Prompt)
            // Replace endpoint with your specific STK push URL from the documentation
            const stkRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/stk/push', {
                amount: amount,
                phone: payerPhone,
                reference: orderRef.id,
                description: `Sarami Ticket: ${eventName}`
            }, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            await orderRef.update({ status: 'STK_PUSH_SENT', bankRequestId: stkRes.data.requestId });
            return res.status(200).json({ success: true, message: "M-Pesa prompt sent!" });
        }
    } catch (err) {
        console.error(`[BOOKING_ERROR] - ${err.message}`);
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: err.message });
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- PDF GENERATOR (V6.4 DESIGN) ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Not found");
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID GUEST: ${data.payerName} | REF: ${req.params.orderId}`);

        await page.setContent(`
            <html>
            <head>
                <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; }
                    .bg-hearts { position: absolute; inset: 0; background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M50 80c-10-10-30-20-30-40 0-10 10-15 15-15 5 0 10 5 15 10 5-5 10-10 15-10 5 0 15 5 15 15 0 20-20 30-30 40z' fill='%23${meta.color.replace('#','')}' fill-opacity='0.05'/%3E%3C/svg%3E"); z-index: 1; }
                    .border-frame { position: absolute; inset: 10mm; border: 3px solid #D4AF37; border-radius: 25px; background: rgba(255,255,255,0.96); z-index: 2; display: flex; flex-direction: column; overflow: hidden; }
                    .header { background: ${meta.color}; height: 60px; display: flex; align-items: center; justify-content: center; }
                    .header h1 { color: #D4AF37; font-family: 'Playfair Display', serif; letter-spacing: 6px; margin: 0; font-size: 26px; }
                    .content { padding: 25px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; position: relative; }
                    .name-shape { background: #fffcf0; padding: 15px; border-radius: 15px; border: 1px solid #D4AF37; margin: 10px 0; border-left: 8px solid ${meta.color}; }
                    .price-shape { display: inline-block; padding: 10px 20px; background: ${meta.color}; color: #D4AF37; border-radius: 12px; border: 1px solid #D4AF37; }
                    .label { font-family: 'Montserrat'; font-size: 9px; color: #aaa; text-transform: uppercase; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="bg-hearts"></div>
                    <div class="border-frame">
                        <div class="header"><h1>SARAMI EVENTS</h1></div>
                        <div class="content">
                            <div>
                                <div style="font-family: 'Playfair Display'; font-size: 22px; color: ${meta.color};">${meta.venue}</div>
                                <div style="font-family: 'Montserrat'; font-size: 10px; color: #999;">${meta.history}</div>
                            </div>
                            <div class="name-shape">
                                <div class="label">Esteemed Guest</div>
                                <div style="font-family: 'Playfair Display'; font-size: 28px;">${data.payerName}</div>
                            </div>
                            <div style="display: flex; gap: 40px;">
                                <div><div class="label">Date & Time</div><div style="font-family: 'Playfair Display'; font-size: 17px;">${meta.date} | ${meta.time}</div></div>
                                <div><div class="label">Verified Payment</div><div class="price-shape"><div style="font-family: 'Playfair Display'; font-size: 20px;">KES ${data.amount.toLocaleString()}</div></div></div>
                            </div>
                            <div style="position: absolute; bottom: 25px; right: 25px; text-align: center;">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="155">
                                <div class="label" style="color: #D4AF37; margin-top: 5px;">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                </div>
            </body></html>
        `);

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { res.status(500).send(e.message); } finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => console.log(`Sarami V7.0 Production Live`));
