
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file
const crypto = require('crypto'); // Import crypto for generating UUIDs
const qrcode = require('qrcode'); // To generate QR codes for tickets

// --- FIREBASE DATABASE SETUP ---
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error.message);
    process.exit(1);
}
const db = admin.firestore();

// --- SENDGRID EMAIL SETUP ---
const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log('SendGrid API Key set.');
} else {
    console.warn('SENDGRID_API_KEY is not set. Email functionality might be limited.');
}

// --- Initialize Express app ---
const app = express();

// --- Middleware Setup ---
const corsOptions = {
    origin: 'https://saramievents.co.ke', // Your frontend URL
    optionsSuccessStatus: 200 // For legacy browser support
};
app.use(cors(corsOptions));

app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request bodies

const PORT = process.env.PORT || 3000;

// --- Test Route ---
app.get('/', (req, res) => {
    res.status(200).send('Sarami Ticketing Backend is running!');
});

// --- InfinitiPay Authentication Function ---
let infinitiPayAccessToken = null;
let tokenExpiryTime = null;

async function getInfinitiPayToken() {
    if (infinitiPayAccessToken && tokenExpiryTime && Date.now() < tokenExpiryTime) {
        console.log('Using cached InfinitiPay token');
        return infinitiPayAccessToken;
    }

    console.log('Fetching new InfinitiPay token using PARTNER LOGIN...');
    try {
        const authPayload = {
            client_id: process.env.INFINITIPAY_CLIENT_ID,
            client_secret: process.env.INFINITIPAY_CLIENT_SECRET,
            grant_type: 'password',
            username: process.env.INFINITIPAY_MERCHANT_USERNAME,
            password: process.env.INFINITIPAY_MERCHANT_PASSWORD
        };
        const response = await axios.post(
            process.env.INFINITIPAY_AUTH_URL,
            authPayload,
            { headers: { 'Content-Type': 'application/json' } }
        );
        const accessToken = response.data.token || response.data.access_token;
        if (!accessToken) {
            throw new Error('Access Token not found in partner login response.');
        }
        infinitiPayAccessToken = accessToken;
        const expiresIn = response.data.expires_in || 3600;
        tokenExpiryTime = Date.now() + (expiresIn - 60) * 1000;
        console.log('New InfinitiPay token obtained via partner login.');
        return infinitiPayAccessToken;
    } catch (error) {
        console.error('Error fetching InfinitiPay token:', error.message || 'Unknown error');
        if (error.response && error.response.data) {
            console.error('InfinitiPay Auth Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        throw new Error('Could not authenticate with InfinitiPay.');
    }
}

// --- Create Order and Initiate STK Push Endpoint ---
app.post('/api/create-order', async (req, res) => {
    console.log('Received booking request at /api/create-order:', req.body);
    
    const { payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName } = req.body;

    if (!payerName || !payerEmail || !payerPhone || !amount || !eventId || !eventName || !quantity) {
        return res.status(400).json({ success: false, message: 'Missing required booking information.' });
    }

    let orderRef;
    try {
        const orderData = {
            payerName, payerEmail, payerPhone, amount, quantity, eventId, eventName,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            infinitiPayAssignedTxnId: null,
            infinitiPayMerchantTxnId: null
        };
        orderRef = await db.collection('orders').add(orderData);
        const firestoreOrderId = orderRef.id;
        console.log(`Successfully created order document with ID: ${firestoreOrderId}`);

        const token = await getInfinitiPayToken();
        const cleanedPhoneNumber = payerPhone.startsWith('0') ? '254' + payerPhone.substring(1) : payerPhone;
        const fullMerchantId = process.env.INFINITIPAY_MERCHANT_ID;
        const shortMerchantId = fullMerchantId ? fullMerchantId.slice(-3) : '';

        const stkPushPayload = {
            transactionId: firestoreOrderId,
            transactionReference: firestoreOrderId,
            amount,
            merchantId: shortMerchantId,
            transactionTypeId: 1,
            payerAccount: cleanedPhoneNumber,
            narration: `Tickets for ${eventName}`,
            callbackURL: process.env.YOUR_APP_CALLBACK_URL,
            ptyId: 1
        };
        console.log('Sending STK Push request with payload:', JSON.stringify(stkPushPayload, null, 2));

        const infinitiPayResponse = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL,
            stkPushPayload,
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        if (infinitiPayResponse.data.statusCode === 200 || infinitiPayResponse.data.success === true) {
            console.log('InfinitiPay STK Push Raw Success Response:', JSON.stringify(infinitiPayResponse.data, null, 2));
            const { transactionId: infinitiPayAssignedTxnId, merchantTxnId: infinitiPayMerchantTxnId } = infinitiPayResponse.data.results || {};
            const updateData = { status: 'INITIATED_STK_PUSH', infinitiPayAssignedTxnId, infinitiPayMerchantTxnId };
            await orderRef.update(updateData);
            res.status(200).json({
                success: true,
                message: 'STK Push initiated successfully. Please check your phone.',
                orderId: firestoreOrderId,
                infinitiPayAssignedTxnId,
                infinitiPayMerchantTxnId
            });
        } else {
            throw new Error(`STK Push failed. Response: ${JSON.stringify(infinitiPayResponse.data)}`);
        }
    } catch (error) {
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message || 'Unknown error' }).catch(err => console.error('Error updating order status to FAILED:', err));
        }
        console.error('Error in /api/create-order:', error.message || 'Unknown error');
        if (axios.isAxiosError(error) && error.response && error.response.data) {
            console.error('InfinitiPay STK Push Error Details:', JSON.stringify(error.response.data, null, 2));
            res.status(500).json({ success: false, message: error.response.data.message || 'InfinitiPay STK Push failed.', details: error.response.data });
        } else {
            res.status(500).json({ success: false, message: error.message || 'An unexpected error occurred.', details: error });
        }
    }
});

