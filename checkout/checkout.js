const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mysql = require('mysql2/promise');
const moment = require('moment');

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

// Helper function to get current time in US timezone
function getCurrentTime() {
    const ukDateTime = moment();
    const usDateTime = ukDateTime.subtract(5, 'hours');
    return usDateTime.format('YYYY-MM-DD HH:mm:ss');
}

// Create payment method
async function createPaymentMethod(billingEmail, billingName, billingLname, ccNumber, ccExpirationM, ccExpirationY, ccCvv) {
    try {
        const paymentMethod = await stripe.paymentMethods.create({
            type: 'card',
            card: {
                number: ccNumber,
                exp_month: ccExpirationM,
                exp_year: ccExpirationY,
                cvc: ccCvv,
            },
            billing_details: {
                email: billingEmail,
                name: `${billingName} ${billingLname}`,
            },
        });
        return paymentMethod.id;
    } catch (error) {
        throw new Error(`Payment method creation failed: ${error.message}`);
    }
}

// Create customer
async function createCustomer(billingName, billingLname, billingEmail, pmethodId) {
    try {
        const customer = await stripe.customers.create({
            description: `Customer = ${billingName} ${billingLname}`,
            name: `${billingName} ${billingLname}`,
            email: billingEmail,
            payment_method: pmethodId,
            invoice_settings: {
                default_payment_method: pmethodId
            }
        });
        return customer;
    } catch (error) {
        throw new Error(`Customer creation failed: ${error.message}`);
    }
}

// Attach payment method
async function attachPaymentMethod(customerId, paymentCard) {
    try {
        await stripe.paymentMethods.attach(paymentCard, {
            customer: customerId
        });
    } catch (error) {
        throw new Error(`Payment method attachment failed: ${error.message}`);
    }
}

// Create charge intent
async function createChargeIntent(totalCheckoutValue, chargeItems, orderNo, ccCharges, pmid, customerId, donationCurrencyName) {
    try {
        const description = `${(parseFloat(totalCheckoutValue)/100)} Charge for OrderNo = ${orderNo}`;
        const tccCharges = (ccCharges * 100);
        const totalCharge = (parseFloat(tccCharges) + parseFloat(totalCheckoutValue));

        const charge = await stripe.paymentIntents.create({
            setup_future_usage: 'off_session',
            confirm: true,
            amount: totalCharge,
            currency: donationCurrencyName,
            payment_method: pmid,
            customer: customerId,
            description: description,
            metadata: chargeItems,
            return_url: 'https://bhalo.youronlineconversation.com/thank-you/'
        });

        return charge;
    } catch (error) {
        throw new Error(`Charge creation failed: ${error.message}`);
    }
}

// Make plan
async function makePlan(amount, interval, scheduleItems, planName, ccCharges, donationCurrencyName) {
    try {
        let cardFee = 0;
        if (parseFloat(ccCharges) > 0) {
            cardFee = amount * 0.03;
        }
        cardFee = Math.round(cardFee * 100) / 100;
        const subAmount = (amount + cardFee) * 100;

        const plan = await stripe.plans.create({
            amount: subAmount,
            currency: donationCurrencyName,
            interval: interval,
            metadata: scheduleItems,
            product: {
                name: planName
            }
        });

        return plan.id;
    } catch (error) {
        throw new Error(`Plan creation failed: ${error.message}`);
    }
}

// Make subscription
async function makeSubscription(planArray, type, customerId, startDate, iterations, pmethodId, scheduleItems) {
    try {
        const myPlans = planArray
            .filter(plan => type === plan.type)
            .map(plan => ({
                price: plan.planid,
                quantity: plan.appealQuantity
            }));

        const subs = await stripe.subscriptionSchedules.create({
            customer: customerId,
            start_date: startDate,
            end_behavior: 'release',
            metadata: scheduleItems,
            phases: [{
                items: [myPlans],
                proration_behavior: 'none',
                iterations: iterations,
                default_payment_method: pmethodId
            }]
        });

        return subs.id;
    } catch (error) {
        throw new Error(`Subscription creation failed: ${error.message}`);
    }
}

