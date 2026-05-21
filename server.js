// =============================================================================
// Hospital Chatbot Studio v2 - server.js (bootstrap)
// =============================================================================
// -----------------------------------------------------------------------------
// File này chỉ làm 4 việc:
//   1. Wire middleware (helmet, cors, json, static)
//   2. Mount routers (public + chat + admin)
//   3. initDb() + listen()
//   4. Graceful shutdown
//
// Toàn bộ business logic đã tách sang thư mục src/ — xem cấu trúc:
//   src/config.js          — env + demo dates
//   src/db.js              — main MySQL pool + initDb
//   src/middleware.js      — helmet, cors, rate limiters
//   src/upload.js          — multer FAQ upload
//   src/auth.js            — requireDb, requireAdmin
//   src/utils.js           — text/json/url helpers
//   src/anythingllm.js     — AnythingLLM client
//   src/chat-log.js        — chat_logs writer
//   src/sql/*              — validator, summarizer, templates, runner, nl2sql, memory
//   src/router/*           — routing helpers (documents, medical-safety, faq,
//                            data-question, health-question, research, trusted-sources)
//   src/faq/*              — dedupe + file parser
//   src/connections/*      — encryption + minio
//   src/routes/*           — express routers (public, chat, admin/*)
// File backup nguyên bản: server.js.backup
// =============================================================================
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { PORT, ADMIN_TOKEN } from "./src/config.js";
import { initDb, pool } from "./src/db.js";
import { closeAllPools } from "./lib/connection-manager.js";
import { helmetMiddleware, corsMiddleware } from "./src/middleware.js";

import publicRouter from "./src/routes/public.js";
import chatRouter from "./src/routes/chat.js";
import adminRouter from "./src/routes/admin/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// -----------------------------------------------------------------------------
// Base middleware
// -----------------------------------------------------------------------------
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------------------------------------------------------
// Routers
// -----------------------------------------------------------------------------
app.use(publicRouter);
app.use(chatRouter);
app.use(adminRouter);

// -----------------------------------------------------------------------------
// SPA fallback + generic error handler
// -----------------------------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("Unhandled:", err);
  res.status(500).json({ error: "Lỗi server, vui lòng thử lại." });
});

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------
await initDb();

const server = app.listen(PORT, () => {
  console.log(
    `🏥 Hospital Chatbot Studio v2 running at http://localhost:${PORT}`,
  );
  console.log(`🛠️ Admin Studio: http://localhost:${PORT}/admin.html`);
  if (!ADMIN_TOKEN) console.warn("⚠️ ADMIN_TOKEN chưa set, admin API đang mở!");
});

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`Received ${signal}, đóng kết nối...`);
  server.close(async () => {
    try {
      await closeAllPools();
    } catch {}
    if (pool) {
      pool.end().catch(() => {});
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
