// ==========================================
// SARAMI EVENTS - PRODUCTION BACKEND
// EVENT: District Governor's Banquet 2026
// ADDED: QR Code Generation & VIP Ticket Design
// ==========================================
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');
const QRCode = require('qrcode'); // <-- NEW: Required for generating ticket QR codes

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

const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();

// ─── Health check for Render ───
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// ─── Bulletproof CORS Middleware ───
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ─── Safe Body Parsers ───
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/plain' })); 

// ─── Callback JSON Converter ───
app.use((req, res, next) => {
  if (req.method === 'POST') {
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      
      if (typeof req.body === 'string') {
          try {
              req.body = JSON.parse(req.body.trim());
          } catch (e) {
              // Not valid JSON, leave it as a text string
          }
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
        console.error('[AUTH FAIL]', err.message);
        throw err;
    }
}

// ─── STUNNING E-TICKET EMAIL FUNCTION ───
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        console.log(`[EMAIL] Generating VIP Ticket for ${orderData.payerEmail}`);

        // 1. Generate unique QR Code data payload
        // This is what shows up if you scan it with a phone camera/scanner app
        const qrPayload = JSON.stringify({
            ticketID: orderId,
            name: orderData.payerName,
            tier: orderData.packageTier,
            qty: orderData.quantity,
            status: "PAID"
        });

        // 2. Create the visual QR code image (Base64)
        const qrDataUrl = await QRCode.toDataURL(qrPayload, {
            color: { dark: '#00338D', light: '#ffffff' }, // Lions Blue QR
            width: 250,
            margin: 1
        });

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        const eventTitle = orderData.eventName || "District Governor's Banquet";
        
        sendSmtpEmail.subject = `🎫 Your Ticket: ${eventTitle}`;
        
        // 3. High-End Ticket HTML Template
        sendSmtpEmail.htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="margin: 0; padding: 0; background-color: #e2e8f0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #e2e8f0; padding: 40px 20px;">
                <tr>
                    <td align="center">
                        
                        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 15px 35px rgba(0,0,0,0.15); max-width: 600px; width: 100%;">
                            
                            <tr>
                                <td style="background-color: #00338D; padding: 35px 20px; text-align: center; position: relative;">
                                    <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 3px; text-transform: uppercase; font-weight: 800;">SARAMI EVENTS</h1>
                                    <p style="color: #F2A900; margin: 8px 0 0 0; font-size: 13px; font-weight: bold; letter-spacing: 2px;">DISTRICT GOVERNOR'S BANQUET 2026</p>
                                </td>
                            </tr>
                            
                            <tr>
                                <td align="center" style="padding: 40px 20px 20px 20px;">
                                    <div style="border: 4px solid #f1f5f9; padding: 15px; border-radius: 12px; display: inline-block;">
                                        <img src="${qrDataUrl}" width="200" height="200" alt="Scan Ticket" style="display: block; border-radius: 8px;">
                                    </div>
                                    <p style="margin: 15px 0 0 0; font-family: monospace; font-size: 14px; color: #94a3b8; letter-spacing: 2px;">TICKET #${orderId.substring(0,8).toUpperCase()}</p>
                                    <p style="margin: 5px 0 0 0; color: #16a34a; font-weight: bold; font-size: 14px;">✓ PAYMENT VERIFIED</p>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding: 0 20px;">
                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                        <tr>
                                            <td width="20" height="40">
                                                <div style="width: 40px; height: 40px; background-color: #e2e8f0; border-radius: 50%; margin-left: -40px;"></div>
                                            </td>
                                            <td style="border-top: 3px dashed #cbd5e1; height: 1px;"></td>
                                            <td width="20" height="40">
                                                <div style="width: 40px; height: 40px; background-color: #e2e8f0; border-radius: 50%; margin-right: -40px;"></div>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            
                            <tr>
                                <td style="padding: 20px 40px 40px 40px;">
                                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 25px;">
                                        <tr>
                                            <td style="padding-bottom: 15px;">
                                                <p style="margin: 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Admit To</p>
                                                <p style="margin: 5px 0 0 0; font-size: 20px; color: #0f172a; font-weight: bold;">${orderData.payerName}</p>
                                            </td>
                                            <td align="right" style="padding-bottom: 15px;">
                                                <p style="margin: 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Membership Tier</p>
                                                <p style="margin: 5px 0 0 0; font-size: 20px; color: #00338D; font-weight: bold;">${orderData.packageTier}</p>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding-bottom: 15px;">
                                                <p style="margin: 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Date & Time</p>
                                                <p style="margin: 5px 0 0 0; font-size: 16px; color: #334155; font-weight: 600;">July 18th, 2026</p>
                                            </td>
                                            <td align="right" style="padding-bottom: 15px;">
                                                <p style="margin: 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Location</p>
                                                <p style="margin: 5px 0 0 0; font-size: 16px; color: #334155; font-weight: 600;">Ole Sereni Hotel</p>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td>
                                                <p style="margin: 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Guests (Qty)</p>
                                                <p style="margin: 5px 0 0 0; font-size: 16px; color: #334155; font-weight: 600;">${orderData.quantity}</p>
                                            </td>
                                            <td align="right">
                                                <p style="margin: 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Dietary Pref.</p>
                                                <p style="margin: 5px 0 0 0; font-size: 16px; color: #334155; font-weight: 600;">${orderData.dietaryPreference || 'None'}</p>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>

                        <table width="600" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px; max-width: 600px; width: 100%;">
                            <tr>
                                <td align="center">
                                    <p style="color: #64748b; font-size: 14px; margin-bottom: 15px;">Have this ticket ready on your phone for scanning at the door.</p>
                                    <p style="color: #94a3b8; font-size: 12px; margin: 0;">&copy; ${new Date().getFullYear()} Sarami Events. All rights reserved.</p>
                                </td>
                            </tr>
                        </table>

                    </td>
                </tr>
            </table>
        </body>
        </html>
        `;
        
        // Sender and Recipient
        sendSmtpEmail.sender = { "name": "Sarami Events", "email": "etickets@saramievents.co.ke" }; 
        sendSmtpEmail.replyTo = { "email": "etickets@saramievents.co.ke", "name": "Sarami Events Support" };
        sendSmtpEmail.to = [{ "email": orderData.payerEmail, "name": orderData.payerName }];

        // 4. Send the Email
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`[EMAIL] VIP Ticket successfully sent to ${orderData.payerEmail}`);

        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[EMAIL FAIL]', err.response?.text || err.message);
        await orderRef.update({ emailStatus: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
}

// ─── CREATE ORDER ───
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventName, quantity, packageTier, dietaryPreference } = req.body || {};

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
            eventName: eventName || "District Governor's Banquet 2026",
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
            narration: `DG Banquet: ${payerName}`,
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
            status: isSuccess ? 'PAID' : 'CANCELLED',
            paymentStatus: isSuccess ? 'PAID' : 'FAILED',
            reason: reason,
            mpesaReceipt: receipt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            rawCallback: data,
            resultCode: resultCode || statusStr || -1
        });

        // Trigger the VIP email on successful payment
        if (isSuccess) {
            sendConfirmationEmail(orderDoc, ref.id, ref).catch(console.error);
        }

    } catch (e) {
        console.error('[DB UPDATE ERROR]', e.message);
    }

    res.status(200).send('OK');
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
