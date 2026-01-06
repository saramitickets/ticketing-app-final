// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V8.8
// PRODUCTION MASTER: ASTRA PUSH + LUXURY PDF + EMAILS
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();
const admin = require('firebase-admin');

// SET TO FALSE TO TRIGGER REAL M-PESA PROMPTS
const BYPASS_PAYMENT = false; 

// --- 1. FIREBASE & BREVO SETUP ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) { 
    console.error("Firebase Initialization Error:", error.message); 
}

const db = admin.firestore();

// Brevo (Sendinblue) Setup
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- 2. LUXURY EVENT DATA & METADATA ---
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

// --- 3. EMAIL TICKET FUNCTION ---
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
        console.log(`[EMAIL_SENT] - Ticket sent to ${orderData.payerEmail}`);
    } catch (err) { 
        console.error("Email Sending Error:", err.message); 
    }
}

// --- 4. MAIN BOOKING ROUTE ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    let orderRef;
    
    try {
        // Step 1: Record the order in Firestore
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Step 2: Handle Bypass (Testing Mode)
        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            await sendTicketEmail(req.body, orderRef.id);
            return res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            // Step 3: Secure Bank Login
            console.log(`[GATEWAY_ATTEMPT] - Logging in as: ${process.env.INFINITIPAY_MERCHANT_USERNAME}`);
            
            const authRes = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
                username: process.env.INFINITIPAY_MERCHANT_USERNAME,
                password: process.env.INFINITIPAY_MERCHANT_PASSWORD
            }, { timeout: 15000 });

            const token = authRes.data.access_token;
            console.log(`[AUTH_SUCCESS] - Secure token received.`);

            // Step 4: Trigger STK Push (Astra Africa Endpoint)
            const stkUrl = process.env.INFINITIPAY_STKPUSH_URL;
            console.log(`[STK_INITIATING] - Sending request to: ${stkUrl}`);

            const stkRes = await axios.post(stkUrl, {
                amount: amount,
                phoneNumber: payerPhone,
                merchantCode: `ILM0000${process.env.INFINITIPAY_MERCHANT_ID}`,
                reference: orderRef.id,
                description: `Sarami Ticket: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            }, { 
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json' 
                } 
            });

            await orderRef.update({ 
                status: 'STK_PUSH_SENT', 
                bankRequestId: stkRes.data.requestId || "PENDING" 
            });

            return res.status(200).json({ success: true, message: "M-Pesa prompt sent to your phone!" });
        }
    } catch (err) {
        const errorDetail = err.response?.data?.message || err.message;
        console.error(`[BOOKING_ERROR] - ${errorDetail}`);
        
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: errorDetail });
        }
        res.status(500).json({ success: false, debug: errorDetail });
    }
});

// --- 5. LUXURY PDF TICKET GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    let browser;
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if(!orderDoc.exists) return res.status(404).send("Ticket record not found");
        
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId, data.packageTier);

        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'] 
        });
        const page = await browser.newPage();
        const qrContent = encodeURIComponent(`VALID_GUEST: ${data.payerName} | ORDER_ID: ${req.params.orderId}`);

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
                    .name-shape { background: #fffcf0; padding: 15px; border-radius: 12px; border-left: 6px solid ${meta.color}; margin: 10px 0; border-right: 1px solid #eee; border-bottom: 1px solid #eee; }
                    .qr-area { position: absolute; bottom: 25px; right: 25px; text-align: center; }
                    .label { font-family: 'Montserrat'; font-size: 8px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
                    .val { font-family: 'Playfair Display'; font-size: 16px; color: #333; }
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
                                <div style="font-family: 'Montserrat'; font-size: 9px; color: #999;">${meta.history}</div>
                            </div>
                            <div class="name-shape">
                                <div class="label">Esteemed Guest</div>
                                <div style="font-family: 'Playfair Display'; font-size: 28px;">${data.payerName}</div>
                            </div>
                            <div style="display: flex; gap: 40px;">
                                <div><div class="label">Date & Time</div><div class="val">${meta.date} | ${meta.time}</div></div>
                                <div><div class="label">Package Type</div><div class="val">${meta.packageName}</div></div>
                            </div>
                            <div class="qr-area">
                                <img src="https://barcode.tec-it.com/barcode.ashx?data=${qrContent}&code=QRCode" width="140">
                                <div class="label" style="color: #D4AF37; font-weight: bold; margin-top: 5px;">SCAN TO ADMIT</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="page">
                    <div class="bg-hearts"></div>
                    <div class="border-frame">
                        <div class="header">THE PROGRAM</div>
                        <div class="content" style="padding-top: 35px;">
                            <div style="margin-bottom: 25px; border-left: 2px solid #eee; padding-left: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat; font-size: 12px;">18:30</div>
                                <div style="font-family: 'Playfair Display'; font-size: 20px;">Welcoming Cocktails & Red Carpet</div>
                            </div>
                            <div style="margin-bottom: 25px; border-left: 2px solid #eee; padding-left: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat; font-size: 12px;">20:00</div>
                                <div style="font-family: 'Playfair Display'; font-size: 20px;">Grand Valentine's Banquet</div>
                            </div>
                            <div style="margin-bottom: 25px; border-left: 2px solid #eee; padding-left: 20px;">
                                <div style="font-weight: bold; color: #D4AF37; font-family: Montserrat; font-size: 12px;">22:00</div>
                                <div style="font-family: 'Playfair Display'; font-size: 20px;">Live Jazz & Romantic Serenade</div>
                            </div>
                            <div style="margin-top: 40px; text-align: center; border: 1px dashed #D4AF37; padding: 25px; border-radius: 20px; background: #fffcf9;">
                                <p style="font-family: 'Playfair Display'; font-size: 18px; color: ${meta.color}; margin: 0;">"Happy Valentine's to you and yours."</p>
                                <p style="font-family: Montserrat; font-size: 9px; color: #999; margin-top: 10px;">Please present your QR code for entry.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `);

        const pdf = await page.pdf({ width: '210mm', height: '148mm', printBackground: true });
        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) { 
        res.status(500).send("PDF Generation Error: " + e.message); 
    } finally { 
        if (browser) await browser.close(); 
    }
});

app.listen(PORT, () => console.log(`Sarami V8.8 Production Live on Port ${PORT}`));
