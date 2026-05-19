// =============================================================================
// Hospital Chatbot Studio v2 - server.js
// =============================================================================
// Khác bản v1:
//  - Class "Dạy SQL" có CRUD SQL templates (sql_templates table)
//  - Class mới "Nguồn tra cứu" (trusted_sources) - whitelist URL cho mọi câu
//    hỏi không phải SQL/FAQ/file
//  - FAQ chuyển sang upload file (.txt/.md/.docx/.pdf), parse text rồi lưu
//  - Bug fixes P0/P1: dynamic table whitelist, prepared statement, escape XSS,
//    rate limit, helmet, structured errors, graceful shutdown, statement timeout
// =============================================================================

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import multer from "multer";
import mammoth from "mammoth";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { getAdapter, listAdapters, minioAdapter } from "./lib/adapters.js";
import { getPoolForConnection, invalidatePool, closeAllPools, runQuery } from "./lib/connection-manager.js";
import {
  extractKeywordsHeuristic,
  extractKeywordsWithAI,
  keywordsToString,
  generateSchemaFromDescribe
} from "./lib/keyword-extractor.js";
// pdf-parse là CJS, dùng createRequire để tránh side-effect khi import
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 8080);

// -----------------------------------------------------------------------------
// Config & constants
// -----------------------------------------------------------------------------
const USE_REAL_DATE = String(process.env.USE_REAL_DATE || "false") === "true";

function getDemoToday() {
  if (USE_REAL_DATE) return new Date().toISOString().slice(0, 10);
  return process.env.DEMO_TODAY || "2026-05-07";
}

function getDemoTomorrow() {
  const today = new Date(getDemoToday());
  today.setDate(today.getDate() + 1);
  return today.toISOString().slice(0, 10);
}

function getDemoYesterday() {
  const today = new Date(getDemoToday());
  today.setDate(today.getDate() - 1);
  return today.toISOString().slice(0, 10);
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:8080")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false, // disable CSP để inline script ở public/*.html chạy được
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // Tắt X-Frame-Options cho phép iframe từ origin khác (cần cho embed/widget)
    frameguard: false
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Cho phép tools (curl, Postman) khi không có origin
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS: origin không được phép"));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Rate limit cho public chat API
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu, vui lòng chờ một phút." }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Quá nhiều yêu cầu admin trong 1 phút." }
});

// -----------------------------------------------------------------------------
// Multer (upload FAQ files)
// -----------------------------------------------------------------------------
const FAQ_UPLOAD_DIR = path.join(__dirname, "uploads", "faq");
if (!fs.existsSync(FAQ_UPLOAD_DIR)) fs.mkdirSync(FAQ_UPLOAD_DIR, { recursive: true });

const faqStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FAQ_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeBase = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80);
    const ext = path.extname(file.originalname).toLowerCase();
    const id = crypto.randomBytes(6).toString("hex");
    cb(null, `${Date.now()}_${id}_${safeBase}${ext}`);
  }
});

const ALLOWED_FAQ_EXT = new Set([".txt", ".md", ".docx", ".pdf"]);

const faqUpload = multer({
  storage: faqStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_FAQ_EXT.has(ext)) {
      return cb(new Error(`Chỉ hỗ trợ file ${[...ALLOWED_FAQ_EXT].join(", ")}`));
    }
    cb(null, true);
  }
});

// -----------------------------------------------------------------------------
// MySQL pool
// -----------------------------------------------------------------------------
let pool;
let dbReady = false;

async function initDb() {
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

// -----------------------------------------------------------------------------
// Common helpers
// -----------------------------------------------------------------------------
function normalizeVietnamese(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isSafeUrlForLink(url) {
  // Chỉ cho phép http/https hoặc đường dẫn nội bộ /...
  if (!url) return false;
  const trimmed = String(url).trim();
  if (trimmed.startsWith("/")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// SQL conversation memory (in-memory, có sweep định kỳ để không leak)
// -----------------------------------------------------------------------------
const sqlConversationMemory = new Map();
const SQL_CONTEXT_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sqlConversationMemory.entries()) {
    if (now - value.savedAt > SQL_CONTEXT_TTL_MS) sqlConversationMemory.delete(key);
  }
}, 60 * 1000).unref();

function getSqlSessionId(req) {
  // Ưu tiên sessionId từ body. Nếu không có thì kết hợp IP + UA để
  // tránh trường hợp nhiều user chung NAT lẫn context.
  if (req.body && req.body.sessionId) return String(req.body.sessionId);
  const ua = req.get("user-agent") || "no-ua";
  return crypto.createHash("sha1").update(`${req.ip}::${ua}`).digest("hex");
}

function saveSqlContext(sessionId, context) {
  sqlConversationMemory.set(sessionId, { ...context, savedAt: Date.now() });
}

function getSqlContext(sessionId) {
  const context = sqlConversationMemory.get(sessionId);
  if (!context) return null;
  if (Date.now() - context.savedAt > SQL_CONTEXT_TTL_MS) {
    sqlConversationMemory.delete(sessionId);
    return null;
  }
  return context;
}

// -----------------------------------------------------------------------------
// AnythingLLM client
// -----------------------------------------------------------------------------
function anythingLLMConfig() {
  return {
    baseUrl: (process.env.ANYTHINGLLM_BASE_URL || "").replace(/\/$/, ""),
    apiKey: process.env.ANYTHINGLLM_API_KEY || "",
    workspaceSlug: process.env.ANYTHINGLLM_WORKSPACE_SLUG || "",
    mode: process.env.ANYTHINGLLM_MODE || "chat"
  };
}

function isAnythingLLMConfigured() {
  const { baseUrl, apiKey, workspaceSlug } = anythingLLMConfig();
  return Boolean(baseUrl && apiKey && workspaceSlug && !apiKey.includes("replace_with"));
}

function getAnythingLLMText(data) {
  return (
    data?.textResponse ||
    data?.response ||
    data?.text ||
    data?.message ||
    data?.answer ||
    data?.output ||
    ""
  );
}

async function callAnythingLLM(message, options = {}) {
  const { baseUrl, apiKey, workspaceSlug, mode } = anythingLLMConfig();
  if (!isAnythingLLMConfigured()) {
    throw new Error("AnythingLLM chưa được cấu hình trong .env");
  }

  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/workspace/${workspaceSlug}/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        mode: options.mode || mode,
        sessionId: options.sessionId || `hospital-web-${Date.now()}`
      })
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`AnythingLLM phản hồi quá lâu (>${timeoutMs / 1000}s).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `AnythingLLM HTTP ${response.status}`);
  }
  const text = getAnythingLLMText(data);
  if (!text) throw new Error("AnythingLLM phản hồi rỗng.");
  return { text, raw: data };
}

async function logChat({
  userMessage,
  routeName,
  aiSql = null,
  finalSql = null,
  botReply = null,
  source = null,
  latencyMs = null,
  errorMessage = null
}) {
  if (!dbReady || !pool) return;
  try {
    await pool.execute(
      `INSERT INTO chat_logs (user_message, route_name, ai_sql, final_sql, bot_reply, source, latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userMessage, routeName, aiSql, finalSql, botReply, source, latencyMs, errorMessage]
    );
  } catch (error) {
    console.warn("Không lưu được chat log:", error.message);
  }
}

// -----------------------------------------------------------------------------
// Auth & guards
// -----------------------------------------------------------------------------
function requireDb(req, res, next) {
  if (!dbReady || !pool) return res.status(503).json({ error: "MySQL chưa kết nối." });
  next();
}

function timingSafeStringCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    console.warn("⚠️ ADMIN_TOKEN chưa set, admin API đang mở. Set ADMIN_TOKEN trong production.");
    return next();
  }
  const provided = req.headers["x-admin-token"];
  if (!provided || !timingSafeStringCompare(provided, ADMIN_TOKEN)) {
    return res.status(401).json({ error: "Sai hoặc thiếu admin token." });
  }
  next();
}

// =============================================================================
// SECTION: SQL VALIDATOR (dynamic whitelist từ schema_metadata)
// =============================================================================
// =============================================================================
// SECTION: SQL VALIDATOR (multi-DB whitelist từ schema_metadata)
// =============================================================================
// Cache lookup: với mỗi (connection_id, database) trả về Set<table_name>
//   - connection_id = null → DB chính (.env)
//   - connection_id = X, database = Y → connection X, schema Y
// =============================================================================
let allowedTableCache = {
  // Map<scopeKey, Set<tableName>>
  map: new Map([
    // Mặc định DB chính có 3 bảng seed
    [scopeKey(null, null), new Set(["departments", "hospital_procedures", "staff_schedules"])]
  ]),
  at: 0
};

function scopeKey(connectionId, database) {
  return `${connectionId || 'main'}::${database || ''}`;
}

async function getAllowedTables(connectionId = null, database = null) {
  // Cache 30s
  if (Date.now() - allowedTableCache.at >= 30000) {
    await refreshAllowedTableCache();
  }
  return allowedTableCache.map.get(scopeKey(connectionId, database)) || new Set();
}

async function refreshAllowedTableCache() {
  if (!dbReady || !pool) return;
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT table_name, connection_id, connection_database
       FROM schema_metadata WHERE is_active = TRUE`
    );
    const map = new Map();
    // Luôn giữ các bảng seed cho DB chính
    map.set(scopeKey(null, null), new Set(["departments", "hospital_procedures", "staff_schedules"]));

    for (const r of rows) {
      const key = scopeKey(r.connection_id, r.connection_database);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(r.table_name);
    }
    allowedTableCache = { map, at: Date.now() };
  } catch (error) {
    console.warn("Không tải được allowed_tables:", error.message);
  }
}

function normalizeSql(sql) {
  return String(sql || "").replace(/```sql/gi, "").replace(/```/g, "").trim();
}

async function validateAndPrepareSql(sql, connectionId = null, database = null) {
  let cleaned = normalizeSql(sql);
  if (!cleaned) return { ok: false, reason: "SQL rỗng." };

  cleaned = cleaned.replace(/;\s*$/, "").trim();
  const lower = cleaned.toLowerCase();

  // Banned patterns: chỉ chặn ở dạng word boundary, KHÔNG chặn từ trong string literal
  // → bóc string literal trước khi check
  const withoutStrings = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");

  const bannedKeywords = [
    "insert", "update", "delete", "drop", "alter", "create", "truncate",
    "grant", "revoke", "outfile", "execute", "prepare"
  ];
  for (const kw of bannedKeywords) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(withoutStrings)) {
      return { ok: false, reason: `SQL chứa keyword không cho phép: ${kw}` };
    }
  }

  // Chặn dangerous schema/function ngoài string
  const bannedRefs = [
    /\binformation_schema\b/i,
    /\bperformance_schema\b/i,
    /\bmysql\.\w/i,
    /\bsys\.\w/i,
    /\bload_file\s*\(/i,
    /\bbenchmark\s*\(/i,
    /\bsleep\s*\(/i
  ];
  if (bannedRefs.some((re) => re.test(withoutStrings))) {
    return { ok: false, reason: "SQL chứa tham chiếu hoặc function không cho phép." };
  }

  // Chặn comment để không bypass parser
  if (/--/.test(withoutStrings) || /\/\*/.test(withoutStrings) || /#/.test(withoutStrings)) {
    return { ok: false, reason: "SQL chứa comment, không cho phép." };
  }

  // Phải bắt đầu bằng SELECT
  if (!lower.startsWith("select")) return { ok: false, reason: "Chỉ cho phép SELECT query." };
  // Không cho nhiều câu
  if (cleaned.includes(";")) return { ok: false, reason: "Không cho phép nhiều câu SQL." };

  // Whitelist động: lấy từ schema_metadata
  const allowedTables = await getAllowedTables(connectionId, database);
  const tableRefs = [...cleaned.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi)].map(
    (match) => match[1].toLowerCase()
  );
  if (tableRefs.length === 0) return { ok: false, reason: "Không tìm thấy bảng FROM/JOIN hợp lệ." };

  const invalidTable = tableRefs.find((table) => !allowedTables.has(table));
  if (invalidTable) {
    const scope = connectionId ? `connection #${connectionId} (db: ${database || 'default'})` : 'DB chính';
    return { ok: false, reason: `Bảng "${invalidTable}" không nằm trong whitelist của ${scope}.` };
  }

  // Tự thêm LIMIT nếu cần (outer query level)
  // Check LIMIT ở cuối câu (không count sub-query)
  const trimmedForLimit = cleaned.replace(/\)\s*$/, "");
  const hasOuterLimit = /\)\s*limit\s+\d+\s*$/i.test(cleaned) || /^[^()]*limit\s+\d+\s*$/i.test(trimmedForLimit) || /\blimit\s+\d+\s*$/i.test(cleaned);
  const isAggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(cleaned);
  if (!hasOuterLimit && !isAggregate) {
    cleaned += " LIMIT 50";
  }

  return { ok: true, sql: cleaned };
}

// -----------------------------------------------------------------------------
// SQL summarizer (dùng cho NL2SQL route)
// -----------------------------------------------------------------------------
function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// function summarizeSqlResult(question, sql, rows) {
//   if (!rows || rows.length === 0) return "Mình chưa tìm thấy dữ liệu phù hợp với câu hỏi này.";

//   const text = normalizeVietnamese(question);
//   const row = rows[0];
//   const keys = Object.keys(row);

//   // Convention: nếu SQL output cột "reply" → in thẳng giá trị, không format
//   if (keys.includes("reply")) {
//     if (rows.length === 1) return String(row.reply);
//     return rows.map((r) => `- ${r.reply}`).join("\n");
//   }

//   // Heuristic match theo tên cột
//   const has = (k) => keys.some((key) => key.toLowerCase() === k.toLowerCase());

//   if (has("name") && has("visits")) {
//     if (rows.length > 1) {
//       return ["Số lượt khám của các khoa:", "", ...rows.map((item) => `- ${item.name}: ${item.visits} lượt`)].join("\n");
//     }
//     if (text.includes("cao nhat") || text.includes("nhieu nhat") || text.includes("dong nhat"))
//       return `${row.name} có lượt khám cao nhất với ${row.visits} lượt.`;
//     if (text.includes("thap nhat") || text.includes("it nhat"))
//       return `${row.name} có lượt khám thấp nhất với ${row.visits} lượt.`;
//     return `${row.name} có ${row.visits} lượt khám.`;
//   }

//   if (has("total")) {
//     if (text.includes("nhan su") || text.includes("nguoi") || text.includes("truc")) {
//       const today = getDemoToday();
//       if (text.includes("hom nay")) {
//         if (text.includes("sap truc")) return `Hôm nay có ${row.total} nhân sự sắp trực.`;
//         if (text.includes("du kien")) return `Hôm nay có ${row.total} nhân sự dự kiến.`;
//         return `Hôm nay (${today}) có ${row.total} nhân sự đang trực.`;
//       }
//       if (text.includes("ngay mai") || text.includes("mai")) {
//         return `Ngày mai có ${row.total} nhân sự trong lịch trực.`;
//       }
//       return `Có ${row.total} nhân sự phù hợp.`;
//     }
//     return `Tổng số là ${row.total}.`;
//   }

//   if (has("total_visits")) return `Tổng lượt khám hiện có là ${Number(row.total_visits || 0)} lượt.`;

//   if (has("staff_name")) {
//     const lines = rows.map((item) =>
//       `- ${item.staff_name}${item.role_name ? ` (${item.role_name})` : ""}` +
//       `${item.department ? ` - ${item.department}` : ""}` +
//       `${item.shift_time ? `, ca ${item.shift_time}` : ""}` +
//       `${item.status ? `, trạng thái: ${item.status}` : ""}`
//     );
//     const header = rows.length === 1 ? "Có 1 nhân sự phù hợp:" : `Có ${rows.length} nhân sự phù hợp:`;
//     return [header, "", ...lines].join("\n");
//   }

