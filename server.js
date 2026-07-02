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
        emailSubject: "🎫 Your Entry Pass: District Governor's Banquet",
        venue: "Lions Service Centre, Loresho • July 18th, 2026 at 6:30 PM",
        primaryColor: "#00338D", // Lions Blue
        accentColor: "#F2A900",  // Lions Gold
        bgGradient: "linear-gradient(135deg, #001f5b, #00338D)",
        buttonGradient: "linear-gradient(135deg, #F2A900, #d97706)",
        ticketHeader: "SARAMI EVENTS"
    },
    'DANCE_2_EDUCATE_2026': {
        title: "DANCE 2 EDUCATE - CHARITY EVENT",
        emailSubject: "🪩 Your Entry Pass: Dance 2 Educate",
        venue: "Carnivore Grounds, Simba Saloon",
        primaryColor: "#4F46E5", // Indigo 600
        accentColor: "#EC4899",  // Pink 500
        bgGradient: "linear-gradient(135deg, #312e81, #4F46E5)",
        buttonGradient: "linear-gradient(135deg, #EC4899, #be185d)",
        ticketHeader: "SARAMI EVENTS"
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

// ─── PRESTIGIOUS E-TICKET EMAIL FUNCTION ───
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
        
        // Refined HTML Template with Gold Shapes & New Copy
        sendSmtpEmail.htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f1f5f9; padding: 40px 20px;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 4px; overflow: hidden; box-shadow: 0 15px 35px rgba(0,0,0,0.1); max-width: 600px; width: 100%; border: 1px solid #e2e8f0;">
                            
                            <tr>
                                <td style="background: ${config.bgGradient}; padding: 45px 20px; text-align: center; border-bottom: 4px solid ${config.accentColor};">
                                    <h1 style="color: #ffffff; margin: 0; font-family: 'Georgia', serif; font-size: 26px; letter-spacing: 6px; text-transform: uppercase; font-weight: normal;">${config.ticketHeader}</h1>
                                    <p style="color: ${config.accentColor}; margin: 15px 0 0 0; font-size: 11px; font-weight: bold; letter-spacing: 4px; text-transform: uppercase;">${config.title}</p>
                                </td>
                            </tr>
                            
                            <tr>
                                <td align="center" style="padding: 50px 40px 30px 40px;">
                                    <h2 style="color: ${config.primaryColor}; margin-top: 0; font-family: 'Georgia', serif; font-size: 24px; font-weight: normal; letter-spacing: 1px;">Your Gala Access is Secured</h2>
                                    <div style="width: 40px; height: 2px; background-color: ${config.accentColor}; margin: 20px auto;"></div>
                                    <p style="color: #475569; font-size: 16px; line-height: 1.8; margin-bottom: 30px;">The honor of your presence is requested. Welcome, <strong>${orderData.payerName}</strong>. Your reservation is confirmed, and your entry pass has been formally issued.</p>
                                    
                                    <a href="${downloadLink}" style="display: inline-block; background: ${config.buttonGradient}; color: #ffffff; font-size: 14px; font-weight: bold; text-decoration: none; padding: 16px 35px; border-radius: 2px; text-transform: uppercase; letter-spacing: 2px; box-shadow: 0 4px 10px rgba(0,0,0,0.15);">
                                        View Official Entry Pass
                                    </a>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding: 10px 40px 40px 40px;">
                                    <div style="border: 1px solid #e2e8f0; padding: 35px; text-align: center; background-color: #fafaf9;">
                                        <p style="margin: 0 0 25px 0; font-size: 12px; font-weight: bold; color: #94a3b8; text-transform: uppercase; letter-spacing: 3px;">Entry Credentials</p>
                                        
                                        <img src="${qrImageUrl}" width="160" height="160" alt="Your QR Code" style="display: block; margin: 0 auto; border: 4px solid #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                                        
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 35px; text-align: left; border-top: 1px solid #e2e8f0; padding-top: 35px;">
                                            <tr>
                                                <td style="padding-bottom: 25px;">
                                                    <p style="margin: 0 0 8px 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px;">Name of Guest</p>
                                                    <div style="background: linear-gradient(135deg, #fffcf5, #fdf5e6); border: 1px solid #e8c37c; padding: 10px 16px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                                                        <span style="font-size: 16px; color: #0f172a; font-family: 'Georgia', serif; font-weight: bold;">${orderData.payerName}</span>
                                                    </div>
                                                </td>
                                                <td align="right" style="padding-bottom: 25px;">
                                                    <p style="margin: 0 0 8px 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px;">Admit</p>
                                                    <div style="background: linear-gradient(135deg, #fffcf5, #fdf5e6); border: 1px solid #e8c37c; padding: 10px 16px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                                                        <span style="font-size: 16px; color: #0f172a; font-family: 'Georgia', serif; font-weight: bold;">${orderData.quantity} Person(s)</span>
                                                    </div>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td>
                                                    <p style="margin: 0 0 8px 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px;">Access Tier</p>
                                                    <div style="background: linear-gradient(135deg, #fffcf5, #fdf5e6); border: 1px solid #e8c37c; padding: 10px 16px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                                                        <span style="font-size: 15px; color: ${config.primaryColor}; font-weight: bold;">${orderData.packageTier}</span>
                                                    </div>
                                                </td>
                                                <td align="right">
                                                    <p style="margin: 0 0 8px 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px;">Date</p>
                                                    <div style="background: linear-gradient(135deg, #f8fafc, #f1f5f9); border: 1px solid #cbd5e1; padding: 10px 16px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                                                        <span style="font-size: 14px; color: #334155; font-family: 'Georgia', serif; font-weight: bold;">${config.venue.split('•')[1] ? config.venue.split('•')[1].trim() : 'TBA'}</span>
                                                    </div>
                                                </td>
                                            </tr>
                                        </table>
                                    </div>
                                </td>
                            </tr>
                            
                            <tr>
                                <td style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
                                    <p style="color: #94a3b8; font-size: 11px; margin: 0; letter-spacing: 1px; text-transform: uppercase;">&copy; ${new Date().getFullYear()} Sarami Events. All rights reserved.</p>
                                    <p style="color: #64748b; font-size: 10px; margin: 10px 0 0 0;">Please present this digital pass upon arrival for seamless entry.</p>
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

// ─── PRESTIGIOUS WEB TICKET DOWNLOAD ENDPOINT ───
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

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Entry Pass - ${orderData.payerName}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Montserrat', sans-serif; background-color: #f8fafc; }
                .serif-font { font-family: 'Playfair Display', serif; }
                .print-btn { display: block; }
                .gold-border { position: relative; }
                .gold-border::after {
                    content: '';
                    position: absolute;
                    top: 8px; left: 8px; right: 8px; bottom: 8px;
                    border: 1px solid ${config.accentColor}40;
                    pointer-events: none;
                }
                @media print {
                    .print-btn { display: none !important; }
                    body { background-color: white; }
                    .ticket-container { box-shadow: none !important; border: none !important; }
                }
            </style>
        </head>
        <body class="flex flex-col items-center justify-center min-h-screen p-4 py-10">
            
            <div class="mb-8 print-btn">
                <button onclick="window.print()" class="text-white text-sm font-semibold uppercase tracking-widest px-8 py-4 rounded shadow-lg hover:shadow-xl transition duration-300" style="background: ${config.buttonGradient}">
                    <svg class="w-4 h-4 inline mr-2 -mt-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    Download Official Pass
                </button>
            </div>

            <div class="ticket-container bg-white w-full max-w-md relative shadow-2xl border border-gray-200 gold-border flex flex-col">
                
                <div class="p-10 text-center relative z-10" style="background: ${config.bgGradient}; border-bottom: 4px solid ${config.accentColor};">
                    <h1 class="text-3xl text-white tracking-[0.2em] uppercase serif-font">${config.ticketHeader}</h1>
                    <p class="text-[10px] font-bold tracking-[0.3em] mt-3 uppercase" style="color: ${config.accentColor};">${config.title}</p>
                </div>
                
                <div class="p-10 text-center relative z-10 bg-[#fafaf9] border-b border-gray-200">
                    <p class="serif-font italic text-gray-500 mb-6 text-lg">The Honor of Your Presence is Requested</p>
                    <div class="bg-white p-3 inline-block rounded-sm shadow-sm border border-gray-100">
                        <img src="${qrImageUrl}" alt="QR Code" class="w-48 h-48 mx-auto">
                    </div>
                    <p class="mt-4 text-[10px] font-mono text-gray-400 tracking-widest uppercase">ID: ${req.params.orderId.substring(0,12)}</p>
                </div>

                <div class="p-10 bg-white relative z-10 flex-grow">
                    <div class="grid grid-cols-2 gap-y-8 gap-x-4 text-left">
                        
                        <div>
                            <p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Name of Guest</p>
                            <div class="bg-gradient-to-br from-[#FFF8E7] to-[#FDF5E6] border border-[#E8C37C] text-gray-900 px-4 py-2.5 rounded-lg shadow-sm serif-font text-base sm:text-lg font-semibold inline-block">
                                ${orderData.payerName}
                            </div>
                        </div>
                        <div class="text-right flex flex-col items-end">
                            <p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 mr-1">Access Tier</p>
                            <div class="bg-gradient-to-br from-[#FFF8E7] to-[#FDF5E6] border border-[#E8C37C] px-4 py-2.5 rounded-lg shadow-sm serif-font text-base sm:text-lg font-bold inline-block" style="color: ${config.primaryColor};">
                                ${orderData.packageTier}
                            </div>
                        </div>
                        
                        <div>
                            <p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Admit</p>
                            <div class="bg-gradient-to-br from-[#FFF8E7] to-[#FDF5E6] border border-[#E8C37C] text-gray-900 px-4 py-2 rounded-lg shadow-sm serif-font text-base font-medium inline-block">
                                ${orderData.quantity} Person(s)
                            </div>
                        </div>
                        <div class="text-right flex flex-col items-end">
                            <p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 mr-1">Dietary/Notes</p>
                            <div class="bg-gradient-to-br from-[#FFF8E7] to-[#FDF5E6] border border-[#E8C37C] text-gray-700 px-4 py-2 rounded-lg shadow-sm text-sm font-medium inline-block">
                                ${orderData.dietaryPreference || 'None Specified'}
                            </div>
                        </div>
                        
                        <div class="col-span-2 border-t border-gray-100 pt-6 mt-2">
                            <p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Venue & Information</p>
                            <div class="bg-slate-50 border border-slate-200 text-gray-800 px-4 py-3.5 rounded-lg shadow-sm text-sm leading-relaxed block">
                                ${config.venue.replace('•', '<br><span class="text-gray-500 text-xs mt-1 block">')}</span>
                            </div>
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
app.get('/scanner', (req, res) => {
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

// ─── DELETE RECORD ENDPOINT ───
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
