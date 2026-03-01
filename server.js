// ==========================================
// THE SARAMI LENS 2026 - PRODUCTION BACKEND
// FIXED: Mapped InfinitiPay's nested `results.merchantTxnId` and `statusCode`
// ADDED: Professional HTML Email Receipt Integration via Brevo
// ADDED: promptDisplayAccount for custom M-Pesa prompt naming
// ==========================================
const express = require('express');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');
const crypto = require('crypto');

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
      console.log(`[INCOMING REQUEST] Path: ${req.path} | Content-Type: ${contentType}`);
      
      if (typeof req.body === 'string') {
          try {
              req.body = JSON.parse(req.body.trim());
              console.log('[RESCUED TEXT/PLAIN BODY]', JSON.stringify(req.body, null, 2));
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
    if (p.length !== 12) console.warn(`[WARN] Phone might be invalid: ${p}`);
    return p;
}

async function getAuthToken() {
    try {
        console.log('[AUTH] Attempting login...');
        const res = await axios.post('https://moja.dtbafrica.com/api/infinitiPay/v2/users/partner/login', {
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        }, { timeout: 10000 });
        console.log('[AUTH] Success');
        return res.data.access_token;
    } catch (err) {
        console.error('[AUTH FAIL]', err.message, err.response?.data || '');
        throw err;
    }
}

// ─── CREATIVE EMAIL FUNCTION ───
async function sendConfirmationEmail(orderData, orderId, orderRef) {
    try {
        console.log(`[EMAIL] Preparing to send confirmation to ${orderData.payerEmail}`);

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        const eventTitle = orderData.eventName || 'Sarami Lens Exhibition';
        
        sendSmtpEmail.subject = `Ticket Confirmed: ${eventTitle}`;
        
        // Professional HTML Template
        sendSmtpEmail.htmlContent = `
        <!DOCTYPE html>
        <html>
        <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f4f4; padding: 20px;">
                <tr>
                    <td align="center">
                        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                            <tr>
                                <td style="background-color: #111111; padding: 40px 20px; text-align: center;">
                                    <h1 style="color: #d4af37; margin: 0; font-size: 28px; letter-spacing: 2px; text-transform: uppercase;">SARAMI LENS</h1>
                                    <p style="color: #ffffff; margin: 10px 0 0 0; font-size: 14px; opacity: 0.8;">EXHIBITION & AWARDS</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 40px 30px;">
                                    <h2 style="color: #333333; margin-top: 0; font-size: 24px;">Payment Received! 🎉</h2>
                                    <p style="color: #555555; font-size: 16px; line-height: 1.6;">Hello <strong>${orderData.payerName}</strong>,</p>
                                    <p style="color: #555555; font-size: 16px; line-height: 1.6;">This email confirms that we have successfully received your payment for the <strong>${eventTitle}</strong>. We are thrilled to have you join us!</p>
                                    
                                    <div style="background-color: #f9f9f9; border-left: 4px solid #d4af37; padding: 20px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                                        <h3 style="margin-top: 0; color: #111111; font-size: 18px; border-bottom: 1px solid #eeeeee; padding-bottom: 10px;">Transaction Details</h3>
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 15px; color: #444444;">
                                            <tr>
                                                <td style="padding: 8px 0;"><strong>Amount Paid:</strong></td>
                                                <td style="padding: 8px 0; text-align: right;">KES ${orderData.amount}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0;"><strong>M-Pesa Receipt:</strong></td>
                                                <td style="padding: 8px 0; text-align: right;">${orderData.mpesaReceipt || 'N/A'}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0;"><strong>Order ID:</strong></td>
                                                <td style="padding: 8px 0; text-align: right;">${orderId}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0;"><strong>Status:</strong></td>
                                                <td style="padding: 8px 0; text-align: right; color: #2e7d32; font-weight: bold;">PAID</td>
                                            </tr>
                                        </table>
                                    </div>

                                    <p style="color: #555555; font-size: 16px; line-height: 1.6;">Please keep this email as your official receipt and proof of registration. Present it at the entrance on the day of the event.</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="background-color: #111111; padding: 30px 20px; text-align: center;">
                                    <p style="color: #aaaaaa; font-size: 14px; margin: 0;">&copy; ${new Date().getFullYear()} Sarami Events. All rights reserved.</p>
                                    <p style="color: #777777; font-size: 12px; margin: 10px 0 0 0;">Need help? Reply to this email or contact us at etickets@saramievents.co.ke</p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        `;
        
        // Sender and Recipient Configuration
        sendSmtpEmail.sender = { "name": "Sarami Events", "email": "etickets@saramievents.co.ke" }; 
        sendSmtpEmail.replyTo = { "email": "etickets@saramievents.co.ke", "name": "Sarami Events" };
        sendSmtpEmail.to = [{ "email": orderData.payerEmail, "name": orderData.payerName }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`[EMAIL] Successfully sent to ${orderData.payerEmail}`);

        await orderRef.update({ emailStatus: 'SENT', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (err) {
        console.error('[EMAIL FAIL]', err.response?.text || err.message);
        await orderRef.update({ emailStatus: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
}

// ─── CREATE ORDER ───
app.post('/api/create-order', async (req, res) => {
    console.log('[CREATE-ORDER] Body:', JSON.stringify(req.body, null, 2));
    
    const { payerName, payerEmail, payerPhone, amount, eventName } = req.body || {};

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
            eventName: eventName || 'Sarami Lens 2026',
            status: 'INITIATED',
            emailStatus: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('[ORDER CREATED]', orderRef.id);

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
            narration: `Sarami Lens: ${payerName}`,
            callbackURL: "https://ticketing-app-final.onrender.com/api/payment-callback",
            ptyId: 1,
            promptDisplayAccount: "Sarami Events" // <--- ADDED HERE
        };

        console.log('[STK PAYLOAD]', JSON.stringify(payload, null, 2));

        const stkRes = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL,
            payload,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );

        console.log('[STK RESPONSE]', stkRes.data);

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
    console.log('[CALLBACK] Parsed Body:', JSON.stringify(req.body, null, 2));

    let data = req.body || {};
    
    if (data.Body?.stkCallback) {
        data = data.Body.stkCallback; 
    }

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
                console.log('[CALLBACK] Found order by Document ID:', docSnap.id);
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
                const snap = await db.collection('orders')
                    .where('merchantRequestID', '==', mReqId)
                    .limit(1)
                    .get();

                if (!snap.empty) {
                    ref = snap.docs[0].ref;
                    orderDoc = snap.docs[0].data();
                    console.log('[CALLBACK] Found order by merchantRequestID:', mReqId);
                }
            }
        }

        if (!ref) {
            console.error('[CALLBACK] Order not found for incoming payload.');
            return res.status(200).send('OK');
        }

        const resultCode = data.statusCode ?? data.ResultCode ?? data.resultCode;
        const statusStr = (data.status || data.Status || '').toUpperCase();
        
        const isSuccess = 
            resultCode === 0 || 
            resultCode === '0' || 
            resultCode === 200 || 
            resultCode === '200' || 
            statusStr === 'SUCCESS' || 
            statusStr === 'COMPLETED' || 
            statusStr === 'PAID';

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

        console.log(`[UPDATED] Order ${ref.id} → ${isSuccess ? 'PAID' : 'CANCELLED'} (Reason: ${reason})`);

        // Trigger the creative email on successful payment
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
