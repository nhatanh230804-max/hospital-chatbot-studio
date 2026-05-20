// =============================================================================
// src/routes/admin/feedback.js — Feedback CRUD + approve to FAQ
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { requireAdmin, requireDb } from "../../auth.js";

const router = express.Router();

router.get("/api/admin/feedback", requireAdmin, requireDb, async (req, res) => {
  const status = String(req.query.status || "pending");
  const [rows] = await pool.execute(
    `SELECT id, user_question, bot_answer, user_correction, feedback_type, status, created_at
     FROM chat_feedback WHERE status = ? ORDER BY created_at DESC LIMIT 100`,
    [status],
  );
  res.json(rows);
});

router.post(
  "/api/admin/feedback/:id/approve",
  requireAdmin,
  requireDb,
  async (req, res) => {
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
      [topic, keywords, answer, approvedBy],
    );
    await pool.execute(
      `UPDATE chat_feedback SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [approvedBy, id],
    );
    res.json({ ok: true, message: "Đã duyệt feedback và thêm vào FAQ." });
  },
);

router.post(
  "/api/admin/feedback/:id/reject",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    const by = String(req.body.reviewedBy || "admin").trim();
    if (!id) return res.status(400).json({ error: "Thiếu id." });
    await pool.execute(
      `UPDATE chat_feedback SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [by, id],
    );
    res.json({ ok: true });
  },
);

export default router;
