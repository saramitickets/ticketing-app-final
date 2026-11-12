// ==========================================
// SARAMI EVENTS - PRODUCTION BACKEND (SUPABASE)
// MULTI-EVENT GATEWAY  •  v2 (Mass Induction Dinner + Invites + Secured endpoints)
// ==========================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ─── ENVIRONMENT ───
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';
const ADMIN_KEY = process.env.ADMIN_KEY || '';              // protects dashboard/admin endpoints
const SCANNER_PIN = process.env.SCANNER_PIN || '';          // door staff PIN for the scanner page
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';  // secret path segment for payment callbacks
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ticketing-app-final.onrender.com';

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
console.log("✅ Supabase Initialized");

// Initialize Brevo (Email)
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ─── EVENT CONFIGURATION DICTIONARY ───
// Prices live HERE, on the server. The browser's "amount" is ignored.
const EVENT_CONFIGS = {
    'MASS_INDUCTION_2026': {
        title: "MASS INDUCTION DINNER 2026",
        emailSubject: "🎫 Your Entry Pass: Mass Induction Dinner",
        venue: "Lions Service Centre, Loresho • 27th November 2026 at 6:30 PM",
        primaryColor: "#00338D",
        accentColor: "#F2A900",
        bgGradient: "linear-gradient(135deg, #001f5b, #00338D)",
        buttonGradient: "linear-gradient(135deg, #F2A900, #d97706)",
        ticketHeader: "SARAMI EVENTS",
        tiers: { GENERAL: 1800 },
        maxQty: 10,
        invite: {
            codeEnv: 'MASS_INDUCTION_INVITE_CODE',                       // set this in Render
            cap: Number(process.env.MASS_INDUCTION_INVITE_CAP) || 100   // max invited guests
        }
    },
    'DG_BANQUET_2026': {
        title: "DISTRICT GOVERNOR'S BANQUET 2026",
        emailSubject: "🎫 Your Entry Pass: District Governor's Banquet",
        venue: "Lions Service Centre, Loresho • July 18th, 2026 at 6:30 PM",
        primaryColor: "#00338D",
        accentColor: "#F2A900",
        bgGradient: "linear-gradient(135deg, #001f5b, #00338D)",
        buttonGradient: "linear-gradient(135deg, #F2A900, #d97706)",
        ticketHeader: "SARAMI EVENTS",
        tiers: { LIONS: 2500, LEOS: 1500 },
        maxQty: 10
    },
    'DANCE_2_EDUCATE_2026': {
        title: "DANCE 2 EDUCATE - CHARITY EVENT",
        emailSubject: "🪩 Your Entry Pass: Dance 2 Educate",
        venue: "Carnivore Grounds, Simba Saloon",
        primaryColor: "#4F46E5",
        accentColor: "#EC4899",
        bgGradient: "linear-gradient(135deg, #312e81, #4F46E5)",
        buttonGradient: "linear-gradient(135deg, #EC4899, #be185d)",
        ticketHeader: "SARAMI EVENTS",
        tiers: {}, // ⚠️ Add prices here (e.g. { GENERAL: 1000 }) before selling tickets for this event
        maxQty: 10
    }
};

const TIER_LABELS = { GENERAL: 'General', INVITED: 'Invited Guest', LIONS: 'Lions', LEOS: 'Leos' };
const tierLabel = (t) => TIER_LABELS[t] || t || 'General';

// Guest positions shown on the booking and invite forms (keep in sync with the pages)
const POSITIONS = [
    'International Officer', 'PDG', 'GAT', 'District Officer',
    'New Club Charter Officer', 'New Club Member', 'Leo District Cabinet', 'Other'
];
const cleanPosition = (v) => POSITIONS.find(p => p.toLowerCase() === String(v || '').trim().toLowerCase()) || '';

function getEventConfig(eventId) {
    return EVENT_CONFIGS[eventId] || EVENT_CONFIGS['MASS_INDUCTION_2026'];
}
function findEvent(eventId) {
    return Object.prototype.hasOwnProperty.call(EVENT_CONFIGS, eventId) ? EVENT_CONFIGS[eventId] : null;
}

// ─── Middleware ───
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key, X-Scanner-Pin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/plain' }));
app.use((req, res, next) => {
    if (req.method === 'POST' && typeof req.body === 'string') {
        try { req.body = JSON.parse(req.body.trim()); } catch (e) { }
    }
    next();
});

// ─── Helpers ───
function formatPhone(phone) {
    let p = (phone || '').replace(/\D/g, '');
    if (!p) return '';
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (!p.startsWith('254')) p = '254' + p;
    return p;
}
const isValidKePhone = (p) => /^254[17]\d{8}$/.test(p);
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) return res.status(503).json({ success: false, message: 'ADMIN_KEY is not configured on the server.' });
    if (!safeEqual(req.get('x-admin-key'), ADMIN_KEY)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    next();
}

function requireScanner(req, res, next) {
    const pin = req.get('x-scanner-pin');
    if ((SCANNER_PIN && safeEqual(pin, SCANNER_PIN)) || (ADMIN_KEY && safeEqual(pin, ADMIN_KEY))) return next();
    return res.status(401).json({ success: false, message: 'Wrong scanner PIN.' });
}