//   if (has("title") && has("steps")) return [`${row.title}:`, "", formatValue(row.steps)].join("\n");

//   // Fallback
//   return rows.map((item, index) => {
//     const values = Object.entries(item).map(([key, value]) => `${key}: ${formatValue(value)}`).join("; ");
//     return `- Dòng ${index + 1}: ${values}`;
//   }).join("\n");
// }

// Legacy heuristic summarizer - dùng làm fallback nếu AI fail
function summarizeSqlResultHeuristic(question, sql, rows) {
  if (!rows || rows.length === 0) return "Mình chưa tìm thấy dữ liệu phù hợp với câu hỏi này.";

  const text = normalizeVietnamese(question);
  const row = rows[0];
  const keys = Object.keys(row);

  const has = (k) => keys.some((key) => key.toLowerCase() === k.toLowerCase());

  if (has("reply")) {
    if (rows.length === 1) return String(row.reply);
    return rows.map((r) => `- ${r.reply}`).join("\n");
  }

  if (has("name") && has("visits")) {
    if (rows.length > 1) {
      return ["Số lượt khám của các khoa:", "", ...rows.map((item) => `- ${item.name}: ${item.visits} lượt`)].join("\n");
    }
    if (text.includes("cao nhat") || text.includes("nhieu nhat") || text.includes("dong nhat"))
      return `${row.name} có lượt khám cao nhất với ${row.visits} lượt.`;
    if (text.includes("thap nhat") || text.includes("it nhat"))
      return `${row.name} có lượt khám thấp nhất với ${row.visits} lượt.`;
    return `${row.name} có ${row.visits} lượt khám.`;
  }

  if (has("total")) {
    if (text.includes("nhan su") || text.includes("nguoi") || text.includes("truc")) {
      const today = getDemoToday();
      if (text.includes("hom nay")) {
        if (text.includes("sap truc")) return `Hôm nay có ${row.total} nhân sự sắp trực.`;
        if (text.includes("du kien")) return `Hôm nay có ${row.total} nhân sự dự kiến.`;
        return `Hôm nay (${today}) có ${row.total} nhân sự đang trực.`;
      }
      if (text.includes("ngay mai") || text.includes("mai")) {
        return `Ngày mai có ${row.total} nhân sự trong lịch trực.`;
      }
      return `Có ${row.total} nhân sự phù hợp.`;
    }
    return `Tổng số là ${row.total}.`;
  }

  if (has("total_visits")) return `Tổng lượt khám hiện có là ${Number(row.total_visits || 0)} lượt.`;

  if (has("staff_name")) {
    const lines = rows.map((item) =>
      `- ${item.staff_name}${item.role_name ? ` (${item.role_name})` : ""}` +
      `${item.department ? ` - ${item.department}` : ""}` +
      `${item.shift_time ? `, ca ${item.shift_time}` : ""}` +
      `${item.status ? `, trạng thái: ${item.status}` : ""}`
    );
    const header = rows.length === 1 ? "Có 1 nhân sự phù hợp:" : `Có ${rows.length} nhân sự phù hợp:`;
    return [header, "", ...lines].join("\n");
  }

  if (has("title") && has("steps")) return [`${row.title}:`, "", formatValue(row.steps)].join("\n");

  return rows.map((item, index) => {
    const values = Object.entries(item).map(([key, value]) => `${key}: ${formatValue(value)}`).join("; ");
    return `- Dòng ${index + 1}: ${values}`;
  }).join("\n");
}

// AI-powered summarizer: gọi AnythingLLM diễn giải kết quả SQL thành câu trả lời tự nhiên
async function summarizeSqlResult(question, sql, rows) {
  if (!rows || rows.length === 0) return "Mình chưa tìm thấy dữ liệu phù hợp với câu hỏi này.";

  // Convention: nếu admin đã viết SQL trả về cột "reply" → in thẳng, không gọi AI
  const firstRow = rows[0];
  const keysLower = Object.keys(firstRow).map((k) => k.toLowerCase());
  if (keysLower.includes("reply")) {
    if (rows.length === 1) return String(firstRow.reply);
    return rows.map((r) => `- ${r.reply}`).join("\n");
  }

  // Nếu AnythingLLM chưa cấu hình → dùng heuristic cũ
  if (!isAnythingLLMConfigured()) {
    return summarizeSqlResultHeuristic(question, sql, rows);
  }

  const limitedRows = rows.slice(0, 20);
  const rowsJson = JSON.stringify(limitedRows, (key, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  }, 2);

  const moreNote = rows.length > 20 ? `\n(Có tổng cộng ${rows.length} dòng, chỉ hiển thị 20 dòng đầu.)` : "";

  const prompt = `
Bạn là trợ lý diễn giải kết quả truy vấn database thành câu trả lời tự nhiên bằng tiếng Việt cho user của bệnh viện.

Câu hỏi user: "${question}"

Kết quả SQL trả về (JSON):
${rowsJson}${moreNote}

Yêu cầu trả lời:
- Diễn giải kết quả thành câu tiếng Việt rõ ràng, tự nhiên, ngắn gọn.
- KHÔNG nhắc tên cột (như "total_amount", "patient_name") trong câu trả lời — dùng từ tiếng Việt tự nhiên.
- Định dạng số tiền VND với dấu phẩy ngăn cách hàng nghìn (vd: 10,760,000 VND).
- Nếu có nhiều dòng (>3), liệt kê dạng gạch đầu dòng. Nếu 1-3 dòng, viết thành câu hoàn chỉnh.
- KHÔNG bịa thêm thông tin ngoài data trên.
- KHÔNG nói "Theo dữ liệu...", "Kết quả truy vấn..." — trả lời trực tiếp.
- KHÔNG dùng dấu "**" markdown, chỉ dùng plaintext + dấu xuống dòng.

Câu trả lời:
`.trim();

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `hospital-sql-summary-${Date.now()}`,
      timeoutMs: 30000
    });
    const cleaned = String(text || "").trim();
    if (!cleaned) return summarizeSqlResultHeuristic(question, sql, rows);
    return cleaned;
  } catch (err) {
    console.warn("AI summarize fail, fallback heuristic:", err.message);
    return summarizeSqlResultHeuristic(question, sql, rows);
  }
}


// =============================================================================
// SECTION: SQL TEMPLATES (Class "Dạy SQL")
// =============================================================================
// Mỗi template có:
//   - keywords: pipe-separated, dùng để match câu hỏi user
//   - sql_template: SELECT mẫu, có thể chứa placeholder {DEMO_TODAY},
//     {DEMO_TOMORROW}, {department}, ... — backend resolve trước khi chạy
// Có 2 cách dùng:
//   1. Match trực tiếp: nếu câu hỏi match keywords của 1 template → resolve placeholder
//      và chạy SQL ngay, không gọi AI
//   2. Đưa vào prompt AI làm few-shot examples
// =============================================================================

function matchSqlTemplate(question, templates) {
  const text = normalizeVietnamese(question);
  let best = null;
  let bestScore = 0;

  for (const tpl of templates) {
    const keywords = String(tpl.keywords || "")
      .split("|")
      .map((kw) => normalizeVietnamese(kw))
      .filter(Boolean);
    if (!keywords.length) continue;

    const matched = keywords.filter((kw) => text.includes(kw));
    if (matched.length === 0) continue;
    // Ưu tiên template có nhiều keyword match nhất, ưu tiên keyword dài hơn (cụ thể hơn)
    const score = matched.reduce((acc, kw) => acc + kw.length, 0);
    if (score > bestScore) {
      best = tpl;
      bestScore = score;
    }
  }
  return best;
}

function extractDepartmentName(question) {
  // Tìm "khoa X" trong câu hỏi
  const match = String(question).match(/khoa\s+([A-Za-zÀ-ỹà-ỹ]+)/i);
  if (!match) return null;
  // Capitalize: "ngoại" → "Ngoại", "noi" → "Nội" (đơn giản hoá)
  const word = match[1];
  return `Khoa ${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function resolvePlaceholders(sqlTemplate, question) {
  let sql = String(sqlTemplate || "");
  sql = sql.replaceAll("{DEMO_TODAY}", getDemoToday());
  sql = sql.replaceAll("{DEMO_TOMORROW}", getDemoTomorrow());
  sql = sql.replaceAll("{DEMO_YESTERDAY}", getDemoYesterday());

  // {department}: thử bắt tên khoa từ câu hỏi
  if (sql.includes("{department}")) {
    const dept = extractDepartmentName(question);
    if (dept) {
      // Escape single quotes phòng injection (template đã trong quotes)
      const safe = dept.replace(/'/g, "''");
      sql = sql.replaceAll("{department}", safe);
    } else {
      // Không tìm được tên khoa → bỏ wildcard cho khỏi match-all
      sql = sql.replaceAll("{department}", "__NO_MATCH__");
    }
  }

  return sql;
}

async function loadActiveSqlTemplates() {
  if (!dbReady || !pool) return [];
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, connection_id, connection_database, description,
              question_pattern, keywords, sql_template, category
       FROM sql_templates WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 100`
    );
    return rows;
  } catch (error) {
    console.warn("Không tải được sql_templates:", error.message);
    return [];
  }
}

// =============================================================================
// Helper: chạy SQL trên đúng connection
// =============================================================================
async function runSqlOnScope(sql, connectionId, database) {
  // connectionId = null → DB chính (.env)
  if (!connectionId) {
    const [rows] = await pool.query(sql);
    return rows;
  }
  // connectionId có → lấy connection từ DB, tạo pool external
  const [connRows] = await pool.execute(
    `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
    [connectionId]
  );
  if (!connRows.length) throw new Error(`Connection #${connectionId} không tồn tại hoặc đã disabled.`);
  const conn = connRows[0];
  const config = decryptConfigSecrets(conn.type, safeJsonParse(conn.config_json, {}));
  const externalPool = await getPoolForConnection({
    id: conn.id,
    database,
    type: conn.type,
    config
  });
  return await runQuery(externalPool, conn.type, sql);
}

async function tryAnswerWithTemplate(question) {
  const templates = await loadActiveSqlTemplates();
  if (!templates.length) return null;

  const match = matchSqlTemplate(question, templates);
  if (!match) return null;

  const resolvedSql = resolvePlaceholders(match.sql_template, question);
  if (resolvedSql.includes("__NO_MATCH__")) return null;

  const validation = await validateAndPrepareSql(
    resolvedSql,
    match.connection_id,
    match.connection_database
  );
  if (!validation.ok) {
    console.warn(`Template #${match.id} tạo SQL không hợp lệ:`, validation.reason);
    return null;
  }

  try {
    const rows = await runSqlOnScope(
      validation.sql,
      match.connection_id,
      match.connection_database
    );
    // Update usage stats
    pool.execute(
      `UPDATE sql_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?`,
      [match.id]
    ).catch((err) => console.warn("Update usage_count fail:", err.message));

    return {
      ok: true,
      templateId: match.id,
      templateName: match.name,
      sql: validation.sql,
      rows,
      reply: await summarizeSqlResult(question, validation.sql, rows),
      connectionId: match.connection_id,
      database: match.connection_database
    };
  } catch (error) {
    console.warn(`Template #${match.id} chạy fail:`, error.message);
    return null;
  }
}

// =============================================================================
// SECTION: NL2SQL qua AnythingLLM (dùng schema_metadata + sql_templates làm few-shot)
// =============================================================================
function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Không parse được JSON từ model.");
  }
}

async function getSchemaPromptBlock() {
  if (!dbReady || !pool) return "";
  try {
    const [rows] = await pool.execute(
      `SELECT s.table_name, s.connection_id, s.connection_database, s.domain,
              s.description, s.columns_json, s.examples_json,
              c.name AS connection_name, c.type AS connection_type
       FROM schema_metadata s
       LEFT JOIN data_connections c ON c.id = s.connection_id
       WHERE s.is_active = TRUE ORDER BY s.id ASC LIMIT 30`
    );
    if (!rows.length) return "";

    // Group theo scope (connection_id, database)
    const groups = new Map();
    for (const row of rows) {
      const scopeLabel = row.connection_id
        ? `Database "${row.connection_database || row.connection_name}" (qua connection #${row.connection_id})`
        : `Database CHÍNH (mặc định)`;
      if (!groups.has(scopeLabel)) groups.set(scopeLabel, []);
      groups.get(scopeLabel).push(row);
    }

    const blocks = [];
    for (const [scopeLabel, tables] of groups.entries()) {
      const tableBlocks = tables.map((row) => {
        const columns = safeJsonParse(row.columns_json, []);
        const examples = safeJsonParse(row.examples_json, []);
        const colText = columns.map((col) => {
          const enumText = col.enum ? ` enum: ${JSON.stringify(col.enum)}` : "";
          return `- ${col.name} ${col.type || ""}: ${col.description || ""}${enumText}`;
        }).join("\n");
        const exText = examples.map((ex) => `Q: ${ex.question}\nSQL: ${ex.sql}`).join("\n");
        return `Bảng ${row.table_name}\nDomain: ${row.domain || ""}\nMô tả: ${row.description || ""}\nCột:\n${colText}\nVí dụ:\n${exText}`;
      }).join("\n\n");
      blocks.push(`### ${scopeLabel} ###\n\n${tableBlocks}`);
    }

    return blocks.join("\n\n---\n\n");
  } catch (error) {
    console.warn("Không đọc được schema_metadata:", error.message);
    return "";
  }
}

// Lookup connection cho 1 bảng cụ thể (dùng khi AI sinh SQL xong, backend xác định pool)
async function lookupConnectionForTable(tableName) {
  if (!dbReady || !pool) return { connection_id: null, connection_database: null };
  try {
    const [rows] = await pool.execute(
      `SELECT connection_id, connection_database FROM schema_metadata
       WHERE table_name = ? AND is_active = TRUE LIMIT 1`,
      [tableName]
    );
    if (!rows.length) return { connection_id: null, connection_database: null };
    return rows[0];
  } catch {
    return { connection_id: null, connection_database: null };
  }
}

async function getSqlTemplatesPromptBlock() {
  const templates = await loadActiveSqlTemplates();
  if (!templates.length) return "";
  return templates.slice(0, 15).map((t) => `Q: ${t.question_pattern}\nSQL: ${t.sql_template}`).join("\n\n");
}

