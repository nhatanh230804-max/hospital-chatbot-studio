// =============================================================================
// src/middleware.js — Helmet, CORS, rate limiters
// =============================================================================
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ALLOWED_ORIGINS } from "./config.js";

export const helmetMiddleware = helmet({
  contentSecurityPolicy: false, // disable CSP để inline script ở public/*.html chạy được
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // Tắt X-Frame-Options cho phép iframe từ origin khác (cần cho embed/widget)
  frameguard: false
});

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Cho phép tools (curl, Postman) khi không có origin
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS: origin không được phép"));
  },
  credentials: true
});

// Rate limit cho public chat API
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu, vui lòng chờ một phút." }
});

export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu admin trong 1 phút." }
});
