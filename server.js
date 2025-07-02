// Import necessary modules
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file
const crypto = require('crypto'); // Import crypto for generating UUIDs

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
// --- DEBUGGING CORS: Temporarily allow ALL origins ---
// This is for troubleshooting only. Revert to a specific origin for production.
app.use(cors()); // Simple usage to allow all origins
// --- END DEBUGGING CORS ---

// Parse JSON request bodies
app.use(express.json());
// Parse URL-encoded request bodies (for form data)
app.use(express.urlencoded({ extended: true }));

// Determine the port to listen on: use the environment variable PORT provided by Render,
// or default to 3000 for local development.
const PORT = process.env.PORT || 3000;

// --- Test Route ---
// This GET route is for a simple health check or to confirm the server is running.
app.get('/', (req, res) => {
    res.status(200).send('Sarami Ticketing Backend is running!');
});

// --- IMPORTANT: FRONTEND FETCH URL NOTE ---
// Your frontend 'fetch' call's URL for booking MUST be:
// 'https://ticketing-app-final.onrender.com/api/create-order'
// It should NOT be just 'https://ticketing-app-final.onrender.com/' for POST requests.
// --- END FRONTEND FETCH URL NOTE ---


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

        // Make a POST request to the InfinitiPay authentication URL
        const response = await axios.post(
            process.env.INFINITIPAY_AUTH_URL,
            authPayload,
            { headers: { 'Content-Type': 'application/json' } }
        );

        // Extract the access token from the response
        const accessToken = response.data.token || response.data.access_token;
        if (!accessToken) {
            throw new Error('Access Token not found in partner login response.');
        }

        infinitiPayAccessToken = accessToken;
        // Set expiry time (default to 1 hour if not provided, subtract 60 seconds buffer)
        const expiresIn = response.data.expires_in || 3600;
        tokenExpiryTime = Date.now() + (expiresIn - 60) * 1000;

        console.log('New InfinitiPay token obtained via partner login.');
        return infinitiPayAccessToken;
    } catch (error) {
        console.error('Error fetching InfinitiPay token:', error.message || 'Unknown error during token fetch.');
        // Log the full error response from InfinitiPay if available
        if (error.response && error.response.data) {
            console.error('InfinitiPay Auth Error Details:', JSON.stringify(error.response.data, null, 2));
        }
        // Re-throw the error to be caught by the calling function/endpoint
        throw new Error('Could not authenticate with InfinitiPay.');
    }
}

