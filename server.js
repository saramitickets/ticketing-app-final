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
const CLIENT_KEY = process.env.CLIENT_KEY || '';            // read-only access code for the organisers' registry page
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
        emailSubject: "Your entry pass: Mass Induction Dinner, 27 Nov",
        venue: "Lions Service Centre, Loresho • 27th November 2026 at 6:30 PM",
        primaryColor: "#00338D",
        accentColor: "#F2A900",
        bgGradient: "linear-gradient(135deg, #001f5b, #00338D)",
        buttonGradient: "linear-gradient(135deg, #F2A900, #d97706)",
        ticketHeader: "SARAMI EVENTS",
        details: {
            name: 'Mass Induction Dinner',
            year: '2026',
            date: 'Friday, 27th November 2026',
            shortDate: 'Fri, 27 Nov 2026',
            time: '6:30 PM',
            venue: 'Lions Service Centre',
            area: 'Loresho, Nairobi',
            mapsQuery: 'Lions Service Centre, Loresho, Nairobi',
            kicker: 'Sarami Events presents',
            start: '2026-11-27T18:30:00+03:00',
            calStart: '20261127T153000Z',   // 6:30 PM Nairobi time
            calEnd: '20261127T193000Z'      // 10:30 PM Nairobi time (adjust if the dinner ends at a different time)
        },
        clientKeyEnv: 'CLIENT_KEY',          // organisers' read-only code (Lions District 411A)
        showDiet: true,                      // dinner: organisers need meal counts
        // One booking can mix these (a Lion bringing guests). Prices are set here only.
        tiers: { LIONS: 1000, GUEST: 2500 },
        // From this moment (Nairobi time) the early prices end and everyone pays one price.
        // Change the time in Render with MASS_PRICE_CHANGE_AT if needed, e.g. 2026-11-27T12:00:00+03:00
        priceChange: { at: process.env.MASS_PRICE_CHANGE_AT || '2026-11-27T12:00:00+03:00', tiers: { LATE: 1500 } },
        maxQty: 10,
        invite: {
            codeEnv: 'MASS_INDUCTION_INVITE_CODE',                       // set this in Render
            cap: Number(process.env.MASS_INDUCTION_INVITE_CAP) || 100   // max invited guests
        }
    },
    'MR_MISS_SAMIA_2026': {
        title: "MR & MISS SAMIA 2026",
        emailSubject: "Your entry pass: Mr & Miss Samia, 22 Dec",
        venue: "Moody Awori Primary • 22nd December 2026 at 10:00 AM",
        primaryColor: "#00338D",
        accentColor: "#F2A900",
        bgGradient: "linear-gradient(135deg, #001f5b, #00338D)",
        buttonGradient: "linear-gradient(135deg, #F2A900, #d97706)",
        ticketHeader: "SARAMI EVENTS",
        details: {
            name: 'Mr & Miss Samia',
            year: '2nd Edition',
            date: 'Tuesday, 22nd December 2026',
            shortDate: 'Tue, 22 Dec 2026',
            time: '10:00 AM till late',
            venue: 'Moody Awori Primary',
            area: 'Presented by 5th Wheel Conservatoire',
            mapsQuery: 'Moody Awori Primary School',
            kicker: '5th Wheel Conservatoire presents',
            start: '2026-12-22T10:00:00+03:00',
            calStart: '20261222T070000Z',   // 10:00 AM Nairobi time
            calEnd: '20261222T180000Z'      // 9:00 PM Nairobi time ("till late"; adjust if needed)
        },
        // One booking can mix these. Prices are set here on the server only.
        clientKeyEnv: 'SAMIA_CLIENT_KEY',    // organisers' read-only code (5th Wheel Conservatoire)
        tiers: { CHILDREN: 200, REGULAR: 500, VIP: 1000 },
        maxQty: 20
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

const TIER_LABELS = { GENERAL: 'General', INVITED: 'Invited Guest', COMPLIMENTARY: 'Complimentary', LIONS: 'Lion Member', GUEST: 'Non-Lion Guest', LATE: 'General Admission', LEOS: 'Leos', CHILDREN: 'Children', REGULAR: 'Regular', VIP: 'VIP', MIXED: 'Mixed' };

// The ticket prices that apply right now (early prices switch to one price at a set time)
function currentTiers(config) {
    const pc = config.priceChange;
    if (pc && pc.at && Date.now() >= Date.parse(pc.at)) return pc.tiers;
    return config.tiers || {};
}
const earlyPricesEnded = (config) => !!(config.priceChange && Date.now() >= Date.parse(config.priceChange.at));

// "2 × VIP · 3 × Children" for bookings that mix ticket types
function itemsSummary(items) {
    if (!Array.isArray(items) || !items.length) return '';
    return items.filter(i => i && i.qty > 0).map(i => `${i.qty} × ${tierLabel(i.tier)}`).join(' · ');
}
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
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key, X-Scanner-Pin, X-Client-Key');
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

// Organisers' read-only registry: accepts the client code (or the admin key)
function requireClient(req, res, next) {
    const key = req.get('x-client-key');
    if ((CLIENT_KEY && safeEqual(key, CLIENT_KEY)) || (ADMIN_KEY && safeEqual(key, ADMIN_KEY))) return next();
    return res.status(401).json({ success: false, message: 'Wrong access code.' });
}

// Live-sync screens must log in with the scanner PIN (or admin key) to receive guest names
io.use((socket, next) => {
    const pin = socket.handshake.auth?.pin;
    if ((SCANNER_PIN && safeEqual(pin, SCANNER_PIN)) || (ADMIN_KEY && safeEqual(pin, ADMIN_KEY))) return next();
    next(new Error('UNAUTHORIZED'));
});

// The QR holds a link to the ticket's verification page, e.g. https://…/v/<ticket id>.
// A phone camera opens the page (guest name, event, status); the door kiosk reads the ID out of the link.
// No personal data is inside the code itself.
const verifyUrl = (orderId) => `${PUBLIC_BASE_URL}/v/${orderId}`;
function qrUrl(orderId, config, size = 300) {
    const payload = verifyUrl(orderId);
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

// ─── TICKET DESIGN HELPERS ───
function eventDetails(config) {
    if (config.details) return config.details;
    const [place, when] = config.venue.split('•').map(s => (s || '').trim());
    return { name: config.title, year: '', date: when || 'TBA', time: '', venue: place, area: '', mapsQuery: place };
}

function mapsUrl(d) {
    return d.mapsQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.mapsQuery)}` : '';
}

function calendarUrl(d) {
    if (!d.calStart || !d.calEnd) return '';
    const p = new URLSearchParams({
        action: 'TEMPLATE',
        text: `${d.name}${d.year ? ' ' + d.year : ''}`,
        dates: `${d.calStart}/${d.calEnd}`,
        location: [d.venue, d.area].filter(Boolean).join(', '),
        details: 'Show your QR entry pass at the entrance.'
    });
    return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

function ticketBadge(order) {
    if (order.paymentMethod === 'INVITE') return 'Invited Guest';
    const mix = itemsSummary(order.ticketItems);
    if (mix) return mix;
    const t = tierLabel(order.packageTier);
    return t === 'General' ? 'General Admission' : t;
}

// ─── E-TICKET EMAIL ───
function buildTicketEmail(order, orderId, config) {
    const d = eventDetails(config);
    const isInvite = order.paymentMethod === 'INVITE';
    const name = esc(order.payerName);
    const qty = Number(order.quantity) || 1;
    const passUrl = `${PUBLIC_BASE_URL}/api/ticket/${orderId}`;
    const cal = calendarUrl(d);
    const map = mapsUrl(d);
    const subline = [order.position, order.clubName && order.clubName !== 'N/A' ? order.clubName : ''].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');
    const diet = order.dietaryPreference && order.dietaryPreference !== 'None' ? esc(order.dietaryPreference) : '';
    const PAGE = '#E9ECF2', NAVY = '#00205B', GOLD = '#F2A900', CREAM = '#FBF7EE', INK = '#1C2541', MUTED = '#6B7280';
    const sans = "Arial, Helvetica, sans-serif";
    const serif = "Georgia, 'Times New Roman', serif";
    const label = (t) => `<p style="margin:0 0 6px;font:bold 10px/1 ${sans};letter-spacing:2.5px;color:#9A8B5F;text-transform:uppercase;">${t}</p>`;

    const detailCell = (title, value, extra = '') => `
        <td class="stack" width="33%" valign="top" style="padding:10px 8px;text-align:center;">
            ${label(title)}
            <p style="margin:0;font:bold 15px/1.35 ${sans};color:${INK};">${value}</p>
            ${extra}
        </td>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(d.name)} entry pass</title>
