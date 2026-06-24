// ==========================================
// SARAMI EVENTS - PRODUCTION BACKEND
// MULTI-EVENT GATEWAY
// FEATURES: Dynamic Event Routing, M-Pesa STK, VIP E-Tickets, Live Stats, QR Check-In, Manual Overrides, Maintenance Mode, Photo Capture
// ==========================================
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

// ─── MAINTENANCE MODE TOGGLE ───
// Reads from Render Environment Variables. If set to 'true', bookings are halted.
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';

// Initialize Firebase
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("✅ Firebase Initialized");
} catch (error) {
    console.error("❌ Firebase init failed:", error);
}

// Initialize Brevo (Email)
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

// ─── EVENT CONFIGURATION DICTIONARY ───
const EVENT_CONFIGS = {
    'DG_BANQUET_2026': {
        title: "DISTRICT GOVERNOR'S BANQUET 2026",
        emailSubject: "🎫 Your VIP Pass: District Governor's Banquet",
        venue: "Lions Service Centre, Loresho • July 18th, 2026 at 6:30 PM",
        primaryColor: "#00338D", // Lions Blue
        accentColor: "#F2A900",  // Lions Gold
        bgGradient: "linear-gradient(135deg, #001f5b, #00338D)",
        buttonGradient: "linear-gradient(135deg, #F2A900, #d97706)",
        ticketHeader: "SARAMI"
    },
    'DANCE_2_EDUCATE_2026': {
        title: "DANCE 2 EDUCATE - CHARITY EVENT",
        emailSubject: "🪩 Your Ticket: Dance 2 Educate",
        venue: "Carnivore Grounds, Simba Saloon",
        primaryColor: "#4F46E5", // Indigo 600
        accentColor: "#EC4899",  // Pink 500
        bgGradient: "linear-gradient(135deg, #312e81, #4F46E5)",
        buttonGradient: "linear-gradient(135deg, #EC4899, #be185d)",
        ticketHeader: "SARAMI TICKETS"
    }
};

// Failsafe helper function
function getEventConfig(eventId) {
    return EVENT_CONFIGS[eventId] || EVENT_CONFIGS['DG_BANQUET_2026'];
}

// ─── Middleware ───
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/plain' })); 

app.use((req, res, next) => {
  if (req.method === 'POST') {
      if (typeof req.body === 'string') {
          try { req.body = JSON.parse(req.body.trim()); } catch (e) { }
      }
  }
  next();
});

// Helpers
function formatPhone(phone) {
    let p = (phone || '').replace(/\D/g, '');
    if (!p) return '';
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (!p.startsWith('254')) p = '254' + p;
    return p;
}

async function getAuthToken() {
    try {
        const res = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        }, { timeout: 10000 });
        return res.data.access_token;
    } catch (err) {
        throw err;
    }
}

