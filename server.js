// Import necessary modules
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file
const crypto = require('crypto'); // Import crypto for generating UUIDs
const qrcode = require('qrcode'); // To generate QR codes for tickets

// --- FIREBASE DATABASE SETUP ---
// Ensure serviceAccountKey.json is in the same directory as server.js
// This file contains your Firebase project's service account credentials.
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

try {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
} catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error.message);
    // Exit the process if Firebase initialization fails, as it's critical
    process.exit(1);
}
const db = admin.firestore(); // Get a reference to the Firestore database

// --- SENDGRID EMAIL SETUP ---
// Configure SendGrid with your API key from environment variables
const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log('SendGrid API Key set.');
} else {
    console.warn('SENDGRID_API_KEY is not set. Email functionality might be limited.');
}
// --- END SENDGRID SETUP ---


// Initialize Express app
const app = express();

// --- Middleware Setup ---
app.use(cors()); // Allows all origins for simplicity. For production, restrict to your frontend URL.
app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request bodies

// Determine the port to listen on: use the environment variable PORT provided by Render,
// or default to 3000 for local development.
const PORT = process.env.PORT || 3000;

// --- Test Route ---
app.get('/', (req, res) => {
    res.status(200).send('Sarami Ticketing Backend is running!');
});


// --- InfinitiPay Authentication Function ---
// Caches the token to avoid re-fetching on every request until it expires.
let infinitiPayAccessToken = null;
let tokenExpiryTime = null;