<style>
  @media (max-width: 620px) {
    .px { padding-left: 22px !important; padding-right: 22px !important; }
    .h1 { font-size: 34px !important; }
    .stack { display: block !important; width: 100% !important; }
    .qr { width: 200px !important; height: 200px !important; }
  }
  a { text-decoration: none; }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};">
    ${isInvite ? 'Your RSVP is confirmed.' : 'Payment received.'} Your QR entry pass for ${esc(d.name)} on ${esc(d.date)} is inside.
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};">
<tr><td align="center" style="padding:32px 12px 40px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

    <!-- Brand -->
    <tr><td align="center" style="padding:0 0 18px;font:bold 11px/1 ${sans};letter-spacing:5px;color:${NAVY};">SARAMI EVENTS</td></tr>

    <!-- Ticket head -->
    <tr><td class="px" bgcolor="${NAVY}" style="background:${NAVY};background-image:linear-gradient(160deg,#0A3A94 0%,${NAVY} 55%,#001233 100%);border-radius:20px 20px 0 0;padding:46px 44px 40px;text-align:center;">
        <p style="margin:0 0 16px;font:italic 16px/1.4 ${serif};color:#E8C766;">${isInvite ? 'You are cordially invited to the' : 'Your seat is reserved for the'}</p>
        <h1 class="h1" style="margin:0;font:normal 42px/1.12 ${serif};color:#FFFFFF;letter-spacing:1px;">${esc(d.name)}</h1>
        ${d.year ? `<p style="margin:14px 0 0;font:bold 13px/1 ${sans};letter-spacing:8px;color:${GOLD};">${esc(d.year)}</p>` : ''}
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 0;"><tr>
            <td width="60" valign="middle"><div style="height:1px;line-height:1px;font-size:1px;background:#B8932E;">&nbsp;</div></td>
            <td style="padding:0 10px;font:12px/1 ${serif};color:${GOLD};">&#9670;</td>
            <td width="60" valign="middle"><div style="height:1px;line-height:1px;font-size:1px;background:#B8932E;">&nbsp;</div></td>
        </tr></table>
        <p style="margin:24px 0 0;font:16px/1.65 ${sans};color:#C9D6F2;">
            Dear <strong style="color:#FFFFFF;">${name}</strong>,<br>
            ${isInvite ? 'thank you for accepting our invitation. Your place is confirmed.' : 'thank you, your payment has been received.'}
        </p>
    </td></tr>

    <!-- Event details -->
    <tr><td bgcolor="${CREAM}" style="background:${CREAM};padding:26px 22px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            ${detailCell('Date', esc(d.shortDate || d.date))}
            ${detailCell('Time', esc(d.time || 'TBA'))}
            ${detailCell('Venue', `${esc(d.venue)}${d.area ? `<br><span style="font-weight:normal;color:${MUTED};font-size:13px;">${esc(d.area)}</span>` : ''}`,
                map ? `<p style="margin:8px 0 0;"><a href="${map}" style="font:bold 12px ${sans};color:${NAVY};text-decoration:underline;">Get directions</a></p>` : '')}
        </tr></table>
    </td></tr>

    <!-- Perforation -->
    <tr><td bgcolor="${CREAM}" style="background:${CREAM};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="16" height="32" style="background:${PAGE};border-radius:0 16px 16px 0;font-size:0;">&nbsp;</td>
            <td style="padding:0 10px;"><div style="border-top:2px dashed #D8CCAA;height:0;line-height:0;font-size:0;">&nbsp;</div></td>
            <td width="16" height="32" style="background:${PAGE};border-radius:16px 0 0 16px;font-size:0;">&nbsp;</td>
        </tr></table>
    </td></tr>

    <!-- Stub -->
    <tr><td class="px" bgcolor="${CREAM}" style="background:${CREAM};border-radius:0 0 20px 20px;padding:20px 44px 42px;text-align:center;">
        <span style="display:inline-block;background:${NAVY};color:${GOLD};font:bold 11px/1 ${sans};letter-spacing:3px;text-transform:uppercase;padding:9px 18px;border-radius:999px;">${esc(ticketBadge(order))}</span>
        <p style="margin:18px 0 0;font:normal 28px/1.25 ${serif};color:${NAVY};">${name}</p>
        ${subline ? `<p style="margin:8px 0 0;font:14px/1.5 ${sans};color:${MUTED};">${subline}</p>` : ''}

        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 0;"><tr>
            <td bgcolor="#FFFFFF" style="background:#FFFFFF;border:1px solid #E6DCC0;border-radius:18px;padding:14px;">
                <img class="qr" src="${qrUrl(orderId, config, 440)}" width="220" height="220" alt="Entry QR code for ${name}" style="display:block;width:220px;height:220px;border:0;">
            </td>
        </tr></table>
        <p style="margin:12px 0 0;font:13px/1.4 ${sans};color:${MUTED};">Show this code at the entrance</p>

        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 0;border-collapse:separate;"><tr>
            <td style="padding:12px 24px;border:1px solid #E6DCC0;border-radius:14px 0 0 14px;text-align:center;">
                ${label('Admit')}
                <p style="margin:0;font:bold 22px/1 ${serif};color:${NAVY};">${qty} ${qty === 1 ? 'Guest' : 'Guests'}</p>
            </td>
            <td style="padding:12px 24px;border:1px solid #E6DCC0;border-left:0;border-radius:0 14px 14px 0;text-align:center;">
                ${label('Ticket No.')}
                <p style="margin:0;font:bold 18px/1.2 'Courier New', monospace;color:${NAVY};letter-spacing:1px;">${esc(orderId.slice(0, 8).toUpperCase())}</p>
            </td>
        </tr></table>

        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:30px auto 0;"><tr>
            <td bgcolor="${GOLD}" style="background:${GOLD};border-radius:999px;">
                <a href="${passUrl}" style="display:inline-block;padding:16px 34px;font:bold 15px/1 ${sans};color:${NAVY};text-decoration:none;border-radius:999px;">Open my entry pass</a>
            </td>
        </tr></table>
        ${cal ? `<p style="margin:16px 0 0;"><a href="${cal}" style="font:bold 13px ${sans};color:${NAVY};text-decoration:underline;">Add to my calendar</a></p>` : ''}
    </td></tr>

    <!-- Notes -->
    <tr><td style="padding:28px 34px 6px;text-align:center;font:13px/1.75 ${sans};color:#5B6478;">
        Show the QR code on your phone or on paper. Each code can only be scanned once, so please don't forward this email.
        ${diet ? `<br>Dietary preference noted: <strong style="color:${INK};">${diet}</strong>.` : ''}
        <br>Questions? Call or WhatsApp <a href="tel:+254104410892" style="color:${NAVY};font-weight:bold;">+254 104 410 892</a>.
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:22px 20px 0;text-align:center;font:11px/1.6 ${sans};color:#8A93A6;letter-spacing:1px;">
        &copy; ${new Date().getFullYear()} SARAMI EVENTS &nbsp;|&nbsp; A property of Sarami Group<br>
        2nd Ngong Avenue, Bishop Gardens Tower, Upperhill, Nairobi
    </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendConfirmationEmail(orderData, orderId) {
    try {
        console.log(`[EMAIL] Generating Ticket for ${orderData.payerEmail}`);
        const config = getEventConfig(orderData.eventId);

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = config.emailSubject;
        sendSmtpEmail.htmlContent = buildTicketEmail(orderData, orderId, config);
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

// ─── WEB ENTRY PASS ───
function buildTicketPage(order, orderId, config) {
    const d = eventDetails(config);
    const isInvite = order.paymentMethod === 'INVITE';
    const name = esc(order.payerName);
    const qty = Number(order.quantity) || 1;
    const cal = calendarUrl(d);
    const map = mapsUrl(d);
    const subline = [order.position, order.clubName && order.clubName !== 'N/A' ? order.clubName : ''].filter(Boolean).map(esc).join(' · ');
    const diet = order.dietaryPreference && order.dietaryPreference !== 'None' ? esc(order.dietaryPreference) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#00205B">
<title>Entry pass · ${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
    :root { --navy:#00205B; --navy2:#0A3A94; --deep:#001233; --gold:#F2A900; --gold-soft:#E8C766; --cream:#FBF7EE; --line:#E6DCC0; --ink:#1C2541; --muted:#6B7280; --page:#E9ECF2; }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
        min-height: 100vh; padding: max(28px, env(safe-area-inset-top)) 16px max(40px, env(safe-area-inset-bottom));
        font-family: 'Inter', Arial, sans-serif; color: var(--ink);
        background: radial-gradient(ellipse at top, #F7F1E1 0%, var(--page) 55%);
        display: flex; flex-direction: column; align-items: center;
    }
    .brand { font: 700 11px/1 'Inter', Arial, sans-serif; letter-spacing: 5px; color: var(--navy); margin: 0 0 18px; }
    .ticket { width: 100%; max-width: 440px; filter: drop-shadow(0 24px 40px rgba(0,32,91,.18)); }

    .head {
        position: relative; overflow: hidden; text-align: center; color: #fff;
        background: linear-gradient(160deg, var(--navy2) 0%, var(--navy) 55%, var(--deep) 100%);
        border-radius: 22px 22px 0 0; padding: 40px 28px 34px;
    }
    .head::before {
        content: ""; position: absolute; inset: 12px; border: 1px solid rgba(242,169,0,.35); border-radius: 14px; pointer-events: none;
    }
    .kicker { font: italic 500 15px/1.4 Georgia, serif; color: var(--gold-soft); margin: 0 0 14px; }
    h1 { font: 700 clamp(30px, 8vw, 38px)/1.08 'Cinzel', Georgia, serif; margin: 0; letter-spacing: .5px; }
    .year { font: 700 12px/1 'Inter', sans-serif; letter-spacing: 8px; color: var(--gold); margin: 14px 0 0; }
    .rule { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 22px 0 0; color: var(--gold); font-size: 10px; }
    .rule::before, .rule::after { content: ""; width: 56px; height: 1px; background: var(--gold); opacity: .7; }

    .body { background: var(--cream); }
    .details { display: grid; grid-template-columns: 1fr 1fr; gap: 18px 12px; padding: 26px 26px 6px; }
    .details .venue { grid-column: 1 / -1; }
    .lbl { font: 700 10px/1 'Inter', sans-serif; letter-spacing: 2.5px; text-transform: uppercase; color: #9A8B5F; margin: 0 0 7px; }
    .val { font: 600 15px/1.35 'Inter', sans-serif; margin: 0; }
    .val small { display: block; font-weight: 400; color: var(--muted); font-size: 13px; margin-top: 2px; }

    .perf { position: relative; height: 34px; background: var(--cream); }
    .perf::before, .perf::after { content: ""; position: absolute; top: 0; width: 34px; height: 34px; border-radius: 50%; background: var(--page); }
    .perf::before { left: -17px; } .perf::after { right: -17px; }
    .perf span { position: absolute; left: 24px; right: 24px; top: 16px; border-top: 2px dashed #D8CCAA; }

    .stub { background: var(--cream); border-radius: 0 0 22px 22px; padding: 10px 26px 32px; text-align: center; }
    .badge { display: inline-block; background: var(--navy); color: var(--gold); font: 700 11px/1 'Inter', sans-serif; letter-spacing: 3px; text-transform: uppercase; padding: 9px 18px; border-radius: 999px; }
    .name { font: 500 26px/1.2 'Cinzel', Georgia, serif; color: var(--navy); margin: 16px 0 0; overflow-wrap: anywhere; }
    .sub { color: var(--muted); font-size: 14px; margin: 8px 0 0; }

    .qr { display: inline-block; margin: 24px 0 0; padding: 14px; background: #fff; border: 1px solid var(--line); border-radius: 20px; position: relative; }
    .qr img { display: block; width: min(240px, 62vw); height: auto; aspect-ratio: 1; }
    .qr::before, .qr::after { content: ""; position: absolute; width: 26px; height: 26px; border-color: var(--gold); border-style: solid; }
    .qr::before { top: -6px; left: -6px; border-width: 3px 0 0 3px; border-radius: 10px 0 0 0; }
    .qr::after { bottom: -6px; right: -6px; border-width: 0 3px 3px 0; border-radius: 0 0 10px 0; }
    .hint { font-size: 13px; color: var(--muted); margin: 12px 0 0; }

    .facts { display: grid; grid-template-columns: 1fr 1fr; margin: 24px 0 0; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
    .facts div { padding: 14px 10px; }
    .facts div + div { border-left: 1px solid var(--line); }
    .facts .big { font: 700 22px/1 'Cinzel', Georgia, serif; color: var(--navy); margin: 0; }
    .facts .mono { font: 700 17px/1.2 'Courier New', monospace; color: var(--navy); letter-spacing: 1px; margin: 0; }
    .diet { margin: 18px 0 0; font-size: 13px; color: var(--muted); }
    .diet strong { color: var(--ink); }

    .actions { width: 100%; max-width: 440px; display: grid; gap: 10px; margin: 26px 0 0; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 15px 18px; border-radius: 999px; font: 700 15px/1 'Inter', sans-serif; text-decoration: none; cursor: pointer; border: 0; }
    .btn-gold { background: var(--gold); color: var(--navy); }
    .btn-line { background: #fff; color: var(--navy); border: 1px solid #CBD3E3; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .btn:focus-visible { outline: 3px solid var(--navy); outline-offset: 3px; }
    .note { max-width: 440px; text-align: center; font-size: 12.5px; line-height: 1.7; color: #5B6478; margin: 22px 0 0; }

    @media print {
        body { background: #fff; padding: 0; }
        .ticket { filter: none; }
        .actions, .note { display: none; }
        .perf::before, .perf::after { background: #fff; }
    }
</style>
</head>
<body>
    <p class="brand">SARAMI EVENTS</p>

    <main class="ticket" aria-label="Entry pass">
        <section class="head">
            <p class="kicker">${isInvite ? 'You are cordially invited to the' : 'Your seat is reserved for the'}</p>
            <h1>${esc(d.name)}</h1>
            ${d.year ? `<p class="year">${esc(d.year)}</p>` : ''}
            <div class="rule" aria-hidden="true">&#9670;</div>
        </section>

        <section class="body details">
            <div><p class="lbl">Date</p><p class="val">${esc(d.shortDate || d.date)}</p></div>
            <div><p class="lbl">Time</p><p class="val">${esc(d.time || 'TBA')}</p></div>
            <div class="venue"><p class="lbl">Venue</p><p class="val">${esc(d.venue)}${d.area ? `<small>${esc(d.area)}</small>` : ''}</p></div>
        </section>

        <div class="perf" aria-hidden="true"><span></span></div>

        <section class="stub">
            <span class="badge">${esc(ticketBadge(order))}</span>
            <p class="name">${name}</p>
            ${subline ? `<p class="sub">${subline}</p>` : ''}
            <div class="qr"><img src="${qrUrl(orderId, config, 480)}" alt="Entry QR code"></div>
            <p class="hint">Show this code at the entrance</p>
            <div class="facts">
                <div><p class="lbl">Admit</p><p class="big">${qty} ${qty === 1 ? 'Guest' : 'Guests'}</p></div>
                <div><p class="lbl">Ticket No.</p><p class="mono">${esc(orderId.slice(0, 8).toUpperCase())}</p></div>
            </div>
            ${diet ? `<p class="diet">Dietary preference: <strong>${diet}</strong></p>` : ''}
        </section>
    </main>

    <div class="actions">
        <button class="btn btn-gold" onclick="window.print()">Save or print pass</button>
        ${cal || map ? `<div class="row">
            ${cal ? `<a class="btn btn-line" href="${cal}" target="_blank" rel="noopener">Add to calendar</a>` : ''}
            ${map ? `<a class="btn btn-line" href="${map}" target="_blank" rel="noopener">Directions</a>` : ''}
        </div>` : ''}
    </div>
    <p class="note">Tip: take a screenshot so you have it even without internet. Each code can only be scanned once, so please don't share it.<br>Need help? +254 104 410 892</p>
</body>
</html>`;
}

app.get('/api/ticket/:orderId', async (req, res) => {
    try {
        if (!isUuid(req.params.orderId)) return res.status(404).send('<h1>Ticket Not Found</h1>');
        const { data: orderData, error } = await supabase.from('orders').select('*').eq('id', req.params.orderId).single();
        if (error || !orderData) return res.status(404).send('<h1>Ticket Not Found</h1>');
        if (orderData.status !== 'PAID') return res.status(403).send('<h1>Payment for this ticket is pending or failed.</h1>');
        res.send(buildTicketPage(orderData, req.params.orderId, getEventConfig(orderData.eventId)));
    } catch (e) {
        res.status(500).send('Error loading ticket.');
    }
});

// ─── TICKET VERIFICATION PAGE (opened by scanning the QR with any phone camera) ───
// Shows who the ticket belongs to, the event, and whether it is valid or already used.
// No phone numbers, emails or payment details.
function buildVerifyPage(order, orderId, config) {
    const d = eventDetails(config);
    const tz = { timeZone: 'Africa/Nairobi' };
    const inTime = order.checkInTime ? new Date(order.checkInTime).toLocaleString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '';
    let state, title, note;
    if (order.status === 'PAID' && order.attended) { state = 'used'; title = 'Already checked in'; note = inTime ? `This ticket was scanned at the entrance on ${esc(inTime)}.` : 'This ticket has already been used at the entrance.'; }
    else if (order.status === 'PAID') { state = 'ok'; title = 'Valid ticket'; note = 'This entry pass is confirmed. Show it at the entrance to be checked in.'; }
    else if (order.status === 'PENDING_APPROVAL') { state = 'wait'; title = 'Awaiting approval'; note = 'This invitation has not been confirmed by the organisers yet.'; }
    else { state = 'bad'; title = 'Not a valid ticket'; note = 'This booking was not completed or has been cancelled. It cannot be used for entry.'; }
    const colours = { ok: ['#0E9F6E', '#E6F6EF', '&#10003;'], used: ['#B87500', '#FFF4DE', '!'], wait: ['#12317A', '#E8EEFC', '&#8230;'], bad: ['#D92D5B', '#FDEBF0', '&#10005;'] }[state];
    const qty = Number(order.quantity) || 1;
    const ticket = state === 'bad' ? '' : esc(ticketBadge(order));
    const club = order.clubName && order.clubName !== 'N/A' ? esc(order.clubName) : '';
    const position = order.position ? esc(order.position) : '';
    const row = (k, v) => v ? `<div class="row"><span>${k}</span><b>${v}</b></div>` : '';
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} | ${esc(d.name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#EDF0F6;color:#0F1B33;min-height:100vh;padding:20px 14px 40px}
.card{max-width:440px;margin:0 auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(6,20,51,.45)}
.top{background:radial-gradient(120% 140% at 0% 0%,#12317A,#0A1F4F 50%,#061433);color:#fff;padding:22px 24px 26px;position:relative}
.brand{display:flex;align-items:center;gap:10px;font:700 13px Georgia,serif;letter-spacing:3px;color:#F2A900}
.brand i{width:30px;height:30px;border-radius:50%;background:#0A1F4F;box-shadow:inset 0 0 0 2px #F2A900;display:grid;place-items:center;font-style:normal;font-size:14px}
.ev{margin-top:18px;font:700 26px/1.15 Georgia,serif}.ev small{display:block;color:#F2A900;font:700 12px Arial,sans-serif;letter-spacing:4px;margin-top:8px}
.meta{margin-top:12px;color:#C7D3EE;font-size:14px;line-height:1.6}
.status{display:flex;gap:14px;align-items:center;padding:18px 24px;background:${colours[1]};color:${colours[0]}}
.status .ic{width:46px;height:46px;border-radius:50%;background:${colours[0]};color:#fff;display:grid;place-items:center;font-size:22px;font-weight:800;flex-shrink:0}
.status b{display:block;font-size:19px}.status span{display:block;font-size:13.5px;margin-top:3px;color:#3E4A63;line-height:1.45}
.who{padding:22px 24px 6px}.who p{font-size:12px;letter-spacing:2px;color:#8C96AB;font-weight:700}.who h1{font:700 28px/1.2 Georgia,serif;margin-top:6px;word-break:break-word}
.rows{padding:6px 24px 8px}.row{display:flex;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid #EEF1F6;font-size:14.5px}.row:last-child{border-bottom:0}
.row span{color:#5E6A84}.row b{text-align:right}
.foot{padding:16px 24px 22px}.btn{display:block;text-align:center;padding:14px;border-radius:14px;background:#0A1F4F;color:#fff;text-decoration:none;font-weight:700}
.ref{text-align:center;color:#8C96AB;font-size:12px;margin-top:14px}
</style></head><body><div class="card">
<div class="top"><div class="brand"><i>S</i>SARAMI EVENTS</div>
<div class="ev">${esc(d.name)}${d.year ? `<small>${esc(String(d.year).toUpperCase())}</small>` : ''}</div>
<div class="meta">${esc(d.date)}${d.time ? ' · ' + esc(d.time) : ''}<br>${esc(d.venue)}${d.area ? ', ' + esc(d.area) : ''}</div></div>
<div class="status"><span class="ic">${colours[2]}</span><div><b>${esc(title)}</b><span>${note}</span></div></div>
<div class="who"><p>TICKET HOLDER</p><h1>${esc(order.payerName || 'Guest')}</h1></div>
<div class="rows">${row('Ticket', ticket)}${state === 'bad' ? '' : row('Admits', `${qty} guest${qty === 1 ? '' : 's'}`)}${row('Position', position)}${row('Club', club)}</div>
<div class="foot">${order.status === 'PAID' ? `<a class="btn" href="${PUBLIC_BASE_URL}/api/ticket/${orderId}">Open full entry pass</a>` : ''}
<p class="ref">Ticket ref ${esc(String(orderId).slice(0, 8).toUpperCase())} · Verified by Sarami Events</p></div>
</div></body></html>`;
}

async function sendVerifyPage(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
        if (!isUuid(req.params.orderId)) return res.status(404).send(buildNotFoundPage());
        const { data: order, error } = await supabase.from('orders').select('*').eq('id', req.params.orderId).single();
        if (error || !order) return res.status(404).send(buildNotFoundPage());
        res.send(buildVerifyPage(order, req.params.orderId, getEventConfig(order.eventId)));
    } catch (e) {
        console.error('[VERIFY ERROR]', e.message);
        res.status(500).send('Could not check this ticket right now. Please try again.');
    }
}
function buildNotFoundPage() {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Ticket not found</title>
<style>body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#EDF0F6;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}
.c{max-width:400px;background:#fff;border-radius:22px;padding:30px;text-align:center}.i{width:56px;height:56px;border-radius:50%;background:#D92D5B;color:#fff;display:grid;place-items:center;margin:0 auto 14px;font-size:26px;font-weight:800}
h1{font:700 22px Georgia,serif;margin:0 0 8px;color:#0F1B33}p{color:#5E6A84;margin:0;line-height:1.5}</style></head>
<body><div class="c"><div class="i">&#10005;</div><h1>Ticket not found</h1><p>This code is not a Sarami Events ticket. If you think this is a mistake, contact the organisers.</p></div></body></html>`;
}
app.get('/v/:orderId', sendVerifyPage);
app.get('/verify/:orderId', sendVerifyPage);

// ─── CURRENT PRICES (the booking page reads these, so it always matches what is charged) ───
app.get('/api/pricing/:eventId', (req, res) => {
    const config = findEvent(req.params.eventId);
    if (!config) return res.status(404).json({ success: false });
    const tiers = currentTiers(config);
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true,
        serverTime: new Date().toISOString(),
        earlyEnded: earlyPricesEnded(config),
        priceChangeAt: config.priceChange?.at || null,
        tiers: Object.keys(tiers).map(t => ({ code: t, label: tierLabel(t), price: tiers[t] })),
        laterTiers: config.priceChange && !earlyPricesEnded(config) ? Object.keys(config.priceChange.tiers).map(t => ({ code: t, label: tierLabel(t), price: config.priceChange.tiers[t] })) : []
    });
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

    const maxQty = config.maxQty || 10;
    const tiersNow = currentTiers(config);   // prices that apply at this moment
    let tier, qty, amount, ticketItems = null;

    if (Array.isArray(body.items)) {
        // Mixed booking, e.g. [{ tier: 'REGULAR', qty: 2 }, { tier: 'CHILDREN', qty: 3 }]
        const merged = {};
        for (const it of body.items.slice(0, 10)) {
            const t = clean(it?.tier, 20).toUpperCase();
            const q = parseInt(it?.qty, 10);
            if (!Number.isInteger(q) || q < 0 || q > maxQty) return res.status(400).json({ success: false, error: 'Invalid ticket quantity.' });
            if (q === 0) continue;
            if (!tiersNow[t]) return res.status(400).json({ success: false, error: earlyPricesEnded(config) && config.tiers?.[t] ? 'EARLY_PRICES_ENDED' : 'This ticket type is not available.' });
            merged[t] = (merged[t] || 0) + q;
        }
        ticketItems = Object.keys(tiersNow).filter(t => merged[t]).map(t => ({ tier: t, qty: merged[t], unitPrice: tiersNow[t] }));
        qty = ticketItems.reduce((n, i) => n + i.qty, 0);
        if (qty < 1 || qty > maxQty) return res.status(400).json({ success: false, error: `You can book between 1 and ${maxQty} tickets at a time.` });
        amount = ticketItems.reduce((n, i) => n + i.qty * i.unitPrice, 0);   // ← computed on the server only
        tier = ticketItems.length === 1 ? ticketItems[0].tier : 'MIXED';
    } else {
        tier = clean(body.packageTier || 'GENERAL', 20).toUpperCase();
        const unitPrice = tiersNow[tier];
        if (!unitPrice) return res.status(400).json({ success: false, error: 'This ticket type is not available.' });
        qty = parseInt(body.quantity, 10);
        if (!Number.isInteger(qty) || qty < 1 || qty > maxQty) {
            return res.status(400).json({ success: false, error: `You can buy between 1 and ${maxQty} tickets.` });
        }
        amount = unitPrice * qty;   // ← computed on the server, never trusted from the browser
    }

    const payerName = clean(body.payerName, 80);
    const payerEmail = clean(body.payerEmail, 120).toLowerCase();
    const payerPhone = formatPhone(body.payerPhone);
    if (!payerName || !isValidEmail(payerEmail)) return res.status(400).json({ success: false, error: 'Enter your full name and a valid email address.' });
    if (!isValidKePhone(payerPhone)) return res.status(400).json({ success: false, error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });
    let createdOrderId;

    try {
        const { data: newOrder, error: dbError } = await supabase.from('orders').insert({
            payerName, payerEmail, payerPhone, amount, quantity: qty,
            packageTier: tier,
            ...(ticketItems ? { ticketItems } : {}),
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

        // Two steps, logged separately so a failure says exactly which one DTB refused
        let token;
        try { token = await getAuthToken(); }
        catch (e) { e.stkStep = 'LOGIN (partner/login)'; throw e; }
        if (!token) { const e = new Error('Login succeeded but no access_token was returned'); e.stkStep = 'LOGIN (partner/login)'; throw e; }
        console.log('[STK] login OK, requesting STK push for order', createdOrderId);
        // DTB sometimes briefly fails to connect to Safaricom ("Failed to get token").
        // No prompt is sent in that case, so it is safe to try again, up to 3 attempts in total.
        const isTokenHiccup = (e) => /failed to get token/i.test(JSON.stringify(e.response?.data || ''));
        const narration = `Event ${String(payerName).replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()}`.slice(0, 40);   // plain characters only: symbols such as & are rejected
        let merchantTxId;
        for (let attempt = 1; ; attempt++) {
            merchantTxId = `TXN-${crypto.randomBytes(4).toString('hex')}`;
            try {
                await axios.post(process.env.INFINITIPAY_STKPUSH_URL, {
                    transactionId: merchantTxId,
                    transactionReference: createdOrderId,
                    amount,
                    merchantId: "139",
                    transactionTypeId: 1,
                    payerAccount: payerPhone,
                    narration,
                    callbackURL: `${PUBLIC_BASE_URL}/api/payment-callback/${CALLBACK_SECRET}`,
                    ptyId: 1,
                    promptDisplayAccount: "Sarami Events"
                }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
                break;
            } catch (e) {
                if (attempt < 3 && isTokenHiccup(e)) {
                    console.warn(`[STK] "Failed to get token" on attempt ${attempt}, retrying for order`, createdOrderId);
                    await new Promise(r => setTimeout(r, 1500 * attempt));
                    continue;
                }
                e.stkStep = attempt > 1 ? `STK PUSH (payment request, after ${attempt} attempts)` : 'STK PUSH (payment request)';
                throw e;
            }
        }

        await setOrder(createdOrderId, { merchantRequestID: merchantTxId, status: 'STK_SENT' });
        res.status(200).json({ success: true, orderId: createdOrderId });
    } catch (err) {
        const body = err.response?.data || err.message || 'Unknown error';
        const errMsg = {
            step: err.stkStep || 'BEFORE PAYMENT',
            httpStatus: err.response?.status || null,
            at: new Date().toISOString(),
            response: body
        };
        console.error('[CREATE-ORDER ERROR]', JSON.stringify(errMsg));
        if (createdOrderId) await setOrder(createdOrderId, { status: 'FAILED', reason: errMsg });
        res.status(502).json({ success: false, error: 'STK_FAILED' });
    }
});

// ─── INVITED GUESTS: CHECK LINK ───
// Counts confirmed and waiting RSVPs (declined ones free their place again)
async function countInvites(eventId) {
    const { count, error } = await supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('eventId', eventId).eq('paymentMethod', 'INVITE')
        .in('status', ['PAID', 'PENDING_APPROVAL']);
    if (error) throw error;
    return count || 0;
}

function inviteCodeOk(config, code) {
    if (!config?.invite) return false;
    const expected = process.env[config.invite.codeEnv];
    return !!expected && safeEqual(clean(code, 100), expected);
}

async function isOnGuestList(eventId, phone) {
    const { data, error } = await supabase.from('invite_list').select('id').eq('eventId', eventId).eq('phone', phone).limit(1);
    if (error) { console.error('[GUEST LIST LOOKUP ERROR]', error.message); return false; }
    return !!(data && data.length);
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

// ─── INVITED GUESTS: RSVP ───
// On the guest list: confirmed at once and the QR pass is emailed.
// Not on the list: saved as PENDING_APPROVAL until an admin approves or declines it.
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
        // One RSVP per phone number
        const { data: existing } = await supabase.from('orders').select('*')
            .eq('eventId', eventId).eq('paymentMethod', 'INVITE').eq('payerPhone', payerPhone)
            .order('createdAt', { ascending: false }).limit(1);
        if (existing && existing.length) {
            const prev = existing[0];
            if (prev.status === 'PAID') {
                await sendConfirmationEmail(prev, prev.id);
                return res.status(409).json({ success: false, error: 'ALREADY_RSVPD',
                    message: "This phone number has already RSVP'd. We've re-sent the entry pass to the email used at the time." });
            }
            if (prev.status === 'PENDING_APPROVAL') {
                return res.status(409).json({ success: false, error: 'ALREADY_PENDING',
                    message: 'Your RSVP has already been received and is waiting for the organisers to confirm it. Your entry pass will be emailed once it is confirmed.' });
            }
            if (prev.status === 'REJECTED') {
                return res.status(403).json({ success: false, error: 'DECLINED',
                    message: "We weren't able to confirm an invitation for this number. If you believe this is a mistake, please contact the organisers." });
            }
        }

        if (await countInvites(eventId) >= config.invite.cap) {
            return res.status(410).json({ success: false, error: 'FULL', message: 'Invited-guest places are now full.' });
        }

        const onList = await isOnGuestList(eventId, payerPhone);
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
            status: onList ? 'PAID' : 'PENDING_APPROVAL',   // PAID = valid ticket everywhere else
            paymentMethod: 'INVITE',
            emailStatus: 'PENDING',
            attended: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const { data: newOrder, error } = await supabase.from('orders').insert(orderData).select().single();
        if (error) throw error;

        if (!onList) {
            console.log(`[RSVP PENDING] ${payerName} (${payerPhone}) for ${eventId}`);
            io.emit('rsvp_pending', { eventId, name: payerName });
            return res.json({ success: true, pending: true });
        }

        const emailSent = await sendConfirmationEmail(orderData, newOrder.id);
        console.log(`[RSVP] ${payerName} (${payerPhone}) for ${eventId} (on guest list)`);
        res.json({ success: true, orderId: newOrder.id, emailSent });
    } catch (err) {
        console.error('[RSVP ERROR]', err.message);
        res.status(500).json({ success: false, message: 'Something went wrong saving your RSVP. Please try again.' });
    }
});

// ─── RSVP APPROVALS (ADMIN) ───
async function approveRsvp(id) {
    const { data, error } = await supabase.from('orders')
        .update({ status: 'PAID', reason: 'Approved by admin', updatedAt: new Date().toISOString() })
        .eq('id', id).eq('status', 'PENDING_APPROVAL')
        .select().single();
    if (error || !data) return { ok: false };
    const emailSent = await sendConfirmationEmail(data, id);
    return { ok: true, emailSent, name: data.payerName };
}

app.post('/api/approve-rsvp/:id', requireAdmin, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'RSVP not found.' });
    const r = await approveRsvp(req.params.id);
    if (!r.ok) return res.status(409).json({ success: false, message: 'This RSVP is no longer waiting for approval.' });
    console.log(`[RSVP APPROVED] ${r.name}`);
    res.json({ success: true, emailSent: r.emailSent, message: r.emailSent ? 'Approved and entry pass emailed.' : 'Approved, but the email failed. Use "Email ticket again".' });
});

app.post('/api/reject-rsvp/:id', requireAdmin, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ success: false, message: 'RSVP not found.' });
    const { data, error } = await supabase.from('orders')
        .update({ status: 'REJECTED', reason: 'Declined by admin', updatedAt: new Date().toISOString() })
        .eq('id', req.params.id).eq('status', 'PENDING_APPROVAL')
        .select().single();
    if (error || !data) return res.status(409).json({ success: false, message: 'This RSVP is no longer waiting for approval.' });
    console.log(`[RSVP DECLINED] ${data.payerName}`);
    res.json({ success: true, message: 'RSVP declined.' });
});

// ─── GUEST LIST (ADMIN) ───
app.get('/api/invite-list', requireAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase.from('invite_list').select('id, name, phone, createdAt')
            .eq('eventId', req.query.eventId).order('name', { ascending: true });
        if (error) throw error;
        res.json({ success: true, entries: data });
    } catch (e) {
        console.error('[GUEST LIST ERROR]', e.message);
        res.status(500).json({ success: false, message: 'Could not load the guest list. Has the invite_list table been created in Supabase?' });
    }
});

// Body: { eventId, entries: [{ name, phone }] }. Adds new numbers, skips duplicates,
// and approves any RSVP already waiting from a number on the list.
app.post('/api/invite-list', requireAdmin, async (req, res) => {
    const eventId = req.body?.eventId;
    if (!findEvent(eventId)) return res.status(400).json({ success: false, message: 'Unknown event.' });
    const raw = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 2000) : [];

    const seen = new Set(), rows = [], invalid = [];
    raw.forEach(e => {
        const phone = formatPhone(e?.phone);
        if (!isValidKePhone(phone)) { if (e?.phone || e?.name) invalid.push(clean(e?.phone || e?.name, 40)); return; }
        if (seen.has(phone)) return;
        seen.add(phone);
        rows.push({ eventId, phone, name: clean(e?.name, 80) || null });
    });

    try {
        let added = 0;
        if (rows.length) {
            const { data, error } = await supabase.from('invite_list')
                .upsert(rows, { onConflict: 'eventId,phone', ignoreDuplicates: true }).select('id');
            if (error) throw error;
            added = data ? data.length : 0;
        }

        // Auto-approve RSVPs already waiting from these numbers
        let approved = 0;
        if (rows.length) {
            const { data: waiting } = await supabase.from('orders').select('id, payerPhone')
                .eq('eventId', eventId).eq('status', 'PENDING_APPROVAL').in('payerPhone', rows.map(r => r.phone));
            for (const w of waiting || []) { if ((await approveRsvp(w.id)).ok) approved++; }
        }

        res.json({ success: true, added, skipped: rows.length - added, invalid, approved });
    } catch (e) {
        console.error('[GUEST LIST ADD ERROR]', e.message);
        res.status(500).json({ success: false, message: 'Could not save the guest list. Has the invite_list table been created in Supabase?' });
    }
});

app.delete('/api/invite-list/:id', requireAdmin, async (req, res) => {
    const { error } = await supabase.from('invite_list').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ success: false, message: 'Could not remove the entry.' });
    res.json({ success: true });
});

// ─── MANUAL TICKET CREATION (ADMIN ONLY) ───
// ─── DOOR LIST (ADMIN): invited guests checked in by name, no email or QR is sent ───
// Body: { eventId, guests: [{ name, club, position, seats, phone }] }
app.post('/api/door-list', requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!findEvent(b.eventId)) return res.status(400).json({ success: false, error: 'Unknown event.' });
    const config = getEventConfig(b.eventId);
    const list = Array.isArray(b.guests) ? b.guests.slice(0, 600) : [];
    const rows = list.map(g => ({
        name: clean(g?.name, 80),
        club: clean(g?.club || '', 100),
        position: cleanPosition(g?.position) || clean(g?.position || '', 60) || null,   // any position text is fine here
        seats: Math.min(10, Math.max(1, parseInt(g?.seats, 10) || 1)),
        phone: formatPhone(g?.phone) || 'N/A'
    })).filter(g => g.name.length >= 2);
    if (!rows.length) return res.status(400).json({ success: false, error: 'No names to add.' });
    try {
        // Skip names already on this event's door list, so importing twice doesn't duplicate anyone
        const { data: existing, error: e1 } = await supabase.from('orders').select('payerName')
            .eq('eventId', b.eventId).eq('paymentMethod', 'DOOR_LIST');
        if (e1) throw e1;
        const have = new Set((existing || []).map(o => String(o.payerName || '').trim().toLowerCase()));
        const fresh = [];
        rows.forEach(g => { const k = g.name.toLowerCase(); if (!have.has(k)) { have.add(k); fresh.push(g); } });
        if (fresh.length) {
            const now = new Date().toISOString();
            const { error } = await supabase.from('orders').insert(fresh.map(g => ({
                payerName: g.name, payerEmail: 'N/A', payerPhone: g.phone,
                amount: 0, quantity: g.seats, packageTier: 'INVITED', position: g.position,
                dietaryPreference: 'None', clubName: g.club || 'N/A',
                eventName: config.title, eventId: b.eventId,
                status: 'PAID', paymentMethod: 'DOOR_LIST', mpesaReceipt: 'N/A',
                emailStatus: 'NOT_SENT', attended: false, createdAt: now, updatedAt: now
            })));
            if (error) throw error;
        }
        res.json({ success: true, added: fresh.length, skipped: rows.length - fresh.length });
    } catch (err) {
        console.error('[DOOR LIST ERROR]', err.message);
        res.status(500).json({ success: false, error: 'Could not save the door list.' });
    }
});

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
            mpesaReceipt: clean(b.mpesaReceipt, 20).toUpperCase() || 'N/A',
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
            tier: itemsSummary(orderDoc.ticketItems) || tierLabel(orderDoc.packageTier),
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
                if (Array.isArray(d.ticketItems) && d.ticketItems.length) d.ticketItems.forEach(i => { tierCounts[i.tier] = (tierCounts[i.tier] || 0) + (Number(i.qty) || 0); });
                else tierCounts[d.packageTier] = (tierCounts[d.packageTier] || 0) + qty;
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
                ticketItems: Array.isArray(d.ticketItems) ? d.ticketItems : null,
                ticketSummary: itemsSummary(d.ticketItems),
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

