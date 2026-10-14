import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;
const app = express();

app.use(cors({
  origin: [
    "https://jamborz95-alt.github.io",
    "http://localhost:5173"
  ]
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get("/", (req, res) => {
  res.json({
    app: "ALLCOINS",
    status: "running",
    message: "Allcoins server is ready"
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      app: "ALLCOINS",
      database: "connected",
      version: "1.0.0"
    });
  } catch (error) {
    console.error("Database check failed:", error.message);

    res.status(500).json({
      ok: false,
      app: "ALLCOINS",
      database: "disconnected"
    });
  }
});

app.post("/api/setup", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        balance BIGINT NOT NULL DEFAULT 10000,
        energy INTEGER NOT NULL DEFAULT 100,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    res.json({
      ok: true,
      message: "Players table is ready"
    });
  } catch (error) {
    console.error("Database setup failed:", error.message);

    res.status(500).json({
      ok: false,
      message: "Database setup failed"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Allcoins server started on port ${PORT}`);
});
