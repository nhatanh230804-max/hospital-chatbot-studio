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
  errorMessage = null,
  sessionHash = null,
}) {
  // Structured console log — luôn chạy, không cần migration DB.
  // Giúp debug: phiên nào, route nào, nguồn nào, mất bao lâu, có lỗi không.
  console.log(
    `[chat] session=${sessionHash || "-"} route=${routeName || "-"} ` +
      `source=${source || "-"} latency=${latencyMs == null ? "-" : latencyMs + "ms"}` +
      (errorMessage ? ` error="${errorMessage}"` : ""),
  );

  if (!dbReady || !pool) return;
  try {
    await pool.execute(
      `INSERT INTO chat_logs (user_message, route_name, ai_sql, final_sql, bot_reply, source, latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userMessage,
        routeName,
        aiSql,
        finalSql,
        botReply,
        source,
        latencyMs,
        errorMessage,
      ],
    );
  } catch (error) {
    console.warn("Không lưu được chat log:", error.message);
  }
}
