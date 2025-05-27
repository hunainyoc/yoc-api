const mysql = require('mysql2/promise');
const moment = require('moment');
const nodemailer = require('nodemailer');

// Helper function to get current time in US timezone
function getCurrentTime() {
    const ukDateTime = moment();
    const usDateTime = ukDateTime.subtract(5, 'hours');
    return usDateTime.format('YYYY-MM-DD HH:mm:ss');
}

// Create payment method
async function createPaymentMethod(stripe, billingEmail, billingName, billingLname, ccNumber, ccExpirationM, ccExpirationY, ccCvv) {
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
        return `Exception: ${error.message}`;
    }
}

// Create customer
async function createCustomer(stripe, billingName, billingLname, billingEmail, pmethodId) {
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
        return `Exception: ${error.message}`;
    }
}

// Attach payment method
async function attachPaymentMethod(stripe, customerId, paymentCard) {
    try {
        await stripe.paymentMethods.attach(paymentCard, {
            customer: customerId
        });
    } catch (error) {
        return `Exception: ${error.message}`;
    }
}

// Create charge intent
async function createChargeIntent(stripe, totalCheckoutValue, chargeItems, orderNo, ccCharges, pmid, customerId, donationCurrencyName) {
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
        return `Exception: ${error.message}`;
    }
}

// Make plan
async function makePlan(stripe, donationCurrencyName, amount, interval, scheduleItems, planName, ccCharges) {
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
        return `Exception: ${error.message}`;
    }
}

// Make subscription
async function makeSubscription(stripe, planArray, type, customerId, startDate, iterations, pmethodId, scheduleItems) {
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
        return `Exception: ${error.message}\n`;
    }
}

// Check donor
async function checkDonor(stripe, currentTime, conn, pmethodId, billingName, billingLname, billingOrganization, 
    billingStreet, billingCity, billingState, billingZip, billingCountry, billingPhone, billingEmail, fourdigit, donationCurrencyName) {
    
    let giftAid = "0";
    let billingMailchimp = "0";

    if (billingMailchimp && billingMailchimp.toLowerCase() === "on") {
        billingMailchimp = "1";
    }

    let DID = '0';
    let CustomerId = '0';
    let fourdigitO = '';

    const currency = donationCurrencyName.toUpperCase();

    try {
        // Check if donor exists
        const [rows] = await conn.execute(
            'CALL Stripe_CheckDonor(?, ?)',
            [billingEmail, billingLname]
        );

        if (rows[0].length > 0) {
            const row = rows[0][0];
            DID = row.id;
            CustomerId = row.stripe_id;
            fourdigitO = row.fourdigit;

            if (stripe !== 'paypal') {
                if (CustomerId === '0' || CustomerId === '') {
                    const customer = await createCustomer(stripe, billingName, billingLname, billingEmail, pmethodId);
                    if (customer && customer.id) {
                        CustomerId = customer.id;
                    }

                    await conn.execute(
                        'UPDATE `wp_yoc_donors` SET `stripe_id` = ?, `fourdigit` = ? WHERE `id` = ?',
                        [CustomerId, fourdigit, DID]
                    );
                }

                await attachPaymentMethod(stripe, CustomerId, pmethodId);
            }
        } else {
            if (stripe !== 'paypal') {
                const customer = await createCustomer(stripe, billingName, billingLname, billingEmail, pmethodId);
                if (customer && customer.id) {
                    CustomerId = customer.id;
                }
            }

            const [result] = await conn.execute(
                'CALL Stripe_CreateDonor(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    CustomerId, fourdigit, billingEmail, billingName, billingLname,
                    billingOrganization, billingStreet, billingState, billingCity,
                    billingCountry, billingZip, billingPhone, giftAid, billingMailchimp, currentTime
                ]
            );

            DID = result[0][0].DID;
        }

        return { did: DID, customerid: CustomerId };
    } catch (error) {
        throw new Error(`Donor check failed: ${error.message}`);
    }
}