// Live-sync screens must log in with the scanner PIN (or admin key) to receive guest names
io.use((socket, next) => {
    const pin = socket.handshake.auth?.pin;
    if ((SCANNER_PIN && safeEqual(pin, SCANNER_PIN)) || (ADMIN_KEY && safeEqual(pin, ADMIN_KEY))) return next();
    next(new Error('UNAUTHORIZED'));
});

// QR holds only the ticket ID (short = scans fast, no personal data inside)
function qrUrl(orderId, config, size = 300) {
    const payload = JSON.stringify({ ticketID: orderId });
    const color = config.primaryColor.replace('#', '');
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(payload)}&color=${color}`;
}

// Accepts a raw ID, the JSON QR payload, or a ticket URL
function extractTicketId(raw) {
    const s = String(raw || '').trim();
    try { const j = JSON.parse(s); if (j && j.ticketID) return String(j.ticketID).trim(); } catch (e) { }
    const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : s;
}

async function getAuthToken() {
    const res = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
        username: process.env.INFINITIPAY_MERCHANT_USERNAME,
        password: process.env.INFINITIPAY_MERCHANT_PASSWORD
    }, { timeout: 10000 });
    return res.data.access_token;
}

async function setOrder(id, fields) {
    const { error } = await supabase.from('orders')
        .update({ ...fields, updatedAt: new Date().toISOString() })
        .eq('id', id);
    if (error) console.error('[DB UPDATE ERROR]', id, error.message);
}

// ─── LUXURY E-TICKET EMAIL ───
async function sendConfirmationEmail(orderData, orderId) {
    try {
        console.log(`[EMAIL] Generating Ticket for ${orderData.payerEmail}`);
        const config = getEventConfig(orderData.eventId);
        const downloadLink = `${PUBLIC_BASE_URL}/api/ticket/${orderId}`;
        const name = esc(orderData.payerName);
        const tier = esc(tierLabel(orderData.packageTier));
        const dateText = esc(config.venue.split('•')[1] ? config.venue.split('•')[1].trim() : 'TBA');
        const venueText = esc(config.venue.split('•')[0].trim());
        const isInvite = orderData.paymentMethod === 'INVITE';

        const plate = (text, size = 17) => `
            <div style="background: linear-gradient(135deg, #BF953F 0%, #FCF6BA 25%, #B38728 50%, #FBF5B7 75%, #AA771C 100%); padding: 2px; border-radius: 6px; display: inline-block;">
                <div style="background: linear-gradient(135deg, #fdfbf7, #fffcf5); padding: 12px 20px; border-radius: 4px;">
                    <span style="font-size: ${size}px; color: #00205B; font-family: 'Georgia', serif; font-weight: bold;">${text}</span>
                </div>
            </div>`;
        const label = (t) => `<p style="margin: 0 0 8px 0; font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px;">${t}</p>`;

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = config.emailSubject;
        sendSmtpEmail.htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f1f5f9; padding: 40px 20px;">
                <tr><td align="center">
                    <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 4px; overflow: hidden; max-width: 600px; width: 100%; border: 1px solid #e2e8f0;">
                        <tr>
                            <td style="background: ${config.bgGradient}; background-color: ${config.primaryColor}; padding: 45px 20px; text-align: center; border-bottom: 4px solid ${config.accentColor};">
                                <h1 style="color: #ffffff; margin: 0; font-family: 'Georgia', serif; font-size: 28px; letter-spacing: 6px; text-transform: uppercase; font-weight: normal;">${config.ticketHeader}</h1>
                                <p style="color: ${config.accentColor}; margin: 15px 0 0 0; font-size: 11px; font-weight: bold; letter-spacing: 4px; text-transform: uppercase;">${config.title}</p>
                            </td>
                        </tr>
                        <tr>
                            <td align="center" style="padding: 50px 40px 30px 40px;">
                                <h2 style="color: ${config.primaryColor}; margin-top: 0; font-family: 'Georgia', serif; font-size: 24px; font-weight: normal;">${isInvite ? 'Your RSVP is Confirmed' : 'Your Seat is Secured'}</h2>
                                <div style="width: 50px; height: 2px; background: #B38728; margin: 20px auto;"></div>
                                <p style="color: #475569; font-size: 16px; line-height: 1.8; margin-bottom: 30px;">Welcome, <strong>${name}</strong>. ${isInvite ? 'Thank you for accepting our invitation.' : 'Your payment has been received.'} Show the QR code below at the entrance on the night.</p>
                                <a href="${downloadLink}" style="display: inline-block; background: #B38728; background: linear-gradient(135deg, #BF953F, #B38728); color: #ffffff; font-size: 14px; font-weight: bold; text-decoration: none; padding: 18px 40px; border-radius: 4px; text-transform: uppercase; letter-spacing: 2px; border: 1px solid #AA771C;">View Entry Pass</a>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 10px 40px 40px 40px;">
                                <div style="border: 1px solid #e2e8f0; padding: 35px; text-align: center; background-color: #fafaf9;">
                                    <img src="${qrUrl(orderId, config, 250)}" width="180" height="180" alt="Your entry QR code" style="display: block; margin: 0 auto; border: 4px solid #ffffff;">
                                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 35px; text-align: left; border-top: 1px solid #e2e8f0; padding-top: 35px;">
                                        <tr>
                                            <td style="padding-bottom: 25px; width: 50%;">${label('Name of Guest')}${plate(name)}</td>
                                            <td align="right" style="padding-bottom: 25px; width: 50%;">${label('Admit')}${plate(`${Number(orderData.quantity) || 1} Person(s)`)}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding-bottom: 25px;">${label('Ticket')}${plate(tier, 16)}</td>
                                            <td align="right" style="padding-bottom: 25px;">${label('Date')}
                                                <div style="background: #f8fafc; border: 1px solid #cbd5e1; padding: 12px 20px; border-radius: 6px; display: inline-block;">
                                                    <span style="font-size: 14px; color: #334155; font-family: 'Georgia', serif; font-weight: bold;">${dateText}</span>
                                                </div>
                                            </td>
                                        </tr>
                                        ${orderData.position ? `<tr><td colspan="2" style="padding-bottom: 25px;">${label('Position')}${plate(esc(orderData.position), 15)}</td></tr>` : ''}
                                        <tr><td colspan="2">${label('Venue')}<span style="font-size: 14px; color: #334155;">${venueText}</span></td></tr>
                                    </table>
                                </div>
                            </td>
                        </tr>
                        <tr>
                            <td style="background-color: #0f172a; padding: 30px 20px; text-align: center;">
                                <p style="color: #94a3b8; font-size: 11px; margin: 0; letter-spacing: 1px; text-transform: uppercase;">&copy; ${new Date().getFullYear()} Sarami Events. All rights reserved.</p>
                                <p style="color: #64748b; font-size: 10px; margin: 10px 0 0 0;">Each QR code can be scanned once. Please don't share it.</p>
                            </td>
                        </tr>
                    </table>
                </td></tr>
            </table>
        </body>
        </html>`;

        sendSmtpEmail.sender = { name: "Sarami Events", email: "etickets@saramievents.co.ke" };
        sendSmtpEmail.replyTo = { email: "etickets@saramievents.co.ke", name: "Sarami Events Support" };
        sendSmtpEmail.to = [{ email: orderData.payerEmail, name: orderData.payerName }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`[EMAIL] Ticket sent to ${orderData.payerEmail}`);
        await setOrder(orderId, { emailStatus: 'SENT' });
        return true;
    } catch (err) {
        console.error('[EMAIL FAIL]', err.response?.text || err.message);
        await setOrder(orderId, { emailStatus: 'FAILED' });
        return false;
    }
}

