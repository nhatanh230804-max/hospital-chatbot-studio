// =============================================================================
// src/config.js — Environment configuration, demo date helpers
// =============================================================================
import dotenv from "dotenv";

dotenv.config();

export const PORT = Number(process.env.PORT || 8080);

export const USE_REAL_DATE =
  String(process.env.USE_REAL_DATE || "false") === "true";

export function getDemoToday() {
  if (USE_REAL_DATE) return new Date().toISOString().slice(0, 10);
  return process.env.DEMO_TODAY || "2026-05-07";
}

export function getDemoTomorrow() {
  const today = new Date(getDemoToday());
  today.setDate(today.getDate() + 1);
  return today.toISOString().slice(0, 10);
}

export function getDemoYesterday() {
  const today = new Date(getDemoToday());
  today.setDate(today.getDate() - 1);
  return today.toISOString().slice(0, 10);
}

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

export const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "http://localhost:8080"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// -----------------------------------------------------------------------------
// Chat session store (bộ nhớ hội thoại ngắn hạn)
// -----------------------------------------------------------------------------
// REDIS_URL: nếu set → session store dùng Redis; nếu rỗng → dùng in-memory.
//   vd: redis://127.0.0.1:6379
// SESSION_TTL_SECONDS: phiên hết hạn sau bao nhiêu giây không tương tác
//   (mặc định 300 = 5 phút)
export const REDIS_URL = process.env.REDIS_URL || "";
export const SESSION_TTL_SECONDS = Number(
  process.env.SESSION_TTL_SECONDS || 300,
);