// Insert records
async function insertRecords(conn, donationCurrencyName, paymentType, did, chargeId, status, orderComments, 
    invoiceId, orderNo, ccCharges, totalCart, session, currentTime) {
    
    const currency = donationCurrencyName;
    const totalAmount = ccCharges + totalCart;

    let tstatus = "Declined";
    let reason = "Declined";
    if (status.toLowerCase() === "succeeded" || status.toLowerCase() === 'success') {
        tstatus = "Completed";
        reason = "Approved";
    }

    let giftAid = "0";
    if (giftAid && giftAid.toLowerCase() === "on") {
        giftAid = "1";
    }

    try {
        // Insert transaction
        const [result] = await conn.execute(
            'CALL Stripe_InsertTransaction(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                did, invoiceId, orderNo, chargeId, '0', ccCharges, totalAmount,
                totalCart, status, reason, orderComments, paymentType, tstatus, currentTime
            ]
        );

        const tid = result[0][0].NEW_TID;
        session.tid = tid;

        const updateTdid = [];

        if (session.arr_appealid) {
            const scart = session.arr_appealid.length;
            for (let i = 0; i < scart; i++) {
                if (session.arr_appealid[i] != null) {
                    const currentDate = session.arr_startdate[i];
                    let remainingCount = session.arr_interval[i];

                    let freq = '0';
                    let interval = "1";
                    let next = `+${parseInt(interval)} months`;

                    switch (session.arr_donationtype[i].toLowerCase()) {
                        case 'year':
                        case 'yearly':
                            interval = '12';
                            freq = '2';
                            break;
                        case 'month':
                        case 'monthly':
                            interval = '1';
                            freq = '1';
                            break;
                        case 'day':
                        case 'daily':
                            interval = '1';
                            next = `+${parseInt(interval)} day`;
                            freq = '3';
                            break;
                        case 'quarter':
                        case 'quarterly':
                            interval = '3';
                            freq = '5';
                            break;
                        case 'week':
                        case 'weekly':
                            interval = '7';
                            next = `+${parseInt(interval)} day`;
                            freq = '4';
                            break;
                    }

                    const fundlistId = session.arr_handlerid?.[i] || "0";
                    const amountId = (fundlistId === "0") ? session.arr_amount_id[i] : "0";
                    const sfId = null;

                    if (session.arr_donationtype[i].toLowerCase() !== "single") {
                        if (session.arr_startdate[i] === session.datetoday[i]) {
                            const nextDate = moment(currentDate).add(parseInt(interval), 'months').format('YYYY-MM-DD');
                            remainingCount = (parseInt(session.arr_interval[i]) - 1);

                            const [detailResult] = await conn.execute(
                                'CALL Stripe_InsertTransaction_Detail(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                [
                                    tid, session.arr_appealid[i], amountId, fundlistId, sfId,
                                    session.arr_amount[i], session.arr_appealquantity[i], freq,
                                    session.arr_startdate[i], session.arr_interval[i], currency
                                ]
                            );

                            const tdid = detailResult[0][0].TDID;

                            updateTdid.push({
                                tdid: tdid,
                                tid: tid,
                                amount: session.arr_amount[i],
                                quantity: session.arr_appealquantity[i],
                                freq: freq,
                                appealid: session.arr_appealid[i],
                                amountid: session.arr_amount_id[i],
                                fundid: fundlistId
                            });
                        }
                    } else {
                        await conn.execute(
                            'CALL Stripe_InsertTransaction_Detail(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            [
                                tid, session.arr_appealid[i], amountId, fundlistId, sfId,
                                session.arr_amount[i], session.arr_appealquantity[i], freq,
                                session.arr_startdate[i], session.arr_interval[i], currency
                            ]
                        );
                    }
                }
            }
        }

        session.scheduledata = updateTdid;
    } catch (error) {
        throw new Error(`Record insertion failed: ${error.message}`);
    }
}

// Insert card
async function insertCard(conn, did, invoiceId, orderNo, fourdigit, ccExpirationM, ccExpirationY, session) {
    const tid = session.tid || 0;

    await conn.execute(
        'CALL Stripe_Card(?, ?, ?, ?, ?, ?, ?)',
        [tid, did, invoiceId, orderNo, fourdigit, ccExpirationM, ccExpirationY]
    );
}

// Insert employee
async function insertEmploy(conn, did, billingEmpname, billingEmpemail) {
    await conn.execute(
        'CALL Stripe_employee(?, ?, ?)',
        [did, billingEmpname, billingEmpemail]
    );
}

// Run query
async function runQuery(host, user, pass, db, query) {
    let connection;
    try {
        connection = await mysql.createConnection({
            host: host,
            user: user,
            password: pass,
            database: db
        });

        const [result] = await connection.execute(query);
        return result;
    } catch (error) {
        console.error("Bhalo Snippet Error:", error.message);
        
        // Send email notification
        const transporter = nodemailer.createTransport({
            // Configure your email transport here
        });

        await transporter.sendMail({
            from: 'your-email@example.com',
            to: 'dev@youronlineconversation.com',
            subject: 'Bhalo Snippet Error',
            text: `Error message: ${error.message}`
        });

        throw new Error('Database operation failed');
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

module.exports = {
    getCurrentTime,
    createPaymentMethod,
    createCustomer,
    attachPaymentMethod,
    createChargeIntent,
    makePlan,
    makeSubscription,
    checkDonor,
    insertRecords,
    insertCard,
    insertEmploy,
    runQuery,
    dbConfig
};