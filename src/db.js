// =============================================================================
// src/db.js — Main MySQL pool initialization and shared db state
// =============================================================================
// `pool` and `dbReady` are exported as live bindings: importers receive
// updated values after initDb() completes (ES module semantics).
// =============================================================================
import mysql from "mysql2/promise";

export let pool;
export let dbReady = false;

export async function initDb() {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "hospital_user",
      password: process.env.DB_PASSWORD || "hospital_pass",
      database: process.env.DB_NAME || "hospital_demo",
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // Giới hạn timeout cho mỗi connect attempt
      connectTimeout: 10000
    });

    await pool.query("SET NAMES utf8mb4");
    // Set MAX_EXECUTION_TIME cho mọi SELECT (ms) — chặn long-running query
    await pool.query("SET SESSION MAX_EXECUTION_TIME = 5000");
    await pool.query("SELECT 1");
    dbReady = true;
    console.log("✅ MySQL connected");
  } catch (error) {
    dbReady = false;
    console.warn("⚠️ MySQL not connected. Some APIs will be unavailable.");
    console.warn(error.message);
  }
}

// Getter helpers (useful for places that need a single value reference)
export function getPool() {
  return pool;
}

export function isDbReady() {
  return dbReady;
}
