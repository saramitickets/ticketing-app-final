// Import necessary modules
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file

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
// Enable CORS for all origins (consider restricting in production)
app.use(cors());
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
        // --- PROPOSED CHANGE START ---
        // Updated authPayload to use client_id, client_secret, and grant_type
        const authPayload = {
            client_id: process.env.INFINITIPAY_CLIENT_ID,
            client_secret: process.env.INFINITIPAY_CLIENT_SECRET,
            grant_type: 'password' // As specified by Peter
        };
        // --- PROPOSED CHANGE END ---

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
        console.error('Error fetching InfinitiPay token:', error.message);
        // Re-throw the error to be caught by the calling function/endpoint
        throw new Error('Could not authenticate with InfinitiPay.');
    }
}


// --- API Endpoint for Creating an Order ---
// This endpoint handles the initial booking request from the frontend,
// creates an order in Firestore, and generates a payment link via InfinitiPay.
app.post('/api/create-order', async (req, res) => {
    console.log('Received booking request at /api/create-order:', req.body);
    const { fullName, email, phone, amount, quantity, eventId, eventName } = req.body;

    // Basic input validation
    if (!fullName || !email || !phone || !amount || !eventId || !eventName || !quantity) {
        return res.status(400).json({ success: false, message: 'Missing required booking information.' });
    }

    let orderRef; // Variable to hold Firestore document reference
    try {
        console.log('Creating PENDING order in Firestore...');
        const orderData = {
            fullName, email, phone, amount, quantity, eventId, eventName,
            status: 'PENDING', // Initial status
            createdAt: admin.firestore.FieldValue.serverTimestamp(), // Timestamp when created
            infinitiPayCheckoutId: null // To be updated later
        };

        // Add the order to the 'orders' collection in Firestore
        orderRef = await db.collection('orders').add(orderData);
        console.log(`Successfully created order document with ID: ${orderRef.id}`);

        // Get InfinitiPay access token
        const token = await getInfinitiPayToken();

        // Prepare payload for generating payment link
        const paymentLinkPayload = {
            amount: String(amount), // Amount needs to be a string for InfinitiPay
            currency: "KES",
            description: `Tickets for ${eventName}`,
            merchantId: process.env.INFINITIPAY_MERCHANT_ID,
            transactionReference: orderRef.id, // Use Firestore order ID as transaction reference
            customerName: fullName,
            callbackURL: process.env.YOUR_APP_CALLBACK_URL // URL where InfinitiPay sends status updates
        };

        // Request payment link from InfinitiPay
        const infinitiPayResponse = await axios.post(
            process.env.INFINITIPAY_GENERATE_LINK_URL,
            paymentLinkPayload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const checkoutId = infinitiPayResponse.data.checkoutId;

        // Check if payment link generation was successful
        if (infinitiPayResponse.data.statusCode === 200 && checkoutId) {
            const paymentGatewayUrl = `https://dtbx-infinitilite-dashboard-v2-client-uat.azurewebsites.net/checkout/${checkoutId}`;

            // Update the Firestore order with the InfinitiPay checkout ID
            await orderRef.update({ infinitiPayCheckoutId: checkoutId });

            // Send success response to frontend with payment gateway URL
            res.status(200).json({
                success: true,
                message: 'Order created, proceed to payment.',
                paymentGatewayUrl,
                orderId: orderRef.id
            });
        } else {
            // Throw an error if InfinitiPay response indicates failure
            throw new Error(`Failed to process payment with provider. Response: ${JSON.stringify(infinitiPayResponse.data)}`);
        }
    } catch (error) {
        // If an order was created before the error, update its status to FAILED
        if (orderRef) {
            await orderRef.update({ status: 'FAILED', errorMessage: error.message }).catch(updateErr => {
                console.error('Error updating order status to FAILED:', updateErr.message);
            });
        }
        console.error('Error in /api/create-order endpoint:', error.message);
        // Send an error response to the frontend
        res.status(500).json({ success: false, message: error.message, details: error.message });
    }
});


// --- InfinitiPay Callback Endpoint ---
// This endpoint receives payment status updates from InfinitiPay.
app.post('/api/infinitipay-callback', async (req, res) => {
    console.log('--- Received InfinitiPay Callback ---');
    console.log('Callback Body:', JSON.stringify(req.body, null, 2));

    const { transactionReference, transactionStatus } = req.body;

    // Validate essential callback data
    if (!transactionReference) {
        return res.status(400).json({ success: false, message: 'Missing transactionReference.' });
    }

    try {
        const orderRef = db.collection('orders').doc(transactionReference);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            console.warn(`Order with transactionReference ${transactionReference} not found.`);
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        // Determine the new status based on InfinitiPay's transactionStatus
        let newStatus = ['COMPLETED', 'SUCCESS', 'PAID'].includes((transactionStatus || '').toUpperCase()) ? 'PAID' : 'FAILED';

        // Update the order status and save callback data in Firestore
        await orderRef.update({ status: newStatus, callbackData: req.body });
        console.log(`Updated order ${transactionReference} status to ${newStatus}`);

        // --- SEND EMAIL ON SUCCESSFUL PAYMENT ---
        if (newStatus === 'PAID') {
            const orderData = orderDoc.data();
            console.log(`Payment successful for order ${transactionReference}. Sending email receipt...`);

            const emailMsg = {
                to: orderData.email, // The customer's email address
                from: process.env.SENDGRID_FROM_EMAIL, // Your verified sender email (MUST be verified in SendGrid)
                subject: `Your Ticket for ${orderData.eventName}`,
                html: `
                    <h1>Thank you for your order!</h1>
                    <p>Hi ${orderData.fullName},</p>
                    <p>Your booking is confirmed. Here are your ticket details:</p>
                    <ul>
                        <li><strong>Order ID:</strong> ${transactionReference}</li>
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
        console.error(`Error processing callback for order ${transactionReference}:`, error);
        res.status(500).json({ success: false, message: 'Internal server error processing callback.' });
    }
});


// --- Generic Error Handling Middleware ---
// This catches any errors that weren't caught by individual route handlers.
// It ensures a consistent JSON error response for unhandled errors.
app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err.stack); // Log the full stack trace for debugging
    res.status(500).json({
        success: false,
        message: 'An unexpected internal server error occurred.',
        error: process.env.NODE_ENV === 'production' ? {} : { message: err.message, stack: err.stack }
    });
});


// --- Start the Server ---
// The server starts listening on the determined PORT.
app.listen(PORT, () => {
    // Log the port the server is actually listening on.
    // On Render, this will be the port assigned by the platform, not necessarily 3000 or localhost.
    console.log(`Sarami Ticketing Backend server is running on port ${PORT}`);
});
