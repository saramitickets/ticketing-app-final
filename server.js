// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.6
// MASTER: STRICT PAYLOAD + RESPONSE CAPTURE
// ==========================================

// ... (Firebase & Brevo setup remain the same)

app.post('/api/create-order', async (req, res) => {
    const { payerName, payerEmail, payerPhone, amount, eventId, packageTier, eventName } = req.body;
    let orderRef;
    
    try {
        orderRef = await db.collection('orders').add({
            payerName, payerEmail, payerPhone, amount: Number(amount),
            eventId, packageTier, eventName, status: 'INITIATED',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (BYPASS_PAYMENT) {
            await orderRef.update({ status: 'PAID' });
            return res.status(200).json({ success: true, orderId: orderRef.id });
        } else {
            const token = await getAuthToken();
            const stkUrl = process.env.INFINITIPAY_STKPUSH_URL;

            // STRICT PAYLOAD: Ensuring merchantCode is a NUMBER
            const payload = {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: Number(process.env.INFINITIPAY_MERCHANT_ID), // Changed to Number
                reference: orderRef.id,
                description: `Sarami: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            };

            const stkRes = await axios.post(stkUrl, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } 
            });

            // LOG THE ENTIRE RESPONSE TO SEE HIDDEN ID FIELDS
            console.log(`[BANK_RESPONSE_RAW]`, JSON.stringify(stkRes.data));

            // Try all common ID field names used by different bank gateways
            const bankId = stkRes.data.requestId || stkRes.data.conversationId || stkRes.data.transactionId || "MISSING_ID";
            
            await orderRef.update({ 
                status: bankId === "MISSING_ID" ? 'BANK_REJECTED' : 'STK_PUSH_SENT', 
                bankRequestId: bankId 
            });
            
            console.log(`[STK_SENT] Order: ${orderRef.id} | BankID: ${bankId}`);
            return res.status(200).json({ success: true, message: "Request processed", orderId: orderRef.id });
        }
    } catch (err) {
        console.error(`[BOOKING_ERROR] - ${err.message}`);
        res.status(500).json({ success: false, debug: err.message });
    }
});

// ... (Rest of the status query and PDF logic remains the same)