async function generateSqlFromQuestion(question, context = null) {
  const safeQuestion = String(question || "").replaceAll('"', '\\"');
  const schemaBlock = await getSchemaPromptBlock();
  const templatesBlock = await getSqlTemplatesPromptBlock();

  const shouldUseContext = context && /con lai|còn lại|the con|thế còn|cac khoa con lai|các khoa còn lại/i.test(normalizeVietnamese(question));
  const contextBlock = shouldUseContext ? `
Ngữ cảnh câu hỏi trước:
- Câu hỏi trước: ${context.question}
- SQL trước: ${context.sql}
Nếu câu hỏi hiện tại là follow-up như "còn lại", "thế còn", hãy dùng ngữ cảnh trên.
` : "";

  const prompt = `
Bạn là bộ chuyển câu hỏi tiếng Việt thành MySQL SELECT query cho hệ thống bệnh viện đa database.

CHỈ trả về JSON hợp lệ đúng format:
{"sql":"SELECT ...","reason":null}

Nếu không liên quan database bệnh viện:
{"sql":null,"reason":"Câu hỏi không liên quan database"}

Schema được phép dùng (chú ý mỗi bảng thuộc 1 database cụ thể):

${schemaBlock || "(không có schema metadata)"}

${templatesBlock ? `Các SQL mẫu admin đã dạy:\n\n${templatesBlock}\n` : ""}

Ngày demo:
- Hôm nay = '${getDemoToday()}'
- Ngày mai = '${getDemoTomorrow()}'
- Hôm qua = '${getDemoYesterday()}'

Luật bắt buộc:
- Chỉ tạo SELECT (KHÔNG INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/SET).
- Chỉ dùng các bảng trong schema metadata phía trên.
- KHÔNG được JOIN bảng giữa 2 database khác nhau — câu hỏi chỉ liên quan tới đúng 1 database.
- Tên bảng KHÔNG được prefix database (vd dùng "invoices" KHÔNG dùng "hospital_billing.invoices") — backend sẽ tự route đúng database.
- Nếu hỏi lượt khám của khoa, dùng departments.name và departments.visits.
- Nếu hỏi tổng lượt khám, dùng COALESCE(SUM(visits), 0) AS total_visits.
- "trực" hoặc "đang trực" = status = 'Đang trực'.
- "sắp trực" = status = 'Sắp trực'.
- Nếu hỏi "bao nhiêu nhân sự", dùng COUNT(*) AS total.
- Nếu hỏi "cao nhất/nhiều nhất", dùng ORDER BY ... DESC LIMIT 1.
- Nếu không hỏi số lượng/tổng, thêm LIMIT 20.

${contextBlock}

Câu hỏi: "${safeQuestion}"
`.trim();

  const { text } = await callAnythingLLM(prompt, {
    mode: "chat",
    sessionId: `hospital-nl2sql-${Date.now()}`,
    timeoutMs: 45000
  });
  const parsed = extractJsonObject(text);
  return { sql: parsed.sql || null, reason: parsed.reason || null, raw: text };
}

async function answerWithSqlPlan(question, plan) {
  if (!dbReady || !pool) return { ok: false, reply: "MySQL chưa kết nối nên chưa kiểm tra được dữ liệu." };
  if (!plan || !plan.sql) return { ok: false, reply: plan?.reason || "Không tạo được SQL." };

  // Phát hiện bảng từ SQL → suy ra connection cần dùng
  const tableMatch = plan.sql.match(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/i);
  let connectionId = null;
  let database = null;
  if (tableMatch) {
    const info = await lookupConnectionForTable(tableMatch[1]);
    connectionId = info.connection_id;
    database = info.connection_database;
  }

  const validation = await validateAndPrepareSql(plan.sql, connectionId, database);
  if (!validation.ok) return { ok: false, reply: `SQL bị chặn: ${validation.reason}` };

  try {
    const rows = await runSqlOnScope(validation.sql, connectionId, database);
    return {
      ok: true,
      reply: await summarizeSqlResult(question, validation.sql, rows),
      sql: validation.sql,
      rows,
      originalSql: plan.sql,
      connectionId,
      database
    };
  } catch (dbError) {
    console.error("DB error:", dbError.message);
    return { ok: false, reply: "Không truy vấn được dữ liệu. Vui lòng thử câu hỏi khác." };
  }
}

async function answerWithSql(question, context = null) {
  // Bước 1: thử match SQL template trước (nhanh, không tốn AI call)
  const tplResult = await tryAnswerWithTemplate(question);
  if (tplResult && tplResult.ok) {
    return {
      ok: true,
      reply: tplResult.reply,
      sql: tplResult.sql,
      rows: tplResult.rows,
      originalSql: `[template #${tplResult.templateId}: ${tplResult.templateName}]`,
      viaTemplate: true
    };
  }

  // Bước 2: gọi AnythingLLM để tạo SQL
  if (!isAnythingLLMConfigured()) {
    return { ok: false, reply: "Chưa cấu hình AnythingLLM trong .env." };
  }
  try {
    const plan = await generateSqlFromQuestion(question, context);
    if (!plan.sql) return { ok: false, reply: plan.reason || "Model không tạo được SQL." };
    return await answerWithSqlPlan(question, plan);
  } catch (error) {
    return { ok: false, reply: `Lỗi khi gọi AI tạo SQL: ${error.message}` };
  }
}


// =============================================================================
// SECTION: TRUSTED SOURCES (Class "Nguồn tra cứu")
// =============================================================================
// Chatbot CHỈ được tham khảo các URL/domain trong bảng trusted_sources cho:
//   - Research Mode (câu hỏi sức khỏe/wellness)
//   - Fallback chat (câu hỏi không phải SQL/FAQ/file)
// Backend áp dụng theo 2 lớp:
//   1. Đưa danh sách domain vào prompt, yêu cầu AI chỉ dùng các domain này
//   2. Post-check: parse câu trả lời, nếu có URL không nằm trong whitelist
//      thì cảnh báo / strip ra
// =============================================================================

let trustedSourcesCache = { list: [], at: 0 };

