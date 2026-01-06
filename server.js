// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V8.4
// PRODUCTION: SECURE M-PESA + LUXURY DESIGN + DEBUG
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

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

// --- LUXURY EVENT DATA ---
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

// --- EMAIL TICKET FUNCTION (STABLE TABLE STRUCTURE) ---
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
                                <h1 style="color: ${meta.color}; margin-bottom: 20px; font-size: 28px;">Invitation Confirmed! ❤️</h1>
                                <p style="font-size: 16px; color: #333; line-height: 1.5; margin-bottom: 30px;">
                                    Hi <strong>${orderData.payerName}</strong>, your reservation for <strong>${meta.packageName}</strong> at ${meta.venue} is ready.
                                </p>
                                <div style="margin-bottom: 30px;">
                                    <a href="https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}" 
                                       style="background-color: ${meta.color}; color: #ffffff; padding: 18px 35px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                                       DOWNLOAD PDF TICKET
                                    </a>
                                </div>
                                <div style="border-top: 1px solid #D4AF37; padding-top: 25px; margin-top: 20px;">
                                    <p style="font-size: 15px; font-weight: bold; color: ${meta.color}; margin: 0;">Sarami Events</p>
                                    <p style="font-size: 13px; color: #444; margin: 5px 0;">www.saramievents.co.ke | +254 104 410 892</p>
                                </div>
                            </td></tr>
                        </table>
                    </td></tr>
                </table>`
        });
    } catch (err) { console.error("Email Error:", err.message); }
}

// --- MAIN BOOKING ROUTE WITH DEBUG LOGGER ---
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
            console.log(`[GATEWAY_ATTEMPT] - Secure login initiated...`);
            
            // 1. LOGIN TO BANK WITH DEBUG LOGGING
            const loginUrl = 'https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login';
            try {
                const authRes = await axios({
                    method: 'post',
                    url: loginUrl,
                    data: {
                        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
                        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
                    },
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 15000
                });

                const token = authRes.data.access_token;
                console.log(`[AUTH_SUCCESS] - Secure token obtained.`);

                // 2. TRIGGER STK PUSH (M-PESA PROMPT)
                const stkRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/stk/push', {
                    amount: amount,
                    phoneNumber: payerPhone,
                    merchantCode: `ILM0000${process.env.INFINITIPAY_MERCHANT_ID}`,
                    reference: orderRef.id,
                    description: `Ticket: ${eventName}`
                }, { headers: { 'Authorization': `Bearer ${token}` } });

                await orderRef.update({ 
                    status: 'STK_PUSH_SENT', 
                    bankRequestId: stkRes.data.requestId 
                });

                return res.status(200).json({ success: true, message: "M-Pesa prompt sent!" });

            } catch (gatewayErr) {
                // DETAILED DIAGNOSTICS FOR RENDER LOGS
                console.error(`[DEBUG_GATEWAY_ERROR]`);
                console.error(`- URL attempted: ${gatewayErr.config?.url}`);
                console.error(`- HTTP Status: ${gatewayErr.response?.status}`);
                console.error(`- Response Data:`, JSON.stringify(gatewayErr.response?.data));
                throw gatewayErr; // Pass to main catch
            }
        }
    } catch (err) {
        const errorDetail = err.response?.data?.message || err.message;
        console.error(`[BOOKING_ERROR] - ${errorDetail}`);
        if (orderRef) await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

// --- PDF GENERATOR (STRICTLY LUXURY V6.4 DESIGN) ---
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
                    body { margin: 0; padding: 0; }
                    .page { width: 210mm; height: 148mm; position: relative; overflow: hidden; page-break-after: always; }
                    .bg-hearts {
                        position: absolute; inset: 0;
                        background-image: url("data:image/svg+xml,%3Csvg width='100' height='100' viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M50 80c-10-10-30-20-30-40 0-10 10-15 15-15 5 0 10 5 15 10 5-5 10-10 15-10 5 0 15 5 15 15 0 20-20 30-30 40z' fill='%23${meta.color.replace('#','')}' fill-opacity='0.05'/%3E%3C/svg%3E");
                        z-index: 1;
                    }
                    .border-frame { position: absolute; inset: 10mm; border: 3px solid #D4AF37; border-radius: 25px; background: rgba(255,255,255,0.96); z-index: 2; display: flex; flex-direction: column; }
                    .header { background: ${meta.color}; height: 50px; display: flex; align-items: center; justify-content: center; color: #D4AF37; font-family: 'Playfair Display'; letter-spacing: 5px; }
                    .content { padding: 20px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; position: relative; }
                    .name-shape { background: #fffcf0; padding: 12px; border-radius: 10px; border-left: 6px solid ${meta.color}; margin: 10px 0; }
                    .qr-area { position: absolute; bottom: 20px; right: 20px; text-align: center; }
                    .label { font-family: 'Montserrat'; font-size: 8px; color: #aaa; text-transform: uppercase; }
                </style>
            </head>
            <body>
                <div class="page">
                    <div class="bg-hearts"></div>
                    <div class="border-frame">
                        <div class="header">SARAMI EVENTS</div>
                        <div class="content">
                            <div>
                                <div style="font-family: 'Playfair Display'; font-size: 20px; color: ${meta.color};">${meta.venue}</div>
                                <div style="font-family: 'Montserrat'; font-size: 9px; color: #999;">${meta.history}</div>
                            </div>
                            <div class="name-shape">
                                <div class="label">Esteemed Guest</div>
                                <div style="font-family: 'Playfair Display'; font-size: 24px;">${data.payerName}</div>
                            </div>
                            <div style="display: flex; gap: 30px;">
                                <div><div class="label">Date & Time</div><div style="font-family: 'Playfair Display'; font-size: 15px;">${meta.date} | ${meta.time}</div></div>
                                <div><div class="label">Package</div><div style="font-family: 'Playfair Display'; font-size: 15px;">${meta.packageName}</div></div>
                            </div>
                            <div class="qr-area">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="130">
                                <div class="label" style="color: #D4AF37; font-weight: bold;">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="page">
                    <div class="bg-hearts"></div>
                    <div class="border-frame">
                        <div class="header">THE PROGRAM</div>
                        <div class="content" style="padding-top: 30px;">
                            <div style="margin-bottom: 15px; border-left: 2px solid #eee; padding-left: 10px;">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat;">18:30</div>
                                <div style="font-family: 'Playfair Display';">Welcoming Cocktails</div>
                            </div>
                            <div style="margin-bottom: 15px; border-left: 2px solid #eee; padding-left: 10px;">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat;">20:00</div>
                                <div style="font-family: 'Playfair Display';">Grand Valentine's Banquet</div>
                            </div>
                            <div style="margin-top: 30px; text-align: center; border: 1px dashed #D4AF37; padding: 15px; border-radius: 15px; background: #fffcf9;">
                                <p style="font-family: 'Playfair Display'; color: ${meta.color}; margin: 0;">"Happy Valentine's to you and yours."</p>
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

app.listen(PORT, () => console.log(`Sarami V8.4 Production Live`));
