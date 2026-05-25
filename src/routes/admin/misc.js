// =============================================================================
// src/routes/admin/misc.js — SQL Playground, Research Cache, Logs
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { asyncHandler } from "../../middleware.js";
import { answerWithSql } from "../../sql/nl2sql.js";

const router = express.Router();

// -----------------------------------------------------------------------------
// SQL PLAYGROUND
// -----------------------------------------------------------------------------
router.post(
  "/api/admin/sql-playground",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
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
        viaTemplate: result.viaTemplate || false,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  }),
);

// -----------------------------------------------------------------------------
// RESEARCH CACHE
// -----------------------------------------------------------------------------
router.get(
  "/api/admin/research-cache",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, normalized_question, original_question, source, expires_at, created_at, updated_at
     FROM research_answer_cache ORDER BY updated_at DESC LIMIT 200`,
    );
    res.json(rows);
  }),
);

router.delete(
  "/api/admin/research-cache/:id",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });
    await pool.execute(`DELETE FROM research_answer_cache WHERE id = ?`, [id]);
    res.json({ ok: true });
  }),
);

// -----------------------------------------------------------------------------
// LOGS
// -----------------------------------------------------------------------------
router.get("/api/admin/logs", requireAdmin, requireDb, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, user_message, route_name, ai_sql, final_sql, source, latency_ms, error_message, created_at
     FROM chat_logs ORDER BY created_at DESC LIMIT 200`,
  );
  res.json(rows);
}));

export default router;
