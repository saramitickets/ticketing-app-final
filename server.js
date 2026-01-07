// ==========================================
// SARAMI EVENTS TICKETING BACKEND - V10.13
// MASTER: PTYID FIXED TO 1 (PETER'S UPDATE)
// ==========================================

// ... (Firebase, Brevo, and Helpers remain the same)

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

            // V10.13 FIX: Applying Peter's instruction for ptyId
            const payload = {
                amount: Number(amount),
                phoneNumber: formatPhone(payerPhone),
                merchantCode: process.env.INFINITIPAY_MERCHANT_ID, // Still "139"
                ptyId: 1,  // CHANGED TO 1 AS PER PETER'S INSTRUCTION
                reference: orderRef.id,
                description: `Sarami Ticket: ${eventName}`,
                callbackUrl: "https://ticketing-app-final.onrender.com/api/payment-callback"
            };

            const stkRes = await axios.post(stkUrl, payload, { 
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } 
            });

            console.log(`[BANK_RAW]`, JSON.stringify(stkRes.data));

            const bankId = stkRes.data.requestId || stkRes.data.conversationId || "MISSING";
            
            await orderRef.update({ 
                status: bankId === "MISSING" ? 'BANK_REJECTED' : 'STK_PUSH_SENT', 
                bankRequestId: bankId 
            });
            
            console.log(`[STK_SENT] Order: ${orderRef.id} | BankID: ${bankId}`);
            return res.status(200).json({ success: true, message: "M-Pesa prompt sent!", orderId: orderRef.id });
        }
    } catch (err) {
        // ... (Error handling remains the same)
    }
});

// ... (Rest of the status query and PDF logic remains the same)
