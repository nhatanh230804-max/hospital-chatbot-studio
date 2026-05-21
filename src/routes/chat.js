// =============================================================================
// src/routes/chat.js — /api/chat (router chính)
// =============================================================================
// Có hỗ trợ hội thoại nhiều lượt:
//   - Mỗi request mang sessionId riêng (frontend tạo, theo từng tab).
//   - Nạp conversation từ session store (Redis / in-memory) theo sessionId.
//   - Phát hiện câu hỏi follow-up ("chi tiết hơn", "nói rõ hơn"...) → ghép
//     ngữ cảnh lượt trước (effectiveMessage) và trả lời nối tiếp đúng route.
//   - Lưu lại conversation sau mỗi lượt; mọi context tách riêng theo sessionId
//     nên không lẫn giữa các user.
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
import { answerWithSql } from "../sql/nl2sql.js";
import {
  getSessionId,
  sessionHash,
  loadConversation,
  saveConversation,
  isFollowUp,
  buildEffectiveMessage,
} from "../session/conversation.js";

const router = express.Router();

router.post("/api/chat", chatLimiter, async (req, res) => {
  const startedAt = Date.now();
  const message = String(req.body.message || "").trim();
  if (!message)
    return res.status(400).json({ error: "Thiếu nội dung câu hỏi." });

  const sessionId = getSessionId(req);
  const sHash = sessionHash(sessionId);

  // Helper: lưu hội thoại + ghi log + trả response (gom 1 chỗ cho mọi route)
  async function finish(routeName, payload, conv, logExtra = {}) {
    conv.lastQuestion = message;
    conv.lastAnswer = String(payload.reply || "");
    conv.lastRoute = routeName;
    conv.history = Array.isArray(conv.history) ? conv.history : [];
    conv.history.push({
      q: message,
      a: conv.lastAnswer,
      route: routeName,
      ts: Date.now(),
    });
    await saveConversation(sessionId, conv);
    await logChat({
      userMessage: message,
      routeName,
      botReply: payload.reply,
      source: payload.source,
      latencyMs: Date.now() - startedAt,
      sessionHash: sHash,
      ...logExtra,
    });
    return res.json(payload);
  }

  try {
    // Nạp hội thoại của phiên này (rỗng nếu phiên mới / đã hết hạn 5 phút)
    const conv = await loadConversation(sessionId);
    const followUp = isFollowUp(message) && !!conv.lastRoute;
    const effectiveMessage = followUp
      ? buildEffectiveMessage(message, conv)
      : message;

    // =========================================================================
    // FOLLOW-UP: câu hỏi nối tiếp — trả lời bám theo route của lượt trước
    // =========================================================================
    if (followUp) {
      // Follow-up cho câu hỏi dữ liệu (SQL) — answerWithSql đã hỗ trợ context
      if (conv.lastRoute === "nl2sql" || conv.lastRoute === "sql-template") {
        try {
          const sqlResult = await answerWithSql(message, conv.sqlContext);
          if (sqlResult.ok) {
            conv.sqlContext = {
              question: message,
              sql: sqlResult.sql,
              rows: sqlResult.rows,
            };
            const isDebug = process.env.DEBUG_SQL === "true";
            const payload = {
              source: sqlResult.viaTemplate
                ? "sql-template"
                : "ai-generated-sql",
              reply: sqlResult.reply,
              followUp: true,
              ...(isDebug
                ? {
                    sql: sqlResult.sql,
                    rows: sqlResult.rows,
                    originalSql: sqlResult.originalSql,
                  }
                : {}),
            };
            return finish(
              sqlResult.viaTemplate ? "sql-template" : "nl2sql",
              payload,
              conv,
              { aiSql: sqlResult.originalSql, finalSql: sqlResult.sql },
            );
          }
          // SQL follow-up không ra kết quả → rơi xuống trả lời bằng LLM
        } catch (error) {
          console.warn("SQL follow-up lỗi:", error.message);
        }
      }
      // Mọi follow-up khác (research / fallback / faq / bhyt...) → LLM với
      // effectiveMessage (đã chứa Q&A lượt trước)
      const fb = await answerWithFallbackChat(effectiveMessage);
      return finish("followup-chat", { ...fb, followUp: true }, conv);
    }

    // =========================================================================
    // LUỒNG BÌNH THƯỜNG — câu hỏi mới
    // =========================================================================

    // 1. File request — check chatbot_documents local trước
    const fileResult = await handleFileRequest(message);
    if (fileResult) {
      return finish("document", fileResult, conv);
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
        return finish("minio-file", payload, conv);
      }
    }

    // 2. Urgent medical safety
    const urgent = handleUrgentMedicalQuestion(message);
    if (urgent) {
      return finish("medical-safety", urgent, conv);
    }

    // 2b. Malicious intent (SQL injection, xoá data, lệnh hệ thống)
    if (isMaliciousIntent(message)) {
      const payload = {
        source: "intent-blocked",
        reply:
          "Xin lỗi, mình không hỗ trợ thao tác này. Mình chỉ giúp tra cứu thông tin bệnh viện và sức khỏe.",
      };
      return finish("intent-blocked", payload, conv);
    }

    // 3. Approved FAQ
    const faq = await findApprovedMedicalFaq(message);
    if (faq) {
      const payload = {
        source: "approved-medical-faq",
        faqId: faq.id,
        reply: faq.answer,
      };
      return finish("faq", payload, conv);
    }

    // 4. BHYT
    const bhyt = handleBHYTQuestion(message);
    if (bhyt) {
      return finish("bhyt", bhyt, conv);
    }

    // 5. SQL data question
    // Logic: nếu câu hỏi VỪA match health pattern VỪA match data keyword
    // → ưu tiên Research (vì có thể cache data lệch do trích từ description)
    // Chỉ vào SQL khi: có signal data rõ HOẶC match data nhưng không phải health
    const isDataQ = await isHospitalDataQuestion(message);
    const isHealthQ = isHealthOrWellnessQuestion(message);
    const hasDataSignal = hasStrongDataSignal(message);

    // Nếu là câu y tế thuần (không có signal data) → skip SQL, đi Research
    const goToSql = isDataQ && (!isHealthQ || hasDataSignal);

    if (goToSql) {
      try {
        const sqlResult = await answerWithSql(message, conv.sqlContext);

        if (sqlResult.ok) {
          conv.sqlContext = {
            question: message,
            sql: sqlResult.sql,
            rows: sqlResult.rows,
          };
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
          return finish(
            sqlResult.viaTemplate ? "sql-template" : "nl2sql",
            payload,
            conv,
            { aiSql: sqlResult.originalSql, finalSql: sqlResult.sql },
          );
        }

        return finish(
          "nl2sql-error",
          { source: "ai-generated-sql", reply: sqlResult.reply },
          conv,
        );
      } catch (error) {
        await logChat({
          userMessage: message,
          routeName: "nl2sql-exception",
          errorMessage: error.message,
          latencyMs: Date.now() - startedAt,
          sessionHash: sHash,
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
        return finish("research", r, conv);
      }
    }

    // 7. Fallback chat — cũng dùng trusted_sources whitelist
    const fb = await answerWithFallbackChat(message);
    return finish("fallback", fb, conv);
  } catch (error) {
    console.error("/api/chat error:", error);
    await logChat({
      userMessage: message,
      routeName: "chat-error",
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
      sessionHash: sHash,
    });
    return res.status(500).json({ error: "Lỗi xử lý chatbot." });
  }
});

export default router;