// --- [UPDATED TICKET DESIGN] InfinitiPay Callback Endpoint ---
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    console.log('--- Received InfinitiPay Callback ---');
    let callbackData;
    try {
        if (req.body && req.body.length > 0) {
            callbackData = JSON.parse(req.body.toString());
            console.log('Callback Body (Parsed JSON):', JSON.stringify(callbackData, null, 2));
        } else {
            return res.status(400).json({ success: false, message: 'Empty callback body.' });
        }
    } catch (parseError) {
        console.error('Callback Error: Failed to parse JSON body.', parseError);
        return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
    }

    if (!callbackData || !callbackData.results) {
        return res.status(400).json({ success: false, message: 'Malformed callback: missing results.' });
    }

    const { results, statusCode: transactionStatus } = callbackData;
    const { merchantTxnId, transactionReference, transactionId: infinitiPayAssignedTxnIdFromCallback } = results;
    const firestoreOrderIdFromCallback = merchantTxnId || transactionReference;
    const transactionMessage = (callbackData.data && callbackData.data.description) || callbackData.message;

    if (!firestoreOrderIdFromCallback && !infinitiPayAssignedTxnIdFromCallback) {
        return res.status(400).json({ success: false, message: 'Missing transaction identifiers.' });
    }

    try {
        let orderDoc;
        let orderRef;
        if (firestoreOrderIdFromCallback) {
            orderRef = db.collection('orders').doc(firestoreOrderIdFromCallback);
            orderDoc = await orderRef.get();
        }

        if ((!orderDoc || !orderDoc.exists) && infinitiPayAssignedTxnIdFromCallback) {
            const querySnapshot = await db.collection('orders').where('infinitiPayAssignedTxnId', '==', infinitiPayAssignedTxnIdFromCallback).limit(1).get();
            if (!querySnapshot.empty) {
                orderDoc = querySnapshot.docs[0];
                orderRef = orderDoc.ref;
            }
        }

        if (!orderDoc || !orderDoc.exists) {
            return res.status(404).json({ success: false, message: 'Order not found for callback.' });
        }

        const foundFirestoreOrderId = orderDoc.id;
        console.log(`Processing callback for order: ${foundFirestoreOrderId}`);

        let newStatus = 'FAILED';
        if (transactionStatus === 200 && transactionMessage?.toLowerCase().includes("success")) {
            newStatus = 'PAID';
        } else if (transactionMessage?.toLowerCase().includes("request cancelled by user")) {
            newStatus = 'CANCELLED';
        } else if (transactionMessage?.toLowerCase().includes("ds timeout user cannot be reached")) {
            newStatus = 'TIMED_OUT';
        } else if (transactionStatus === 400 && transactionMessage?.toLowerCase().includes("duplicate request")) {
            console.warn(`Duplicate request for ${foundFirestoreOrderId}.`);
            return res.status(200).json({ success: true, message: 'Callback already processed.' });
        }

        await orderRef.update({
            status: newStatus,
            callbackData,
            infinitiPayCallbackStatus: transactionStatus,
            infinitiPayCallbackMessage: transactionMessage,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            infinitiPayAssignedTxnId: infinitiPayAssignedTxnIdFromCallback || orderDoc.data().infinitiPayAssignedTxnId,
            infinitiPayMerchantTxnId: merchantTxnId || orderDoc.data().infinitiPayMerchantTxnId,
        });
        console.log(`Updated order ${foundFirestoreOrderId} status to ${newStatus}.`);

        if (newStatus === 'PAID') {
            const orderData = orderDoc.data();
            console.log(`Preparing to send e-ticket for order ${foundFirestoreOrderId}...`);
            try {
                const qrCodeDataURL = await qrcode.toDataURL(foundFirestoreOrderId);
                
                // Set the correct, non-placeholder event details
                const eventDetails = {
                    date: "August 02, 2025",
                    time: "6:00 PM EAT",   
                    venue: "Lions Service Centre, Loresho" 
                };
                
                // This is the new, redesigned HTML for the ticket
                const emailHtml = `
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <title>Your Ticket for ${orderData.eventName}</title>
                        <style>
                            body { font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f7; margin: 0; padding: 20px; }
                            .email-container { max-width: 650px; margin: auto; background: #ffffff; padding: 20px; }
                            .greeting { font-size: 18px; color: #333; }
                            .ticket-wrapper { margin-top: 20px; filter: drop-shadow(0 4px 15px rgba(0,0,0,0.1)); }
                            .ticket-container { display: flex; max-width: 600px; margin: auto; background: #ffffff; border-radius: 12px; border: 1px solid #e5e7eb; }
                            .main-section { padding: 30px; flex-grow: 1; border-right: 2px dashed #d1d5db; }
                            .event-title { color: #004d40; font-size: 24px; font-weight: 700; margin: 0; }
                            .event-subtitle { color: #00796b; font-size: 16px; margin-top: 4px; }
                            .details-grid { margin-top: 25px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                            .detail-item p { margin: 0; color: #6b7280; font-size: 12px; }
                            .detail-item strong { color: #111827; font-size: 14px; display: block; }
                            .stub-section { padding: 20px; width: 160px; text-align: center; display: flex; flex-direction: column; justify-content: space-between; align-items: center; background-color: #f8f9fa; border-top-right-radius: 12px; border-bottom-right-radius: 12px; }
                            .stub-section .event-title-stub { color: #004d40; font-weight: 600; writing-mode: vertical-rl; transform: rotate(180deg); text-transform: uppercase; letter-spacing: 2px; }
                            .qr-code img { max-width: 120px; border: 5px solid white; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
                            .order-id { font-size: 10px; color: #6b7280; word-break: break-all; }
                            .footer { margin-top: 30px; text-align: center; font-size: 12px; color: #9ca3af; }
                        </style>
                    </head>
                    <body>
                        <div class="email-container">
                            <p class="greeting">Hi ${orderData.payerName},</p>
                            <p style="color: #555;">Your payment was successful! Here is your ticket for the event. Please have it ready for scanning at the entrance.</p>
                            <div class="ticket-wrapper">
                                <div class="ticket-container">
                                    <div class="main-section">
                                        <p class="event-subtitle">You're Invited To</p>
                                        <h1 class="event-title">${orderData.eventName}</h1>
                                        <div class="details-grid">
                                            <div class="detail-item"><p>ATTENDEE</p><strong>${orderData.payerName}</strong></div>
                                            <div class="detail-item"><p>QUANTITY</p><strong>${orderData.quantity} Ticket(s)</strong></div>
                                            <div class="detail-item"><p>DATE</p><strong>${eventDetails.date}</strong></div>
                                            <div class="detail-item"><p>TIME</p><strong>${eventDetails.time}</strong></div>
                                            <div class="detail-item" style="grid-column: 1 / -1;"><p>VENUE</p><strong>${eventDetails.venue}</strong></div>
                                        </div>
                                    </div>
                                    <div class="stub-section">
                                        <div class="qr-code"><img src="${qrCodeDataURL}" alt="Ticket QR Code" /></div>
                                        <p class="order-id">ID: ${foundFirestoreOrderId}</p>
                                    </div>
                                </div>
                            </div>
                             <div class="footer"><p>We look forward to seeing you there!<br>&copy; Sarami Events</p></div>
                        </div>
                    </body>
                    </html>`;

                await sgMail.send({
                    to: orderData.payerEmail,
                    from: process.env.SENDGRID_FROM_EMAIL,
                    subject: `🎟️ Your Ticket to ${orderData.eventName} is Confirmed!`,
                    html: emailHtml,
                });
                console.log(`E-Ticket sent successfully to: ${orderData.payerEmail}`);
            } catch (error) {
                console.error('Error during e-ticket generation or sending:', error);
                if (error.response) console.error('SendGrid Error Body:', error.response.body);
            }
        }
        res.status(200).json({ success: true, message: 'Callback processed successfully.' });
    } catch (error) {
        console.error(`Error processing callback:`, error);
        res.status(500).json({ success: false, message: 'Internal server error processing callback.' });
    }
});

// --- Generic Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err.stack);
    res.status(500).json({
        success: false,
        message: 'An unexpected internal server error occurred.',
        error: process.env.NODE_ENV === 'production' ? {} : { message: err.message, stack: err.stack }
    });
});

// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Sarami Ticketing Backend server is running on port ${PORT}`);
});
