require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: "",
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});
const db = pool.promise();

app.get("/", (req, res) => {
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

app.listen(port, () => {
  console.log(`🚀 Listening on http://localhost:${port}`);
});