async function getTrustedSources() {
  if (Date.now() - trustedSourcesCache.at < 30000) return trustedSourcesCache.list;
  if (!dbReady || !pool) return [];
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, url, domain, description, category, language, trust_level
       FROM trusted_sources WHERE is_active = TRUE ORDER BY trust_level DESC, name ASC`
    );
    trustedSourcesCache = { list: rows, at: Date.now() };
    return rows;
  } catch (error) {
    console.warn("Không tải được trusted_sources:", error.message);
    return [];
  }
}

function buildTrustedSourcesPromptBlock(sources) {
  if (!sources.length) return "(chưa có nguồn nào được duyệt)";
  return sources
    .map((s) => `- ${s.name} (${s.domain}) — ${s.description || s.category || ""}`)
    .join("\n");
}

function extractUrlsFromText(text) {
  const urlRegex = /https?:\/\/[^\s\)\]\}<>"']+/g;
  return String(text || "").match(urlRegex) || [];
}

function filterAnswerByTrustedDomains(answer, sources) {
  const allowedDomains = new Set(sources.map((s) => s.domain.toLowerCase()));
  const urls = extractUrlsFromText(answer);
  const violatingUrls = urls.filter((url) => {
    const domain = extractDomain(url);
    if (!domain) return false;
    return !allowedDomains.has(domain) && !isSubdomainOfAllowed(domain, allowedDomains);
  });
  return {
    hasViolations: violatingUrls.length > 0,
    violatingUrls,
    allUrls: urls
  };
}

function isSubdomainOfAllowed(domain, allowedDomains) {
  for (const allowed of allowedDomains) {
    if (domain === allowed || domain.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

// =============================================================================
// SECTION: ROUTER LAYER (giữ luồng cũ + thêm template + trusted filter)
// =============================================================================
const fallbackDocuments = [
  {
    id: 1,
    title: "Bảng giá dịch vụ",
    keywords: "bang gia|bang gia dich vu|gia dich vu|vien phi|file bang gia|bảng giá|bảng giá dịch vụ",
    file_url: "/documents/bang-gia-dich-vu.txt",
    category: "pricing",
    is_active: true
  }
];

async function getActiveDocuments() {
  if (!dbReady || !pool) return fallbackDocuments;
  try {
    const [rows] = await pool.execute(
      `SELECT id, title, keywords, file_url, category, is_active
       FROM chatbot_documents WHERE is_active = TRUE ORDER BY updated_at DESC`
    );
    return rows.length ? rows : fallbackDocuments;
  } catch {
    return fallbackDocuments;
  }
}

async function handleFileRequest(message) {
  const text = normalizeVietnamese(message);
  const wantsFile =null ; 

  if (!wantsFile) return null;

  const docs = await getActiveDocuments();
  const matchedDoc = docs.find((doc) => {
    const keywords = String(doc.keywords || "")
      .split("|")
      .map((kw) => normalizeVietnamese(kw))
      .filter(Boolean);
    return keywords.some((kw) => text.includes(kw));
  });

  if (!matchedDoc) {
    return {
      source: "document-catalog",
      reply: [
        "Mình chưa tìm thấy file phù hợp với yêu cầu này.",
        "",
        "Bạn có thể hỏi rõ hơn, ví dụ:",
        "- Cho tôi file bảng giá dịch vụ"
      ].join("\n")
    };
  }

  // Validate URL trước khi trả về để chặn javascript: scheme
  if (!isSafeUrlForLink(matchedDoc.file_url)) {
    return {
      source: "document-catalog",
      reply: "Tài liệu này có URL không hợp lệ, vui lòng liên hệ admin."
    };
  }

  return {
    source: "document-catalog",
    reply: [
      `Mình tìm thấy tài liệu phù hợp: **${matchedDoc.title}**.`,
      "",
      `[Bấm vào đây để tải/xem file](${matchedDoc.file_url})`
    ].join("\n")
  };
}

function handleUrgentMedicalQuestion(message) {
  const text = normalizeVietnamese(message);
  const urgentSignals = [
    "du doi", "non lien tuc", "kho tho", "ngat", "co giat", "li bi",
    "dau nguc", "chay mau nhieu", "sot cao", "met la", "mat nuoc",
    "yeu liet", "mat kiem soat tieu", "bi tieu", "hon me"
  ];
  const medicineRequest =
    text.includes("uong thuoc gi") ||
    text.includes("dung thuoc gi") ||
    text.includes("thuoc nao") ||
    text.includes("ke thuoc") ||
    text.includes("lieu luong");

  if (urgentSignals.some((s) => text.includes(s)) || medicineRequest) {
    return {
      source: "medical-safety-rule",
      reply: [
        "Tình trạng này cần được nhân viên y tế đánh giá trực tiếp.",
        "",
        "- Mình không thể kê thuốc hoặc hướng dẫn dùng thuốc trong trường hợp này.",
        "- Nếu đau dữ dội, nôn liên tục, khó thở, ngất, sốt cao hoặc tình trạng nặng lên, hãy đến cơ sở y tế hoặc khoa cấp cứu ngay.",
        "- Nếu có thể, hãy đi cùng người thân và mang theo giấy tờ y tế/thuốc đang dùng."
      ].join("\n")
    };
  }
  return null;
}

function matchFaqFromList(message, list) {
  const text = normalizeVietnamese(message);
  return list.find((item) => {
    const keywords = String(item.keywords || "")
      .split("|")
      .map((kw) => normalizeVietnamese(kw))
      .filter(Boolean);
    return keywords.some((kw) => text.includes(kw));
  }) || null;
}

async function findApprovedMedicalFaq(message) {
  if (!dbReady || !pool) return null;
  try {
    const [rows] = await pool.execute(
      `SELECT id, topic, keywords, answer FROM approved_medical_faq
       WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 200`
    );
    return matchFaqFromList(message, rows);
  } catch (error) {
    console.warn("FAQ unavailable:", error.message);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Dynamic data-question detector (Phương án B)
// Gom keyword từ:
//   - sql_templates.keywords (admin tự viết)
//   - schema_metadata: domain, description, table_name, column names
// + 1 base safety net nhỏ (~5 keyword trụ cột)
// + fuzzy match theo tên bảng/cột raw (vd "invoices" trong câu user)
// Cache 60s để không query DB mỗi request.
// -----------------------------------------------------------------------------
let dataQuestionCache = { keywords: [], rawIdentifiers: new Set(), at: 0 };

// Base safety net — luôn có hiệu lực dù admin chưa kịp dạy template
const BASE_DATA_KEYWORDS = [
  "sql",
  "query",
  "database",
  "du lieu",
  "truy van",
  "su dung sql"  // explicit trigger cho dev
];

async function refreshDataQuestionKeywords() {
  if (!dbReady || !pool) return;
  try {
    const keywords = new Set(BASE_DATA_KEYWORDS);
    const identifiers = new Set();

    // 1. Lấy keywords từ sql_templates
    const [tplRows] = await pool.execute(
      `SELECT keywords FROM sql_templates WHERE is_active = TRUE`
    );
    for (const row of tplRows) {
      const parts = String(row.keywords || "")
        .split("|")
        .map((kw) => normalizeVietnamese(kw))
        .filter((kw) => kw && kw.length >= 3);
      parts.forEach((kw) => keywords.add(kw));
    }

    // 2. Lấy keywords từ schema_metadata: domain, description, table_name, column names
    const [schRows] = await pool.execute(
      `SELECT table_name, domain, description, columns_json
       FROM schema_metadata WHERE is_active = TRUE`
    );
    for (const row of schRows) {
      // Tên bảng raw (không normalize) để fuzzy match
      if (row.table_name) {
        const name = row.table_name.toLowerCase();
        identifiers.add(name);
        // Số ít (bỏ 's' cuối nếu là plural)
        if (name.endsWith('s') && name.length > 3) {
          identifiers.add(name.slice(0, -1));
        }
        // Số nhiều (thêm 's' nếu là singular)
        if (!name.endsWith('s')) {
          identifiers.add(name + 's');
        }
        // Snake_case → space (vd staff_schedules → staff schedules)
        if (name.includes('_')) {
          identifiers.add(name.replaceAll('_', ' '));
        }
      }

      // Tên bảng đã normalize
      if (row.table_name) {
        const t = normalizeVietnamese(row.table_name);
        if (t.length >= 3) keywords.add(t);
      }

      // Domain
      if (row.domain) {
        const d = normalizeVietnamese(row.domain);
        if (d.length >= 3) keywords.add(d);
      }

      // Description: tách thành từ đơn, lấy từ có nghĩa (>3 ký tự, không phải stopword)
      if (row.description) {
        const words = normalizeVietnamese(row.description)
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
        // Lấy cụm 2 từ liền nhau cho match tốt hơn (vd "hoa don", "doanh thu")
        for (let i = 0; i < words.length - 1; i++) {
          const phrase = `${words[i]} ${words[i + 1]}`;
          if (phrase.length >= 6) keywords.add(phrase);
        }
        // Cụm 1 từ cho fallback
        words.forEach((w) => keywords.add(w));
      }

      // Column names
      const columns = safeJsonParse(row.columns_json, []);
      for (const col of columns) {
        if (col.name) {
          const colName = String(col.name).toLowerCase();
          identifiers.add(colName);
          // Snake_case → space
          if (colName.includes('_')) {
            identifiers.add(colName.replaceAll('_', ' '));
          }
          const n = normalizeVietnamese(col.name);
          if (n.length >= 3) keywords.add(n);
        }
        // Enum values: nếu cột có enum → add từng value vào identifiers
        // Vd status enum ['paid', 'pending', 'cancelled'] → user hỏi "hóa đơn pending" sẽ match
        if (Array.isArray(col.enum)) {
          for (const v of col.enum) {
            const val = String(v).toLowerCase();
            if (val.length >= 3) identifiers.add(val);
          }
        }
        // Cũng tách description của cột
        if (col.description) {
          const words = normalizeVietnamese(col.description)
            .split(/\s+/)
            .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
          for (let i = 0; i < words.length - 1; i++) {
            keywords.add(`${words[i]} ${words[i + 1]}`);
          }
        }
      }
    }

    dataQuestionCache = {
      keywords: Array.from(keywords),
      rawIdentifiers: identifiers,
      at: Date.now()
    };
  } catch (err) {
    console.warn("refreshDataQuestionKeywords fail:", err.message);
  }
}

// Stopwords tiếng Việt cơ bản — tránh keyword vô nghĩa (vd "cua", "tren", "voi")
const STOPWORDS = new Set([
  "cua", "tren", "duoi", "trong", "ngoai", "voi", "cho", "tu", "den", "den",
  "khi", "thi", "neu", "hoac", "va", "hay", "nhung", "boi", "vi", "ma",
  "co", "khong", "duoc", "phai", "moi", "tat", "ca", "moi", "moi",
  "cac", "nhung", "nay", "kia", "ay", "kia", "ban", "minh", "toi", "anh", "em",
  "la", "thi", "rang", "hay", "luc", "thoi", "lan", "phan", "muc",
  "thong", "tin", "luu", "ghi", "nhan", "moi", "ngay", "thang", "nam"
]);

async function isHospitalDataQuestion(message) {
  // Refresh cache nếu hết hạn (60s)
  if (Date.now() - dataQuestionCache.at >= 60000) {
    await refreshDataQuestionKeywords();
  }

  const text = normalizeVietnamese(message);
  const textRaw = String(message || "").toLowerCase();

  // 1. Match keyword đã chuẩn hoá
  if (dataQuestionCache.keywords.some((kw) => text.includes(kw))) {
    return true;
  }

  // 2. Fuzzy match: câu hỏi có tên bảng/cột raw (vd "invoices", "patient_name")
  for (const ident of dataQuestionCache.rawIdentifiers) {
    if (textRaw.includes(ident)) return true;
  }

  return false;
}

// Detect câu hỏi có signal data RÕ RÀNG (có số, có pattern data query)
// Dùng để break tie khi vừa match medical vừa match data keyword
function hasStrongDataSignal(message) {
  const text = normalizeVietnamese(message);

  // Pattern câu hỏi data: "có bao nhiêu", "top X", "tổng", "trung bình", "thống kê"
  const dataPatterns = [
    "co bao nhieu", "bao nhieu", "tong so", "tong cong", "tong tien",
    "top ", "trung binh", "thong ke", "danh sach", "liet ke",
    "doanh thu", "luot kham", "hoa don", "ca truc", "lich truc",
    "duoc bao nhieu", "thuc te la", "report", "bao cao"
  ];
  if (dataPatterns.some((p) => text.includes(p))) return true;

  // Có chứa con số rõ ràng (vd "5 hóa đơn", "10 lượt khám")
  if (/\b\d+\b/.test(text)) return true;

  return false;
}

function isHealthOrWellnessQuestion(message) {
  const text = normalizeVietnamese(message);
  const patterns = [
    "trieu chung", "dau hieu", "benh", "sot", "ho", "kho tho", "dau bung", "dau dau",
    "tieu duong", "dai thao duong", "tay chan mieng", "sot xuat huyet", "cum", "covid",
    "hen suyen", "huyet ap", "tim mach", "viem hong", "viem phoi", "tieu chay",
    "thoat vi", "dau than kinh toa", "dau lung", "dau co", "dau vai", "te bi",
    "giac ngu", "ngu ngon", "mat ngu", "kho ngu", "stress", "cang thang", "lo au",
    "tang can", "giam can", "an uong", "dinh duong", "thuc don", "calo", "protein", "bmi",
    "tap luyen", "tap the duc", "gian co", "keo gian", "stretching", "yoga"
  ];
  if ((text.includes("giam") && text.includes("can")) || (text.includes("tang") && text.includes("can"))) return true;
  return patterns.some((p) => text.includes(p));
}

async function shouldUseResearchAgent(message) {
  // Logic mới:
  // - Nếu là câu hỏi y tế (health/wellness) VÀ KHÔNG có signal data mạnh → Research
  // - Nếu vừa có y tế vừa có signal data mạnh (vd "có bao nhiêu bệnh nhân tiểu đường") → Data
  // - Nếu chỉ là data → Data (không vào Research)
  const isHealth = isHealthOrWellnessQuestion(message);
  const isData = await isHospitalDataQuestion(message);
  const strongDataSignal = hasStrongDataSignal(message);

  // Case 1: Chỉ health, không phải data → Research
  if (isHealth && !isData) return true;

  // Case 2: Cả health và data, nhưng KHÔNG có signal data rõ → ưu tiên Research
  // (vì khả năng cao admin trích description chứa "benh" làm cache lệch)
  if (isHealth && isData && !strongDataSignal) return true;

  // Case 3: Cả health và data, có signal data rõ → Data (vd "có bao nhiêu bệnh nhân tiểu đường")
  // Case 4: Chỉ data → Data
  return false;
}

function handleBHYTQuestion(message) {
  const text = normalizeVietnamese(message);
  if (text.includes("bhyt") || text.includes("bao hiem y te") || (text.includes("quy trinh") && text.includes("kham"))) {
    return {
      source: "hospital-static-guide",
      reply: [
        "Quy trình khám BHYT thường gồm các bước:",
        "",
        "1. Người bệnh mang thẻ BHYT, CCCD và giấy chuyển tuyến nếu có.",
        "2. Đăng ký tại quầy tiếp nhận.",
        "3. Chờ gọi số thứ tự hoặc phân phòng khám.",
        "4. Khám với bác sĩ theo chuyên khoa phù hợp.",
        "5. Thực hiện xét nghiệm/cận lâm sàng nếu được chỉ định.",
        "6. Thanh toán phần chi phí còn lại nếu có và nhận thuốc theo quy định.",
        "",
        "Bạn nên kiểm tra thêm tại quầy tiếp nhận vì quyền lợi BHYT có thể phụ thuộc vào tuyến khám, giấy chuyển tuyến và loại dịch vụ."
      ].join("\n")
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Research Mode + Fallback chat — đều áp whitelist trusted_sources
// -----------------------------------------------------------------------------
function normalizeResearchQuestion(message) {
  return normalizeVietnamese(message)
    .replace(/^cho\s+(toi|minh|em)\s+hoi\s+/, "")
    .replace(/^toi\s+muon\s+hoi\s+/, "")
    .replace(/^cach\s+de\s+/, "cach ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

function extractWeightsFromMessage(message) {
  // Tách rõ tuổi/chiều cao/cân nặng để không lẫn
  const text = normalizeVietnamese(message);
  // Bỏ qua các số đi kèm "tuoi", "cao", "cm"
  const cleaned = text
    .replace(/\d+\s*tuoi/g, " ")
    .replace(/\d+\s*cm/g, " ")
    .replace(/cao\s*\d+/g, " ");
  return [...cleaned.matchAll(/\b(\d{2,3})\s*(?:kg|can|ky|kilogram)?\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 30 && n <= 250);
}

function buildResearchCacheKey(message) {
  const text = normalizeVietnamese(message);
  const weights = extractWeightsFromMessage(message);

  const isWeight =
    text.includes("giam can") ||
    text.includes("tang can") ||
    (text.includes("giam") && text.includes("can")) ||
    (text.includes("tang") && text.includes("can")) ||
    text.includes("calo") ||
    text.includes("thuc don") ||
    text.includes("dinh duong");

  if (isWeight) {
    const isLoss = text.includes("giam can") || text.includes("giam xuong") || (text.includes("giam") && text.includes("can"));
    const isGain = text.includes("tang can") || (text.includes("tang") && text.includes("can"));
    if (weights.length >= 2) {
      const [from, to] = weights;
      if (isLoss || from > to) return `wellness:giam-can:${from}-to-${to}`;
      if (isGain || from < to) return `wellness:tang-can:${from}-to-${to}`;
    }
    if (isLoss) return "wellness:giam-can:general";
    if (isGain) return "wellness:tang-can:general";
    return "wellness:weight:general";
  }
  if (text.includes("gian co") || text.includes("keo gian")) return "wellness:gian-co:general";
  if (text.includes("giac ngu") || text.includes("mat ngu")) return "wellness:giac-ngu:general";

  return normalizeResearchQuestion(message);
}

async function getCachedResearchAnswer(message) {
  if (!dbReady || !pool) return null;
  const key = buildResearchCacheKey(message);
  try {
    const [rows] = await pool.execute(
      `SELECT answer, source FROM research_answer_cache WHERE normalized_question = ? AND expires_at > NOW() LIMIT 1`,
      [key]
    );
    return rows[0] || null;
  } catch (error) {
    console.warn("Research cache unavailable:", error.message);
    return null;
  }
}

async function saveResearchAnswerCache(message, answer) {
  if (!dbReady || !pool) return;
  const key = buildResearchCacheKey(message);
  try {
    await pool.execute(
      `INSERT INTO research_answer_cache (normalized_question, original_question, answer, source, expires_at)
       VALUES (?, ?, ?, 'anythingllm-research', DATE_ADD(NOW(), INTERVAL 7 DAY))
       ON DUPLICATE KEY UPDATE original_question = VALUES(original_question), answer = VALUES(answer),
       expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP`,
      [key, message, answer]
    );
  } catch (error) {
    console.warn("Không lưu được research cache:", error.message);
  }
}

function isUrgentOrTreatmentSeeking(message) {
  const text = normalizeVietnamese(message);
  const urgent = ["du doi", "non lien tuc", "kho tho", "ngat", "co giat", "li bi",
    "dau nguc", "chay mau nhieu", "hon me", "tim tai", "sot cao"];
  const treatment = ["uong thuoc gi", "dung thuoc gi", "thuoc nao", "ke don", "lieu luong"];
  return urgent.some((w) => text.includes(w)) || treatment.some((w) => text.includes(w));
}

// Detect câu hỏi có intent xấu: thao tác phá hoại data, SQL injection, lệnh hệ thống
function isMaliciousIntent(message) {
  const text = normalizeVietnamese(message);
  const raw = String(message || "").toLowerCase();

  // Tiếng Việt: thao tác phá hoại
  const vietnameseHarm = [
    "xoa toan bo", "xoa het", "xoa tat ca", "xoa moi",
    "xoa database", "xoa du lieu", "xoa bang",
    "drop database", "drop bang", "xoa du lieu cua toi",
    "format lai", "reset database", "wipe", "format database"
  ];

  // SQL injection và DDL/DML patterns trong raw text
  const sqlInjection = [
    "drop table", "drop database", "drop schema",
    "delete from", "truncate table", "truncate ",
    "alter table", "alter database",
    "insert into", "update ", "grant ", "revoke ",
    "/*", ";--", "; --", "'; --", "union select"
  ];

  // Lệnh hệ thống
  const systemCommands = [
    "rm -rf", "exec(", "eval(", "system(", "/etc/passwd",
    "powershell", "cmd /c", "wget ", "curl http"
  ];

  if (vietnameseHarm.some((w) => text.includes(w))) return true;
  if (sqlInjection.some((w) => raw.includes(w))) return true;
  if (systemCommands.some((w) => raw.includes(w))) return true;

  return false;
}

// =============================================================================
// FAQ DEDUPE - Hybrid: keyword overlap + AI similarity check
// =============================================================================
// Strategy:
//   - <40% keyword overlap → khác biệt rõ, không trùng
//   - >=70% overlap → chắc chắn trùng, cảnh báo ngay
//   - 40-70% overlap → mơ hồ, hỏi AI confirm
// =============================================================================

function keywordOverlap(kwStr1, kwStr2) {
  const set1 = new Set(String(kwStr1 || "").split("|").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const set2 = new Set(String(kwStr2 || "").split("|").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!set1.size || !set2.size) return 0;
  let intersection = 0;
  for (const w of set1) if (set2.has(w)) intersection++;
  const union = new Set([...set1, ...set2]).size;
  return union === 0 ? 0 : intersection / union;
}

function topicSimilarity(topic1, topic2) {
  const n1 = normalizeVietnamese(topic1);
  const n2 = normalizeVietnamese(topic2);
  if (n1 === n2) return 1;
  if (n1.includes(n2) || n2.includes(n1)) return 0.85;
  const w1 = new Set(n1.split(/\s+/).filter((w) => w.length >= 3));
  const w2 = new Set(n2.split(/\s+/).filter((w) => w.length >= 3));
  if (!w1.size || !w2.size) return 0;
  let overlap = 0;
  for (const w of w1) if (w2.has(w)) overlap++;
  return overlap / Math.max(w1.size, w2.size);
}

async function checkFaqSimilarityWithAI(newFaq, candidates) {
  if (!isAnythingLLMConfigured() || !candidates.length) return null;

  const prompt = `Bạn cần kiểm tra FAQ mới có trùng nội dung với FAQ nào sẵn có không.

FAQ MỚI:
- Chủ đề: ${newFaq.topic}
- Nội dung: ${(newFaq.answer || "").slice(0, 300)}

DANH SÁCH FAQ SẴN CÓ:
${candidates.map((c, i) => `[${i + 1}] Chủ đề: ${c.topic}\n     Nội dung: ${(c.answer || "").slice(0, 200)}`).join("\n\n")}

Trả lời CHỈ 1 dòng theo format:
- "DUPLICATE: <số FAQ trùng>" nếu trùng (vd "DUPLICATE: 2")
- "UNIQUE" nếu không trùng cái nào

KHÔNG giải thích, KHÔNG markdown.`;

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `faq-dedupe-${Date.now()}`,
      timeoutMs: 20000
    });
    const match = String(text || "").match(/DUPLICATE:\s*(\d+)/i);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (candidates[idx]) return candidates[idx];
    }
    return null;
  } catch (err) {
    console.warn("AI dedupe fail:", err.message);
    return null;
  }
}

async function findSimilarFaqs(newFaq, opts = {}) {
  const useAI = opts.useAI !== false;

  const [rows] = await pool.query(
    `SELECT id, topic, keywords, answer FROM approved_medical_faq WHERE is_active = TRUE`
  );

  const duplicates = [];
  const ambiguous = [];

  for (const row of rows) {
    const kwScore = keywordOverlap(newFaq.keywords || "", row.keywords || "");
    const topicScore = topicSimilarity(newFaq.topic || "", row.topic || "");
    const maxScore = Math.max(kwScore, topicScore);

    if (maxScore >= 0.7) {
      duplicates.push({ ...row, score: maxScore, reason: "keyword+topic" });
    } else if (maxScore >= 0.4) {
      ambiguous.push({ ...row, score: maxScore });
    }
  }

  if (useAI && ambiguous.length > 0 && ambiguous.length <= 5) {
    const aiDup = await checkFaqSimilarityWithAI(newFaq, ambiguous);
    if (aiDup) {
      duplicates.push({ ...aiDup, score: 0.65, reason: "ai-confirmed" });
    }
  }

  return {
    duplicates,
    ambiguous: ambiguous.filter((a) => !duplicates.find((d) => d.id === a.id)),
    method: useAI ? "hybrid" : "keyword"
  };
}

async function handleResearchMode(message) {
  if (!(await shouldUseResearchAgent(message))) return null;

  // Cache
  const cached = await getCachedResearchAnswer(message);
  if (cached) return { source: "research-cache", reply: cached.answer };

  // Chặn nếu là câu cấp cứu/kê thuốc
  if (isUrgentOrTreatmentSeeking(message)) {
    return {
      source: "medical-safety-rule",
      reply: [
        "Tình trạng này cần được nhân viên y tế đánh giá trực tiếp.",
        "",
        "- Mình không thể kê thuốc, chỉ định thuốc hoặc đưa liều dùng.",
        "- Nếu triệu chứng nặng, đau dữ dội, khó thở, ngất, co giật, sốt cao hoặc nôn liên tục, hãy đến cơ sở y tế hoặc khoa cấp cứu.",
        "- Nếu có thể, hãy đi cùng người thân và mang theo giấy tờ y tế/thuốc đang dùng."
      ].join("\n")
    };
  }

  // Lấy whitelist trusted sources
  const sources = await getTrustedSources();
  if (!sources.length) {
    return {
      source: "no-trusted-sources",
      reply: "Hiện tại chưa có nguồn tra cứu nào được admin cho phép. Vui lòng liên hệ admin để bổ sung."
    };
  }

  const sourcesBlock = buildTrustedSourcesPromptBlock(sources);

  const prompt = `
@agent

Bạn là trợ lý nghiên cứu nhanh thông tin sức khỏe/wellness cho website bệnh viện.

QUY TẮC NGUỒN TRA CỨU (BẮT BUỘC):
- CHỈ ĐƯỢC tham khảo thông tin từ các nguồn dưới đây.
- KHÔNG ĐƯỢC trích dẫn, tham khảo, hoặc dùng thông tin từ bất kỳ website nào KHÔNG nằm trong danh sách này.
- KHÔNG được suy diễn từ nguồn ngoài danh sách.
- Nếu không tìm thấy thông tin trong các nguồn cho phép, hãy nói rõ là chưa có thông tin và đề nghị người dùng hỏi nhân viên y tế.

Danh sách nguồn được cho phép:
${sourcesBlock}

Nhiệm vụ:
- Tìm kiếm trong các nguồn trên để trả lời câu hỏi của người dùng.
- Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng, dễ hiểu.
- Tối đa 2 nguồn, tối đa 500 từ.
- Cuối câu trả lời, ghi mục "Nguồn tham khảo" với URL đầy đủ của các nguồn đã dùng (URL phải thuộc các domain trong danh sách trên).
- Không chẩn đoán bệnh, không kê thuốc, không thay thế bác sĩ.
- Không bịa nguồn, không bịa số liệu.

Câu hỏi của người dùng:
${message}
`.trim();

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `hospital-research-${Date.now()}`,
      timeoutMs: 120000 
    });
    
    // Detect tool call rác — model output JSON tool call thay vì câu trả lời thật
    // Vd: 'ronics {"name": "web-browsing", "arguments": {"query": "..."}}'
    const looksLikeRawToolCall =
      /\{\s*"name"\s*:\s*"[a-z-]+"\s*,\s*"arguments"\s*:/i.test(text) &&
      text.length < 500;

    if (looksLikeRawToolCall) {
      console.warn("Research Mode: AI output raw tool call (model lệch), không cache:", text.slice(0, 200));
      return {
        source: "research-error",
        reply: "Hệ thống nghiên cứu chưa xử lý xong câu hỏi này. Bạn vui lòng thử lại hoặc đặt lại câu hỏi rõ hơn."
      };
    }

    // Detect output rỗng hoặc quá ngắn (model fail)
    if (!text || text.trim().length < 30) {
      console.warn("Research Mode: AI output quá ngắn:", text);
      return {
        source: "research-error",
        reply: "Hệ thống nghiên cứu chưa có thông tin phù hợp cho câu hỏi này. Bạn có thể hỏi nhân viên y tế."
      };
    }

    // Post-check: nếu có URL ngoài whitelist, cảnh báo
    const check = filterAnswerByTrustedDomains(text, sources);
    let finalReply = text;
    if (check.hasViolations) {
      finalReply +=
        `\n\n⚠️ Lưu ý: câu trả lời có nhắc tới ${check.violatingUrls.length} nguồn ngoài danh sách được duyệt. ` +
        `Vui lòng kiểm tra lại với nhân viên y tế.`;
    }

    await saveResearchAnswerCache(message, finalReply);
    return { source: "anythingllm-research", reply: finalReply, trustedSourcesCount: sources.length };
  } catch (error) {
    console.warn("Research Mode lỗi:", error.message);
    return {
      source: "research-error",
      reply: [
        "Research Mode phản hồi quá lâu hoặc chưa lấy được nguồn phù hợp.",
        "",
        "Bạn có thể thử hỏi lại ngắn hơn hoặc hỏi nhân viên y tế."
      ].join("\n")
    };
  }
}

async function answerWithFallbackChat(message) {
  // Fallback chat cũng phải dùng trusted_sources làm whitelist
  const sources = await getTrustedSources();
  const sourcesBlock = buildTrustedSourcesPromptBlock(sources);

  const hospitalContext = `
Bạn là chatbot hỗ trợ website bệnh viện.
Chỉ hỗ trợ thông tin hành chính, quy trình và tài liệu đã được cung cấp.
Không chẩn đoán bệnh, không kê thuốc, không thay thế bác sĩ.
Nếu không chắc hoặc không có dữ liệu, hãy nói chưa có thông tin phù hợp.
Trả lời ngắn gọn, rõ ràng, thân thiện.

QUY TẮC NGUỒN TRA CỨU (BẮT BUỘC):
- Nếu cần tham khảo nguồn bên ngoài, CHỈ được dùng các nguồn trong danh sách dưới đây.
- KHÔNG được dùng nguồn ngoài danh sách này.

Danh sách nguồn được cho phép:
${sourcesBlock}
`.trim();

  if (!isAnythingLLMConfigured()) {
    return { source: "local-demo", reply: "Backend chưa có AnythingLLM API key/workspace slug." };
  }

  try {
    const { text } = await callAnythingLLM(`${hospitalContext}\n\nCâu hỏi của người dùng: ${message}`, {
      sessionId: `hospital-fallback-${Date.now()}`,
      timeoutMs: 60000
    });

    const check = filterAnswerByTrustedDomains(text, sources);
    let finalReply = text;
    if (check.hasViolations) {
      finalReply +=
        `\n\n⚠️ Lưu ý: câu trả lời có nhắc tới nguồn ngoài danh sách được duyệt.`;
    }
    return { source: "anythingllm-fallback", reply: finalReply };
  } catch (error) {
    return { source: "fallback-error", reply: `Không gọi được AI: ${error.message}` };
  }
}


// =============================================================================
// SECTION: PUBLIC APIs
// =============================================================================
app.get("/api/health", (req, res) => {
  res.json({
    ok: dbReady,
    dbReady,
    anythingLLMConfigured: isAnythingLLMConfigured(),
    demoToday: getDemoToday(),
    demoTomorrow: getDemoTomorrow(),
    useRealDate: USE_REAL_DATE,
    version: "2.0.0"
  });
});

app.get("/api/dashboard", requireDb, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, DATE_FORMAT(visit_date, '%Y-%m-%d') AS visit_date, visits FROM departments ORDER BY visits DESC"
    );
    const totalVisits = rows.reduce((sum, r) => sum + Number(r.visits || 0), 0);
    const busiest = rows[0] || null;
    res.json({
      totalVisits,
      activeDepartments: rows.length,
      emergencyVisits: rows.find((r) => r.name === "Khoa Cấp cứu")?.visits || 0,
      busiestDepartment: busiest?.name || "Chưa có dữ liệu",
      departments: rows
    });
  } catch (error) {
    console.error("dashboard error:", error.message);
    res.status(500).json({ error: "Không lấy được dữ liệu dashboard." });
  }
});

app.post("/api/feedback", chatLimiter, requireDb, async (req, res) => {
  const userQuestion = String(req.body.userQuestion || "").trim();
  const botAnswer = String(req.body.botAnswer || "").trim();
  const userCorrection = String(req.body.userCorrection || "").trim();
  const feedbackType = String(req.body.feedbackType || "correction").trim();

  if (!userQuestion || !botAnswer) {
    return res.status(400).json({ error: "Thiếu câu hỏi hoặc câu trả lời." });
  }

  try {
    await pool.execute(
      `INSERT INTO chat_feedback (user_question, bot_answer, user_correction, feedback_type, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [userQuestion, botAnswer, userCorrection, feedbackType]
    );
    res.json({ ok: true, message: "Đã ghi nhận góp ý." });
  } catch (error) {
    console.error("feedback error:", error.message);
    res.status(500).json({ error: "Không lưu được góp ý." });
  }
});

