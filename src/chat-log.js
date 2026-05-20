// =============================================================================
// src/chat-log.js — Persist chat logs to MySQL (best-effort)
// =============================================================================
import { dbReady, pool } from "./db.js";

export async function logChat({
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
