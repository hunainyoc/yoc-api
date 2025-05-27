const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mysql = require('mysql2/promise');
const {
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
} = require('../utils/stripe_funcs');

// Database connection middleware
const dbMiddleware = async (req, res, next) => {
    try {
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password,
            database: dbConfig.database
        });
        req.db = connection;
        next();
    } catch (error) {
        console.error('Database connection error:', error);
        res.status(500).json({ error: 'Database connection failed' });
    }
};

// Cleanup middleware
const cleanupMiddleware = async (req, res, next) => {
    res.on('finish', async () => {
        if (req.db) {
            try {
                await req.db.end();
            } catch (error) {
                console.error('Error closing database connection:', error);
            }
        }
    });
    next();
};

router.use(dbMiddleware);
router.use(cleanupMiddleware);

router.post('/process-payment', async (req, res) => {
    if (req.body.payment_type === "credit_card") {
        try {
            // Sanitize and prepare billing information
            const billing_firstname = req.body.billing_name?.trim() || '';
            const billing_name = billing_firstname.replace(/[^A-Za-z]/g, "");
            const billing_lastname = req.body.billing_lname?.trim() || '';
            const billing_lname = billing_lastname.replace(/[^A-Za-z]/g, "");
            
            const billing_street = req.body.billing_street?.trim() || '';
            const billing_city = req.body.billing_city?.trim() || '';
            let billing_state = "";
            if (req.body.billing_country === "US") {
                billing_state = req.body.billing_state2?.trim() || '';
            } else {
                billing_state = req.body.billing_state1?.trim() || '';
            }
            const billing_zip = encodeURIComponent((req.body.billing_zip?.trim() || '').toUpperCase());
            const billing_country = req.body.billing_country?.trim() || '';
            
            const billing_phone = (req.body.billing_phone?.trim() || '').replace(/[^0-9]/g, "");
            const billing_email = req.body.billing_email?.trim() || '';
            
            const cc_number = req.body.cc_number?.trim() || '';
            const cc_expiration_m = req.body.cc_expiration_m?.trim() || '';
            const cc_expiration_y = req.body.cc_expiration_y?.trim() || '';
            const cc_cvv = req.body.cc_cvv?.trim() || '';
            const fourdigit = cc_number.slice(-4);
            const billing_organization = req.body.billing_organization?.trim() || '';
            
            let client_id = req.body.cookie_clientId || '';
            let session_id = req.body.cookie_sessionId || '';
            
            if (!client_id) {
                client_id = req.body.test_clientId || '';
            }
            if (!session_id) {
                session_id = req.body.test_session_id || '';
            }
            
            let billing_empname = '';
            let billing_empemail = '';
            
            if (req.body.billing_empname) {
                billing_empname = req.body.billing_empname.trim();
            }
            if (req.body.billing_empemail) {
                billing_empemail = req.body.billing_empemail.trim();
            }
            
            const order_comments = req.body.order_comments?.trim() || '';
            const invoiceid = `bhalo-${Date.now()}`;
            const order_no = `${new Date().getTime()}${Math.floor(Math.random() * 11)}`;

            let cc_charges = 0;
            if (req.session?.cccharges) {
                cc_charges = req.body.totalcart * 0.03;
            }
            cc_charges = Math.round(cc_charges * 100) / 100;
            const totalcart_stripe = (req.body.totalcart * 100);
            const schedulecart = (req.body.schedulecart * 100);

            // Create session object to store data
            const session = {
                invoiceid: invoiceid,
                payment_type: 'Credit Card',
                order_number: order_no,
                name: `${billing_name} ${billing_lname}`,
                email: billing_email,
                phone: billing_phone,
                address: `${billing_street}, ${billing_city}, ${billing_state}`,
                fourdigit: fourdigit,
                street: billing_street,
                order_comments: order_comments,
                fn: billing_name,
                ln: billing_lname,
                ct: billing_city,
                st: billing_state,
                zp: billing_zip,
                country: billing_country,
                arr_appealid: req.body.arr_appealid,
                arr_appealname: req.body.arr_appealname,
                arr_amount: req.body.arr_amount,
                arr_appealquantity: req.body.arr_appealquantity,
                arr_interval: req.body.arr_interval,
                arr_startdate: req.body.arr_startdate,
                arr_donationtype: req.body.arr_donationtype,
                arr_amount_id: req.body.arr_amount_id,
                arr_handlerid: req.body.arr_handlerid,
                datetoday: req.body.datetoday,
                scheduledata: req.body.scheduledata,
                tid: null
            };

            // Create payment method
            const pmethodid = await createPaymentMethod(
                stripe,
                billing_email,
                billing_name,
                billing_lname,
                cc_number,
                cc_expiration_m,
                cc_expiration_y,
                cc_cvv
            );

            // Check donor
            const currenttime = getCurrentTime();
            const donor = await checkDonor(
                stripe,
                currenttime,
                req.db,
                pmethodid,
                billing_name,
                billing_lname,
                billing_organization,
                billing_street,
                billing_city,
                billing_state,
                billing_zip,
                billing_country,
                billing_phone,
                billing_email,
                fourdigit,
                req.body.donation_currency_name
            );

            const customer_id = donor.customerid;
            const did = donor.did;
            session.donor_id = did;

            // Create charge intent
            const charge = await createChargeIntent(
                stripe,
                totalcart_stripe,
                req.body.chargeitems,
                order_no,
                cc_charges,
                pmethodid,
                customer_id,
                req.body.donation_currency_name
            );

            let chargeId = 'undefined';
            let chargeStatus = 'declined';
            if (charge && charge.id) {
                chargeId = charge.id;
                chargeStatus = charge.status;
            }

            // Insert records
            await insertRecords(
                req.db,
                req.body.donation_currency_name,
                'cc',
                did,
                chargeId,
                chargeStatus,
                order_comments,
                invoiceid,
                order_no,
                cc_charges,
                req.body.totalcart,
                session,
                currenttime
            );

            // Save card and employee info
            if (billing_empname && billing_empemail) {
                await insertEmploy(req.db, did, billing_empname, billing_empemail);
            }
            await insertCard(req.db, did, invoiceid, order_no, fourdigit, cc_expiration_m, cc_expiration_y, session);

            session.status = charge?.status?.toLowerCase();

            if (charge?.status?.toLowerCase() === "succeeded" || 
                charge?.status?.toLowerCase() === "requires_action" || 
                charge?.status?.toLowerCase() === 'requires_source_action') {

                // Handle recurring payments
                if (req.body.isrecurring) {
                    const allPlans = [];
                    const token_id = '';
                    let m = 1;

                    if (session.arr_appealid) {
                        const Ncarttotal = session.arr_appealid.length;

                        for (let i = 0; i < Ncarttotal; i++) {
                            if (session.arr_appealid[i]) {
                                const appealid = session.arr_appealid[i];
                                const appealName = session.arr_appealname[i];
                                const appealAmount = session.arr_amount[i];
                                const appealQuantity = session.arr_appealquantity[i];
                                let appealiterations = session.arr_interval[i];
                                const appealstartdate = session.arr_startdate[i];
                                const planName = `${appealName} ${appealAmount}`;
                                let planid = 'undefined';
                                let subid = 'undefined';

                                // Handle different donation types
                                if (['month', 'monthly'].includes(session.arr_donationtype[i]?.toLowerCase())) {
                                    appealiterations = "60";
                                    const remainingCount = (parseInt(appealiterations) - 1);
                                    const monthlyItems = {
                                        [`item${m}_id`]: appealid,
                                        [`item${m}_name`]: appealName,
                                        [`item${m}_amount`]: appealAmount,
                                        [`item${m}_quantity`]: appealQuantity
                                    };

                                    planid = await makePlan(
                                        stripe,
                                        req.body.donation_currency_name,
                                        appealAmount,
                                        'month',
                                        monthlyItems,
                                        planName,
                                        cc_charges
                                    );

                                    const interval = "1";
                                    const next = `+${parseInt(interval)} months`;
                                    const nextdate = new Date(new Date(appealstartdate).getTime() + parseInt(interval) * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                                    let td_id = 0;

                                    if (session.scheduledata) {
                                        const updatetdid = session.scheduledata;
                                        for (const value of updatetdid) {
                                            if (session.arr_amount[i] === value.amount &&
                                                session.arr_appealquantity[i] === value.quantity &&
                                                value.freq === "1" &&
                                                session.arr_amount_id[i] === value.amountid &&
                                                session.arr_appealid[i] === value.appealid) {
                                                td_id = value.tdid;
                                                break;
                                            }
                                        }
                                    }

                                    const planquery = `CALL Stripe_Schedule('${did}','${session.tid}','${td_id}', '${invoiceid}' ,'${order_no}', '${token_id}', '${planid}','changesubscriptionid','${session.arr_amount[i]}', '${session.arr_appealquantity[i]}', '${cc_charges}', '${session.arr_donationtype[i]}','${appealstartdate}','${interval}','${appealiterations}','${remainingCount}','${nextdate}')`;

                                    allPlans.push({
                                        type: 'monthly',
                                        planid: planid.trim(),
                                        monthlyquery: planquery,
                                        appealQuantity: appealQuantity
                                    });
                                }

                                // Similar blocks for daily, yearly, weekly, and quarterly donations
                                // ... (implement similar logic for other donation types)

                                m++;
                            }
                        }
                    }

                    // Process all plans
                    let queryschedule = '';
                    let dailycheck = true;
                    let monthlycheck = true;
                    let yearlycheck = true;
                    let weeklycheck = true;
                    let quarterlycheck = true;
                    let subId_daily = '';
                    let subId_monthly = '';
                    let subId_yearly = '';
                    let subId_weekly = '';
                    let subId_quarterly = '';

                    for (const plan of allPlans) {
                        if (plan.type === "daily" && dailycheck) {
                            const appealiterations = "1825";
                            subId_daily = await makeSubscription(
                                stripe,
                                allPlans,
                                "daily",
                                customer_id,
                                Math.floor(Date.now() / 1000) + 86400,
                                appealiterations,
                                pmethodid,
                                req.body.scheduleitems
                            );
                            dailycheck = false;
                        }
                        // Similar blocks for other subscription types
                        // ... (implement similar logic for other subscription types)

                        if (plan.type === "daily") {
                            queryschedule += plan.dailyquery.replace("changesubscriptionid", subId_daily);
                        }
                        // Similar blocks for other query types
                        // ... (implement similar logic for other query types)
                    }

                    const result = await runQuery(
                        dbConfig.host,
                        dbConfig.user,
                        dbConfig.password,
                        dbConfig.database,
                        queryschedule
                    );

                    if (!result) {
                        return res.status(500).json({ error: "There is some error" });
                    }
                }

                if (charge?.status?.toLowerCase() === "requires_action" || 
                    charge?.status?.toLowerCase() === 'requires_source_action') {
                    return res.json({ redirect_url: charge.next_action.redirect_to_url.url });
                }

                return res.json({ status: 'success', data: { charge, session } });
            } else {
                return res.status(400).json({ error: "Unable to make transaction" });
            }
        } catch (error) {
            console.error('Payment processing error:', error);
            return res.status(500).json({ error: error.message });
        }
    } else {
        return res.status(400).json({ error: "Invalid payment type" });
    }
});

// Add error handling middleware at the end
router.use((err, req, res, next) => {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;