// =============================================================================
// src/routes/admin/summary.js — /api/admin/studio/summary
// =============================================================================
import express from "express";
import { dbReady, pool } from "../../db.js";
import { getDemoToday, getDemoTomorrow } from "../../config.js";
import { isAnythingLLMConfigured } from "../../anythingllm.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { asyncHandler } from "../../middleware.js";

const router = express.Router();

router.get(
  "/api/admin/studio/summary",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    try {
      const [[feedbackPending]] = await pool.query(
        "SELECT COUNT(*) AS total FROM chat_feedback WHERE status = 'pending'",
      );
      const [[faqTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM approved_medical_faq WHERE is_active = TRUE",
      );
      const [[schemaTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM schema_metadata WHERE is_active = TRUE",
      );
      const [[cacheTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM research_answer_cache WHERE expires_at > NOW()",
      );
      const [[templateTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM sql_templates WHERE is_active = TRUE",
      );
      const [[sourceTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM trusted_sources WHERE is_active = TRUE",
      );
      const [[connectionTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM data_connections WHERE is_active = TRUE",
      );
      const [[minioFileTotal]] = await pool.query(
        "SELECT COUNT(*) AS total FROM minio_indexed_files WHERE is_active = TRUE",
      );

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
        minioFileTotal: minioFileTotal.total,
      });
    } catch (error) {
      console.error("admin summary error:", error.message);
      res.status(500).json({ error: "Không lấy được tổng quan." });
    }
  }),
);

export default router;
