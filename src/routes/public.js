// =============================================================================
// src/routes/public.js — Public APIs: /api/health, /api/dashboard, /api/feedback,
//                       /api/trusted-sources
// =============================================================================
import express from "express";
import { dbReady, pool } from "../db.js";
import { getDemoToday, getDemoTomorrow, USE_REAL_DATE } from "../config.js";
import { isAnythingLLMConfigured } from "../anythingllm.js";
import { chatLimiter } from "../middleware.js";
import { requireDb } from "../auth.js";

const router = express.Router();

router.get("/api/health", (req, res) => {
  res.json({
    ok: dbReady,
    dbReady,
    anythingLLMConfigured: isAnythingLLMConfigured(),
    demoToday: getDemoToday(),
    demoTomorrow: getDemoTomorrow(),
    useRealDate: USE_REAL_DATE,
    version: "2.0.0",
  });
});

router.get("/api/dashboard", requireDb, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, DATE_FORMAT(visit_date, '%Y-%m-%d') AS visit_date, visits FROM departments ORDER BY visits DESC",
    );
    const totalVisits = rows.reduce((sum, r) => sum + Number(r.visits || 0), 0);
    const busiest = rows[0] || null;
    res.json({
      totalVisits,
      activeDepartments: rows.length,
      emergencyVisits: rows.find((r) => r.name === "Khoa Cấp cứu")?.visits || 0,
      busiestDepartment: busiest?.name || "Chưa có dữ liệu",
      departments: rows,
    });
  } catch (error) {
    console.error("dashboard error:", error.message);
    res.status(500).json({ error: "Không lấy được dữ liệu dashboard." });
  }
});

router.post("/api/feedback", chatLimiter, requireDb, async (req, res) => {
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
      [userQuestion, botAnswer, userCorrection, feedbackType],
    );
    res.json({ ok: true, message: "Đã ghi nhận góp ý." });
  } catch (error) {
    console.error("feedback error:", error.message);
    res.status(500).json({ error: "Không lưu được góp ý." });
  }
});

// Endpoint cho user-facing: lấy danh sách nguồn để hiển thị (read-only, không cần admin)
router.get("/api/trusted-sources", async (req, res) => {
  if (!dbReady || !pool) return res.json([]);
  try {
    const [rows] = await pool.query(
      `SELECT name, url, domain, description, category, language, trust_level
       FROM trusted_sources WHERE is_active = TRUE ORDER BY trust_level DESC, name ASC LIMIT 100`,
    );
    res.json(rows);
  } catch (error) {
    console.error("trusted-sources public error:", error.message);
    res.status(500).json({ error: "Không lấy được danh sách nguồn tra cứu." });
  }
});

export default router;