// ─── STUNNING E-TICKET EMAIL FUNCTION ───
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        console.log(`[EMAIL] Generating Ticket for ${orderData.payerEmail}`);

        const config = getEventConfig(orderData.eventId);

        const qrPayload = JSON.stringify({
            ticketID: orderId,
            name: orderData.payerName,
            tier: orderData.packageTier,
            qty: orderData.quantity,
            status: "PAID"
        });
        
        const qrColor = config.primaryColor.replace('#', ''); 
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrPayload)}&color=${qrColor}`;
        const downloadLink = `https://ticketing-app-final.onrender.com/api/ticket/${orderId}`;

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = config.emailSubject; 
        
        sendSmtpEmail.htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="margin: 0; padding: 0; background-color: #050a15; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #050a15; padding: 40px 20px;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.15); max-width: 600px; width: 100%;">
                            
                            <tr>
                                <td style="background: ${config.bgGradient}; padding: 40px 20px; text-align: center; border-bottom: 5px solid ${config.accentColor};">
                                    <h1 style="color: #ffffff; margin: 0; font-size: 28px; letter-spacing: 4px; text-transform: uppercase; font-weight: 900;">${config.ticketHeader}</h1>
                                    <p style="color: ${config.accentColor}; margin: 5px 0 0 0; font-size: 11px; font-weight: bold; letter-spacing: 3px;">${config.title}</p>
                                </td>
                            </tr>
                            
                            <tr>
                                <td align="center" style="padding: 40px 30px 20px 30px;">
                                    <h2 style="color: ${config.primaryColor}; margin-top: 0; font-size: 24px;">Payment Confirmed!</h2>
                                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">Hello <strong>${orderData.payerName}</strong>, your ticket is officially secured.</p>
                                    
                                    <a href="${downloadLink}" style="display: inline-block; background: ${config.buttonGradient}; color: #ffffff; font-size: 18px; font-weight: bold; text-decoration: none; padding: 18px 40px; border-radius: 50px; text-transform: uppercase; letter-spacing: 2px; box-shadow: 0 10px 20px rgba(0,0,0,0.2);">
                                        ⬇ Download E-Ticket
                                    </a>
                                    <p style="font-size: 12px; color: #94a3b8; margin-top: 15px;">Click above to save your ticket to your device.</p>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding: 20px 40px 40px 40px;">
                                    <div style="border: 2px dashed #cbd5e1; border-radius: 16px; padding: 30px; text-align: center; background-color: #f8fafc;">
                                        <p style="margin: 0 0 20px 0; font-size: 14px; font-weight: bold; color: ${config.primaryColor}; text-transform: uppercase; letter-spacing: 2px;">Ticket Preview</p>
                                        
                                        <img src="${qrImageUrl}" width="180" height="180" alt="Your QR Code" style="display: block; margin: 0 auto; border-radius: 8px;">
                                        
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 25px; text-align: left;">
                                            <tr>
                                                <td style="padding-bottom: 10px;">
                                                    <p style="margin: 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Ticket Type</p>
                                                    <p style="margin: 2px 0 0 0; font-size: 16px; color: #0f172a; font-weight: bold;">${orderData.packageTier}</p>
                                                </td>
                                                <td align="right" style="padding-bottom: 10px;">
                                                    <p style="margin: 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Admit</p>
                                                    <p style="margin: 2px 0 0 0; font-size: 16px; color: #0f172a; font-weight: bold;">${orderData.quantity} Guest(s)</p>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td>
                                                    <p style="margin: 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Amount</p>
                                                    <p style="margin: 2px 0 0 0; font-size: 16px; color: #16a34a; font-weight: bold;">KES ${orderData.amount.toLocaleString()}</p>
                                                </td>
                                                <td align="right">
                                                    <p style="margin: 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Venue</p>
                                                    <p style="margin: 2px 0 0 0; font-size: 12px; color: #0f172a; font-weight: bold;">${config.venue.split('•')[0]}</p>
                                                </td>
                                            </tr>
                                        </table>
                                    </div>
                                </td>
                            </tr>
                            
                            <tr>
                                <td style="background-color: #f1f5f9; padding: 25px 20px; text-align: center; border-top: 1px solid #e2e8f0;">
                                    <p style="color: #64748b; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Sarami Events. All rights reserved.</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        `;
        
        sendSmtpEmail.sender = { "name": "Sarami Events", "email": "etickets@saramievents.co.ke" }; 
        sendSmtpEmail.replyTo = { "email": "etickets@saramievents.co.ke", "name": "Sarami Events Support" };
        sendSmtpEmail.to = [{ "email": orderData.payerEmail, "name": orderData.payerName }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`[EMAIL] Ticket successfully sent to ${orderData.payerEmail}`);

        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[EMAIL FAIL]', err.response?.text || err.message);
        await orderRef.update({ emailStatus: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
}

// ─── WEB TICKET DOWNLOAD ENDPOINT ───
app.get('/api/ticket/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).send('<h1>Ticket Not Found</h1>');
        
        const orderData = doc.data();
        
        if (orderData.status !== 'PAID') {
            return res.status(403).send('<h1>Payment for this ticket is pending or failed.</h1>');
        }

        const config = getEventConfig(orderData.eventId);
        const qrColor = config.primaryColor.replace('#', ''); 

        const qrPayload = JSON.stringify({
            ticketID: req.params.orderId,
            name: orderData.payerName,
            tier: orderData.packageTier,
            qty: orderData.quantity
        });
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrPayload)}&color=${qrColor}`;

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>E-Ticket - ${orderData.payerName}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;900&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Montserrat', sans-serif; background-color: #f1f5f9; }
                .print-btn { display: block; }
                @media print {
                    .print-btn { display: none !important; }
                    body { background-color: white; }
                    .ticket-container { box-shadow: none !important; }
                }
            </style>
        </head>
        <body class="flex flex-col items-center justify-center min-h-screen p-4">
            
            <div class="mb-6 print-btn">
                <button onclick="window.print()" class="text-white font-bold uppercase tracking-widest px-8 py-4 rounded-full shadow-xl hover:scale-105 transition transform" style="background: ${config.buttonGradient}">
                    <svg class="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    Save as PDF / Print
                </button>
            </div>

            <div class="ticket-container bg-white w-full max-w-md rounded-3xl overflow-hidden shadow-2xl border border-gray-200">
                <div class="p-8 text-center border-b-8" style="background-color: ${config.primaryColor}; border-color: ${config.accentColor};">
                    <h1 class="text-3xl font-black text-white tracking-widest uppercase">${config.ticketHeader}</h1>
                    <p class="text-xs font-bold tracking-[0.2em] mt-1" style="color: ${config.accentColor};">${config.title}</p>
                </div>
                
                <div class="p-8 text-center" style="background-color: ${config.primaryColor}15;">
                    <img src="${qrImageUrl}" alt="QR Code" class="w-48 h-48 mx-auto rounded-xl shadow-sm border-4 border-white">
                    <p class="mt-4 text-xs font-mono text-gray-500 tracking-widest">ID: ${req.params.orderId.substring(0,10).toUpperCase()}</p>
                </div>

                <div class="p-8 bg-white">
                    <div class="grid grid-cols-2 gap-y-6 gap-x-4 text-left">
                        <div>
                            <p class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Admit To</p>
                            <p class="text-lg font-bold text-gray-900">${orderData.payerName}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Ticket Tier</p>
                            <p class="text-lg font-bold" style="color: ${config.primaryColor};">${orderData.packageTier}</p>
                        </div>
                        <div>
                            <p class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Guests</p>
                            <p class="text-lg font-bold text-gray-900">${orderData.quantity}</p>
                        </div>
                        <div class="text-right">
                            <p class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Dietary/Notes</p>
                            <p class="text-lg font-bold text-gray-900">${orderData.dietaryPreference || 'N/A'}</p>
                        </div>
                        <div class="col-span-2 border-t border-gray-100 pt-4 mt-2">
                            <p class="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Venue & Info</p>
                            <p class="text-md font-bold text-gray-900">${config.venue}</p>
                        </div>
                    </div>
                </div>
            </div>
            
        </body>
        </html>
        `;
        res.send(html);
    } catch (e) {
        res.status(500).send('Error loading ticket.');
    }
});