// -----------------------------------------------------------------------------
// /api/chat — luồng router chính
// -----------------------------------------------------------------------------
app.post("/api/chat", chatLimiter, async (req, res) => {
  const startedAt = Date.now();
  const message = String(req.body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Thiếu nội dung câu hỏi." });

  try {
    // 1. File request — check chatbot_documents local trước
    const fileResult = await handleFileRequest(message);
    if (fileResult) {
      await logChat({
        userMessage: message,
        routeName: "document",
        botReply: fileResult.reply,
        source: fileResult.source,
        latencyMs: Date.now() - startedAt
      });
      return res.json(fileResult);
    }

    // 1b. File request — check MinIO indexed files
    const textForFile = normalizeVietnamese(message);
    const hasFileKeyword = ["minio","file", "tai lieu", "tai ve", "download", "tai xuong"]
      .some((kw) => textForFile.includes(kw));
    const hasDocumentRequest = /(cho|gui|dua)\s+(toi|minh|em).*(file|tai lieu|bang|danh sach|hop dong|giay|don|bao cao)/.test(textForFile);
    const wantsFile = hasFileKeyword || hasDocumentRequest;
    if (wantsFile) {
      const minioMatch = await findMinioFileFromQuestion(message);
      if (minioMatch) {
        const payload = {
          source: "minio-storage",
          reply: [
            `Mình tìm thấy file phù hợp trên MinIO: **${minioMatch.objectName}**.`,
            "",
            `[Bấm vào đây để tải/xem file](${minioMatch.url})`,
            "",
            `_(Link có hiệu lực 1 giờ.)_`
          ].join("\n")
        };
        await logChat({
          userMessage: message,
          routeName: "minio-file",
          botReply: payload.reply,
          source: payload.source,
          latencyMs: Date.now() - startedAt
        });
        return res.json(payload);
      }
    }

    // 2. Urgent medical safety
    const urgent = handleUrgentMedicalQuestion(message);
    if (urgent) {
      await logChat({
        userMessage: message,
        routeName: "medical-safety",
        botReply: urgent.reply,
        source: urgent.source,
        latencyMs: Date.now() - startedAt
      });
      return res.json(urgent);
    }

    // 2b. Malicious intent (SQL injection, xoá data, lệnh hệ thống)
    if (isMaliciousIntent(message)) {
      const payload = {
        source: "intent-blocked",
        reply: "Xin lỗi, mình không hỗ trợ thao tác này. Mình chỉ giúp tra cứu thông tin bệnh viện và sức khỏe."
      };
      await logChat({
        userMessage: message,
        routeName: "intent-blocked",
        botReply: payload.reply,
        source: payload.source,
        latencyMs: Date.now() - startedAt
      });
      return res.json(payload);
    }

    // 3. Approved FAQ
    const faq = await findApprovedMedicalFaq(message);
    if (faq) {
      const payload = { source: "approved-medical-faq", faqId: faq.id, reply: faq.answer };
      await logChat({
        userMessage: message,
        routeName: "faq",
        botReply: payload.reply,
        source: payload.source,
        latencyMs: Date.now() - startedAt
      });
      return res.json(payload);
    }

    // 4. BHYT
    const bhyt = handleBHYTQuestion(message);
    if (bhyt) {
      await logChat({
        userMessage: message,
        routeName: "bhyt",
        botReply: bhyt.reply,
        source: bhyt.source,
        latencyMs: Date.now() - startedAt
      });
      return res.json(bhyt);
    }

    // 5. SQL data question
    // Logic mới: nếu câu hỏi VỪA match health pattern VỪA match data keyword
    // → ưu tiên Research (vì có thể cache data lệch do trích từ description)
    // Chỉ vào SQL khi: có signal data rõ HOẶC match data nhưng không phải health
    const isDataQ = await isHospitalDataQuestion(message);
    const isHealthQ = isHealthOrWellnessQuestion(message);
    const hasDataSignal = hasStrongDataSignal(message);

    // Nếu là câu y tế thuần (không có signal data) → skip SQL, đi Research
    const goToSql = isDataQ && (!isHealthQ || hasDataSignal);

    if (goToSql) {
      try {
        const sessionId = getSqlSessionId(req);
        const previousContext = getSqlContext(sessionId);
        const sqlResult = await answerWithSql(message, previousContext);

        if (sqlResult.ok) {
          saveSqlContext(sessionId, { question: message, sql: sqlResult.sql, rows: sqlResult.rows });
          const isDebug = process.env.DEBUG_SQL === "true";
          const payload = {
            source: sqlResult.viaTemplate ? "sql-template" : "ai-generated-sql",
            reply: sqlResult.reply,
            ...(isDebug ? { sql: sqlResult.sql, rows: sqlResult.rows, originalSql: sqlResult.originalSql } : {})
          };
          await logChat({
            userMessage: message,
            routeName: sqlResult.viaTemplate ? "sql-template" : "nl2sql",
            aiSql: sqlResult.originalSql,
            finalSql: sqlResult.sql,
            botReply: sqlResult.reply,
            source: payload.source,
            latencyMs: Date.now() - startedAt
          });
          return res.json(payload);
        }

        await logChat({
          userMessage: message,
          routeName: "nl2sql-error",
          botReply: sqlResult.reply,
          source: "ai-generated-sql",
          latencyMs: Date.now() - startedAt
        });
        return res.json({ source: "ai-generated-sql", reply: sqlResult.reply });
      } catch (error) {
        await logChat({
          userMessage: message,
          routeName: "nl2sql-exception",
          errorMessage: error.message,
          latencyMs: Date.now() - startedAt
        });
        return res.json({
          source: "ai-generated-sql-error",
          reply: "Mình chưa truy vấn được dữ liệu bệnh viện cho câu hỏi này."
        });
      }
    }

    // 6. Research mode (wellness)
    if (await shouldUseResearchAgent(message)) {
      const r = await handleResearchMode(message);
      if (r) {
        await logChat({
          userMessage: message,
          routeName: "research",
          botReply: r.reply,
          source: r.source,
          latencyMs: Date.now() - startedAt
        });
        return res.json(r);
      }
    }

    // 7. Fallback chat — cũng dùng trusted_sources whitelist
    const fb = await answerWithFallbackChat(message);
    await logChat({
      userMessage: message,
      routeName: "fallback",
      botReply: fb.reply,
      source: fb.source,
      latencyMs: Date.now() - startedAt
    });
    return res.json(fb);
  } catch (error) {
    console.error("/api/chat error:", error);
    await logChat({
      userMessage: message,
      routeName: "chat-error",
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt
    });
    return res.status(500).json({ error: "Lỗi xử lý chatbot." });
  }
});


// =============================================================================
// SECTION: ADMIN STUDIO APIs (đều áp adminLimiter + requireAdmin + requireDb)
// =============================================================================
app.use("/api/admin", adminLimiter);

// ---- Tổng quan ----
app.get("/api/admin/studio/summary", requireAdmin, requireDb, async (req, res) => {
  try {
    const [[feedbackPending]] = await pool.query("SELECT COUNT(*) AS total FROM chat_feedback WHERE status = 'pending'");
    const [[faqTotal]] = await pool.query("SELECT COUNT(*) AS total FROM approved_medical_faq WHERE is_active = TRUE");
    const [[schemaTotal]] = await pool.query("SELECT COUNT(*) AS total FROM schema_metadata WHERE is_active = TRUE");
    const [[cacheTotal]] = await pool.query("SELECT COUNT(*) AS total FROM research_answer_cache WHERE expires_at > NOW()");
    const [[templateTotal]] = await pool.query("SELECT COUNT(*) AS total FROM sql_templates WHERE is_active = TRUE");
    const [[sourceTotal]] = await pool.query("SELECT COUNT(*) AS total FROM trusted_sources WHERE is_active = TRUE");
    const [[connectionTotal]] = await pool.query("SELECT COUNT(*) AS total FROM data_connections WHERE is_active = TRUE");
    const [[minioFileTotal]] = await pool.query("SELECT COUNT(*) AS total FROM minio_indexed_files WHERE is_active = TRUE");

    res.json({
      dbReady,
      anythingLLMConfigured: isAnythingLLMConfigured(),
      demoToday: getDemoToday(),
      demoTomorrow: getDemoTomorrow(),
      feedbackPending: feedbackPending.total,
      faqTotal: faqTotal.total,
      schemaTotal: schemaTotal.total,
      cacheTotal: cacheTotal.total,
      templateTotal: templateTotal.total,
      sourceTotal: sourceTotal.total,
      connectionTotal: connectionTotal.total,
      minioFileTotal: minioFileTotal.total
    });
  } catch (error) {
    console.error("admin summary error:", error.message);
    res.status(500).json({ error: "Không lấy được tổng quan." });
  }
});

// -----------------------------------------------------------------------------
// FEEDBACK (giữ nguyên CRUD cũ + approve để add vào FAQ)
// -----------------------------------------------------------------------------
app.get("/api/admin/feedback", requireAdmin, requireDb, async (req, res) => {
  const status = String(req.query.status || "pending");
  const [rows] = await pool.execute(
    `SELECT id, user_question, bot_answer, user_correction, feedback_type, status, created_at
     FROM chat_feedback WHERE status = ? ORDER BY created_at DESC LIMIT 100`,
    [status]
  );
  res.json(rows);
});

app.post("/api/admin/feedback/:id/approve", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const topic = String(req.body.topic || "").trim();
  const keywords = String(req.body.keywords || "").trim();
  const answer = String(req.body.answer || "").trim();
  const approvedBy = String(req.body.approvedBy || "admin").trim();
  if (!id || !topic || !keywords || !answer) {
    return res.status(400).json({ error: "Thiếu thông tin." });
  }
  await pool.execute(
    `INSERT INTO approved_medical_faq (topic, keywords, answer, approved_by, is_active) VALUES (?, ?, ?, ?, TRUE)`,
    [topic, keywords, answer, approvedBy]
  );
  await pool.execute(
    `UPDATE chat_feedback SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
    [approvedBy, id]
  );
  res.json({ ok: true, message: "Đã duyệt feedback và thêm vào FAQ." });
});

app.post("/api/admin/feedback/:id/reject", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const by = String(req.body.reviewedBy || "admin").trim();
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(
    `UPDATE chat_feedback SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
    [by, id]
  );
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// AI-powered keyword suggestion (chung cho FAQ, Template, File, Schema)
// -----------------------------------------------------------------------------
// Request: { text, source, additionalContext?, existingKeywords? }
// Response: { ok, keywords: string[], method: 'heuristic' | 'ai' }
// -----------------------------------------------------------------------------
app.post("/api/admin/suggest-keywords", requireAdmin, async (req, res) => {
  const text = String(req.body.text || "").trim();
  const source = String(req.body.source || "general").trim();
  const additionalContext = String(req.body.additionalContext || "").trim();
  const existingKeywords = Array.isArray(req.body.existingKeywords)
    ? req.body.existingKeywords
    : [];
  const useAI = req.body.useAI !== false; // default true

  if (!text) {
    return res.status(400).json({ error: "Thiếu text." });
  }

  // Heuristic luôn chạy
  const heuristic = extractKeywordsHeuristic(text, {
    source,
    additionalContext,
    maxKeywords: 8
  });

  // Nếu không yêu cầu AI, return heuristic
  if (!useAI || !isAnythingLLMConfigured()) {
    return res.json({ ok: true, keywords: heuristic, method: "heuristic" });
  }

  // Gọi AI bổ sung
  try {
    const aiKeywords = await extractKeywordsWithAI(
      text,
      { source, additionalContext, existingKeywords: [...heuristic, ...existingKeywords] },
      callAnythingLLM
    );

    // Merge: heuristic + AI, dedupe
    const merged = Array.from(new Set([...heuristic, ...aiKeywords])).slice(0, 12);

    res.json({
      ok: true,
      keywords: merged,
      method: aiKeywords.length > 0 ? "heuristic+ai" : "heuristic",
      heuristic,
      ai: aiKeywords
    });
  } catch (err) {
    console.warn("AI suggest keywords fail, fallback heuristic:", err.message);
    res.json({ ok: true, keywords: heuristic, method: "heuristic", error: err.message });
  }
});

// -----------------------------------------------------------------------------
// AI-powered schema auto-generation từ tên bảng + DESCRIBE
// -----------------------------------------------------------------------------
// Request: { connectionId, database?, tableName }
// Response: { ok, schema: { columns_json, description, examples_json, domain, keywords } }
// -----------------------------------------------------------------------------
app.post("/api/admin/suggest-schema", requireAdmin, requireDb, async (req, res) => {
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const database = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;
  const tableName = String(req.body.table_name || "").trim();

  if (!tableName) return res.status(400).json({ error: "Thiếu tên bảng." });

  // Lấy DESCRIBE cho bảng
  let describeRows = [];
  try {
    if (!connectionId) {
      // DB chính
      const [rows] = await pool.query(`DESCRIBE \`${tableName}\``);
      describeRows = rows;
    } else {
      // Connection external
      const [connRows] = await pool.execute(
        `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
        [connectionId]
      );
      if (!connRows.length) return res.status(404).json({ error: "Connection không tồn tại." });
      const conn = connRows[0];
      const config = decryptConfigSecrets(conn.type, safeJsonParse(conn.config_json, {}));
      const externalPool = await getPoolForConnection({
        id: conn.id, database, type: conn.type, config
      });
      const result = await runQuery(externalPool, conn.type, `DESCRIBE \`${tableName}\``);
      describeRows = result;
    }
  } catch (err) {
    return res.status(400).json({ error: `Không lấy được schema bảng: ${err.message}` });
  }

  if (!describeRows.length) {
    return res.status(404).json({ error: "Bảng không tồn tại hoặc rỗng." });
  }

  const generated = generateSchemaFromDescribe(tableName, describeRows);

  // Cũng gen keywords từ tên bảng + tên cột
  const columnsText = generated.columns_json.map((c) => c.name + " " + (c.description || "")).join(" ");
  const keywords = extractKeywordsHeuristic(tableName, {
    source: "tablename",
    additionalContext: columnsText
  });

  res.json({
    ok: true,
    schema: { ...generated, keywords }
  });
});

// -----------------------------------------------------------------------------
// List tables của 1 connection (cho UI checkbox chọn bảng để import)
// -----------------------------------------------------------------------------
// Request: { connection_id, connection_database? }
// Response: { ok, tables: [{ name, alreadyHasSchema }], total }
// -----------------------------------------------------------------------------
app.post("/api/admin/list-tables", requireAdmin, requireDb, async (req, res) => {
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const database = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;

  // Bảng/prefix cần skip (system, log, tạm)
  const SKIP_PREFIXES = ["sys_", "tmp_", "temp_", "log_", "_", "__"];
  const SKIP_NAMES = new Set([
    // System schemas
    "information_schema", "performance_schema", "mysql", "sys",
    // Chatbot internal tables (không nên import lại chính nó)
    "schema_metadata", "sql_templates", "approved_medical_faq", "chat_logs",
    "chat_feedback", "trusted_sources", "data_connections", "minio_indexed_files",
    "chatbot_documents", "research_answer_cache"
  ]);

  try {
    let tableNames = [];

    if (!connectionId) {
      // DB chính
      const [rows] = await pool.query(`SHOW TABLES`);
      tableNames = rows.map((r) => Object.values(r)[0]);
    } else {
      const [connRows] = await pool.execute(
        `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
        [connectionId]
      );
      if (!connRows.length) return res.status(404).json({ error: "Connection không tồn tại." });
      const conn = connRows[0];
      const config = decryptConfigSecrets(conn.type, safeJsonParse(conn.config_json, {}));

      if (conn.type === "mysql") {
        const externalPool = await getPoolForConnection({ id: conn.id, database, type: conn.type, config });
        const rows = await runQuery(externalPool, "mysql", `SHOW TABLES`);
        tableNames = rows.map((r) => Object.values(r)[0]);
      } else if (conn.type === "postgres") {
        const externalPool = await getPoolForConnection({ id: conn.id, database, type: conn.type, config });
        const rows = await runQuery(
          externalPool, "postgres",
          `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename`
        );
        tableNames = rows.map((r) => r.tablename);
      } else {
        return res.status(400).json({ error: `Type ${conn.type} không support list tables.` });
      }
    }

    // Filter bỏ system tables
    const filtered = tableNames.filter((name) => {
      const lower = String(name).toLowerCase();
      if (SKIP_NAMES.has(lower)) return false;
      return !SKIP_PREFIXES.some((p) => lower.startsWith(p));
    });

    // Check bảng nào đã có schema metadata (kèm trạng thái)
    const [existing] = await pool.query(
      `SELECT table_name, is_active FROM schema_metadata
       WHERE ${connectionId ? 'connection_id = ?' : 'connection_id IS NULL'}
       ${database && connectionId ? 'AND connection_database = ?' : ''}`,
      connectionId ? (database ? [connectionId, database] : [connectionId]) : []
    );
    const existingMap = new Map();
    for (const row of existing) {
      existingMap.set(row.table_name.toLowerCase(), row.is_active === 1 || row.is_active === true);
    }

    const tables = filtered.map((name) => {
      const key = String(name).toLowerCase();
      const hasSchema = existingMap.has(key);
      const isActive = existingMap.get(key);
      return {
        name,
        alreadyHasSchema: hasSchema,
        isDisabled: hasSchema && !isActive
      };
    });

    res.json({ ok: true, tables, total: tables.length });
  } catch (err) {
    console.error("list-tables error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Auto-import schema cho 1 hoặc nhiều bảng
// -----------------------------------------------------------------------------
// Request: { connection_id, connection_database?, tables: [name1, name2, ...] }
// Response: { ok, imported: N, updated: M, skipped: K, results: [...] }
// -----------------------------------------------------------------------------
app.post("/api/admin/auto-import-schema", requireAdmin, requireDb, async (req, res) => {
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const database = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;
  const tables = Array.isArray(req.body.tables) ? req.body.tables : [];

  if (!tables.length) {
    return res.status(400).json({ error: "Thiếu danh sách bảng để import." });
  }

  // Lấy connection info (nếu không phải DB chính)
  let connType = "mysql";
  let externalPool = null;
  if (connectionId) {
    const [connRows] = await pool.execute(
      `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
      [connectionId]
    );
    if (!connRows.length) return res.status(404).json({ error: "Connection không tồn tại." });
    const conn = connRows[0];
    connType = conn.type;
    const config = decryptConfigSecrets(conn.type, safeJsonParse(conn.config_json, {}));
    externalPool = await getPoolForConnection({ id: conn.id, database, type: conn.type, config });
  }

  const results = [];
  let imported = 0, updated = 0, skipped = 0;

  for (const tableName of tables) {
    try {
      // 1. DESCRIBE table
      let describeRows = [];
      if (!connectionId) {
        const [rows] = await pool.query(`DESCRIBE \`${tableName}\``);
        describeRows = rows;
      } else if (connType === "mysql") {
        describeRows = await runQuery(externalPool, "mysql", `DESCRIBE \`${tableName}\``);
      } else if (connType === "postgres") {
        // Postgres: dùng information_schema
        const pgRows = await runQuery(
          externalPool, "postgres",
          `SELECT column_name AS "Field", data_type AS "Type"
           FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
          [tableName]
        );
        describeRows = pgRows;
      }

      if (!describeRows.length) {
        results.push({ table: tableName, status: "skipped", reason: "DESCRIBE trống" });
        skipped++;
        continue;
      }

      // 2. Check schema cũ
      const [existingRows] = await pool.execute(
        `SELECT id, columns_json, description, domain, examples_json, is_active FROM schema_metadata
         WHERE table_name = ?
         AND (connection_id ${connectionId ? '= ?' : 'IS NULL'})
         ${connectionId && database ? 'AND connection_database = ?' : ''}
         LIMIT 1`,
        connectionId ? (database ? [tableName, connectionId, database] : [tableName, connectionId]) : [tableName]
      );

      const generated = generateSchemaFromDescribe(tableName, describeRows);
      const generatedKeywords = extractKeywordsHeuristic(tableName, {
        source: "tablename",
        additionalContext: generated.columns_json.map((c) => c.name).join(" ")
      });

      if (existingRows.length > 0) {
        // CẬP NHẬT: thêm cột mới nếu DB có, giữ description cũ
        // Auto-revive nếu schema cũ đang bị disabled (is_active = FALSE)
        const old = existingRows[0];
        const wasDisabled = old.is_active === 0 || old.is_active === false;
        const oldColumns = safeJsonParse(old.columns_json, []);
        const oldColumnNames = new Set(oldColumns.map((c) => String(c.name).toLowerCase()));

        const newColumns = generated.columns_json.filter(
          (c) => !oldColumnNames.has(String(c.name).toLowerCase())
        );

        if (newColumns.length === 0 && !wasDisabled) {
          results.push({ table: tableName, status: "skipped", reason: "Schema đã đầy đủ" });
          skipped++;
          continue;
        }

        const mergedColumns = newColumns.length > 0 ? [...oldColumns, ...newColumns] : oldColumns;

        // UPDATE và LUÔN set is_active = TRUE (revive nếu cần)
        await pool.execute(
          `UPDATE schema_metadata SET columns_json = ?, is_active = TRUE, updated_at = NOW() WHERE id = ?`,
          [JSON.stringify(mergedColumns), old.id]
        );

        results.push({
          table: tableName,
          status: wasDisabled ? "revived" : "updated",
          newColumns: newColumns.map((c) => c.name),
          totalColumns: mergedColumns.length,
          revived: wasDisabled
        });
        updated++;
      } else {
        // TẠO MỚI
        await pool.execute(
          `INSERT INTO schema_metadata (table_name, connection_id, connection_database, domain, description, columns_json, examples_json, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
          [
            tableName,
            connectionId,
            database,
            generated.domain,
            generated.description + (generatedKeywords.length ? ` Keywords: ${generatedKeywords.join(", ")}` : ""),
            JSON.stringify(generated.columns_json),
            JSON.stringify(generated.examples_json)
          ]
        );

        results.push({
          table: tableName,
          status: "imported",
          columns: generated.columns_json.length,
          keywords: generatedKeywords
        });
        imported++;
      }
    } catch (err) {
      console.warn(`auto-import ${tableName} fail:`, err.message);
      results.push({ table: tableName, status: "error", reason: err.message });
      skipped++;
    }
  }

  // Invalidate cache
  allowedTableCache.at = 0;
  dataQuestionCache.at = 0;

  res.json({ ok: true, imported, updated, skipped, results });
});

// -----------------------------------------------------------------------------
// FAQ — CRUD truyền thống + upload file mới
// -----------------------------------------------------------------------------
app.get("/api/admin/faqs", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, topic, keywords, answer, source_file, source_file_name, approved_by, is_active, created_at, updated_at
     FROM approved_medical_faq ORDER BY updated_at DESC LIMIT 200`
  );
  res.json(rows);
});

// Parse file → text
async function parseFaqFile(filePath, ext) {
  const lower = ext.toLowerCase();
  if (lower === ".txt" || lower === ".md") {
    return fs.readFileSync(filePath, "utf8");
  }
  if (lower === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  }
  if (lower === ".pdf") {
    const buffer = fs.readFileSync(filePath);
    const result = await pdfParse(buffer);
    return result.text || "";
  }
  throw new Error("Định dạng file không hỗ trợ.");
}

// Upload file để TẠO FAQ mới
app.post(
  "/api/admin/faqs/upload",
  requireAdmin,
  requireDb,
  (req, res, next) => {
    faqUpload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    const file = req.file;
    const topic = String(req.body.topic || "").trim();
    let keywords = String(req.body.keywords || "").trim();
    const approvedBy = String(req.body.approvedBy || "admin").trim();

    if (!file) return res.status(400).json({ error: "Thiếu file upload." });
    if (!topic) {
      fs.unlink(file.path, () => {});
      return res.status(400).json({ error: "Thiếu topic." });
    }

    // Auto-fill keywords từ topic nếu admin để trống (file content xử lý sau)
    if (!keywords) {
      const auto = extractKeywordsHeuristic(topic, { source: "faq" });
      keywords = keywordsToString(auto);
    }

    try {
      const ext = path.extname(file.originalname).toLowerCase();
      const answer = await parseFaqFile(file.path, ext);
      const cleanedAnswer = String(answer || "").trim();
      if (!cleanedAnswer) {
        fs.unlink(file.path, () => {});
        return res.status(400).json({ error: "File không có nội dung text đọc được." });
      }

      if (!keywords || keywords.split("|").length < 3) {
        const enhanced = extractKeywordsHeuristic(topic, {
          source: "faq",
          additionalContext: cleanedAnswer.slice(0, 1000)
        });
        keywords = keywordsToString(enhanced);
      }

      // Dedupe check: nếu admin chưa confirm cho phép trùng → check
      const skipDedupe = req.body.skipDedupeCheck === "true" || req.body.skipDedupeCheck === true;
      const replaceFaqId = Number(req.body.replaceFaqId || 0) || null;

      if (!skipDedupe && !replaceFaqId) {
        const dedupeResult = await findSimilarFaqs(
          { topic, keywords, answer: cleanedAnswer },
          { useAI: true }
        );
        if (dedupeResult.duplicates.length > 0) {
          fs.unlink(file.path, () => {});
          return res.status(409).json({
            error: "duplicate_detected",
            message: "Phát hiện FAQ tương tự đã có trong hệ thống.",
            duplicates: dedupeResult.duplicates.map((d) => ({
              id: d.id,
              topic: d.topic,
              answer: String(d.answer || "").slice(0, 300),
              score: d.score,
              reason: d.reason
            })),
            pendingFaq: {
              topic, keywords,
              answer: cleanedAnswer.slice(0, 500),
              fullLength: cleanedAnswer.length
            }
          });
        }
      }

      if (replaceFaqId) {
        await pool.execute(`UPDATE approved_medical_faq SET is_active = FALSE WHERE id = ?`, [replaceFaqId]);
      }

      const [result] = await pool.execute(
        `INSERT INTO approved_medical_faq (topic, keywords, answer, source_file, source_file_name, approved_by, is_active)
         VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
        [topic, keywords, cleanedAnswer, file.filename, file.originalname, approvedBy]
      );
      res.json({
        ok: true,
        id: result.insertId,
        message: replaceFaqId ? "Đã thay thế FAQ cũ và tạo FAQ mới." : "Đã upload file và tạo FAQ.",
        preview: cleanedAnswer.slice(0, 300),
        fullLength: cleanedAnswer.length,
        autoKeywords: keywords,
        replacedFaqId: replaceFaqId
      });
    } catch (error) {
      console.error("faq upload parse error:", error);
      fs.unlink(file.path, () => {});
      res.status(500).json({ error: "Lỗi đọc file: " + error.message });
    }
  }
);

// Update FAQ (text edit, không bắt buộc upload lại file)
app.put("/api/admin/faqs/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const topic = String(req.body.topic || "").trim();
  const keywords = String(req.body.keywords || "").trim();
  const answer = String(req.body.answer || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  if (!id || !topic || !keywords || !answer) return res.status(400).json({ error: "Thiếu thông tin." });
  await pool.execute(
    `UPDATE approved_medical_faq SET topic = ?, keywords = ?, answer = ?, is_active = ? WHERE id = ?`,
    [topic, keywords, answer, isActive, id]
  );
  res.json({ ok: true });
});

app.delete("/api/admin/faqs/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });

  // Xóa luôn cả file đã upload (nếu có)
  try {
    const [rows] = await pool.execute(`SELECT source_file FROM approved_medical_faq WHERE id = ?`, [id]);
    if (rows[0]?.source_file) {
      const filePath = path.join(FAQ_UPLOAD_DIR, rows[0].source_file);
      fs.unlink(filePath, () => {}); // best-effort
    }
  } catch {}

  await pool.execute(`DELETE FROM approved_medical_faq WHERE id = ?`, [id]);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// SCHEMA (Dạy chatbot hiểu bảng)
// -----------------------------------------------------------------------------
app.get("/api/admin/schema", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT s.id, s.table_name, s.connection_id, s.connection_database, s.domain,
            s.description, s.columns_json, s.examples_json, s.is_active, s.updated_at,
            c.name AS connection_name, c.type AS connection_type
     FROM schema_metadata s
     LEFT JOIN data_connections c ON c.id = s.connection_id
     ORDER BY s.updated_at DESC LIMIT 200`
  );
  res.json(rows.map((r) => ({
    ...r,
    columns_json: safeJsonParse(r.columns_json, []),
    examples_json: safeJsonParse(r.examples_json, [])
  })));
});

app.post("/api/admin/schema", requireAdmin, requireDb, async (req, res) => {
  const tableName = String(req.body.table_name || "").trim();
  const domain = String(req.body.domain || "").trim();
  const description = String(req.body.description || "").trim();
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;
  if (!tableName || !description || !req.body.columns_json) {
    return res.status(400).json({ error: "Thiếu thông tin." });
  }
  let columnsStr, examplesStr;
  try {
    columnsStr = JSON.stringify(typeof req.body.columns_json === "string" ? JSON.parse(req.body.columns_json) : req.body.columns_json);
    examplesStr = JSON.stringify(typeof req.body.examples_json === "string" ? JSON.parse(req.body.examples_json || "[]") : (req.body.examples_json || []));
  } catch {
    return res.status(400).json({ error: "JSON không hợp lệ." });
  }
  const [result] = await pool.execute(
    `INSERT INTO schema_metadata (table_name, connection_id, connection_database, domain, description, columns_json, examples_json, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [tableName, connectionId, connectionDatabase, domain, description, columnsStr, examplesStr]
  );
  allowedTableCache.at = 0; dataQuestionCache.at = 0;
  res.json({ ok: true, id: result.insertId });
});

app.put("/api/admin/schema/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const tableName = String(req.body.table_name || "").trim();
  const domain = String(req.body.domain || "").trim();
  const description = String(req.body.description || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;
  if (!id || !tableName || !description || !req.body.columns_json) {
    return res.status(400).json({ error: "Thiếu thông tin." });
  }
  let columnsStr, examplesStr;
  try {
    columnsStr = JSON.stringify(typeof req.body.columns_json === "string" ? JSON.parse(req.body.columns_json) : req.body.columns_json);
    examplesStr = JSON.stringify(typeof req.body.examples_json === "string" ? JSON.parse(req.body.examples_json || "[]") : (req.body.examples_json || []));
  } catch {
    return res.status(400).json({ error: "JSON không hợp lệ." });
  }
  await pool.execute(
    `UPDATE schema_metadata SET table_name = ?, connection_id = ?, connection_database = ?, domain = ?, description = ?, columns_json = ?, examples_json = ?, is_active = ? WHERE id = ?`,
    [tableName, connectionId, connectionDatabase, domain, description, columnsStr, examplesStr, isActive, id]
  );
  allowedTableCache.at = 0; dataQuestionCache.at = 0;
  res.json({ ok: true });
});

app.delete("/api/admin/schema/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM schema_metadata WHERE id = ?`, [id]);
  allowedTableCache.at = 0; dataQuestionCache.at = 0;
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// SQL TEMPLATES — Class "Dạy SQL" (CRUD đầy đủ)
// -----------------------------------------------------------------------------
app.get("/api/admin/sql-templates", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.id, t.name, t.connection_id, t.connection_database, t.description,
            t.question_pattern, t.keywords, t.sql_template, t.category,
            t.created_by, t.is_active, t.usage_count, t.last_used_at, t.created_at, t.updated_at,
            c.name AS connection_name, c.type AS connection_type
     FROM sql_templates t
     LEFT JOIN data_connections c ON c.id = t.connection_id
     ORDER BY t.updated_at DESC LIMIT 200`
  );
  res.json(rows);
});

app.post("/api/admin/sql-templates", requireAdmin, requireDb, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const questionPattern = String(req.body.question_pattern || "").trim();
  let keywords = String(req.body.keywords || "").trim();
  const sqlTemplate = String(req.body.sql_template || "").trim();
  const category = String(req.body.category || "").trim();
  const createdBy = String(req.body.created_by || "admin").trim();
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;

  if (!name || !questionPattern || !sqlTemplate) {
    return res.status(400).json({ error: "Thiếu name/question_pattern/sql_template." });
  }

  // Auto-fill keywords từ question_pattern + name nếu admin để trống
  if (!keywords) {
    const auto = extractKeywordsHeuristic(questionPattern, {
      source: "question",
      additionalContext: name + " " + description
    });
    keywords = keywordsToString(auto);
    if (!keywords) {
      return res.status(400).json({ error: "Không tạo được keywords tự động. Vui lòng nhập thủ công." });
    }
  }

  const testSql = sqlTemplate
    .replaceAll("{DEMO_TODAY}", getDemoToday())
    .replaceAll("{DEMO_TOMORROW}", getDemoTomorrow())
    .replaceAll("{DEMO_YESTERDAY}", getDemoYesterday())
    .replaceAll("{department}", "Khoa Test");

  const validation = await validateAndPrepareSql(testSql, connectionId, connectionDatabase);
  if (!validation.ok) {
    return res.status(400).json({
      error: `SQL template không qua validator: ${validation.reason}`,
      hint: "Template phải là SELECT, không có DDL/DML, không có comment, và bảng phải nằm trong schema metadata của DB tương ứng."
    });
  }

  const [result] = await pool.execute(
    `INSERT INTO sql_templates (name, connection_id, connection_database, description, question_pattern, keywords, sql_template, category, created_by, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [name, connectionId, connectionDatabase, description, questionPattern, keywords, sqlTemplate, category, createdBy]
  );
  dataQuestionCache.at = 0;
  res.json({ ok: true, id: result.insertId, message: "Đã tạo SQL template." });
});

app.put("/api/admin/sql-templates/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });

  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const questionPattern = String(req.body.question_pattern || "").trim();
  const keywords = String(req.body.keywords || "").trim();
  const sqlTemplate = String(req.body.sql_template || "").trim();
  const category = String(req.body.category || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;

  if (!name || !questionPattern || !keywords || !sqlTemplate) {
    return res.status(400).json({ error: "Thiếu thông tin bắt buộc." });
  }

  const testSql = sqlTemplate
    .replaceAll("{DEMO_TODAY}", getDemoToday())
    .replaceAll("{DEMO_TOMORROW}", getDemoTomorrow())
    .replaceAll("{DEMO_YESTERDAY}", getDemoYesterday())
    .replaceAll("{department}", "Khoa Test");
  const validation = await validateAndPrepareSql(testSql, connectionId, connectionDatabase);
  if (!validation.ok) {
    return res.status(400).json({ error: `SQL không hợp lệ: ${validation.reason}` });
  }

  await pool.execute(
    `UPDATE sql_templates SET name = ?, connection_id = ?, connection_database = ?, description = ?, question_pattern = ?, keywords = ?, sql_template = ?, category = ?, is_active = ? WHERE id = ?`,
    [name, connectionId, connectionDatabase, description, questionPattern, keywords, sqlTemplate, category, isActive, id]
  );
  dataQuestionCache.at = 0;
  res.json({ ok: true });
});

app.delete("/api/admin/sql-templates/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM sql_templates WHERE id = ?`, [id]);
  dataQuestionCache.at = 0;
  res.json({ ok: true });
});

