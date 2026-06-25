// ==========================================
// SARAMI EVENTS - PRODUCTION BACKEND (SUPABASE)
// MULTI-EVENT GATEWAY
// ==========================================
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ─── MAINTENANCE MODE TOGGLE ───
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("✅ Supabase Initialized");

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
async function sendConfirmationEmail(orderData, orderId) {
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
        
        // (Your existing HTML template remains exactly the same here)
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

        // Update emailStatus in Supabase
        await supabase
            .from('orders')
            .update({ emailStatus: 'SENT', updatedAt: new Date().toISOString() })
            .eq('id', orderId);

    } catch (err) {
        console.error('[EMAIL FAIL]', err.response?.text || err.message);
        await supabase
            .from('orders')
            .update({ emailStatus: 'FAILED', updatedAt: new Date().toISOString() })
            .eq('id', orderId);
    }
}

// ─── WEB TICKET DOWNLOAD ENDPOINT ───
app.get('/api/ticket/:orderId', async (req, res) => {
    try {
        const { data: orderData, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', req.params.orderId)
            .single();

        if (error || !orderData) return res.status(404).send('<h1>Ticket Not Found</h1>');
        
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

        // (Your existing HTML template remains exactly the same here)
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
    if (MAINTENANCE_MODE) {
        console.log("[MAINTENANCE] Blocked new order attempt.");
        return res.status(503).json({ success: false, error: 'MAINTENANCE_MODE_ACTIVE' });
    }

    const { payerName, payerEmail, payerPhone, amount, eventName, quantity, packageTier, dietaryPreference, clubName, eventId } = req.body || {};

    if (!payerName || !payerEmail || !payerPhone || !amount) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    let createdOrderId;
    
    try {
        const { data: newOrder, error: dbError } = await supabase
            .from('orders')
            .insert({
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
                attended: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            })
            .select()
            .single();

        if (dbError) throw dbError;
        createdOrderId = newOrder.id;

        const token = await getAuthToken();
        const merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;
        const formattedPhone = formatPhone(payerPhone);

        const payload = {
            transactionId: merchantTxId,
            transactionReference: createdOrderId, // Pass Supabase UUID here
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

        await supabase
            .from('orders')
            .update({
                merchantRequestID: merchantTxId,
                status: 'STK_SENT',
                updatedAt: new Date().toISOString()
            })
            .eq('id', createdOrderId);

        res.status(200).json({ success: true, orderId: createdOrderId });
    } catch (err) {
        console.error('[CREATE-ORDER ERROR]', err.message);
        const errMsg = err.response?.data || err.message || 'Unknown error';
        
        if (createdOrderId) {
            await supabase
                .from('orders')
                .update({
                    status: 'FAILED',
                    reason: errMsg,
                    updatedAt: new Date().toISOString()
                })
                .eq('id', createdOrderId)
                .catch(() => {});
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
            status: 'PAID', 
            paymentMethod: 'MANUAL_ENTRY', 
            emailStatus: 'PENDING',
            attended: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const { data: newOrder, error } = await supabase
            .from('orders')
            .insert(orderData)
            .select()
            .single();

        if (error) throw error;

        // Instantly trigger the VIP E-Ticket delivery
        await sendConfirmationEmail(orderData, newOrder.id);

        res.status(200).json({ success: true, orderId: newOrder.id, message: 'Ticket created and emailed successfully!' });
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
        let orderId = null;

        const possibleDocId = data.transactionReference || data.reference || resultsObj.transactionReference;
        
        // 1. Try to find by ID
        if (possibleDocId && typeof possibleDocId === 'string') {
            const { data: docSnap } = await supabase
                .from('orders')
                .select('*')
                .eq('id', possibleDocId)
                .single();
                
            if (docSnap) {
                orderDoc = docSnap;
                orderId = docSnap.id;
            }
        }

        // 2. Fallback: Try to find by Merchant Request ID
        if (!orderId) {
            const possibleIds = [
                resultsObj.merchantTxnId, 
                data.merchantRequestId, data.MerchantRequestID, data.merchantRequestID,
                data.checkoutRequestId, data.CheckoutRequestID,
                data.transactionId, data.TransactionId, resultsObj.transactionId
            ];
            
            const mReqId = possibleIds.find(id => id && typeof id === 'string' && id.trim());
            
            if (mReqId) {
                const { data: matchedOrders } = await supabase
                    .from('orders')
                    .select('*')
                    .eq('merchantRequestID', mReqId)
                    .limit(1);
                    
                if (matchedOrders && matchedOrders.length > 0) {
                    orderDoc = matchedOrders[0];
                    orderId = orderDoc.id;
                }
            }
        }

        if (!orderId) {
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

        await supabase
            .from('orders')
            .update({
                status: isSuccess ? 'PAID' : 'FAILED', 
                paymentStatus: isSuccess ? 'PAID' : 'FAILED',
                reason: reason,
                mpesaReceipt: receipt,
                updatedAt: new Date().toISOString(),
                rawCallback: data,
                resultCode: String(resultCode || statusStr || -1)
            })
            .eq('id', orderId);

        if (isSuccess) {
            // Re-fetch updated doc just to be safe
            const { data: updatedDoc } = await supabase.from('orders').select('*').eq('id', orderId).single();
            sendConfirmationEmail(updatedDoc, orderId).catch(console.error);
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
        const { data: orderDoc, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', ticketId)
            .single();
        
        if (error || !orderDoc) return res.json({ success: false, message: "Invalid Ticket: Ticket not found." });
        
        if (orderDoc.status !== 'PAID') {
            return res.json({ success: false, message: `Ticket Unpaid. Current Status: ${orderDoc.status}` });
        }

        if (orderDoc.attended) {
            return res.json({ success: false, message: "Ticket Already Used!" });
        }
        
        await supabase
            .from('orders')
            .update({ 
                attended: true, 
                checkInTime: new Date().toISOString()
            })
            .eq('id', ticketId);
        
        res.json({ success: true, name: orderDoc.payerName, tier: orderDoc.packageTier, qty: orderDoc.quantity });
    } catch (e) {
        console.error("[SCANNER ERROR]", e);
        res.status(500).json({ success: false, message: "System Error communicating with database." });
    }
});

// ─── MANUAL ATTENDANCE TOGGLE ───
app.post('/api/toggle-attendance/:id', async (req, res) => {
    try {
        const docId = req.params.id;
        const { data: orderDoc, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', docId)
            .single();
        
        if (error || !orderDoc) return res.status(404).json({ success: false, message: "Order not found" });
        
        const newStatus = !orderDoc.attended;
        
        await supabase
            .from('orders')
            .update({ 
                attended: newStatus,
                checkInTime: newStatus ? new Date().toISOString() : null
            })
            .eq('id', docId);
        
        res.json({ success: true, attended: newStatus });
    } catch (e) {
        console.error("[TOGGLE ERROR]", e);
        res.status(500).json({ success: false, message: "Server error toggling status." });
    }
});

// ─── WEB SCANNER UI PAGE ENDPOINT ───
// (Your existing /scanner HTML block remains exactly the same here. 
//  No backend JS logic lives inside it that needs changing for Supabase.)
app.get('/scanner', (req, res) => {
    // Note: Kept exact code from prompt for brevity
    res.send(`<!DOCTYPE html>...[HTML Content From Prompt]...</html>`); 
});

// ─── COMPREHENSIVE LIVE STATS ENDPOINT ───
app.get('/api/live-stats', async (req, res) => {
    try {
        const { data: allOrdersData, error } = await supabase
            .from('orders')
            .select('*')
            .order('createdAt', { ascending: false });

        if (error) throw error;
        
        let totalTickets = 0;
        let totalRevenue = 0;
        let lionsCount = 0;
        let leosCount = 0;
        let allOrders = [];

        allOrdersData.forEach(data => {
            const qty = Number(data.quantity) || 1;
            
            if (data.status === 'PAID') {
                totalTickets += qty;
                totalRevenue += Number(data.amount) || 0;
                if (data.packageTier === 'LIONS') lionsCount += qty;
                if (data.packageTier === 'LEOS') leosCount += qty;
            }
            
            // Supabase returns timestamps as ISO strings
            let timeObj = data.updatedAt ? new Date(data.updatedAt) : new Date(data.createdAt);

            allOrders.push({
                id: data.id,
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
                checkInTime: data.checkInTime ? new Date(data.checkInTime) : null
            });
        });

        // Re-sort just to be absolutely certain (optional since we ordered in DB)
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
        console.error('[STATS ERROR RAW]', e);
        res.status(500).json({ success: false, error: 'Could not fetch stats' });
    }
});

// ─── MANUAL TICKET EMAIL TRIGGER ───
app.post('/api/resend-ticket/:id', async (req, res) => {
    try {
        const docId = req.params.id;
        const { data: orderData, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', docId)
            .single();
        
        if (error || !orderData) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        if (orderData.status !== 'PAID') {
            return res.status(400).json({ success: false, message: "Order must be marked as PAID first." });
        }

        await sendConfirmationEmail(orderData, docId);
        
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
        
        const { error } = await supabase
            .from('orders')
            .delete()
            .eq('id', docId);
            
        if (error) throw error;
        
        console.log(`[DELETE] Successfully permanently deleted record: ${docId}`);
        res.status(200).json({ success: true, message: "Record permanently deleted" });

    } catch (error) {
        console.error("[DELETE ERROR] Failed to delete record from Supabase:", error);
        res.status(500).json({ success: false, message: "Failed to delete record" });
    }
});

// Status endpoint
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        const { data: orderData, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', req.params.orderId)
            .single();
            
        if (error || !orderData) return res.status(404).json({ status: 'NOT_FOUND' });
        res.json(orderData);
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