// ─── ORGANISERS' REGISTRY (READ-ONLY) ───
// Each event has its own organiser code, and the code decides which event opens,
// so one organiser can never see another's guests. The admin key can open any event (?eventId=).
// Valid tickets only, and no phone numbers, emails or payment references.
function eventForClientCode(code, requestedEventId) {
    if (ADMIN_KEY && safeEqual(code, ADMIN_KEY)) return findEvent(requestedEventId) ? requestedEventId : null;
    return Object.keys(EVENT_CONFIGS).find(id => {
        const env = EVENT_CONFIGS[id].clientKeyEnv;
        return env && process.env[env] && safeEqual(code, process.env[env]);
    }) || null;
}

function publicEventInfo(eventId) {
    const c = EVENT_CONFIGS[eventId], d = eventDetails(c);
    return {
        id: eventId, name: d.name, year: d.year || '', kicker: d.kicker || 'Sarami Events presents',
        date: d.date, time: d.time, venue: d.venue, area: d.area || '', start: d.start || null,
        hasInvites: !!c.invite,
        showDiet: !!c.showDiet,
        tiers: Object.entries({ ...(c.tiers || {}), ...(c.priceChange?.tiers || {}) }).map(([t, p]) => ({ code: t, label: tierLabel(t), price: p }))
    };
}

