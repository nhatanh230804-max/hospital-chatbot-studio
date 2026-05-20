// =============================================================================
// src/sql/memory.js — SQL conversation memory (in-memory + periodic sweep)
// =============================================================================
import crypto from "crypto";

const sqlConversationMemory = new Map();
const SQL_CONTEXT_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sqlConversationMemory.entries()) {
    if (now - value.savedAt > SQL_CONTEXT_TTL_MS) sqlConversationMemory.delete(key);
  }
}, 60 * 1000).unref();

export function getSqlSessionId(req) {
  // Ưu tiên sessionId từ body. Nếu không có thì kết hợp IP + UA để
  // tránh trường hợp nhiều user chung NAT lẫn context.
  if (req.body && req.body.sessionId) return String(req.body.sessionId);
  const ua = req.get("user-agent") || "no-ua";
  return crypto.createHash("sha1").update(`${req.ip}::${ua}`).digest("hex");
}

export function saveSqlContext(sessionId, context) {
  sqlConversationMemory.set(sessionId, { ...context, savedAt: Date.now() });
}

export function getSqlContext(sessionId) {
  const context = sqlConversationMemory.get(sessionId);
  if (!context) return null;
  if (Date.now() - context.savedAt > SQL_CONTEXT_TTL_MS) {
    sqlConversationMemory.delete(sessionId);
    return null;
  }
  return context;
}