// Check donor
async function checkDonor(conn, billingEmail, billingLname, billingName, billingOrganization, billingStreet, 
    billingCity, billingState, billingZip, billingCountry, billingPhone, fourdigit, pmethodId, donationCurrencyName) {
    
    try {
        const [rows] = await conn.execute(
            'CALL Stripe_CheckDonor(?, ?)',
            [billingEmail, billingLname]
        );

        let DID = '0';
        let CustomerId = '0';
        let fourdigitO = '';

        if (rows[0].length > 0) {
            const row = rows[0][0];
            DID = row.id;
            CustomerId = row.stripe_id;
            fourdigitO = row.fourdigit;

            if (CustomerId === '0' || CustomerId === '') {
                const customer = await createCustomer(billingName, billingLname, billingEmail, pmethodId);
                if (customer && customer.id) {
                    CustomerId = customer.id;
                }

                await conn.execute(
                    'UPDATE `wp_yoc_donors` SET `stripe_id` = ?, `fourdigit` = ? WHERE `id` = ?',
                    [CustomerId, fourdigit, DID]
                );
            }

            await attachPaymentMethod(CustomerId, pmethodId);
        } else {
            const customer = await createCustomer(billingName, billingLname, billingEmail, pmethodId);
            if (customer && customer.id) {
                CustomerId = customer.id;
            }

            const [result] = await conn.execute(
                'CALL Stripe_CreateDonor(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    CustomerId, fourdigit, billingEmail, billingName, billingLname,
                    billingOrganization, billingStreet, billingState, billingCity,
                    billingCountry, billingZip, billingPhone, '0', '0', getCurrentTime()
                ]
            );

            DID = result[0][0].DID;
        }

        return { did: DID, customerid: CustomerId };
    } catch (error) {
        throw new Error(`Donor check failed: ${error.message}`);
    }
}

// Main API endpoint
router.post('/process-payment', async (req, res) => {
    try {
        const {
            paymentType,
            cartItems,
            billingInfo,
            paymentInfo,
            clientId,
            sessionId
        } = req.body;

        if (!cartItems || cartItems.length === 0) {
            return res.status(400).json({
                error: "Exception: we are sorry your donation cart has been expired"
            });
        }

        // Process cart items
        const chargeItems = {};
        const scheduleItems = {};
        let totalCart = 0;
        let scheduleCart = 0;
        let planName = '';
        let isRecurring = false;

        cartItems.forEach((item, index) => {
            const m = index + 1;
            const itemKey = `item${m}`;
            chargeItems[`${itemKey}_id`] = item.appealId;
            chargeItems[`${itemKey}_name`] = item.appealName;
            chargeItems[`${itemKey}_amount`] = item.amount;
            chargeItems[`${itemKey}_quantity`] = item.quantity;

            totalCart += (item.amount * item.quantity);

            if (item.donationType.toLowerCase() !== 'single') {
                isRecurring = true;
                scheduleCart += (item.amount * item.quantity);
                scheduleItems[`${itemKey}_id`] = item.appealId;
                scheduleItems[`${itemKey}_name`] = item.appealName;
                scheduleItems[`${itemKey}_amount`] = item.amount;
                scheduleItems[`${itemKey}_quantity`] = item.quantity;
                planName += `${item.appealName} ${item.amount}, `;
            }
        });

        if (paymentType === 'credit_card') {
            const {
                billingName,
                billingLname,
                billingStreet,
                billingCity,
                billingState,
                billingZip,
                billingCountry,
                billingPhone,
                billingEmail,
                ccNumber,
                ccExpirationM,
                ccExpirationY,
                ccCvv,
                billingOrganization,
                orderComments
            } = billingInfo;

            const fourdigit = ccNumber.slice(-4);
            const invoiceId = `bhalo-${Date.now()}`;
            const orderNo = `${moment().format('MMDDYYYYHHmmss')}${Math.floor(Math.random() * 11)}`;

            // Calculate credit card charges
            const ccCharges = totalCart * 0.03;
            const totalCartStripe = totalCart * 100;
            const scheduleCartStripe = scheduleCart * 100;

            // Create payment method
            const pmethodId = await createPaymentMethod(
                billingEmail,
                billingName,
                billingLname,
                ccNumber,
                ccExpirationM,
                ccExpirationY,
                ccCvv
            );

            // Check/Create donor
            const conn = await mysql.createConnection(dbConfig);
            const donor = await checkDonor(
                conn,
                billingEmail,
                billingLname,
                billingName,
                billingOrganization,
                billingStreet,
                billingCity,
                billingState,
                billingZip,
                billingCountry,
                billingPhone,
                fourdigit,
                pmethodId,
                'USD'
            );

            // Create charge
            const charge = await createChargeIntent(
                totalCartStripe,
                chargeItems,
                orderNo,
                ccCharges,
                pmethodId,
                donor.customerid,
                'USD'
            );

            if (charge.status === 'succeeded' || charge.status === 'requires_action' || charge.status === 'requires_source_action') {
                // Handle recurring payments if needed
                if (isRecurring) {
                    // Implementation for recurring payments
                    // This would need to be implemented based on your specific requirements
                }

                if (charge.status === 'requires_action' || charge.status === 'requires_source_action') {
                    return res.json({
                        redirectUrl: charge.next_action.redirect_to_url.url
                    });
                }

                return res.json({
                    status: 'success',
                    message: 'Payment processed successfully',
                    data: {
                        chargeId: charge.id,
                        orderNo: orderNo,
                        invoiceId: invoiceId
                    }
                });
            } else {
                return res.status(400).json({
                    error: "Exception: Unable to make transaction"
                });
            }
        }
    } catch (error) {
        console.error('Payment processing error:', error);
        return res.status(500).json({
            error: `Exception: ${error.message}`
        });
    }
});

module.exports = router; 