async function getInfinitiPayToken() {
    // If token exists and is not expired, use cached token
    if (infinitiPayAccessToken && tokenExpiryTime && Date.now() < tokenExpiryTime) {
        console.log('Using cached InfinitiPay token');
        return infinitiPayAccessToken;
    }

    console.log('Fetching new InfinitiPay token using PARTNER LOGIN...');
    try {
        const authPayload = {
            client_id: process.env.INFINITIPAY_CLIENT_ID,
            client_secret: process.env.INFINITIPAY_CLIENT_SECRET,
            grant_type: 'password', // As specified by Peter
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
        console.error('Error fetching InfinitiPay token:', error.message || 'Unknown error during token fetch.');
        if (error.response && error.response.data) {
            console.error('InfinitiPay Auth Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        throw new Error('Could not authenticate with InfinitiPay.');
    }
}

// --- Create Order and Initiate STK Push Endpoint ---
app.post('/api/create-order', async (req, res) => {
    console.log('Received booking request at /api/create-order:', req.body);
    const { fullName, email, phone, amount, quantity, eventId, eventName } = req.body;

    if (!fullName || !email || !phone || !amount || !eventId || !eventName || !quantity) {
        return res.status(400).json({ success: false, message: 'Missing required booking information.' });
    }

    let orderRef;
    let firestoreOrderId;
    try {
        console.log('Creating PENDING order in Firestore...');
        const orderData = {
            fullName, email, phone, amount, quantity, eventId, eventName,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            infinitiPayAssignedTxnId: null,
            infinitiPayMerchantTxnId: null
        };

        orderRef = await db.collection('orders').add(orderData);
        firestoreOrderId = orderRef.id;
        console.log(`Successfully created order document with ID: ${firestoreOrderId}`);

        const token = await getInfinitiPayToken();

        const cleanedPhoneNumber = phone.startsWith('0') ? '254' + phone.substring(1) : phone;
        const fullMerchantId = process.env.INFINITIPAY_MERCHANT_ID;
        const shortMerchantId = fullMerchantId ? fullMerchantId.slice(-3) : '';

        const stkPushPayload = {
            transactionId: firestoreOrderId,
            transactionReference: firestoreOrderId,
            amount: amount,
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
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (infinitiPayResponse.data.statusCode === 200 || infinitiPayResponse.data.success === true) {
            console.log('InfinitiPay STK Push Raw Success Response:', JSON.stringify(infinitiPayResponse.data, null, 2));

            let updateData = { status: 'INITIATED_STK_PUSH' };

            const infinitiPayAssignedTxnId = infinitiPayResponse.data.results?.transactionId || null;
            const infinitiPayMerchantTxnId = infinitiPayResponse.data.results?.merchantTxnId || null;

            if (infinitiPayAssignedTxnId) {
                updateData.infinitiPayAssignedTxnId = infinitiPayAssignedTxnId;
                console.log(`Stored InfinitiPay Assigned Transaction ID from initial response: ${infinitiPayAssignedTxnId}`);
            }
            if (infinitiPayMerchantTxnId) {
                updateData.infinitiPayMerchantTxnId = infinitiPayMerchantTxnId;
                console.log(`Stored InfinitiPay Merchant Transaction ID from initial response: ${infinitiPayMerchantTxnId}`);
            }

            await orderRef.update(updateData);

            res.status(200).json({
                success: true,
                message: 'STK Push initiated successfully. Please check your phone for the prompt.',
                orderId: firestoreOrderId,
                infinitiPayAssignedTxnId,
                infinitiPayMerchantTxnId
            });
        } else {
            throw new Error(`STK Push failed with provider. Response: ${JSON.stringify(infinitiPayResponse.data)}`);
        }
    } catch (error) {
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message || 'Unknown error' }).catch(err => console.error('Error updating order status to FAILED:', err));
        }
        console.error('Error in /api/create-order endpoint:', error.message || 'Unknown error occurred.');

        if (axios.isAxiosError(error) && error.response && error.response.data) {
            console.error('InfinitiPay STK Push Error Details:', JSON.stringify(error.response.data, null, 2));
            res.status(500).json({
                success: false,
                message: error.response.data.message || 'InfinitiPay STK Push failed.',
                details: error.response.data
            });
        } else {
            res.status(500).json({ success: false, message: error.message || 'An unexpected error occurred.', details: error });
        }
    }
});


// --- InfinitiPay Callback Endpoint ---
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => {
    console.log('--- Received InfinitiPay Callback ---');
    console.log('Callback Content-Type:', req.headers['content-type']);

    let callbackData;
    try {
        if (req.body && req.body.length > 0) {
            callbackData = JSON.parse(req.body.toString());
            console.log('Callback Body (Parsed JSON):', JSON.stringify(callbackData, null, 2));
        } else {
            console.log('Callback Body: empty or undefined');
            return res.status(400).json({ success: false, message: 'Empty callback body.' });
        }
    } catch (parseError) {
        console.error('Callback Error: Failed to parse JSON body.', parseError);
        console.log('Callback Body (Raw - JSON parse failed):', req.body.toString());
        return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
    }

    if (!callbackData || !callbackData.results) {
        console.error('Callback Error: Malformed payload, missing results.', JSON.stringify(callbackData, null, 2));
        return res.status(400).json({ success: false, message: 'Malformed callback payload: missing results.' });
    }

    const results = callbackData.results;
    const firestoreOrderIdFromCallback = results.merchantTxnId || results.transactionReference;
    const infinitiPayAssignedTxnIdFromCallback = results.transactionId;
    const transactionStatus = callbackData.statusCode;
    const transactionMessage = (callbackData.data && callbackData.data.description) || callbackData.message;

    if (!firestoreOrderIdFromCallback && !infinitiPayAssignedTxnIdFromCallback) {
        console.error('Callback Error: Could not extract any valid order identifier from callback.', JSON.stringify(callbackData, null, 2));
        return res.status(400).json({ success: false, message: 'Missing essential transaction identifiers in callback.' });
    }

    try {
        let orderDoc;
        let orderRef;
        let foundFirestoreOrderId;

        if (firestoreOrderIdFromCallback) {
            orderRef = db.collection('orders').doc(firestoreOrderIdFromCallback);
            orderDoc = await orderRef.get();
            if (orderDoc.exists) {
                foundFirestoreOrderId = orderDoc.id;
                console.log(`Order found directly by Firestore ID: ${foundFirestoreOrderId}`);
            }
        }

        if ((!orderDoc || !orderDoc.exists) && infinitiPayAssignedTxnIdFromCallback) {
            console.warn(`Order not found by direct ID. Attempting lookup by 'infinitiPayAssignedTxnId': ${infinitiPayAssignedTxnIdFromCallback}`);
            const querySnapshot = await db.collection('orders').where('infinitiPayAssignedTxnId', '==', infinitiPayAssignedTxnIdFromCallback).limit(1).get();
            if (!querySnapshot.empty) {
                orderDoc = querySnapshot.docs[0];
                orderRef = orderDoc.ref;
                foundFirestoreOrderId = orderDoc.id;
                console.log(`Order found by 'infinitiPayAssignedTxnId'. Firestore ID: ${foundFirestoreOrderId}`);
            }
        }

        if (!orderDoc || !orderDoc.exists) {
            console.error('Order not found in Firestore for callback.', JSON.stringify(callbackData, null, 2));
            return res.status(404).json({ success: false, message: 'Order not found for callback.' });
        }

        let newStatus = 'FAILED';
        if (transactionStatus === 200 && transactionMessage && (transactionMessage.toLowerCase().includes("success") || transactionMessage.toLowerCase().includes("completed"))) {
            newStatus = 'PAID';
        } else if (transactionMessage?.toLowerCase().includes("request cancelled by user")) {
            newStatus = 'CANCELLED';
        } else if (transactionMessage?.toLowerCase().includes("ds timeout user cannot be reached")) {
            newStatus = 'TIMED_OUT';
        } else if (transactionStatus === 400 && transactionMessage?.toLowerCase().includes("duplicate request")) {
            console.warn(`InfinitiPay callback: Duplicate request for ${foundFirestoreOrderId}.`);
            return res.status(200).json({ success: true, message: 'Callback already processed.' });
        }

        let updateFields = {
            status: newStatus,
            callbackData: callbackData,
            infinitiPayCallbackStatus: transactionStatus,
            infinitiPayCallbackMessage: transactionMessage,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (infinitiPayAssignedTxnIdFromCallback) {
            updateFields.infinitiPayAssignedTxnId = infinitiPayAssignedTxnIdFromCallback;
        }
        if (results.merchantTxnId) {
            updateFields.infinitiPayMerchantTxnId = results.merchantTxnId;
        }

        await orderRef.update(updateFields);
        console.log(`Updated order ${foundFirestoreOrderId} status to ${newStatus}.`);

        // --- [MODIFIED] SEND E-TICKET ON SUCCESSFUL PAYMENT ---
        if (newStatus === 'PAID') {
            const orderData = orderDoc.data();
            console.log(`Payment successful for order ${foundFirestoreOrderId}. Preparing to send e-ticket...`);

            try {
                const qrCodeDataURL = await qrcode.toDataURL(foundFirestoreOrderId);

                // For a real app, you would fetch these details from your 'events' collection
                // using orderData.eventId to make them dynamic.
                const eventDetails = {
                    date: "January 1, 2026", // Placeholder
                    time: "7:00 PM EAT",      // Placeholder
                    venue: "Sarit Centre, Nairobi" // Placeholder
                };

                const emailHtml = `
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Your Ticket for ${orderData.eventName}</title>
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f0f2f5; margin: 0; padding: 20px; }
                            .container { max-width: 420px; margin: auto; background: #ffffff; border-radius: 12px; box-shadow: 0 6px 20px rgba(0,0,0,0.08); overflow: hidden; }
                            .header { background-color: #111827; color: white; padding: 24px; text-align: center; }
                            .header h1 { margin: 0; color: #d4af37; font-size: 26px; font-weight: 600; }
                            .content { padding: 24px; }
                            .content p { color: #4b5563; line-height: 1.6; margin: 0 0 16px 0; }
                            .ticket-details { margin-top: 20px; border-top: 1px dashed #d1d5db; padding-top: 20px; font-size: 14px; }
                            .ticket-details p { margin-bottom: 8px; }
                            .ticket-details strong { color: #1f2937; }
                            .qr-code { text-align: center; margin: 25px 0 10px 0; }
                            .qr-code img { border: 6px solid #111827; border-radius: 8px; }
                            .footer { text-align: center; padding: 20px; font-size: 12px; color: #6b7280; background-color: #f9fafb; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1>E-Ticket Confirmation</h1>
                            </div>
                            <div class="content">
                                <p><strong>Hi ${orderData.fullName},</strong></p>
                                <p>Get ready for an amazing experience! Your ticket for <strong>${orderData.eventName}</strong> is confirmed.</p>
                                
                                <div class="ticket-details">
                                    <p><strong>Attendee:</strong> ${orderData.fullName}</p>
                                    <p><strong>Event:</strong> ${orderData.eventName}</p>
                                    <p><strong>Date:</strong> ${eventDetails.date}</p>
                                    <p><strong>Time:</strong> ${eventDetails.time}</p>
                                    <p><strong>Venue:</strong> ${eventDetails.venue}</p>
                                    <p><strong>Quantity:</strong> ${orderData.quantity}</p>
                                    <p><strong>Order ID:</strong> ${foundFirestoreOrderId}</p>
                                </div>

                                <div class="qr-code">
                                    <p style="color: #4b5563; font-weight: 500;">Scan this QR code at the entrance for entry.</p>
                                    <img src="${qrCodeDataURL}" alt="Your QR Code Ticket" />
                                </div>
                            </div>
                            <div class="footer">
                                <p>We look forward to seeing you there!<br>The Sarami Events Team</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `;

                const emailMsg = {
                    to: orderData.email,
                    from: process.env.SENDGRID_FROM_EMAIL,
                    subject: `✨ Your Ticket to ${orderData.eventName} is Here!`,
                    html: emailHtml,
                };

                await sgMail.send(emailMsg);
                console.log(`E-Ticket sent successfully to: ${orderData.email}`);

            } catch (error) {
                console.error('Error during e-ticket generation or sending:', error);
                if (error.response) {
                    console.error('SendGrid Error Body:', error.response.body);
                }
            }
        }
        // --- END EMAIL LOGIC ---

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