app.post('/api/create-order', async (req, res) => {
    console.log('Received booking request at /api/create-order:', req.body);
    const { fullName, email, phone, amount, quantity, eventId, eventName } = req.body;

    // Basic input validation
    if (!fullName || !email || !phone || !amount || !eventId || !eventName || !quantity) {
        return res.status(400).json({ success: false, message: 'Missing required booking information.' });
    }

    let orderRef; // Variable to hold Firestore document reference
    let firestoreOrderId; // NEW: Variable to store the Firestore generated ID
    try {
        console.log('Creating PENDING order in Firestore...');
        const orderData = {
            fullName, email, phone, amount, quantity, eventId, eventName,
            status: 'PENDING', // Initial status
            createdAt: admin.firestore.FieldValue.serverTimestamp(), // Timestamp when created
            // Renamed and initialized to null; will be updated after STK push initiates
            infinitiPayTransactionId: null
        };

        // Add the order to the 'orders' collection in Firestore
        orderRef = await db.collection('orders').add(orderData);
        firestoreOrderId = orderRef.id; // Store the Firestore generated ID
        console.log(`Successfully created order document with ID: ${firestoreOrderId}`);

        // Get InfinitiPay access token
        const token = await getInfinitiPayToken();

        // --- PROPOSED CHANGE: STK Push Payload ---
        const cleanedPhoneNumber = phone.startsWith('0') ? '254' + phone.substring(1) : phone;

        // Extract last 3 digits of merchant ID
        const fullMerchantId = process.env.INFINITIPAY_MERCHANT_ID;
        const shortMerchantId = fullMerchantId ? fullMerchantId.slice(-3) : '';

        const stkPushPayload = {
            // Keep sending YOUR Firestore order ID as a reference to InfinitiPay.
            // This is useful if they allow it, so you have your internal reference.
            transactionId: firestoreOrderId, // Still sending YOUR Firestore order ID
            transactionReference: firestoreOrderId, // Still sending YOUR Firestore order ID
            amount: amount, // Passed as a number (double)
            merchantId: shortMerchantId, // UPDATED: Using last 3 digits as per Peter
            transactionTypeId: 1,
            payerAccount: cleanedPhoneNumber, // Changed from customerPhone to payerAccount
            narration: `Tickets for ${eventName}`, // UPDATED: Changed from 'description' to 'narration'
            callbackURL: process.env.YOUR_APP_CALLBACK_URL, // URL where InfinitiPay sends status updates
            ptyId: 1 // Added as per Peter's latest instruction
        };

        console.log('Sending STK Push request with payload:', JSON.stringify(stkPushPayload, null, 2));

        // Request STK Push from InfinitiPay
        const infinitiPayResponse = await axios.post(
            process.env.INFINITIPAY_STKPUSH_URL, // NEW ENDPOINT
            stkPushPayload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // --- STK Push Response Handling ---
        if (infinitiPayResponse.data.statusCode === 200 || infinitiPayResponse.data.success === true) {
            // --- ADDED DEBUGGING LOG FOR RAW SUCCESS RESPONSE ---
            console.log('InfinitiPay STK Push Raw Success Response:', JSON.stringify(infinitiPayResponse.data, null, 2));
            // --- END ADDED DEBUGGING LOG ---

            // --- CRITICAL CHANGE: Extract transactionId from results.transactionId (InfinitiPay's own ID) ---
            const infinitiPayAssignedTransactionId = infinitiPayResponse.data.results && infinitiPayResponse.data.results.transactionId
                                                     ? infinitiPayResponse.data.results.transactionId
                                                     : null; // Fallback to null if not found

            if (infinitiPayAssignedTransactionId) {
                // Update the Firestore document with InfinitiPay's transactionId
                // This is the ID you will use to find the order in the callback
                await orderRef.update({
                    infinitiPayTransactionId: infinitiPayAssignedTransactionId,
                    status: 'INITIATED_STK_PUSH'
                });
                console.log(`Updated Firestore order ${firestoreOrderId} with InfinitiPay Transaction ID: ${infinitiPayAssignedTransactionId}`);

                res.status(200).json({
                    success: true,
                    message: 'STK Push initiated successfully. Please check your phone for the prompt.',
                    transactionId: infinitiPayAssignedTransactionId, // Send THEIR transaction ID to frontend
                    orderId: firestoreOrderId // Still send your internal order ID for reference
                });
            } else {
                // If InfinitiPay didn't return its own transactionId in results.transactionId,
                // log a warning and proceed, but this might lead to issues in callback matching
                console.warn(`STK Push initiated, but no 'transactionId' found in InfinitiPay response. Falling back to internal Firestore ID for response.`);
                await orderRef.update({ status: 'INITIATED_STK_PUSH' }); // Update without InfinitiPay ID
                // You might choose to throw an error here if `infinitiPayAssignedTransactionId` is mandatory for your flow.
                res.status(200).json({
                    success: true,
                    message: 'STK Push initiated successfully. Please check your phone for the prompt. (InfinitiPay ID not received)',
                    transactionId: firestoreOrderId, // Fallback to sending your Firestore ID
                    orderId: firestoreOrderId
                });
            }
        } else {
            throw new Error(`STK Push failed with provider. Response: ${JSON.stringify(infinitiPayResponse.data)}`);
        }
    } catch (error) {
        // If an order was created before the error, update its status to FAILED
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message || 'Unknown error' }).catch(updateErr => {
                console.error('Error updating order status to FAILED after STK Push attempt:', updateErr.message);
            });
        }
        console.error('Error in /api/create-order endpoint:', error.message || 'Unknown error occurred.');

        // Log InfinitiPay's detailed error response
        if (axios.isAxiosError(error) && error.response && error.response.data) {
            console.error('InfinitiPay STK Push Error Details:', JSON.stringify(error.response.data, null, 2));
            res.status(500).json({
                success: false,
                message: error.response.data.message || 'InfinitiPay STK Push failed.',
                details: error.response.data
            });
        } else {
            // Handle other types of errors
            res.status(500).json({ success: false, message: error.message || 'An unexpected error occurred.', details: error });
        }
    }
});