app.get('/api/client-registry', async (req, res) => {
    const eventId = eventForClientCode(req.get('x-client-key'), req.query.eventId);
    if (!eventId) return res.status(401).json({ success: false, message: 'Wrong access code.' });
    try {
        const { data, error } = await supabase.from('orders')
            .select('id, payerName, clubName, position, packageTier, ticketItems, paymentMethod, quantity, amount, dietaryPreference, attended, checkInTime, createdAt, updatedAt')
            .eq('eventId', eventId).eq('status', 'PAID')
            .order('createdAt', { ascending: false });
        if (error) throw error;

        res.json({
            success: true,
            event: publicEventInfo(eventId),
            guests: data.map(g => {
                const kind = g.paymentMethod === 'INVITE' || g.packageTier === 'INVITED' ? 'invited'
                    : g.packageTier === 'COMPLIMENTARY' ? 'complimentary' : 'paid';
                const items = Array.isArray(g.ticketItems) && g.ticketItems.length ? g.ticketItems.map(i => ({ tier: i.tier, qty: Number(i.qty) || 0 }))
                    : (kind === 'paid' ? [{ tier: g.packageTier, qty: Number(g.quantity) || 1 }] : []);
                return {
                    ref: String(g.id).slice(0, 8).toUpperCase(),
                    name: g.payerName || 'Guest',
                    club: g.clubName && g.clubName !== 'N/A' ? g.clubName : '',
                    position: g.position || '',
                    kind,
                    doorList: g.paymentMethod === 'DOOR_LIST',
                    ticket: itemsSummary(g.ticketItems) || tierLabel(g.packageTier),
                    items,
                    qty: Number(g.quantity) || 1,
                    amount: kind === 'paid' ? Number(g.amount) || 0 : 0,
                    diet: g.dietaryPreference || 'None',
                    attended: !!g.attended,
                    checkInTime: g.checkInTime,
                    time: g.createdAt || g.updatedAt
                };
            }),
            lastUpdated: new Date().toISOString()
        });
    } catch (e) {
        console.error('[CLIENT REGISTRY ERROR]', e.message);
        res.status(500).json({ success: false, message: 'Could not load the registry.' });
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
