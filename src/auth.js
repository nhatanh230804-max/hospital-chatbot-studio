// =============================================================================
// src/auth.js — Auth & DB guards
// =============================================================================
import crypto from "crypto";
import { ADMIN_TOKEN } from "./config.js";
import { dbReady, pool } from "./db.js";

export function requireDb(req, res, next) {
  if (!dbReady || !pool)
    return res.status(503).json({ error: "MySQL chưa kết nối." });
  next();
}

export function timingSafeStringCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    console.warn(
      "⚠️ ADMIN_TOKEN chưa set, admin API đang mở. Set ADMIN_TOKEN trong production.",
    );
    return next();
  }
  const provided = req.headers["x-admin-token"];
  if (!provided || !timingSafeStringCompare(provided, ADMIN_TOKEN)) {
    return res.status(401).json({ error: "Sai hoặc thiếu admin token." });
  }
  next();
}