// --- InfinitiPay Callback Endpoint ---
// This endpoint receives payment status updates from InfinitiPay.
app.post('/api/infinitipay-callback', express.raw({ type: '*/*' }), async (req, res) => { // Use express.raw to get the raw body
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

    // --- CRITICAL CHANGE: Use results.transactionId from the callback payload ---
    // This is the ID (e.g., "IL98556") that InfinitiPay sent back.
    const infinitiPayCallbackTransactionId = results.transactionId;

    const transactionStatus = callbackData.statusCode; // Use statusCode for primary status check
    const transactionMessage = callbackData.message; // Use message for detailed status

    // Validate essential callback data
    if (!infinitiPayCallbackTransactionId) {
        console.error('Callback Error: Missing transactionId in results from InfinitiPay. Callback Payload:', JSON.stringify(callbackData, null, 2));
        return res.status(400).json({ success: false, message: 'Missing transactionId in callback results.' });
    }

    try {
        // --- CRITICAL CHANGE: Query Firestore using the infinitiPayTransactionId field ---
        // Instead of .doc(), we use .where() to find the document that has this InfinitiPay ID.
        const ordersSnapshot = await db.collection('orders')
                                        .where('infinitiPayTransactionId', '==', infinitiPayCallbackTransactionId)
                                        .limit(1) // Limit to 1 as this ID should be unique to an order
                                        .get();

        if (ordersSnapshot.empty) {
            console.warn(`Order with InfinitiPay transactionId ${infinitiPayCallbackTransactionId} not found in Firestore. Callback Payload:`, JSON.stringify(callbackData, null, 2));
            return res.status(404).json({ success: false, message: 'Order not found for callback (InfinitiPay transaction ID mismatch).' });
        }

        // Get the actual Firestore document and its reference
        const orderDoc = ordersSnapshot.docs[0];
        const orderRef = orderDoc.ref;
        const firestoreOrderId = orderDoc.id; // Your internal Firestore ID

        // Determine the new status based on InfinitiPay's callback status codes and messages
        let newStatus = 'FAILED'; // Default to FAILED
        if (transactionStatus === 200 && transactionMessage === "Transaction processed successfully") {
            newStatus = 'PAID';
        } else if (transactionStatus === 400 && transactionMessage === "Request cancelled by user") {
            newStatus = 'CANCELLED'; // Specific status for user cancellation
        } else if (transactionStatus === 400 && transactionMessage === "DS timeout user cannot be reached") {
            newStatus = 'TIMED_OUT'; // Specific status for timeout
        }
        // You might want to add more specific statuses based on other messages if they exist

        // Update the order status and save the full callback data in Firestore
        await orderRef.update({
            status: newStatus,
            callbackData: callbackData, // Save the entire callback payload for debugging
            infinitiPayCallbackStatus: transactionStatus,
            infinitiPayCallbackMessage: transactionMessage,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Updated order ${firestoreOrderId} (InfinitiPay ID: ${infinitiPayCallbackTransactionId}) status to ${newStatus} based on InfinitiPay callback.`);

        // --- SEND EMAIL ON SUCCESSFUL PAYMENT ---
        if (newStatus === 'PAID') {
            const orderData = orderDoc.data(); // Get the latest data from the found document
            console.log(`Payment successful for order ${firestoreOrderId}. Sending email receipt...`);

            const emailMsg = {
                to: orderData.email, // The customer's email address
                from: process.env.SENDGRID_FROM_EMAIL, // Your verified sender email (MUST be verified in SendGrid)
                subject: `Your Ticket for ${orderData.eventName}`,
                html: `
                    <h1>Thank you for your order!</h1>
                    <p>Hi ${orderData.fullName},</p>
                    <p>Your booking is confirmed. Here are your ticket details:</p>
                    <ul>
                        <li><strong>Order ID:</strong> ${firestoreOrderId}</li>
                        <li><strong>InfinitiPay Transaction ID:</strong> ${infinitiPayCallbackTransactionId}</li>
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
                // Important: Do NOT stop the callback process if email fails, just log it.
            }
        }
        // --- END EMAIL LOGIC ---

        // Send a success response back to InfinitiPay (as per their callback requirements)
        res.status(200).json({ success: true, message: 'Callback processed successfully.' });
    } catch (error) {
        console.error(`Error processing callback for InfinitiPay ID ${infinitiPayCallbackTransactionId}:`, error);
        res.status(500).json({ success: false, message: 'Internal server error processing callback.' });
    }
});


// --- Generic Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err.stack); // Log the full stack trace for debugging
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
