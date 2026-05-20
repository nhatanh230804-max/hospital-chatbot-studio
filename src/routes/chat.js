// =============================================================================
// src/routes/chat.js — /api/chat (router chính)
// =============================================================================
import express from "express";
import { normalizeVietnamese } from "../utils.js";
import { chatLimiter } from "../middleware.js";
import { logChat } from "../chat-log.js";
import { handleFileRequest } from "../router/documents.js";
import { findMinioFileFromQuestion } from "../connections/minio.js";
import {
  handleUrgentMedicalQuestion,
  handleBHYTQuestion,
  isMaliciousIntent,
} from "../router/medical-safety.js";
import { findApprovedMedicalFaq } from "../router/faq.js";
import {
  isHospitalDataQuestion,
  hasStrongDataSignal,
} from "../router/data-question.js";
import {
  isHealthOrWellnessQuestion,
  shouldUseResearchAgent,
} from "../router/health-question.js";
import {
  handleResearchMode,
  answerWithFallbackChat,
} from "../router/research.js";
import {
  getSqlSessionId,
  getSqlContext,
  saveSqlContext,
} from "../sql/memory.js";
import { answerWithSql } from "../sql/nl2sql.js";

const router = express.Router();

router.post("/api/chat", chatLimiter, async (req, res) => {
  const startedAt = Date.now();
  const message = String(req.body.message || "").trim();
  if (!message)
    return res.status(400).json({ error: "Thiếu nội dung câu hỏi." });

  try {
    // 1. File request — check chatbot_documents local trước
    const fileResult = await handleFileRequest(message);
    if (fileResult) {
      await logChat({
        userMessage: message,
        routeName: "document",
        botReply: fileResult.reply,
        source: fileResult.source,
        latencyMs: Date.now() - startedAt,
      });
      return res.json(fileResult);
    }

    // 1b. File request — check MinIO indexed files
    const textForFile = normalizeVietnamese(message);
    const hasFileKeyword = [
      "minio",
      "file",
      "tai lieu",
      "tai ve",
      "download",
      "tai xuong",
    ].some((kw) => textForFile.includes(kw));
    const hasDocumentRequest =
      /(cho|gui|dua)\s+(toi|minh|em).*(file|tai lieu|bang|danh sach|hop dong|giay|don|bao cao)/.test(
        textForFile,
      );
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
            `_(Link có hiệu lực 1 giờ.)_`,
          ].join("\n"),
        };
        await logChat({
          userMessage: message,
          routeName: "minio-file",
          botReply: payload.reply,
          source: payload.source,
          latencyMs: Date.now() - startedAt,
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
        latencyMs: Date.now() - startedAt,
      });
      return res.json(urgent);
    }

    // 2b. Malicious intent (SQL injection, xoá data, lệnh hệ thống)
    if (isMaliciousIntent(message)) {
      const payload = {
        source: "intent-blocked",
        reply:
          "Xin lỗi, mình không hỗ trợ thao tác này. Mình chỉ giúp tra cứu thông tin bệnh viện và sức khỏe.",
      };
      await logChat({
        userMessage: message,
        routeName: "intent-blocked",
        botReply: payload.reply,
        source: payload.source,
        latencyMs: Date.now() - startedAt,
      });
      return res.json(payload);
    }

    // 3. Approved FAQ
    const faq = await findApprovedMedicalFaq(message);
    if (faq) {
      const payload = {
        source: "approved-medical-faq",
        faqId: faq.id,
        reply: faq.answer,
      };
      await logChat({
        userMessage: message,
        routeName: "faq",
        botReply: payload.reply,
        source: payload.source,
        latencyMs: Date.now() - startedAt,
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
        latencyMs: Date.now() - startedAt,
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
          saveSqlContext(sessionId, {
            question: message,
            sql: sqlResult.sql,
            rows: sqlResult.rows,
          });
          const isDebug = process.env.DEBUG_SQL === "true";
          const payload = {
            source: sqlResult.viaTemplate ? "sql-template" : "ai-generated-sql",
            reply: sqlResult.reply,
            ...(isDebug
              ? {
                  sql: sqlResult.sql,
                  rows: sqlResult.rows,
                  originalSql: sqlResult.originalSql,
                }
              : {}),
          };
          await logChat({
            userMessage: message,
            routeName: sqlResult.viaTemplate ? "sql-template" : "nl2sql",
            aiSql: sqlResult.originalSql,
            finalSql: sqlResult.sql,
            botReply: sqlResult.reply,
            source: payload.source,
            latencyMs: Date.now() - startedAt,
          });
          return res.json(payload);
        }

        await logChat({
          userMessage: message,
          routeName: "nl2sql-error",
          botReply: sqlResult.reply,
          source: "ai-generated-sql",
          latencyMs: Date.now() - startedAt,
        });
        return res.json({ source: "ai-generated-sql", reply: sqlResult.reply });
      } catch (error) {
        await logChat({
          userMessage: message,
          routeName: "nl2sql-exception",
          errorMessage: error.message,
          latencyMs: Date.now() - startedAt,
        });
        return res.json({
          source: "ai-generated-sql-error",
          reply: "Mình chưa truy vấn được dữ liệu bệnh viện cho câu hỏi này.",
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
          latencyMs: Date.now() - startedAt,
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
      latencyMs: Date.now() - startedAt,
    });
    return res.json(fb);
  } catch (error) {
    console.error("/api/chat error:", error);
    await logChat({
      userMessage: message,
      routeName: "chat-error",
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
    });
    return res.status(500).json({ error: "Lỗi xử lý chatbot." });
  }
});

export default router;
