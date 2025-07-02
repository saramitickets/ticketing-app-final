// Import necessary modules
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file
const crypto = require('crypto'); // Import crypto for generating UUIDs

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
const db = admin.firestore(); // Get a reference to the Firestore database

// --- SENDGRID EMAIL SETUP ---
const sgMail = require('@sendgrid/mail');
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log('SendGrid API Key set.');
} else {
    console.warn('SENDGRID_API_KEY is not set. Email functionality might be limited.');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send('Sarami Ticketing Backend is running!');
});

// --- InfinitiPay Authentication Function (No Change) ---
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
        console.error('Error fetching InfinitiPay token:', error.message || 'Unknown error during token fetch.');
        if (error.response && error.response.data) {
            console.error('InfinitiPay Auth Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        throw new Error('Could not authenticate with InfinitiPay.');
    }
}

app.post('/api/create-order', async (req, res) => {
    console.log('Received booking request at /api/create-order:', req.body);
    const { fullName, email, phone, amount, quantity, eventId, eventName } = req.body;

    if (!fullName || !email || !phone || !amount || !eventId || !eventName || !quantity) {
        return res.status(400).json({ success: false, message: 'Missing required booking information.' });
    }

    let orderRef;
    let firestoreOrderId; // To hold the Firestore generated ID
    try {
        console.log('Creating PENDING order in Firestore...');
        const orderData = {
            fullName, email, phone, amount, quantity, eventId, eventName,
            status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // Rename to make it clear this is InfinitiPay's *specific* transaction ID if they provide it
            infinitiPayAssignedTxnId: null, // Will store InfinitiPay's `results.transactionId` if available
            // Add a field to store the InfinitiPay `merchantTxnId` if different and useful for tracking
            infinitiPayMerchantTxnId: null
        };

        orderRef = await db.collection('orders').add(orderData);
        firestoreOrderId = orderRef.id; // Get the Firestore-generated ID
        console.log(`Successfully created order document with ID: ${firestoreOrderId}`);

        const token = await getInfinitiPayToken();

        const cleanedPhoneNumber = phone.startsWith('0') ? '254' + phone.substring(1) : phone;
        const fullMerchantId = process.env.INFINITIPAY_MERCHANT_ID;
        const shortMerchantId = fullMerchantId ? fullMerchantId.slice(-3) : '';

        const stkPushPayload = {
            // CRITICAL CHANGE: Always send your Firestore Order ID as transactionId and transactionReference
            // This is the primary key you'll use for lookup in the callback.
            transactionId: firestoreOrderId, // Use YOUR Firestore ID
            transactionReference: firestoreOrderId, // Use YOUR Firestore ID
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

            // IMPORTANT: Store InfinitiPay's specific transactionId if they provide it
            const infinitiPayAssignedTxnId = infinitiPayResponse.data.results && infinitiPayResponse.data.results.transactionId
                                                ? infinitiPayResponse.data.results.transactionId
                                                : null;

            // Also store their merchantTxnId if available, as it might be useful for reconciliation
            const infinitiPayMerchantTxnId = infinitiPayResponse.data.results && infinitiPayResponse.data.results.merchantTxnId
                                                ? infinitiPayResponse.data.results.merchantTxnId
                                                : null;

            if (infinitiPayAssignedTxnId) {
                updateData.infinitiPayAssignedTxnId = infinitiPayAssignedTxnId;
                console.log(`Stored InfinitiPay Assigned Transaction ID: ${infinitiPayAssignedTxnId}`);
            } else {
                console.warn(`InfinitiPay STK Push initiated, but no 'transactionId' found in InfinitiPay response. This is not ideal, but proceeding with internal ID.`);
            }

            if (infinitiPayMerchantTxnId) {
                updateData.infinitiPayMerchantTxnId = infinitiPayMerchantTxnId;
                console.log(`Stored InfinitiPay Merchant Transaction ID: ${infinitiPayMerchantTxnId}`);
            }

            // Update the Firestore document
            await orderRef.update(updateData);

            res.status(200).json({
                success: true,
                message: 'STK Push initiated successfully. Please check your phone for the prompt.',
                // Respond with your internal Firestore ID as the primary transaction identifier for the frontend
                // You can also include InfinitiPay's IDs if the frontend needs them for display/tracking.
                orderId: firestoreOrderId,
                infinitiPayAssignedTxnId: infinitiPayAssignedTxnId, // Send this if available
                infinitiPayMerchantTxnId: infinitiPayMerchantTxnId // Send this if available
            });
        } else {
            throw new Error(`STK Push failed with provider. Response: ${JSON.stringify(infinitiPayResponse.data)}`);
        }
    } catch (error) {
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message || 'Unknown error' }).catch(updateErr => {
                console.error('Error updating order status to FAILED after STK Push attempt:', updateErr.message);
            });
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
    if (req.body) {
        const contentType = req.headers['content-type'];
        if (contentType && (contentType.includes('application/json') || contentType.includes('text/plain'))) {
            try {
                callbackData = JSON.parse(req.body.toString());
                console.log('Callback Body (Parsed JSON):', JSON.stringify(callbackData, null, 2));
            } catch (parseError) {
                console.error('Callback Error: Failed to parse JSON body.', parseError);
                console.log('Callback Body (Raw - JSON parse failed):', req.body.toString());
                return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
            }
        } else {
            console.log('Callback Body (Raw - Unsupported Content-Type):', req.body.toString());
            return res.status(400).json({ success: false, message: 'Unsupported Content-Type or malformed body.' });
        }
    } else {
        console.log('Callback Body: undefined or empty');
        return res.status(400).json({ success: false, message: 'Empty or undefined callback body.' });
    }

    if (!callbackData || !callbackData.results) {
        console.error('Callback Error: Missing callbackData or results in payload. Callback Payload:', JSON.stringify(callbackData, null, 2));
        return res.status(400).json({ success: false, message: 'Malformed callback payload: missing results.' });
    }

    const results = callbackData.results;

    // CRITICAL CHANGE: Get YOUR transaction ID from the callback.
    // InfinitiPay should return the 'transactionId' or 'merchantTxnId' that YOU sent them.
    // Based on your logs, `transactionId` in the *callback* contains InfinitiPay's ID.
    // However, if your `firestoreOrderId` was sent as `transactionReference` or `merchantTxnId`
    // and those are reliable in the callback, use them.
    // For now, let's assume `transactionReference` or `merchantTxnId` should carry your original ID.
    // If neither works, then the lookup by `infinitiPayAssignedTxnId` (Method 1 from previous step)
    // is the only way, but that requires InfinitiPay to *always* provide it in the initial response.

    // Let's first try to look up by transactionReference, as you sent your Firestore ID there.
    const transactionReferenceFromCallback = results.transactionReference || results.transactionId || results.merchantTxnId; // Prioritize based on what InfinitiPay sends back that *matches your original ID*

    const infinitiPayAssignedTxnIdFromCallback = results.transactionId; // This is the 'IL98557' that caused previous errors

    const transactionStatus = callbackData.statusCode;
    const transactionMessage = callbackData.data && callbackData.data.description || callbackData.message; // Use data.description if available, then message

    if (!transactionReferenceFromCallback) {
        console.error('Callback Error: Missing primary transaction reference (transactionReference, transactionId, or merchantTxnId) in callback results. Callback Payload:', JSON.stringify(callbackData, null, 2));
        return res.status(400).json({ success: false, message: 'Missing primary transaction reference in callback.' });
    }

    try {
        let orderDoc;
        let orderRef;
        let firestoreOrderId;

        // Try to find the order using the transactionReference you sent
        orderRef = db.collection('orders').doc(transactionReferenceFromCallback);
        orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            console.warn(`Order with Firestore ID (from callback's transactionReference) ${transactionReferenceFromCallback} not found. Attempting lookup by InfinitiPayAssignedTxnId if available...`);

            // If not found by direct ID, try to find by the InfinitiPay assigned ID if present in the callback
            if (infinitiPayAssignedTxnIdFromCallback && infinitiPayAssignedTxnIdFromCallback !== transactionReferenceFromCallback) {
                const altOrdersSnapshot = await db.collection('orders')
                                                .where('infinitiPayAssignedTxnId', '==', infinitiPayAssignedTxnIdFromCallback)
                                                .limit(1)
                                                .get();
                if (!altOrdersSnapshot.empty) {
                    orderDoc = altOrdersSnapshot.docs[0];
                    orderRef = orderDoc.ref;
                    firestoreOrderId = orderDoc.id;
                    console.log(`Order found by InfinitiPayAssignedTxnId: ${firestoreOrderId}`);
                }
            }

            if (!orderDoc) { // Still not found
                console.error(`Order not found by any ID in Firestore for callback. Callback Payload:`, JSON.stringify(callbackData, null, 2));
                return res.status(404).json({ success: false, message: 'Order not found for callback by any matching ID.' });
            }
        } else {
             firestoreOrderId = orderDoc.id;
        }


        let newStatus = 'FAILED';
        // Check for success: status code 200 and success message
        if (transactionStatus === 200 && transactionMessage && (
            transactionMessage.toLowerCase().includes("transaction processed successfully") ||
            transactionMessage.toLowerCase().includes("success") // Add broad success check
        )) {
            newStatus = 'PAID';
        } else if (transactionMessage && transactionMessage.toLowerCase().includes("request cancelled by user")) {
            newStatus = 'CANCELLED';
        } else if (transactionMessage && transactionMessage.toLowerCase().includes("ds timeout user cannot be reached")) {
            newStatus = 'TIMED_OUT';
        } else if (transactionStatus === 400 && transactionMessage && transactionMessage.toLowerCase().includes("duplicate request")) {
            // Handle duplicate requests gracefully if needed, maybe don't change status
            console.warn(`InfinitiPay callback: Duplicate request for ${transactionReferenceFromCallback}. Status: ${transactionStatus}, Message: ${transactionMessage}`);
             return res.status(200).json({ success: true, message: 'Callback already processed or duplicate.' });
        }
        // Add more specific status mappings if InfinitiPay provides other definitive messages/codes

        let updateFields = {
            status: newStatus,
            callbackData: callbackData,
            infinitiPayCallbackStatus: transactionStatus,
            infinitiPayCallbackMessage: transactionMessage,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // If InfinitiPay assigned a specific transactionId in the callback and it's different from our internal ID, store it
        if (infinitiPayAssignedTxnIdFromCallback && infinitiPayAssignedTxnIdFromCallback !== firestoreOrderId) {
             updateFields.infinitiPayAssignedTxnId = infinitiPayAssignedTxnIdFromCallback;
        }
        // Also store their merchantTxnId from callback if present
        if (results.merchantTxnId) {
             updateFields.infinitiPayMerchantTxnId = results.merchantTxnId;
        }


        await orderRef.update(updateFields);
        console.log(`Updated order ${firestoreOrderId} status to ${newStatus} based on InfinitiPay callback. InfinitiPay TxnId: ${infinitiPayAssignedTxnIdFromCallback || 'N/A'}`);

        if (newStatus === 'PAID') {
            const orderData = orderDoc.data();
            console.log(`Payment successful for order ${firestoreOrderId}. Sending email receipt...`);

            const emailMsg = {
                to: orderData.email,
                from: process.env.SENDGRID_FROM_EMAIL,
                subject: `Your Ticket for ${orderData.eventName}`,
                html: `
                    <h1>Thank you for your order!</h1>
                    <p>Hi ${orderData.fullName},</p>
                    <p>Your booking is confirmed. Here are your ticket details:</p>
                    <ul>
                        <li><strong>Order ID:</strong> ${firestoreOrderId}</li>
                        ${infinitiPayAssignedTxnIdFromCallback ? `<li><strong>InfinitiPay Transaction ID:</strong> ${infinitiPayAssignedTxnIdFromCallback}</li>` : ''}
                        <li><strong>Event:</strong> ${orderData.eventName}</li>
                        <li><strong>Quantity:</strong> ${orderData.quantity}</li>
                        <li><strong>Total Amount:</strong> KES ${orderData.amount.toLocaleString()}</li>
                    </ul>
                    <p>We look forward to seeing you there!</p>
                    <p>Sincerely,<br>The Sarami Events Team</p>
                `,
            };

            try {
                await sgMail.send(emailMsg);
                console.log('Email receipt sent successfully to:', orderData.email);
            } catch (emailError) {
                console.error('Error sending email via SendGrid:', emailError.response ? emailError.response.body : emailError);
            }
        }

        res.status(200).json({ success: true, message: 'Callback processed successfully.' });
    } catch (error) {
        console.error(`Error processing callback for original reference ${transactionReferenceFromCallback}:`, error);
        res.status(500).json({ success: false, message: 'Internal server error processing callback.' });
    }
});


// --- Generic Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err.stack);
    res.status(500).json({
        success: false,
        message: 'An unexpected internal server error occurred.',
        error: process.env.NODE_ENV === 'production' ? {} : { message: err.message || 'Unknown error', stack: err.stack }
    });
});


// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Sarami Ticketing Backend server is running on port ${PORT}`);
});
