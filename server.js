// ==========================================
// SARAMI EVENTS - PRODUCTION BACKEND
// MULTI-EVENT GATEWAY
// FEATURES: Dynamic Event Routing, M-Pesa STK, VIP E-Tickets, Live Stats, Database Management
// ==========================================
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

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
// This controls the branding, colors, and text for different events.
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

// Failsafe helper function: ALWAYS defaults to the live DG Banquet if anything goes wrong
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

        // 1. Fetch Event Config (Failsafe defaults to DG Banquet)
        const config = getEventConfig(orderData.eventId);

        // 2. Generate Live QR Code URL
        const qrPayload = JSON.stringify({
            ticketID: orderId,
            name: orderData.payerName,
            tier: orderData.packageTier,
            qty: orderData.quantity,
            status: "PAID"
        });
        // Remove '#' for the QR API color
        const qrColor = config.primaryColor.replace('#', ''); 
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(qrPayload)}&color=${qrColor}`;

        // 3. The Download Link
        const downloadLink = `https://ticketing-app-final.onrender.com/api/ticket/${orderId}`;

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = config.emailSubject; // Dynamic Subject
        
        // 4. Ultra-Premium Email Template (Dynamic Colors & Text)
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

        // Fetch dynamic config
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
    // 1. Destructure clubName explicitly from req.body
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
            clubName: clubName || 'N/A', // 2. Successfully save the clubName
            eventName: eventName || "District Governor's Banquet 2026",
            eventId: eventId || 'DG_BANQUET_2026', 
            status: 'INITIATED',
            emailStatus: 'PENDING',
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
            status: isSuccess ? 'PAID' : 'FAILED', // Adjusted to explicitly mark FAILED so the frontend catches it
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

// ─── LIVE DASHBOARD STATS ENDPOINT (MODIFIED FOR VIEWER) ───
app.get('/api/live-stats', async (req, res) => {
    try {
        // Removed the .where() filter so it fetches ALL records (Paid and Failed)
        const snapshot = await db.collection('orders').get();
        
        let totalTickets = 0;
        let totalRevenue = 0;
        let lionsCount = 0;
        let leosCount = 0;
        let allOrders = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const qty = Number(data.quantity) || 1;
            
            // Only add to the overall stats if the order is PAID
            if (data.status === 'PAID') {
                totalTickets += qty;
                totalRevenue += Number(data.amount) || 0;
                
                if (data.packageTier === 'LIONS') lionsCount += qty;
                if (data.packageTier === 'LEOS') leosCount += qty;
            }

            // Safely grab the timestamp
            let timeObj = new Date();
            if (data.updatedAt && typeof data.updatedAt.toDate === 'function') {
                timeObj = data.updatedAt.toDate();
            } else if (data.createdAt && typeof data.createdAt.toDate === 'function') {
                timeObj = data.createdAt.toDate();
            }

            // Push the ID and normalize the status for the frontend
            allOrders.push({
                id: doc.id, // VERY IMPORTANT: Required for the delete functionality
                name: data.payerName,
                tier: data.packageTier,
                clubName: data.clubName || 'N/A',
                dietaryPreference: data.dietaryPreference || 'None',
                qty: qty,
                amount: Number(data.amount) || 0,
                status: data.status === 'PAID' ? 'paid' : 'failed', // Map for frontend tabs
                failureReason: data.reason || data.status || 'Unknown Error', // Map error message
                time: timeObj
            });
        });

        // Sort by most recent first
        allOrders.sort((a, b) => b.time - a.time);
        
        // Removed the slice so the frontend gets the full database viewer
        res.json({
            success: true,
            totalTickets,
            totalRevenue,
            lionsCount,
            leosCount,
            allOrders, 
            lastUpdated: new Date().toISOString()
        });
    } catch (e) {
        console.error('[STATS ERROR]', e.message);
        res.status(500).json({ success: false, error: 'Could not fetch stats' });
    }
});

// ─── DELETE FAILED RECORD ENDPOINT ───
app.delete('/api/delete-record/:id', async (req, res) => {
    try {
        const docId = req.params.id;

        if (!docId) {
            return res.status(400).json({ success: false, message: "No document ID provided" });
        }

        // Deletes the specific document from the 'orders' collection
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
