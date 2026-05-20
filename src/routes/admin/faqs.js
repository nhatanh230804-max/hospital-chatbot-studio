// =============================================================================
// src/routes/admin/faqs.js — FAQ CRUD + upload file
// =============================================================================
import express from "express";
import path from "path";
import fs from "fs";
import { pool } from "../../db.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { faqUpload, FAQ_UPLOAD_DIR } from "../../upload.js";
import {
  extractKeywordsHeuristic,
  keywordsToString,
} from "../../../lib/keyword-extractor.js";
import { parseFaqFile } from "../../faq/file-parser.js";
import { findSimilarFaqs } from "../../faq/dedupe.js";

const router = express.Router();

router.get("/api/admin/faqs", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, topic, keywords, answer, source_file, source_file_name, approved_by, is_active, created_at, updated_at
     FROM approved_medical_faq ORDER BY updated_at DESC LIMIT 200`,
  );
  res.json(rows);
});

// Upload file để TẠO FAQ mới
router.post(
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
        return res
          .status(400)
          .json({ error: "File không có nội dung text đọc được." });
      }

      if (!keywords || keywords.split("|").length < 3) {
        const enhanced = extractKeywordsHeuristic(topic, {
          source: "faq",
          additionalContext: cleanedAnswer.slice(0, 1000),
        });
        keywords = keywordsToString(enhanced);
      }

      // Dedupe check: nếu admin chưa confirm cho phép trùng → check
      const skipDedupe =
        req.body.skipDedupeCheck === "true" ||
        req.body.skipDedupeCheck === true;
      const replaceFaqId = Number(req.body.replaceFaqId || 0) || null;

      if (!skipDedupe && !replaceFaqId) {
        const dedupeResult = await findSimilarFaqs(
          { topic, keywords, answer: cleanedAnswer },
          { useAI: true },
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
              reason: d.reason,
            })),
            pendingFaq: {
              topic,
              keywords,
              answer: cleanedAnswer.slice(0, 500),
              fullLength: cleanedAnswer.length,
            },
          });
        }
      }

      if (replaceFaqId) {
        await pool.execute(
          `UPDATE approved_medical_faq SET is_active = FALSE WHERE id = ?`,
          [replaceFaqId],
        );
      }

      const [result] = await pool.execute(
        `INSERT INTO approved_medical_faq (topic, keywords, answer, source_file, source_file_name, approved_by, is_active)
         VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
        [
          topic,
          keywords,
          cleanedAnswer,
          file.filename,
          file.originalname,
          approvedBy,
        ],
      );
      res.json({
        ok: true,
        id: result.insertId,
        message: replaceFaqId
          ? "Đã thay thế FAQ cũ và tạo FAQ mới."
          : "Đã upload file và tạo FAQ.",
        preview: cleanedAnswer.slice(0, 300),
        fullLength: cleanedAnswer.length,
        autoKeywords: keywords,
        replacedFaqId: replaceFaqId,
      });
    } catch (error) {
      console.error("faq upload parse error:", error);
      fs.unlink(file.path, () => {});
      res.status(500).json({ error: "Lỗi đọc file: " + error.message });
    }
  },
);

// Update FAQ (text edit, không bắt buộc upload lại file)
router.put("/api/admin/faqs/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const topic = String(req.body.topic || "").trim();
  const keywords = String(req.body.keywords || "").trim();
  const answer = String(req.body.answer || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  if (!id || !topic || !keywords || !answer)
    return res.status(400).json({ error: "Thiếu thông tin." });
  await pool.execute(
    `UPDATE approved_medical_faq SET topic = ?, keywords = ?, answer = ?, is_active = ? WHERE id = ?`,
    [topic, keywords, answer, isActive, id],
  );
  res.json({ ok: true });
});

router.delete(
  "/api/admin/faqs/:id",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });

    // Xóa luôn cả file đã upload (nếu có)
    try {
      const [rows] = await pool.execute(
        `SELECT source_file FROM approved_medical_faq WHERE id = ?`,
        [id],
      );
      if (rows[0]?.source_file) {
        const filePath = path.join(FAQ_UPLOAD_DIR, rows[0].source_file);
        fs.unlink(filePath, () => {}); // best-effort
      }
    } catch {}

    await pool.execute(`DELETE FROM approved_medical_faq WHERE id = ?`, [id]);
    res.json({ ok: true });
  },
);

export default router;
