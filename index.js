require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const checkoutRouter = require("./checkout/checkout");
const helmet = require('helmet');

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Routes
app.use("/checkout", checkoutRouter);

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});
const db = pool.promise();

app.get("/api/", (req, res) => {
    res.send("API Working!");
});

app.post("/visitors/log", async (req, res) => {
    const payload = req.body;

    if (!payload || typeof payload !== "object") {
        return res
            .status(400)
            .json({ error: "Request body must be a JSON object." });
    }

    try {
        const [result] = await db.query(
            "INSERT INTO visitors_log (ip, browser, device, data) VALUES (?)",
            [
                payload.ip,
                payload.browser,
                payload.device,
                JSON.stringify(payload.data),
            ]
        );

        res.status(201).json({
            message: "Inserted successfully!",
            id: result.insertId,
        });
    } catch (err) {
        console.error("DB error:", err);
        res.status(500).json({ error: "Database insert failed." });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
    console.log(`🚀 Listening on http://localhost:${port}`);
});
