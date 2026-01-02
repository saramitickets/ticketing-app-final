// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V3.7
// MODE: BYPASS ENABLED (For Ticket Testing)
// ==========================================

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();

const admin = require('firebase-admin');

// SET TO 'true' TO SKIP ASTRA AND SEND TICKETS IMMEDIATELY
const BYPASS_PAYMENT = true; 

// --- FIREBASE INITIALIZATION ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    process.exit(1);
}

const db = admin.firestore();

// --- BREVO SETUP ---
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

function getEventDetails(eventId) {
    const eventMap = {
        'VAL26-NAIVASHA': { date: "Feb 14, 2026", venue: "Elsamere Resort, Naivasha", color: "#004d40" },
        'VAL26-NAIROBI': { date: "Feb 14, 2026", venue: "Premium Garden, Nairobi", color: "#1e3a8a" },
        'VAL26-ELDORET': { date: "Feb 14, 2026", venue: "Sirikwa Hotel, Eldoret", color: "#800020" }
    };
    return eventMap[eventId] || { date: "Feb 14, 2026", venue: "Sarami Venue", color: "#000000" };
}

// Helper to trigger email (used in bypass and callback)
async function sendSuccessEmail(orderData, orderId) {
    const meta = getEventDetails(orderData.eventId);
    const emailHtml = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
            <div style="background: ${meta.color}; color: white; padding: 20px; text-align: center;">
                <h1 style="color: #D4AF37;">Ticket Confirmed!</h1>
            </div>
            <div style="padding: 20px;">
                <p>Hi ${orderData.payerName}, your ticket for <b>${orderData.eventName}</b> is ready.</p>
                <p><b>Venue:</b> ${meta.venue}</p>
                <p><b>Download Link:</b> https://ticketing-app-final.onrender.com/api/get-ticket-pdf/${orderId}</p>
            </div>
        </div>`;

    return apiInstance.sendTransacEmail({
        sender: { email: "etickets@saramievents.co.ke", name: "Sarami Events" },
        to: [{ email: orderData.payerEmail, name: orderData.payerName }],
        subject: `🎟️ Your Ticket: ${orderData.eventName}`,
        htmlContent: emailHtml
    });
}

// --- MAIN ORDER ENDPOINT ---
app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, eventName, quantity } = req.body;
    const qty = parseInt(quantity) || 1;
    let orderRef;

    try {
        // 1. Save to Firestore
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            quantity: qty, eventId, eventName, status: 'PENDING',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (BYPASS_PAYMENT) {
            console.log("BYPASS MODE: Skipping Astra, marking as PAID.");
            await orderRef.update({ status: 'PAID' });
            
            // Send Email immediately in Bypass mode
            await sendSuccessEmail(req.body, orderRef.id);
            
            return res.status(200).json({ success: true, orderId: orderRef.id });
        }

        // ... Regular Astra Logic would go here ...
        res.status(400).json({ success: false, debug: "Astra Auth currently failing" });

    } catch (err) {
        res.status(500).json({ success: false, debug: err.message });
    }
});

// --- PDF TICKET GENERATOR ---
app.get('/api/get-ticket-pdf/:orderId', async (req, res) => {
    try {
        const orderDoc = await db.collection('orders').doc(req.params.orderId).get();
        if (!orderDoc.exists) return res.status(404).send('Ticket not found');
        
        const data = orderDoc.data();
        const meta = getEventDetails(data.eventId);

        const browser = await puppeteer.launch({ 
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        });

        const page = await browser.newPage();
        const ticketHtml = `
            <div style="border: 10px solid ${meta.color}; padding: 50px; text-align: center; font-family: sans-serif;">
                <h1 style="color: ${meta.color}">SARAMI EVENTS</h1>
                <h2>OFFICIAL TICKET</h2>
                <p>Guest: ${data.payerName}</p>
                <p>Venue: ${meta.venue}</p>
                <img src="https://barcode.tec-it.com/barcode.ashx?data=${orderDoc.id}&code=QRCode" width="150">
            </div>`;

        await page.setContent(ticketHtml);
        const pdf = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        res.set({ 'Content-Type': 'application/pdf' }).send(pdf);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.listen(PORT, () => console.log(`Bypass Mode Live on ${PORT}`));