// ─── WEB TICKET PAGE ───
app.get('/api/ticket/:orderId', async (req, res) => {
    try {
        if (!isUuid(req.params.orderId)) return res.status(404).send('<h1>Ticket Not Found</h1>');
        const { data: orderData, error } = await supabase.from('orders').select('*').eq('id', req.params.orderId).single();
        if (error || !orderData) return res.status(404).send('<h1>Ticket Not Found</h1>');
        if (orderData.status !== 'PAID') return res.status(403).send('<h1>Payment for this ticket is pending or failed.</h1>');

        const config = getEventConfig(orderData.eventId);
        const name = esc(orderData.payerName);
        const venueParts = config.venue.split('•');

        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Entry Pass - ${name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&family=Playfair+Display:ital,wght@0,400;1,400&family=Montserrat:wght@300;400;500;600&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Montserrat', sans-serif; background-color: #f8fafc; }
        .serif-font { font-family: 'Playfair Display', serif; }
        .cinzel-font { font-family: 'Cinzel', serif; }
        .gold-plate { position: relative; background: linear-gradient(135deg, #BF953F 0%, #FCF6BA 25%, #B38728 50%, #FBF5B7 75%, #AA771C 100%); padding: 2px; border-radius: 6px; overflow: hidden; display: inline-block; width: 100%; }
        .gold-inner { background: linear-gradient(135deg, #fdfbf7 0%, #fffcf5 100%); border-radius: 4px; padding: 12px 16px; height: 100%; position: relative; z-index: 2; }
        .gold-text { color: #00205B; }
        @media print {
            .print-btn { display: none !important; }
            body { background-color: white; }
            .ticket-container { box-shadow: none !important; }
        }
    </style>
</head>
<body class="flex flex-col items-center justify-center min-h-screen p-4 py-10">
    <div class="mb-8 print-btn">
        <button onclick="window.print()" class="text-white text-sm font-semibold uppercase tracking-widest px-8 py-4 rounded shadow-lg" style="background: linear-gradient(135deg, #BF953F, #B38728);">Save / Print Pass</button>
    </div>
    <div class="ticket-container bg-white w-full max-w-md shadow-2xl border border-gray-200 overflow-hidden">
        <div class="p-10 text-center" style="background: ${config.bgGradient}; border-bottom: 4px solid ${config.accentColor};">
            <h1 class="text-3xl text-white tracking-[0.2em] uppercase cinzel-font font-bold">${config.ticketHeader}</h1>
            <p class="text-[10px] font-bold tracking-[0.3em] mt-3 uppercase" style="color: ${config.accentColor};">${config.title}</p>
        </div>
        <div class="p-10 text-center bg-[#fafaf9] border-b border-gray-200">
            <p class="serif-font italic text-gray-500 mb-6 text-lg">Show this code at the entrance</p>
            <div class="bg-white p-3 inline-block rounded-sm shadow-md border border-gray-100">
                <img src="${qrUrl(req.params.orderId, config, 300)}" alt="Entry QR code" class="w-56 h-56 mx-auto">
            </div>
            <p class="mt-4 text-[10px] font-mono text-gray-400 tracking-widest uppercase">ID: ${esc(req.params.orderId.substring(0, 8))}</p>
        </div>
        <div class="p-10 bg-white">
            <div class="grid grid-cols-2 gap-y-8 gap-x-4 text-left">
                <div><p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Name of Guest</p>
                    <div class="gold-plate"><div class="gold-inner"><span class="cinzel-font text-base font-bold gold-text leading-tight">${name}</span></div></div></div>
                <div><p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 text-right mr-1">Ticket</p>
                    <div class="gold-plate"><div class="gold-inner text-right"><span class="cinzel-font text-base font-bold gold-text">${esc(tierLabel(orderData.packageTier))}</span></div></div></div>
                <div><p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Admit</p>
                    <div class="gold-plate"><div class="gold-inner"><span class="cinzel-font text-sm font-bold gold-text">${Number(orderData.quantity) || 1} Person(s)</span></div></div></div>
                <div><p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 text-right mr-1">Dietary</p>
                    <div class="gold-plate"><div class="gold-inner text-right"><span class="cinzel-font text-sm font-bold gold-text">${esc(orderData.dietaryPreference || 'None')}</span></div></div></div>
                ${orderData.position ? `<div class="col-span-2"><p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Position</p>
                    <div class="gold-plate"><div class="gold-inner"><span class="cinzel-font text-sm font-bold gold-text">${esc(orderData.position)}</span></div></div></div>` : ''}
                <div class="col-span-2 border-t border-gray-100 pt-6 mt-2">
                    <p class="text-[9px] text-gray-400 uppercase tracking-widest font-semibold mb-2 ml-1">Venue & Time</p>
                    <div class="bg-slate-50 border border-slate-200 text-gray-800 px-5 py-4 rounded-lg text-sm leading-relaxed">
                        ${esc(venueParts[0].trim())}${venueParts[1] ? `<span class="text-gray-500 text-xs mt-1.5 block">${esc(venueParts[1].trim())}</span>` : ''}
                    </div>
                </div>
            </div>
        </div>
    </div>
</body>
</html>`);
    } catch (e) {
        res.status(500).send('Error loading ticket.');
    }
});

// ─── CREATE ORDER (PAID TICKETS, STK PUSH) ───
app.post('/api/create-order', async (req, res) => {
    if (MAINTENANCE_MODE) return res.status(503).json({ success: false, error: 'MAINTENANCE_MODE_ACTIVE' });
    if (!CALLBACK_SECRET) {
        console.error('[CONFIG] CALLBACK_SECRET is not set. Refusing to start payments.');
        return res.status(503).json({ success: false, error: 'PAYMENTS_NOT_CONFIGURED' });
    }

    const body = req.body || {};
    const config = findEvent(body.eventId);
    if (!config) return res.status(400).json({ success: false, error: 'Unknown event.' });

    const tier = clean(body.packageTier || 'GENERAL', 20).toUpperCase();
    const unitPrice = config.tiers?.[tier];
    if (!unitPrice) return res.status(400).json({ success: false, error: 'This ticket type is not available.' });

    const qty = parseInt(body.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > (config.maxQty || 10)) {
        return res.status(400).json({ success: false, error: `You can buy between 1 and ${config.maxQty || 10} tickets.` });
    }

    const payerName = clean(body.payerName, 80);
    const payerEmail = clean(body.payerEmail, 120).toLowerCase();
    const payerPhone = formatPhone(body.payerPhone);
    if (!payerName || !isValidEmail(payerEmail)) return res.status(400).json({ success: false, error: 'Enter your full name and a valid email address.' });
    if (!isValidKePhone(payerPhone)) return res.status(400).json({ success: false, error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });
    const amount = unitPrice * qty; // ← computed on the server, never trusted from the browser
    let createdOrderId;

    try {
        const { data: newOrder, error: dbError } = await supabase.from('orders').insert({
            payerName, payerEmail, payerPhone, amount, quantity: qty,
            packageTier: tier,
            dietaryPreference: clean(body.dietaryPreference || 'None', 30),
            clubName: clean(body.clubName || 'N/A', 100),
            eventName: config.title,
            eventId: body.eventId,
            paymentMethod: 'STK',
            status: 'INITIATED',
            emailStatus: 'PENDING',
            attended: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }).select().single();

        if (dbError) throw dbError;
        createdOrderId = newOrder.id;

        const token = await getAuthToken();
        const merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;

        await axios.post(process.env.INFINITIPAY_STKPUSH_URL, {
            transactionId: merchantTxId,
            transactionReference: createdOrderId,
            amount,
            merchantId: "139",
            transactionTypeId: 1,
            payerAccount: payerPhone,
            narration: `Event: ${payerName}`.slice(0, 40),
            callbackURL: `${PUBLIC_BASE_URL}/api/payment-callback/${CALLBACK_SECRET}`,
            ptyId: 1,
            promptDisplayAccount: "Sarami Events"
        }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });

        await setOrder(createdOrderId, { merchantRequestID: merchantTxId, status: 'STK_SENT' });
        res.status(200).json({ success: true, orderId: createdOrderId });
    } catch (err) {
        const errMsg = err.response?.data || err.message || 'Unknown error';
        console.error('[CREATE-ORDER ERROR]', typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
        if (createdOrderId) await setOrder(createdOrderId, { status: 'FAILED', reason: errMsg });
        res.status(502).json({ success: false, error: 'STK_FAILED' });
    }
});

// ─── INVITED GUESTS: CHECK LINK ───
async function countInvites(eventId) {
    const { count, error } = await supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('eventId', eventId).eq('paymentMethod', 'INVITE');
    if (error) throw error;
    return count || 0;
}

function inviteCodeOk(config, code) {
    if (!config?.invite) return false;
    const expected = process.env[config.invite.codeEnv];
    return !!expected && safeEqual(clean(code, 100), expected);
}

app.get('/api/invite-check', async (req, res) => {
    try {
        const config = findEvent(req.query.eventId);
        if (!inviteCodeOk(config, req.query.code)) return res.json({ valid: false });
        const used = await countInvites(req.query.eventId);
        res.json({ valid: true, open: used < config.invite.cap });
    } catch (e) {
        console.error('[INVITE-CHECK ERROR]', e.message);
        res.status(500).json({ valid: false, error: 'SERVER_ERROR' });
    }
});

// ─── INVITED GUESTS: RSVP (FREE, ISSUES QR TICKET) ───
app.post('/api/rsvp', async (req, res) => {
    if (MAINTENANCE_MODE) return res.status(503).json({ success: false, error: 'MAINTENANCE_MODE_ACTIVE' });

    const body = req.body || {};
    const eventId = body.eventId;
    const config = findEvent(eventId);
    if (!inviteCodeOk(config, body.inviteCode)) {
        return res.status(403).json({ success: false, error: 'INVALID_INVITE', message: 'This invite link is not valid.' });
    }

    const payerName = clean(body.payerName, 80);
    const payerEmail = clean(body.payerEmail, 120).toLowerCase();
    const payerPhone = formatPhone(body.payerPhone);
    if (!payerName || !isValidEmail(payerEmail)) return res.status(400).json({ success: false, message: 'Enter your full name and a valid email address.' });
    if (!isValidKePhone(payerPhone)) return res.status(400).json({ success: false, message: 'Enter a valid Kenyan mobile number, e.g. 0712 345 678.' });
    const position = cleanPosition(body.position);
    if (!position) return res.status(400).json({ success: false, message: 'Select your position.' });
    const clubName = clean(body.clubName, 100);
    if (!clubName) return res.status(400).json({ success: false, message: 'Enter your club or organisation.' });

    try {
        // One RSVP per phone number. If they already RSVP'd, re-send the pass to the email on file.
        const { data: existing } = await supabase.from('orders').select('*')
            .eq('eventId', eventId).eq('paymentMethod', 'INVITE').eq('payerPhone', payerPhone).limit(1);
        if (existing && existing.length) {
            await sendConfirmationEmail(existing[0], existing[0].id);
            return res.status(409).json({
                success: false, error: 'ALREADY_RSVPD',
                message: "This phone number has already RSVP'd. We've re-sent the entry pass to the email used at the time."
            });
        }

        if (await countInvites(eventId) >= config.invite.cap) {
            return res.status(410).json({ success: false, error: 'FULL', message: 'Invited-guest places are now full.' });
        }

        const orderData = {
            payerName, payerEmail, payerPhone,
            amount: 0,
            quantity: 1,
            packageTier: 'INVITED',
            position,
            dietaryPreference: clean(body.dietaryPreference || 'None', 30),
            clubName,
            eventName: config.title,
            eventId,
            status: 'PAID',          // treated as a valid ticket everywhere else
            paymentMethod: 'INVITE',
            emailStatus: 'PENDING',
            attended: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const { data: newOrder, error } = await supabase.from('orders').insert(orderData).select().single();
        if (error) throw error;

        const emailSent = await sendConfirmationEmail(orderData, newOrder.id);
        console.log(`[RSVP] ${payerName} (${payerPhone}) for ${eventId}`);
        res.json({ success: true, orderId: newOrder.id, emailSent });
    } catch (err) {
        console.error('[RSVP ERROR]', err.message);
        res.status(500).json({ success: false, message: 'Something went wrong saving your RSVP. Please try again.' });
    }
});

// ─── MANUAL TICKET CREATION (ADMIN ONLY) ───
app.post('/api/manual-order', requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!b.payerName || !b.payerEmail) return res.status(400).json({ success: false, error: 'Name and Email are required' });

    try {
        const config = getEventConfig(b.eventId);
        const orderData = {
            payerName: clean(b.payerName, 80),
            payerEmail: clean(b.payerEmail, 120).toLowerCase(),
            payerPhone: formatPhone(b.payerPhone) || 'N/A',
            amount: Number(b.amount) || 0,
            quantity: Number(b.quantity) || 1,
            packageTier: clean(b.packageTier || 'GENERAL', 20).toUpperCase(),
            position: cleanPosition(b.position) || null,
            dietaryPreference: clean(b.dietaryPreference || 'None', 30),
            clubName: clean(b.clubName || 'N/A', 100),
            eventName: b.eventName || config.title,
            eventId: findEvent(b.eventId) ? b.eventId : 'MASS_INDUCTION_2026',
            status: 'PAID',
            paymentMethod: 'MANUAL_ENTRY',
            emailStatus: 'PENDING',
            attended: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const { data: newOrder, error } = await supabase.from('orders').insert(orderData).select().single();
        if (error) throw error;

        await sendConfirmationEmail(orderData, newOrder.id);
        res.status(200).json({ success: true, orderId: newOrder.id, message: 'Ticket created and emailed successfully!' });
    } catch (err) {
        console.error('[MANUAL ORDER ERROR]', err.message);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// ─── PAYMENT CALLBACK ───
// The secret in the URL stops anyone else from faking a "payment successful" message.
async function handlePaymentCallback(req, res) {
    let data = req.body || {};
    if (data.Body?.stkCallback) data = data.Body.stkCallback;
    const resultsObj = data.results || {};
    let orderId = null; // declared outside try so the catch block can log it

    try {
        let orderDoc = null;
        const possibleDocId = data.transactionReference || data.reference || resultsObj.transactionReference;

        if (possibleDocId && isUuid(possibleDocId)) {
            const { data: docSnap } = await supabase.from('orders').select('*').eq('id', possibleDocId).single();
            if (docSnap) { orderDoc = docSnap; orderId = docSnap.id; }
        }

        if (!orderId) {
            const possibleIds = [
                resultsObj.merchantTxnId, data.merchantRequestId, data.MerchantRequestID, data.merchantRequestID,
                data.checkoutRequestId, data.CheckoutRequestID, data.transactionId, data.TransactionId, resultsObj.transactionId
            ];
            const mReqId = possibleIds.find(id => id && typeof id === 'string' && id.trim());
            if (mReqId) {
                const { data: matched } = await supabase.from('orders').select('*').eq('merchantRequestID', mReqId).limit(1);
                if (matched && matched.length) { orderDoc = matched[0]; orderId = orderDoc.id; }
            }
        }

        if (!orderId) {
            console.error('[CALLBACK] Order not found.');
            return res.status(200).send('OK');
        }

        // Already paid? Don't downgrade it and don't email twice.
        if (orderDoc.status === 'PAID') {
            console.log(`[CALLBACK] Duplicate callback ignored for ${orderId}`);
            return res.status(200).send('OK');
        }

        const resultCode = data.statusCode ?? data.ResultCode ?? data.resultCode;
        const statusStr = String(data.status || data.Status || '').toUpperCase();
        let isSuccess = [0, '0', 200, '200'].includes(resultCode) || ['SUCCESS', 'COMPLETED', 'PAID'].includes(statusStr);
        let reason = data.message || data.ResultDesc || data.resultDesc || data.ResultDescription || 'No reason provided';

        // If the provider reports an amount, make sure it covers the order
        const paidAmount = Number(resultsObj.amount ?? data.amount ?? data.Amount);
        if (isSuccess && Number.isFinite(paidAmount) && paidAmount > 0 && paidAmount < Number(orderDoc.amount)) {
            isSuccess = false;
            reason = `AMOUNT_MISMATCH: paid ${paidAmount}, expected ${orderDoc.amount}`;
        }

        let receipt = 'N/A';
        if (resultsObj.mnoRef && resultsObj.mnoRef !== "0") receipt = resultsObj.mnoRef;
        else if (data.MpesaReceiptNumber) receipt = data.MpesaReceiptNumber;
        else if (data.receiptNumber) receipt = data.receiptNumber;

        if (isSuccess) console.log(`[PAYMENT SUCCESS] Order: ${orderId}`);
        else console.warn(`[PAYMENT FAILED] Order: ${orderId} | Phone: ${orderDoc.payerPhone} | Reason: ${reason}`);

        await setOrder(orderId, {
            status: isSuccess ? 'PAID' : 'FAILED',
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            reason,
            mpesaReceipt: receipt,
            rawCallback: data,
            resultCode: String(resultCode ?? (statusStr || -1))
        });

        if (isSuccess) {
            const { data: updatedDoc } = await supabase.from('orders').select('*').eq('id', orderId).single();
            sendConfirmationEmail(updatedDoc, orderId).catch(console.error);
        }
    } catch (e) {
        console.error('[CALLBACK ERROR] Order:', orderId, 'Error:', e);
    }

    res.status(200).send('OK');
}

app.post('/api/payment-callback/:secret', (req, res) => {
    if (!CALLBACK_SECRET || !safeEqual(req.params.secret, CALLBACK_SECRET)) {
        console.warn('[CALLBACK] Rejected callback with wrong secret from', req.ip);
        return res.status(200).send('OK');
    }
    return handlePaymentCallback(req, res);
});

// Old unsigned URL: ignored on purpose (anyone could post fake "success" messages to it)
app.post('/api/payment-callback', (req, res) => {
    console.warn('[CALLBACK] Unsigned callback ignored from', req.ip);
    res.status(200).send('OK');
});

// ─── SCANNER CHECK-IN (PIN REQUIRED) ───
app.post('/api/check-in', requireScanner, async (req, res) => {
    const ticketId = extractTicketId(req.body?.ticketId);
    const eventId = req.body?.eventId;
    const fail = (message, extra = {}, kind = 'denied') => {
        io.emit('scan_error', { message, kind, eventId: eventId || null, name: extra.name || null });
        return res.json({ success: false, message, kind, ...extra });
    };

    if (!ticketId || !isUuid(ticketId)) return fail('Not a Sarami ticket. Ask the guest for their entry pass.');

    try {
        const { data: orderDoc, error } = await supabase.from('orders').select('*').eq('id', ticketId).single();
        if (error || !orderDoc) return fail('Ticket not found.');

        if (eventId && orderDoc.eventId !== eventId) {
            return fail(`This ticket is for ${getEventConfig(orderDoc.eventId).title}, not tonight's event.`, { name: orderDoc.payerName });
        }
        if (orderDoc.status !== 'PAID') return fail(`Ticket not paid (status: ${orderDoc.status}).`, { name: orderDoc.payerName });

        if (orderDoc.attended) {
            return fail('Ticket already used.', { name: orderDoc.payerName, checkInTime: orderDoc.checkInTime, qty: orderDoc.quantity }, 'used');
        }

        // Only flips attended if it was still false, so two phones scanning the same code can't both admit it
        const { data: updated, error: updErr } = await supabase.from('orders')
            .update({ attended: true, checkInTime: new Date().toISOString() })
            .eq('id', ticketId).eq('attended', false)
            .select();
        if (updErr) throw updErr;
        if (!updated || !updated.length) return fail('Ticket already used.', { name: orderDoc.payerName }, 'used');

        const info = {
            name: orderDoc.payerName,
            tier: tierLabel(orderDoc.packageTier),
            qty: Number(orderDoc.quantity) || 1,
            club: orderDoc.clubName,
            position: orderDoc.position || '',
            diet: orderDoc.dietaryPreference,
            invited: orderDoc.paymentMethod === 'INVITE'
        };
        io.emit('vip_checked_in', { ...info, eventId: orderDoc.eventId });
        res.json({ success: true, ...info });
    } catch (e) {
        console.error("[SCANNER ERROR]", e);
        io.emit('scan_error', { message: 'System error. Try again.', kind: 'error', eventId: eventId || null });
        res.status(500).json({ success: false, message: "System error. Try again." });
    }
});

// Lets the scanner page confirm the PIN before opening the camera
app.post('/api/scanner-login', requireScanner, (req, res) => res.json({ success: true }));

// ─── DOOR GUEST LIST (PIN REQUIRED) ───
// Only what door staff need to find a guest: no emails, phone shown as last 4 digits.
app.get('/api/guest-list', requireScanner, async (req, res) => {
    try {
        const config = findEvent(req.query.eventId);
        if (!config) return res.status(400).json({ success: false, message: 'Unknown event.' });
        const { data, error } = await supabase.from('orders')
            .select('id, payerName, payerPhone, clubName, position, quantity, packageTier, paymentMethod, attended, checkInTime')
            .eq('eventId', req.query.eventId).eq('status', 'PAID')
            .order('payerName', { ascending: true });
        if (error) throw error;
        res.json({
            success: true,
            guests: data.map(g => ({
                id: g.id,
                name: g.payerName || 'Guest',
                phoneLast4: String(g.payerPhone || '').slice(-4),
                club: g.clubName && g.clubName !== 'N/A' ? g.clubName : '',
                position: g.position || '',
                qty: Number(g.quantity) || 1,
                tier: tierLabel(g.packageTier),
                invited: g.paymentMethod === 'INVITE',
                attended: !!g.attended,
                checkInTime: g.checkInTime
            }))
        });
    } catch (e) {
        console.error('[GUEST LIST ERROR]', e.message);
        res.status(500).json({ success: false, message: 'Could not load guest list.' });
    }
});

// ─── MANUAL ATTENDANCE TOGGLE (ADMIN) ───
app.post('/api/toggle-attendance/:id', requireAdmin, async (req, res) => {
    try {
        const { data: orderDoc, error } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
        if (error || !orderDoc) return res.status(404).json({ success: false, message: "Order not found" });

        const newStatus = !orderDoc.attended;
        await supabase.from('orders')
            .update({ attended: newStatus, checkInTime: newStatus ? new Date().toISOString() : null })
            .eq('id', req.params.id);
        res.json({ success: true, attended: newStatus });
    } catch (e) {
        console.error("[TOGGLE ERROR]", e);
        res.status(500).json({ success: false, message: "Server error toggling status." });
    }
});

// ─── DOOR SCANNER PAGE ───
app.get('/scanner', (req, res) => res.sendFile(path.join(__dirname, 'scanner.html')));

// ─── LIVE STATS (ADMIN)  •  optional ?eventId=MASS_INDUCTION_2026 ───
app.get('/api/live-stats', requireAdmin, async (req, res) => {
    try {
        let query = supabase.from('orders').select('*').order('createdAt', { ascending: false });
        if (req.query.eventId) query = query.eq('eventId', req.query.eventId);
        const { data: allOrdersData, error } = await query;
        if (error) throw error;

        let totalTickets = 0, totalRevenue = 0, lionsCount = 0, leosCount = 0, invitedCount = 0, checkedIn = 0;
        const tierCounts = {};
        const allOrders = [];

        allOrdersData.forEach(d => {
            const qty = Number(d.quantity) || 1;
            if (d.status === 'PAID') {
                totalTickets += qty;
                totalRevenue += Number(d.amount) || 0;
                tierCounts[d.packageTier] = (tierCounts[d.packageTier] || 0) + qty;
                if (d.packageTier === 'LIONS') lionsCount += qty;
                if (d.packageTier === 'LEOS') leosCount += qty;
                if (d.paymentMethod === 'INVITE') invitedCount += qty;
                if (d.attended) checkedIn += qty;
            }
            allOrders.push({
                id: d.id,
                time: new Date(d.updatedAt || d.createdAt),
                eventId: d.eventId,
                name: d.payerName || 'N/A',
                phone: d.payerPhone || 'N/A',
                email: d.payerEmail || 'N/A',
                tier: d.packageTier || 'N/A',
                paymentMethod: d.paymentMethod || 'N/A',
                position: d.position || 'N/A',
                clubName: d.clubName || 'N/A',
                dietaryPreference: d.dietaryPreference || 'None',
                qty,
                amount: Number(d.amount) || 0,
                status: (d.status || d.paymentStatus || 'unknown').toLowerCase(),
                failureReason: d.reason || 'No reason provided',
                emailStatus: d.emailStatus || 'PENDING',
                mpesaReceipt: d.mpesaReceipt || 'N/A',
                merchantTxId: d.merchantRequestID || 'N/A',
                attended: d.attended || false,
                checkInTime: d.checkInTime ? new Date(d.checkInTime) : null
            });
        });

        allOrders.sort((a, b) => b.time - a.time);
        res.json({
            success: true, totalTickets, totalRevenue, lionsCount, leosCount, invitedCount, checkedIn, tierCounts,
            recentOrders: allOrders.filter(o => o.status === 'paid').slice(0, 15),
            allOrders,
            lastUpdated: new Date().toISOString()
        });
    } catch (e) {
        console.error('[STATS ERROR RAW]', e);
        res.status(500).json({ success: false, error: 'Could not fetch stats' });
    }
});

// ─── RESEND TICKET EMAIL (ADMIN) ───
app.post('/api/resend-ticket/:id', requireAdmin, async (req, res) => {
    try {
        const { data: orderData, error } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
        if (error || !orderData) return res.status(404).json({ success: false, message: "Order not found" });
        if (orderData.status !== 'PAID') return res.status(400).json({ success: false, message: "Order must be marked as PAID first." });

        const ok = await sendConfirmationEmail(orderData, req.params.id);
        res.status(ok ? 200 : 502).json({ success: ok, message: ok ? "Ticket email sent." : "Email provider rejected the message." });
    } catch (error) {
        console.error("[RESEND ERROR]", error);
        res.status(500).json({ success: false, message: "Failed to send email." });
    }
});

// ─── DELETE RECORD (ADMIN) ───
app.delete('/api/delete-record/:id', requireAdmin, async (req, res) => {
    try {
        const { error } = await supabase.from('orders').delete().eq('id', req.params.id);
        if (error) throw error;
        console.log(`[DELETE] Deleted record: ${req.params.id}`);
        res.status(200).json({ success: true, message: "Record permanently deleted" });
    } catch (error) {
        console.error("[DELETE ERROR]", error);
        res.status(500).json({ success: false, message: "Failed to delete record" });
    }
});

// ─── ORDER STATUS (used by the booking page while waiting for M-Pesa) ───
// Returns only the status, not the guest's personal details.
app.get('/api/order-status/:orderId', async (req, res) => {
    try {
        if (!isUuid(req.params.orderId)) return res.status(404).json({ status: 'NOT_FOUND' });
        const { data, error } = await supabase.from('orders').select('status, reason').eq('id', req.params.orderId).single();
        if (error || !data) return res.status(404).json({ status: 'NOT_FOUND' });
        res.json({ status: data.status, reason: data.status === 'FAILED' ? data.reason : undefined });
    } catch (e) {
        res.status(500).json({ status: 'ERROR' });
    }
});

// ─── START ───
const HOST = '0.0.0.0';
const port = process.env.PORT || 10000;
server.listen(port, HOST, () => {
    console.log(`Server listening on http://${HOST}:${port}`);
    if (!ADMIN_KEY) console.warn('⚠️  ADMIN_KEY not set: dashboard endpoints are locked.');
    if (!SCANNER_PIN) console.warn('⚠️  SCANNER_PIN not set: only ADMIN_KEY can use the scanner.');
    if (!CALLBACK_SECRET) console.warn('⚠️  CALLBACK_SECRET not set: STK payments are disabled.');
});