// ─── CREATE ORDER ───
app.post('/api/create-order', async (req, res) => {

    // --- NEW: MAINTENANCE MODE CHECK ---
    if (MAINTENANCE_MODE) {
        console.log("[MAINTENANCE] Blocked new order attempt.");
        return res.status(503).json({ 
            success: false, 
            error: 'MAINTENANCE_MODE_ACTIVE' 
        });
    }

    const { payerName, payerEmail, payerPhone, amount, eventName, quantity, packageTier, dietaryPreference, clubName, eventId } = req.body || {};

    if (!payerName || !payerEmail || !payerPhone || !amount) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let orderRef;
    try {
        orderRef = await db.collection('orders').add({
            payerName,
            payerEmail,
            payerPhone,
            amount: Number(amount),
            quantity: Number(quantity) || 1,
            packageTier: packageTier || 'LIONS',
            dietaryPreference: dietaryPreference || 'None',
            clubName: clubName || 'N/A', 
            eventName: eventName || "District Governor's Banquet 2026",
            eventId: eventId || 'DG_BANQUET_2026', 
            status: 'INITIATED',
            emailStatus: 'PENDING',
            attended: false, // For Check-In system
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const token = await getAuthToken();
        const merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;
        const formattedPhone = formatPhone(payerPhone);

        const payload = {
            transactionId: merchantTxId,
            transactionReference: orderRef.id,
            amount: Number(amount),
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: formattedPhone,
            narration: `Event: ${payerName}`, 
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1,
            promptDisplayAccount: "Sarami Events" 
        };

        const stkRes = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL,
            payload,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );

        await orderRef.update({
            merchantRequestID: merchantTxId,
            status: 'STK_SENT',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true, orderId: orderRef.id });
    } catch (err) {
        console.error('[CREATE-ORDER ERROR]', err.message);
        const errMsg = err.response?.data || err.message || 'Unknown error';
        if (orderRef) {
            await orderRef.update({
                status: 'FAILED',
                reason: errMsg,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});
        }
        res.status(500).json({ success: false, error: errMsg });
    }
});

// ─── MANUAL TICKET CREATION (NO STK PUSH) ───
app.post('/api/manual-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, quantity, packageTier, dietaryPreference, clubName, eventId, eventName } = req.body;

    if (!payerName || !payerEmail) {
        return res.status(400).json({ success: false, error: 'Name and Email are required' });
    }

    try {
        const orderData = {
            payerName,
            payerEmail,
            payerPhone: payerPhone || 'N/A',
            amount: Number(amount) || 0,
            quantity: Number(quantity) || 1,
            packageTier: packageTier || 'LIONS',
            dietaryPreference: dietaryPreference || 'None',
            clubName: clubName || 'N/A',
            eventName: eventName || "District Governor's Banquet 2026",
            eventId: eventId || 'DG_BANQUET_2026',
            status: 'PAID', // Instantly marked as paid!
            paymentMethod: 'MANUAL_ENTRY', // Tag for your accounting
            emailStatus: 'PENDING',
            attended: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const orderRef = await db.collection('orders').add(orderData);

        // Instantly trigger the VIP E-Ticket delivery
        await sendConfirmationEmail(orderData, orderRef.id, orderRef);

        res.status(200).json({ success: true, orderId: orderRef.id, message: 'Ticket created and emailed successfully!' });
    } catch (err) {
        console.error('[MANUAL ORDER ERROR]', err.message);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ─── CALLBACK ───
app.post('/api/payment-callback', async (req, res) => {
    let data = req.body || {};
    if (data.Body?.stkCallback) data = data.Body.stkCallback; 
    const resultsObj = data.results || {}; 

    try {
        let orderDoc = null;
        let ref = null;

        const docId = data.transactionReference || data.reference || resultsObj.transactionReference;
        if (docId && typeof docId === 'string') {
            const docSnap = await db.collection('orders').doc(docId).get();
            if (docSnap.exists) {
                orderDoc = docSnap.data();
                ref = docSnap.ref;
            }
        }

        if (!ref) {
            const possibleIds = [
                resultsObj.merchantTxnId, 
                data.merchantRequestId, data.MerchantRequestID, data.merchantRequestID,
                data.checkoutRequestId, data.CheckoutRequestID,
                data.transactionId, data.TransactionId, resultsObj.transactionId
            ];
            
            const mReqId = possibleIds.find(id => id && typeof id === 'string' && id.trim());
            
            if (mReqId) {
                const snap = await db.collection('orders').where('merchantRequestID', '==', mReqId).limit(1).get();
                if (!snap.empty) {
                    ref = snap.docs[0].ref;
                    orderDoc = snap.docs[0].data();
                }
            }
        }

        if (!ref) {
            console.error('[CALLBACK] Order not found.');
            return res.status(200).send('OK');
        }

        const resultCode = data.statusCode ?? data.ResultCode ?? data.resultCode;
        const statusStr = (data.status || data.Status || '').toUpperCase();
        
        const isSuccess = [0, '0', 200, '200'].includes(resultCode) || ['SUCCESS', 'COMPLETED', 'PAID'].includes(statusStr);
        const reason = data.message || data.ResultDesc || data.resultDesc || data.ResultDescription || 'No reason provided';
        
        let receipt = 'N/A';
        if (resultsObj.mnoRef && resultsObj.mnoRef !== "0") receipt = resultsObj.mnoRef;
        else if (data.MpesaReceiptNumber) receipt = data.MpesaReceiptNumber;
        else if (data.receiptNumber) receipt = data.receiptNumber;

        await ref.update({
            status: isSuccess ? 'PAID' : 'FAILED', 
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            reason: reason,
            mpesaReceipt: receipt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rawCallback: data,
            resultCode: resultCode || statusStr || -1
        });

        if (isSuccess) {
            sendConfirmationEmail(orderDoc, ref.id, ref).catch(console.error);
        }

    } catch (e) {
        console.error('[DB UPDATE ERROR]', e.message);
    }

    res.status(200).send('OK');
});

// ─── SCANNER CHECK-IN API ENDPOINT ───
app.post('/api/check-in', async (req, res) => {
    const { ticketId } = req.body;
    
    if (!ticketId) return res.status(400).json({ success: false, message: "No Ticket ID provided" });

    try {
        const orderRef = db.collection('orders').doc(ticketId);
        const doc = await orderRef.get();
        
        if (!doc.exists) return res.json({ success: false, message: "Invalid Ticket: Ticket not found." });
        
        const data = doc.data();
        
        if (data.status !== 'PAID') {
            return res.json({ success: false, message: `Ticket Unpaid. Current Status: ${data.status}` });
        }

        if (data.attended) {
            return res.json({ success: false, message: "Ticket Already Used!" });
        }
        
        await orderRef.update({ 
            attended: true, 
            checkInTime: admin.firestore.FieldValue.serverTimestamp() 
        });
        
        res.json({ success: true, name: data.payerName, tier: data.packageTier, qty: data.quantity });
    } catch (e) {
        console.error("[SCANNER ERROR]", e);
        res.status(500).json({ success: false, message: "System Error communicating with database." });
    }
});

// ─── MANUAL ATTENDANCE TOGGLE ───
app.post('/api/toggle-attendance/:id', async (req, res) => {
    try {
        const docId = req.params.id;
        const docRef = db.collection('orders').doc(docId);
        const docSnap = await docRef.get();
        
        if (!docSnap.exists) return res.status(404).json({ success: false, message: "Order not found" });
        
        const data = docSnap.data();
        const newStatus = !data.attended; // Flip the status
        
        await docRef.update({ 
            attended: newStatus,
            checkInTime: newStatus ? admin.firestore.FieldValue.serverTimestamp() : null
        });
        
        res.json({ success: true, attended: newStatus });
    } catch (e) {
        console.error("[TOGGLE ERROR]", e);
        res.status(500).json({ success: false, message: "Server error toggling status." });
    }
});

// ─── WEB SCANNER UI PAGE ENDPOINT ───
app.get('/scanner', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sarami Events | VIP Kiosk</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/html5-qrcode" type="text/javascript"></script>
        <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800;900&family=Montserrat:wght@300;400;500;700;900&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.6.0/css/all.min.css" />
        <style>
            body { font-family: 'Montserrat', sans-serif; overflow: hidden; background-color: #050a15; color: white; }
            .font-cinzel { font-family: 'Cinzel', serif; }
            .kiosk-view { position: absolute; top: 0; left: 0; width: 100vw; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.4s ease, transform 0.4s ease; transform: scale(0.95); z-index: 10; }
            .kiosk-view.active { opacity: 1; pointer-events: auto; transform: scale(1); z-index: 20; }
            .bg-navy-gold { background: radial-gradient(ellipse at center, #00205B 0%, #050a15 100%); }
            .bg-emerald-luxury { background: radial-gradient(ellipse at center, #059669 0%, #064e3b 100%); }
            .bg-crimson-error { background: radial-gradient(ellipse at center, #e11d48 0%, #4c0519 100%); }
            #reader { border: none !important; border-radius: 1.5rem; overflow: hidden; width: 100%; max-width: 500px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
            #reader__scan_region { background-color: white; }
            #reader__dashboard { padding: 1.5rem; background-color: #0f172a; color: white; border-top: 3px solid #D4AF37; }
            #reader button { background-color: #D4AF37; color: #00205B; padding: 0.75rem 1.5rem; border-radius: 999px; font-weight: 800; text-transform: uppercase; letter-spacing: 2px; transition: all 0.3s; margin: 0.5rem; }
            .gold-text { background: linear-gradient(to bottom, #FDE047, #D4AF37, #A16207); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            ::-webkit-scrollbar { display: none; }
            /* OVERRIDE: Force the video feed to stop mirroring */
#reader video {
    transform: none !important;
    -webkit-transform: none !important;
}
        </style>
    </head>
    <body>
        <div id="view-welcome" class="kiosk-view bg-navy-gold active p-6 text-center">
            <div class="mb-12">
                <h3 class="text-[#D4AF37] font-bold tracking-[0.4em] text-sm uppercase mb-4 opacity-90">Sarami Events Presents</h3>
                <h1 class="text-4xl md:text-6xl lg:text-7xl font-cinzel font-black tracking-widest text-white uppercase leading-[1.2] drop-shadow-2xl">
                    The Banquet<br><span class="text-2xl md:text-4xl tracking-widest font-medium opacity-90">in honour of the</span><br><span class="gold-text">District Governor</span>
                </h1>
            </div>
            <div class="flex flex-col items-center gap-6">
                <button onclick="startScanning()" class="group relative px-12 py-5 bg-transparent overflow-hidden rounded-full border-2 border-[#D4AF37] hover:bg-[#D4AF37] transition-all duration-500 shadow-[0_0_40px_rgba(212,175,55,0.2)] hover:shadow-[0_0_60px_rgba(212,175,55,0.6)]">
                    <span class="relative z-10 text-[#D4AF37] group-hover:text-[#00205B] font-black uppercase tracking-[0.2em] text-lg flex items-center gap-3 transition-colors duration-500"><i class="fa-solid fa-qrcode text-2xl"></i> Tap Here to Scan</span>
                </button>
                <button onclick="openManualSearch()" class="text-slate-400 hover:text-white uppercase tracking-widest text-sm font-bold flex items-center gap-2 transition-colors border-b border-transparent hover:border-white pb-1"><i class="fa-solid fa-keyboard"></i> Manual Guest Search</button>
            </div>
            <p class="absolute bottom-8 text-[#D4AF37]/50 font-mono text-[10px] uppercase tracking-widest">VIP Door Access Kiosk • Live Sync</p>
        </div>

        <div id="view-scanner" class="kiosk-view bg-black p-4">
            <div class="absolute top-8 text-center w-full z-20"><h2 class="text-white font-cinzel font-bold text-2xl tracking-widest uppercase mb-1">Please Present Ticket</h2><p class="text-slate-400 font-mono text-xs uppercase tracking-widest">Hold QR code steady in frame</p></div>
            <div class="relative z-10 w-full max-w-md mx-auto"><div id="reader"></div></div>
            <button onclick="cancelToHome()" class="absolute bottom-10 px-8 py-3 bg-white/10 hover:bg-white/20 border border-white/30 rounded-full text-white font-bold uppercase tracking-widest text-sm backdrop-blur-md transition-all"><i class="fa-solid fa-arrow-left mr-2"></i> Cancel / Back</button>
        </div>

        <div id="view-manual" class="kiosk-view bg-[#050a15] p-6 flex flex-col items-center justify-start pt-16">
            <div class="w-full max-w-2xl text-center mb-8"><h2 class="text-2xl md:text-3xl font-cinzel font-bold text-[#D4AF37] tracking-widest uppercase mb-6">Guest Roster</h2><div class="relative"><i class="fa-solid fa-search absolute left-6 top-1/2 -translate-y-1/2 text-slate-400 text-xl"></i><input type="text" id="search-input" onkeyup="filterGuests()" placeholder="Search by Name, Phone, or ID..." class="w-full bg-[#0f172a] text-white text-lg md:text-xl rounded-full py-4 pl-16 pr-6 border-2 border-slate-700 focus:border-[#D4AF37] focus:outline-none transition-colors shadow-xl"></div></div>
            <div id="search-results" class="w-full max-w-2xl flex-1 overflow-y-auto space-y-3 pb-24 w-full"><div class="text-center text-slate-500 mt-10"><i class="fa-solid fa-circle-notch fa-spin text-3xl mb-4"></i><br>Syncing Live Guest List...</div></div>
            <button onclick="cancelToHome()" class="absolute bottom-10 px-8 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-full text-white font-bold uppercase tracking-widest text-sm transition-all shadow-xl"><i class="fa-solid fa-arrow-left mr-2"></i> Cancel / Back</button>
        </div>

        <div id="view-result" class="kiosk-view p-6 text-center"><div id="result-content" class="max-w-3xl mx-auto w-full"></div></div>

        <script>
            const API_BASE_URL = window.location.origin; 
            let html5QrcodeScanner = null; 
            let isProcessing = false; 
            let resetTimer = null; 
            let liveGuestList = [];
            let capturedImage = null; // Variable to hold the snapped photo

            function switchView(viewId) { 
                document.querySelectorAll('.kiosk-view').forEach(v => v.classList.remove('active')); 
                document.getElementById(viewId).classList.add('active'); 
            }
            
            function cancelToHome() { 
                if (html5QrcodeScanner) html5QrcodeScanner.pause(true); 
                document.getElementById('search-input').value = ''; 
                capturedImage = null; // Clear the photo
                switchView('view-welcome'); 
            }

            // ─── NEW: SNAP THE PHOTO ───
            function capturePhoto() {
                try {
                    // Find the hidden video feed the scanner is using
                    const video = document.querySelector('#reader video');
                    if (!video) return null;
                    
                    // Create a temporary digital canvas to paint the picture
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    const ctx = canvas.getContext('2d');
                    
                    // Draw the current video frame onto the canvas
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    
                    // Convert to a base64 image URL
                    return canvas.toDataURL('image/jpeg', 0.8);
                } catch (e) {
                    console.error("Photo capture failed", e);
                    return null;
                }
            }

            function startScanning() { 
                switchView('view-scanner'); 
                isProcessing = false; 
                if (!html5QrcodeScanner) { 
                    html5QrcodeScanner = new Html5QrcodeScanner("reader", { 
                        fps: 15, 
                        qrbox: { width: 250, height: 250 }, 
                        aspectRatio: 1.0,
                        disableFlip: true, 
                        supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA]
                    }, false); 
                    html5QrcodeScanner.render(onScanSuccess, () => {}); 
                } else { 
                    html5QrcodeScanner.resume(); 
                } 
            }
            
            function onScanSuccess(decodedText) { 
                if (isProcessing) return; 
                isProcessing = true; 
                
                // SNAP THE PHOTO THE MILLISECOND THE QR IS READ
                capturedImage = capturePhoto(); 
                
                html5QrcodeScanner.pause(true); 
                try { 
                    const qrData = JSON.parse(decodedText); 
                    processTicket(qrData.ticketID || decodedText); 
                } catch (e) { 
                    processTicket(decodedText); 
                } 
            }

            async function openManualSearch() { 
                switchView('view-manual'); 
                document.getElementById('search-input').value = ''; 
                document.getElementById('search-results').innerHTML = \`<div class="text-center text-slate-500 mt-10"><i class="fa-solid fa-circle-notch fa-spin text-3xl mb-4"></i><br>Syncing Database...</div>\`; 
                try { 
                    const response = await fetch(\`\${API_BASE_URL}/api/live-stats\`); 
                    const data = await response.json(); 
                    if (data.success) { 
                        liveGuestList = data.allOrders.filter(order => order.status === 'paid'); 
                        filterGuests(); 
                    } 
                } catch (error) { 
                    document.getElementById('search-results').innerHTML = \`<div class="text-center text-rose-500 mt-10"><i class="fa-solid fa-wifi text-3xl mb-4"></i><br>Connection Failed.</div>\`; 
                } 
            }
            
            function filterGuests() { 
                const query = document.getElementById('search-input').value.toLowerCase(); 
                const resultsBox = document.getElementById('search-results'); 
                const filtered = liveGuestList.filter(g => (g.name || '').toLowerCase().includes(query) || (g.phone || '').includes(query) || (g.id || '').toLowerCase().includes(query)); 
                if (filtered.length === 0) { resultsBox.innerHTML = \`<div class="text-center text-slate-500 mt-10">No matching guests found.</div>\`; return; } 
                resultsBox.innerHTML = filtered.map(g => { 
                    const isCheckedIn = g.attended; 
                    const btnHtml = isCheckedIn ? \`<button disabled class="bg-slate-800 text-slate-400 px-6 py-3 rounded-xl font-bold uppercase tracking-wider text-xs border border-slate-700 cursor-not-allowed"><i class="fa-solid fa-check mr-2"></i> Inside</button>\` : \`<button onclick="processTicket('\${g.id}')" class="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-3 rounded-xl font-bold uppercase tracking-wider text-xs shadow-lg transition-transform hover:scale-105 active:scale-95"><i class="fa-solid fa-door-open mr-2"></i> Check In</button>\`; 
                    return \`<div class="bg-[#0f172a] border border-slate-700 rounded-2xl p-4 flex flex-col md:flex-row justify-between items-center gap-4 hover:border-slate-500 transition-colors"><div class="text-center md:text-left w-full md:w-auto"><h3 class="text-white font-bold text-lg">\${g.name}</h3><div class="text-slate-400 text-xs font-mono mt-1">\${g.phone} <span class="mx-2">|</span> \${g.tier} (Qty: \${g.qty})</div></div><div class="w-full md:w-auto flex justify-center">\${btnHtml}</div></div>\`; 
                }).join(''); 
            }

            async function processTicket(ticketId) { 
                const resultView = document.getElementById('view-result'); 
                const contentBox = document.getElementById('result-content'); 
                switchView('view-result'); 
                resultView.className = "kiosk-view bg-[#0f172a] active"; 
                contentBox.innerHTML = \`<i class="fa-solid fa-circle-notch fa-spin text-6xl text-[#D4AF37] mb-8 drop-shadow-lg"></i><h2 class="text-3xl font-cinzel font-bold tracking-widest text-white uppercase">Verifying VIP Access...</h2>\`; 
                
                try { 
                    const response = await fetch(\`\${API_BASE_URL}/api/check-in\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketId }) }); 
                    const data = await response.json(); 
                    
                    if (data.success) { 
                        resultView.className = "kiosk-view bg-emerald-luxury active"; 
                        
                        // ─── NEW: DISPLAY THE PHOTO OR FALLBACK TO CHECKMARK ───
                        const visualHtml = capturedImage 
                            ? \`<img src="\${capturedImage}" class="w-32 h-32 md:w-40 md:h-40 object-cover rounded-full mx-auto mb-6 border-4 border-[#D4AF37] shadow-[0_0_40px_rgba(212,175,55,0.5)]">\`
                            : \`<i class="fa-solid fa-check-circle text-7xl text-emerald-300 mb-6 drop-shadow-lg"></i>\`;

                        contentBox.innerHTML = \`<div class="scale-110">
                            \${visualHtml}
                            <h3 class="text-emerald-100 font-bold tracking-[0.4em] text-lg uppercase mb-4">Thank You</h3>
                            <h1 class="text-4xl md:text-6xl font-cinzel font-black tracking-wider text-white uppercase leading-tight drop-shadow-2xl mb-4">\${data.name}</h1>
                            <div class="inline-block px-8 py-2 bg-white/10 backdrop-blur-md rounded-full border border-white/30 font-black tracking-widest uppercase text-lg shadow-inner mb-8">\${data.tier} TIER <span class="opacity-50 mx-2">|</span> ADMIT \${data.qty}</div>
                            <h2 class="text-2xl md:text-3xl font-cinzel font-bold text-[#D4AF37] tracking-widest drop-shadow-md">Enjoy Your Evening</h2>
                        </div>\`; 
                        
                        try { new Audio('https://www.soundjay.com/buttons/sounds/button-09.mp3').play(); } catch(e){} 
                        
                        // Increased delay to 5.5 seconds so they can see their photo!
                        autoReset(5500); 
                    } else { 
                        resultView.className = "kiosk-view bg-crimson-error active"; 
                        contentBox.innerHTML = \`<div class="scale-110"><i class="fa-solid fa-triangle-exclamation text-7xl text-rose-300 mb-6 drop-shadow-lg"></i><h1 class="text-5xl md:text-6xl font-cinzel font-black tracking-wider text-white uppercase drop-shadow-2xl mb-6">Access Denied</h1><div class="inline-block px-8 py-4 bg-black/40 backdrop-blur-md rounded-2xl border border-rose-500/50 font-bold text-rose-100 text-xl tracking-wide max-w-xl">\${data.message}</div><div class="mt-12"><button onclick="cancelToHome()" class="px-10 py-4 bg-white text-rose-900 rounded-full font-black uppercase tracking-widest shadow-xl hover:scale-105 transition-transform">Return to Home</button></div></div>\`; 
                        try { new Audio('https://www.soundjay.com/buttons/sounds/button-10.mp3').play(); } catch(e){} 
                        autoReset(8000); 
                    } 
                } catch (err) { 
                    resultView.className = "kiosk-view bg-[#b45309] active"; 
                    contentBox.innerHTML = \`<i class="fa-solid fa-wifi text-7xl text-white mb-6"></i><h1 class="text-4xl font-cinzel font-black tracking-wider text-white uppercase drop-shadow-2xl mb-6">Network Error</h1><p class="text-xl text-orange-100 mb-10">Unable to reach the secure database. Please check your internet connection.</p><button onclick="cancelToHome()" class="px-10 py-4 bg-white text-orange-900 rounded-full font-black uppercase tracking-widest shadow-xl">Return to Home</button>\`; 
                    autoReset(8000); 
                } 
            }
            
            function autoReset(delayMs) { 
                if (resetTimer) clearTimeout(resetTimer); 
                resetTimer = setTimeout(() => { cancelToHome(); }, delayMs); 
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// ─── COMPREHENSIVE LIVE STATS ENDPOINT ───
app.get('/api/live-stats', async (req, res) => {
    try {
        const snapshot = await db.collection('orders').get();
        
        let totalTickets = 0;
        let totalRevenue = 0;
        let lionsCount = 0;
        let leosCount = 0;
        let allOrders = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const qty = Number(data.quantity) || 1;
            
            if (data.status === 'PAID') {
                totalTickets += qty;
                totalRevenue += Number(data.amount) || 0;
                if (data.packageTier === 'LIONS') lionsCount += qty;
                if (data.packageTier === 'LEOS') leosCount += qty;
            }
            
            let timeObj = new Date();
            if (data.updatedAt && typeof data.updatedAt.toDate === 'function') {
                timeObj = data.updatedAt.toDate();
            } else if (data.createdAt && typeof data.createdAt.toDate === 'function') {
                timeObj = data.createdAt.toDate();
            }

            allOrders.push({
                id: doc.id,
                time: timeObj,
                name: data.payerName || 'N/A',
                phone: data.payerPhone || 'N/A',
                email: data.payerEmail || 'N/A',
                tier: data.packageTier || 'N/A',
                clubName: data.clubName || 'N/A',
                dietaryPreference: data.dietaryPreference || 'None',
                qty: qty,
                amount: Number(data.amount) || 0,
                status: (data.status || data.paymentStatus || 'unknown').toLowerCase(),
                failureReason: data.reason || 'No reason provided',
                emailStatus: data.emailStatus || 'PENDING',
                mpesaReceipt: data.mpesaReceipt || 'N/A',
                merchantTxId: data.merchantRequestID || 'N/A',
                attended: data.attended || false,
                checkInTime: data.checkInTime ? (typeof data.checkInTime.toDate === 'function' ? data.checkInTime.toDate() : data.checkInTime) : null
            });
        });

        allOrders.sort((a, b) => b.time - a.time);
        
        const recentOrders = allOrders.filter(o => o.status === 'paid').slice(0, 15);
        
        res.json({ 
            success: true, 
            totalTickets, 
            totalRevenue, 
            lionsCount, 
            leosCount, 
            recentOrders, 
            allOrders,    
            lastUpdated: new Date().toISOString() 
        });
    } catch (e) {
        console.error('[STATS ERROR]', e.message);
        res.status(500).json({ success: false, error: 'Could not fetch stats' });
    }
});

// ─── MANUAL TICKET EMAIL TRIGGER ───
app.post('/api/resend-ticket/:id', async (req, res) => {
    try {
        const docId = req.params.id;
        const docSnap = await db.collection('orders').doc(docId).get();
        
        if (!docSnap.exists) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const orderData = docSnap.data();
        if (orderData.status !== 'PAID') {
            return res.status(400).json({ success: false, message: "Order must be marked as PAID first." });
        }

        await sendConfirmationEmail(orderData, docId, docSnap.ref);
        
        res.status(200).json({ success: true, message: "Ticket email successfully triggered." });
    } catch (error) {
        console.error("[RESEND ERROR]", error);
        res.status(500).json({ success: false, message: "Failed to send email." });
    }
});

// ─── DELETE FAILED RECORD ENDPOINT ───
app.delete('/api/delete-record/:id', async (req, res) => {
    try {
        const docId = req.params.id;
        if (!docId) {
            return res.status(400).json({ success: false, message: "No document ID provided" });
        }
        await db.collection('orders').doc(docId).delete();
        console.log(`[DELETE] Successfully permanently deleted record: ${docId}`);
        res.status(200).json({ success: true, message: "Record permanently deleted" });

    } catch (error) {
        console.error("[DELETE ERROR] Failed to delete record from Firestore:", error);
        res.status(500).json({ success: false, message: "Failed to delete record" });
    }
});

// Status endpoint
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const doc = await db.collection('orders').doc(req.params.orderId).get();
        if (!doc.exists) return res.status(404).json({ status: 'NOT_FOUND' });
        res.json(doc.data());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Listen with 0.0.0.0 for Render ───
const HOST = '0.0.0.0';
const port = process.env.PORT || 10000;

app.listen(port, HOST, () => {
  console.log(`Server listening on http://${HOST}:${port}`);
  console.log(`Using NODE_ENV=${process.env.NODE_ENV || 'development'}`);
});