app.post("/api/admin/sql-templates/:id/test", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const testQuestion = String(req.body.question || "").trim();
  if (!id) return res.status(400).json({ error: "Thiếu id." });

  const [rows] = await pool.execute(`SELECT * FROM sql_templates WHERE id = ?`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Không tìm thấy template." });

  const tpl = rows[0];
  const resolvedSql = resolvePlaceholders(tpl.sql_template, testQuestion || tpl.question_pattern);

  const validation = await validateAndPrepareSql(resolvedSql, tpl.connection_id, tpl.connection_database);
  if (!validation.ok) {
    return res.json({ ok: false, sql: resolvedSql, error: validation.reason });
  }

  try {
    const resultRows = await runSqlOnScope(validation.sql, tpl.connection_id, tpl.connection_database);
    res.json({
      ok: true,
      sql: validation.sql,
      rows: resultRows,
      reply: await summarizeSqlResult(testQuestion || tpl.question_pattern, validation.sql, resultRows),
      scope: tpl.connection_id ? `connection #${tpl.connection_id} · ${tpl.connection_database || 'default'}` : 'DB chính'
    });
  } catch (error) {
    res.json({ ok: false, sql: validation.sql, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// TRUSTED SOURCES — Class "Nguồn tra cứu" (CRUD)
// -----------------------------------------------------------------------------
app.get("/api/admin/trusted-sources", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, url, domain, description, category, language, trust_level,
            added_by, is_active, created_at, updated_at
     FROM trusted_sources ORDER BY trust_level DESC, name ASC LIMIT 500`
  );
  res.json(rows);
});

app.post("/api/admin/trusted-sources", requireAdmin, requireDb, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const url = String(req.body.url || "").trim();
  const description = String(req.body.description || "").trim();
  const category = String(req.body.category || "medical").trim();
  const language = String(req.body.language || "vi").trim();
  const trustLevel = String(req.body.trust_level || "medium").trim();
  const addedBy = String(req.body.added_by || "admin").trim();

  if (!name || !url) return res.status(400).json({ error: "Thiếu name hoặc url." });
  if (!isSafeUrlForLink(url)) return res.status(400).json({ error: "URL không hợp lệ (phải là http/https)." });

  const domain = extractDomain(url);
  if (!domain) return res.status(400).json({ error: "Không parse được domain từ URL." });

  if (!["low", "medium", "high"].includes(trustLevel)) {
    return res.status(400).json({ error: "trust_level phải là low/medium/high." });
  }

  const [result] = await pool.execute(
    `INSERT INTO trusted_sources (name, url, domain, description, category, language, trust_level, added_by, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [name, url, domain, description, category, language, trustLevel, addedBy]
  );
  // Invalidate cache
  trustedSourcesCache.at = 0;
  res.json({ ok: true, id: result.insertId, domain });
});

app.put("/api/admin/trusted-sources/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });

  const name = String(req.body.name || "").trim();
  const url = String(req.body.url || "").trim();
  const description = String(req.body.description || "").trim();
  const category = String(req.body.category || "medical").trim();
  const language = String(req.body.language || "vi").trim();
  const trustLevel = String(req.body.trust_level || "medium").trim();
  const isActive = req.body.is_active === false ? false : true;

  if (!name || !url) return res.status(400).json({ error: "Thiếu name hoặc url." });
  if (!isSafeUrlForLink(url)) return res.status(400).json({ error: "URL không hợp lệ." });
  const domain = extractDomain(url);
  if (!domain) return res.status(400).json({ error: "Không parse được domain." });

  await pool.execute(
    `UPDATE trusted_sources SET name = ?, url = ?, domain = ?, description = ?, category = ?, language = ?, trust_level = ?, is_active = ? WHERE id = ?`,
    [name, url, domain, description, category, language, trustLevel, isActive, id]
  );
  trustedSourcesCache.at = 0;
  res.json({ ok: true });
});

app.delete("/api/admin/trusted-sources/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM trusted_sources WHERE id = ?`, [id]);
  trustedSourcesCache.at = 0;
  res.json({ ok: true });
});

// Endpoint cho user-facing: lấy danh sách nguồn để hiển thị (read-only, không cần admin)
app.get("/api/trusted-sources", async (req, res) => {
  if (!dbReady || !pool) return res.json([]);
  const [rows] = await pool.query(
    `SELECT name, url, domain, description, category, language, trust_level
     FROM trusted_sources WHERE is_active = TRUE ORDER BY trust_level DESC, name ASC LIMIT 100`
  );
  res.json(rows);
});

// -----------------------------------------------------------------------------
// SQL PLAYGROUND
// -----------------------------------------------------------------------------
app.post("/api/admin/sql-playground", requireAdmin, requireDb, async (req, res) => {
  const question = String(req.body.question || "").trim();
  if (!question) return res.status(400).json({ error: "Thiếu câu hỏi." });
  try {
    const result = await answerWithSql(question);
    res.json({
      ok: result.ok,
      question,
      reply: result.reply,
      sql: result.sql || null,
      originalSql: result.originalSql || null,
      rows: result.rows || [],
      viaTemplate: result.viaTemplate || false
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// RESEARCH CACHE
// -----------------------------------------------------------------------------
app.get("/api/admin/research-cache", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, normalized_question, original_question, source, expires_at, created_at, updated_at
     FROM research_answer_cache ORDER BY updated_at DESC LIMIT 200`
  );
  res.json(rows);
});

app.delete("/api/admin/research-cache/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM research_answer_cache WHERE id = ?`, [id]);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// LOGS
// -----------------------------------------------------------------------------
app.get("/api/admin/logs", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, user_message, route_name, ai_sql, final_sql, source, latency_ms, error_message, created_at
     FROM chat_logs ORDER BY created_at DESC LIMIT 200`
  );
  res.json(rows);
});

// =============================================================================
// SECTION: DATA CONNECTIONS (Layer 1 - Pluggable adapters)
// =============================================================================
// Mã hoá password trong config_json bằng AES-256-GCM. Key derive từ ADMIN_TOKEN
// (nếu ADMIN_TOKEN đổi → các connection cũ phải tạo lại). Đơn giản nhưng đủ
// để tránh password plain-text trong DB.
// -----------------------------------------------------------------------------
const ENC_KEY = crypto.createHash("sha256").update(ADMIN_TOKEN || "no-token-set-12345").digest();

function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptSecret(encoded) {
  if (!encoded || !String(encoded).startsWith("enc:")) return encoded;
  try {
    const [, ivHex, tagHex, encHex] = encoded.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch (err) {
    console.warn("Decrypt fail:", err.message);
    return null;
  }
}

function encryptConfigSecrets(type, config) {
  const out = { ...config };
  const adapter = getAdapter(type);
  for (const field of adapter.configSchema) {
    if (field.type === "password" && out[field.key]) {
      out[field.key] = encryptSecret(out[field.key]);
    }
  }
  return out;
}

function decryptConfigSecrets(type, config) {
  const out = { ...config };
  try {
    const adapter = getAdapter(type);
    for (const field of adapter.configSchema) {
      if (field.type === "password" && out[field.key]) {
        out[field.key] = decryptSecret(out[field.key]);
      }
    }
  } catch {}
  return out;
}

function redactConfigForRead(type, config) {
  const out = { ...config };
  try {
    const adapter = getAdapter(type);
    for (const field of adapter.configSchema) {
      if (field.type === "password" && out[field.key]) {
        out[field.key] = "••••••••";
      }
    }
  } catch {}
  return out;
}

// List available adapter types (cho UI form động)
app.get("/api/admin/data-connections/adapters", requireAdmin, (req, res) => {
  res.json(listAdapters());
});

// List connections
app.get("/api/admin/data-connections", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, type, description, config_json, is_active, last_test_at, last_test_status, last_test_message, created_at, updated_at
     FROM data_connections ORDER BY updated_at DESC LIMIT 200`
  );
  res.json(rows.map((r) => ({
    ...r,
    config_json: redactConfigForRead(r.type, safeJsonParse(r.config_json, {}))
  })));
});

// Create
app.post("/api/admin/data-connections", requireAdmin, requireDb, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const type = String(req.body.type || "").trim();
  const description = String(req.body.description || "").trim();
  const config = req.body.config_json || {};

  if (!name || !type) return res.status(400).json({ error: "Thiếu name hoặc type." });
  try { getAdapter(type); } catch (err) { return res.status(400).json({ error: err.message }); }

  const encConfig = encryptConfigSecrets(type, config);
  try {
    const [result] = await pool.execute(
      `INSERT INTO data_connections (name, type, description, config_json, is_active, created_by)
       VALUES (?, ?, ?, ?, TRUE, 'admin')`,
      [name, type, description, JSON.stringify(encConfig)]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: `Tên "${name}" đã tồn tại.` });
    res.status(500).json({ error: err.message });
  }
});

// Update
app.put("/api/admin/data-connections/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const name = String(req.body.name || "").trim();
  const type = String(req.body.type || "").trim();
  const description = String(req.body.description || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  const config = req.body.config_json || {};
  if (!name || !type) return res.status(400).json({ error: "Thiếu name hoặc type." });

  // Nếu password = "••••••••" (placeholder UI) thì giữ nguyên password cũ
  const [oldRows] = await pool.execute(`SELECT type, config_json FROM data_connections WHERE id = ?`, [id]);
  if (!oldRows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const oldConfig = safeJsonParse(oldRows[0].config_json, {});

  try {
    const adapter = getAdapter(type);
    for (const field of adapter.configSchema) {
      if (field.type === "password" && config[field.key] === "••••••••") {
        config[field.key] = decryptSecret(oldConfig[field.key]); // restore plain để re-encrypt
      }
    }
  } catch {}

  const encConfig = encryptConfigSecrets(type, config);
  await pool.execute(
    `UPDATE data_connections SET name = ?, type = ?, description = ?, config_json = ?, is_active = ? WHERE id = ?`,
    [name, type, description, JSON.stringify(encConfig), isActive, id]
  );
  // Invalidate external pool + table cache vì config có thể đã đổi
  await invalidatePool(id);
  allowedTableCache.at = 0; dataQuestionCache.at = 0;
  res.json({ ok: true });
});

// Delete
app.delete("/api/admin/data-connections/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM data_connections WHERE id = ?`, [id]);
  await invalidatePool(id);
  allowedTableCache.at = 0; dataQuestionCache.at = 0;
  res.json({ ok: true });
});

// Test connection
app.post("/api/admin/data-connections/:id/test", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const [rows] = await pool.execute(`SELECT type, config_json FROM data_connections WHERE id = ?`, [id]);
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const type = rows[0].type;
  const config = decryptConfigSecrets(type, safeJsonParse(rows[0].config_json, {}));

  try {
    const adapter = getAdapter(type);
    const result = await adapter.testConnection(config);
    await pool.execute(
      `UPDATE data_connections SET last_test_at = NOW(), last_test_status = ?, last_test_message = ? WHERE id = ?`,
      [result.ok ? "ok" : "fail", result.message, id]
    );
    res.json(result);
  } catch (err) {
    await pool.execute(
      `UPDATE data_connections SET last_test_at = NOW(), last_test_status = 'fail', last_test_message = ? WHERE id = ?`,
      [err.message, id]
    );
    res.status(500).json({ ok: false, message: err.message });
  }
});

// List resources (bảng cho SQL, object cho MinIO)
app.get("/api/admin/data-connections/:id/resources", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const [rows] = await pool.execute(`SELECT type, config_json FROM data_connections WHERE id = ?`, [id]);
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const type = rows[0].type;
  const config = decryptConfigSecrets(type, safeJsonParse(rows[0].config_json, {}));
  try {
    const adapter = getAdapter(type);
    const list = await adapter.listResources(config);
    res.json({ ok: true, type, count: list.length, items: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// SECTION: MINIO INDEXED FILES (Layer 2)
// =============================================================================
// Helper: lấy MinIO connection theo id, trả về config đã decrypt
async function getMinioConnection(connectionId) {
  const [rows] = await pool.execute(
    `SELECT id, name, type, config_json FROM data_connections WHERE id = ? AND type = 'minio' AND is_active = TRUE`,
    [connectionId]
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    config: decryptConfigSecrets("minio", safeJsonParse(rows[0].config_json, {}))
  };
}

app.post("/api/admin/minio/:connectionId/sync", requireAdmin, requireDb, async (req, res) => {
  const connectionId = Number(req.params.connectionId);
  const conn = await getMinioConnection(connectionId);
  if (!conn) return res.status(404).json({ error: "MinIO connection không tồn tại hoặc không active." });

  // Option: nếu admin truyền `forceDeleteMissing=true`, tự động delete file mất
  const forceDelete = req.body.forceDeleteMissing === true || req.body.forceDeactivateMissing === true;
  // Option: list cụ thể file IDs admin đồng ý delete (sau khi user confirm trên UI)
  const confirmDeleteIds = Array.isArray(req.body.confirmDeleteIds)
    ? req.body.confirmDeleteIds.map(Number).filter(Boolean)
    : (Array.isArray(req.body.confirmDeactivateIds)
        ? req.body.confirmDeactivateIds.map(Number).filter(Boolean)
        : []);

  try {
    const objects = await minioAdapter.listResources(conn.config);
    let inserted = 0, updated = 0;

    // Track object_keys hiện có trong bucket
    const currentKeys = new Set(objects.map((o) => o.name));

    // 1. Upsert files hiện có
    for (const obj of objects) {
      const objectName = obj.name.split("/").pop() || obj.name;
      const autoKeywords = keywordsToString(
        extractKeywordsHeuristic(objectName, { source: "filename" })
      );

      const [existing] = await pool.execute(
        `SELECT id FROM minio_indexed_files WHERE connection_id = ? AND object_key = ? LIMIT 1`,
        [connectionId, obj.name]
      );

      if (existing.length > 0) {
        // UPDATE
        await pool.execute(
          `UPDATE minio_indexed_files SET
             object_name = ?, size_bytes = ?, etag = ?, last_modified = ?,
             is_active = TRUE, indexed_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [objectName, obj.size, obj.etag, obj.lastModified ? new Date(obj.lastModified) : null, existing[0].id]
        );
        updated++;
      } else {
        // INSERT mới
        await pool.execute(
          `INSERT INTO minio_indexed_files (connection_id, bucket, object_key, object_name, size_bytes, etag, last_modified, keywords, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
          [
            connectionId, conn.config.bucket, obj.name, objectName,
            obj.size, obj.etag, obj.lastModified ? new Date(obj.lastModified) : null,
            autoKeywords
          ]
        );
        inserted++;
      }
    }

    // 2. Phát hiện files trong DB nhưng không còn trong bucket
    const [allInDb] = await pool.execute(
      `SELECT id, object_key, object_name FROM minio_indexed_files WHERE connection_id = ?`,
      [connectionId]
    );
    const missingFiles = allInDb.filter((f) => !currentKeys.has(f.object_key));

    let deleted = 0;

    // 3. Xử lý missing files:
    //    - Nếu forceDelete=true → hard delete hết
    //    - Nếu có confirmDeleteIds → hard delete đúng các ID đó
    //    - Else: return list cho admin confirm
    if (forceDelete && missingFiles.length > 0) {
      const ids = missingFiles.map((f) => f.id);
      const placeholders = ids.map(() => "?").join(",");
      await pool.execute(
        `DELETE FROM minio_indexed_files WHERE id IN (${placeholders})`,
        ids
      );
      deleted = ids.length;
    } else if (confirmDeleteIds.length > 0) {
      const placeholders = confirmDeleteIds.map(() => "?").join(",");
      await pool.execute(
        `DELETE FROM minio_indexed_files WHERE id IN (${placeholders}) AND connection_id = ?`,
        [...confirmDeleteIds, connectionId]
      );
      deleted = confirmDeleteIds.length;
    }

    res.json({
      ok: true,
      total: objects.length,
      inserted, updated, deleted,
      missingFiles: forceDelete || confirmDeleteIds.length > 0 ? [] : missingFiles
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List indexed files
app.get("/api/admin/minio-files", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT f.id, f.connection_id, c.name AS connection_name, f.bucket, f.object_key, f.object_name,
            f.size_bytes, f.content_type, f.keywords, f.description, f.last_modified, f.is_active, f.indexed_at
     FROM minio_indexed_files f
     JOIN data_connections c ON c.id = f.connection_id
     ORDER BY f.indexed_at DESC LIMIT 500`
  );
  res.json(rows);
});

// Update metadata (keywords, description) cho file
app.put("/api/admin/minio-files/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const keywords = String(req.body.keywords || "").trim();
  const description = String(req.body.description || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  await pool.execute(
    `UPDATE minio_indexed_files SET keywords = ?, description = ?, is_active = ? WHERE id = ?`,
    [keywords, description, isActive, id]
  );
  res.json({ ok: true });
});

// Delete (chỉ xoá khỏi index, không xoá object thật trên MinIO)
app.delete("/api/admin/minio-files/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM minio_indexed_files WHERE id = ?`, [id]);
  res.json({ ok: true });
});

// Generate presigned URL cho 1 file (dùng để test trong admin)
app.post("/api/admin/minio-files/:id/url", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const [rows] = await pool.execute(
    `SELECT f.connection_id, f.object_key FROM minio_indexed_files f WHERE f.id = ?`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const conn = await getMinioConnection(rows[0].connection_id);
  if (!conn) return res.status(404).json({ error: "MinIO connection không tồn tại." });

  try {
    const url = await minioAdapter.presignedUrl(conn.config, rows[0].object_key, 3600);
    res.json({ ok: true, url, expiresIn: 3600 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// SECTION: Match MinIO file từ câu hỏi user (gọi trong /api/chat)
// =============================================================================
async function findMinioFileFromQuestion(question) {
  if (!dbReady || !pool) return null;
  const text = normalizeVietnamese(question);

  try {
    const [rows] = await pool.execute(
      `SELECT f.id, f.connection_id, f.object_key, f.object_name, f.keywords, f.description
       FROM minio_indexed_files f
       JOIN data_connections c ON c.id = f.connection_id
       WHERE f.is_active = TRUE AND c.is_active = TRUE
       ORDER BY f.indexed_at DESC LIMIT 500`
    );
    if (!rows.length) return null;

    // Match keyword + object_name
    let best = null;
    let bestScore = 0;
    for (const f of rows) {
      const candidates = [];
      if (f.keywords) {
        candidates.push(...String(f.keywords).split("|").map(normalizeVietnamese));
      }
      if (f.object_name) candidates.push(normalizeVietnamese(f.object_name));
      if (f.description) candidates.push(normalizeVietnamese(f.description));

      const matched = candidates.filter((c) => c && text.includes(c));
      const score = matched.reduce((acc, c) => acc + c.length, 0);
      if (score > bestScore) {
        best = f;
        bestScore = score;
      }
    }
    if (!best) return null;

    // Generate presigned URL
    const conn = await getMinioConnection(best.connection_id);
    if (!conn) return null;
    const url = await minioAdapter.presignedUrl(conn.config, best.object_key, 3600);
    return {
      fileId: best.id,
      objectKey: best.object_key,
      objectName: best.object_name,
      url
    };
  } catch (err) {
    console.warn("MinIO match error:", err.message);
    return null;
  }
}


app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Generic error handler
app.use((err, req, res, next) => {
  console.error("Unhandled:", err);
  res.status(500).json({ error: "Lỗi server, vui lòng thử lại." });
});

await initDb();

const server = app.listen(PORT, () => {
  console.log(`🏥 Hospital Chatbot Studio v2 running at http://localhost:${PORT}`);
  console.log(`🛠️ Admin Studio: http://localhost:${PORT}/admin.html`);
  if (!ADMIN_TOKEN) console.warn("⚠️ ADMIN_TOKEN chưa set, admin API đang mở!");
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`Received ${signal}, đóng kết nối...`);
  server.close(async () => {
    try { await closeAllPools(); } catch {}
    if (pool) {
      pool.end().catch(() => {});
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
