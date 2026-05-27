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
} from "../session/conversation.js";
import { classifyFollowUp } from "../session/follow-up-classifier.js";

const router = express.Router();

function isNonDatabaseSqlMiss(sqlResult) {
  const reply = normalizeVietnamese(sqlResult?.reply || "");
  return (
    reply.includes("khong lien quan database") ||
    reply.includes("khong lien quan den database") ||
    reply.includes("khong lien quan du lieu") ||
    reply.includes("khong phai cau hoi du lieu")
  );
}

async function processChatMessage(req, message, emit = async () => {}, options = {}) {
  const startedAt = Date.now();
  const sessionId = getSessionId(req);
  const sHash = sessionHash(sessionId);
  const signal = options.signal;
  const streamAnswerOptions = options.stream
    ? {
        stream: true,
        onToken: async (text) => {
          if (!text) return;
          if (options.streamState) options.streamState.sent = true;
          await emit("token", { text });
        },
      }
    : {};
  const isCanceled = () => signal?.aborted || options.isClosed?.();
  const throwIfCanceled = () => {
    if (isCanceled()) {
      const error = new Error("chat request canceled");
      error.code = "REQUEST_CANCELED";
      throw error;
    }
  };

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
    return payload;
  }

  try {
    throwIfCanceled();
    await emit("status", { message: "Đang tải ngữ cảnh hội thoại..." });
    // Nạp hội thoại của phiên này (rỗng nếu phiên mới / đã hết hạn 5 phút)
    const conv = await loadConversation(sessionId);
    const followUpInfo = await classifyFollowUp(message, conv, { signal });
    const followUp = followUpInfo.isFollowUp && !!conv.lastRoute;
    const effectiveMessage = followUp
      ? followUpInfo.rewrittenQuestion || message
      : message;
    const followUpRoute = followUpInfo.routeHint || conv.lastRoute;

    // =========================================================================
    // FOLLOW-UP: câu hỏi nối tiếp — trả lời bám theo route của lượt trước
    // =========================================================================
    if (followUp) {
      await emit("status", { message: "Đang xử lý câu hỏi nối tiếp..." });
      // Follow-up cho câu hỏi dữ liệu (SQL) — answerWithSql đã hỗ trợ context
      if (followUpRoute === "nl2sql" || followUpRoute === "sql-template") {
        try {
          await emit("status", {
            message: "Đang truy vấn dữ liệu theo ngữ cảnh trước...",
          });
          throwIfCanceled();
          const sqlResult = await answerWithSql(message, conv.sqlContext, {
            signal,
            ...streamAnswerOptions,
          });
          throwIfCanceled();
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
              {
                aiSql: sqlResult.originalSql,
                finalSql: sqlResult.sql,
                followUpMethod: followUpInfo.method,
                followUpConfidence: followUpInfo.confidence,
              },
            );
          }
          // SQL follow-up không ra kết quả → rơi xuống trả lời bằng LLM
        } catch (error) {
          console.warn("SQL follow-up lỗi:", error.message);
        }
      }
      if (followUpRoute === "research") {
        await emit("status", {
          message: "Đang tra cứu tiếp theo ngữ cảnh trước...",
        });
        throwIfCanceled();
        const r = await handleResearchMode(effectiveMessage, {
          signal,
          skipCache: true,
          ...streamAnswerOptions,
        });
        throwIfCanceled();
        if (r && r.source !== "research-error") {
          return finish("research", { ...r, followUp: true }, conv, {
            followUpMethod: followUpInfo.method,
            followUpConfidence: followUpInfo.confidence,
          });
        }
        const fb = await answerWithFallbackChat(effectiveMessage, {
          signal,
          ...streamAnswerOptions,
        });
        throwIfCanceled();
        return finish("followup-chat", { ...fb, followUp: true }, conv, {
          followUpMethod: followUpInfo.method,
          followUpConfidence: followUpInfo.confidence,
          researchFallbackReason: r?.source || "no-research-result",
        });
      }
      // Mọi follow-up khác (fallback / faq / bhyt...) → LLM với
      // effectiveMessage (đã chứa Q&A lượt trước)
      await emit("status", { message: "Đang tổng hợp câu trả lời..." });
      throwIfCanceled();
      const fb = await answerWithFallbackChat(effectiveMessage, {
        signal,
        ...streamAnswerOptions,
      });
      throwIfCanceled();
      return finish("followup-chat", { ...fb, followUp: true }, conv, {
        followUpMethod: followUpInfo.method,
        followUpConfidence: followUpInfo.confidence,
      });
    }

    // =========================================================================
    // LUỒNG BÌNH THƯỜNG — câu hỏi mới
    // =========================================================================

    // 1. File request — check chatbot_documents local trước
    await emit("status", { message: "Đang phân loại câu hỏi..." });
    throwIfCanceled();
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
      await emit("status", { message: "Đang tìm tài liệu phù hợp..." });
      throwIfCanceled();
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
    await emit("status", { message: "Đang kiểm tra FAQ đã duyệt..." });
    throwIfCanceled();
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
    await emit("status", { message: "Đang kiểm tra dữ liệu bệnh viện..." });
    const goToSql = isDataQ && (!isHealthQ || hasDataSignal);

    if (goToSql) {
      try {
        await emit("status", {
          message: "Đang tạo và kiểm tra truy vấn an toàn...",
        });
        throwIfCanceled();
        const sqlResult = await answerWithSql(message, conv.sqlContext, {
          signal,
          ...streamAnswerOptions,
        });
        throwIfCanceled();

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

        if (!isNonDatabaseSqlMiss(sqlResult)) {
          return finish(
            "nl2sql-error",
            { source: "ai-generated-sql", reply: sqlResult.reply },
            conv,
          );
        }
      } catch (error) {
        await logChat({
          userMessage: message,
          routeName: "nl2sql-exception",
          errorMessage: error.message,
          latencyMs: Date.now() - startedAt,
          sessionHash: sHash,
        });
        return {
          source: "ai-generated-sql-error",
          reply: "Mình chưa truy vấn được dữ liệu bệnh viện cho câu hỏi này.",
        };
      }
    }

    // 6. Research mode (wellness)
    if (await shouldUseResearchAgent(message)) {
      await emit("status", {
        message: "Đang tra cứu nguồn sức khỏe được duyệt...",
      });
      throwIfCanceled();
      const r = await handleResearchMode(message, {
        signal,
        skipCache: Boolean(streamAnswerOptions.stream),
        ...streamAnswerOptions,
      });
      throwIfCanceled();
      if (r) {
        return finish("research", r, conv);
      }
    }

    // 7. Fallback chat — cũng dùng trusted_sources whitelist
    await emit("status", { message: "Đang tổng hợp câu trả lời..." });
    throwIfCanceled();
    const fb = await answerWithFallbackChat(message, {
      signal,
      ...streamAnswerOptions,
    });
    throwIfCanceled();
    return finish("fallback", fb, conv);
  } catch (error) {
    if (error.code === "REQUEST_CANCELED" || signal?.aborted) {
      return { statusCode: 499, error: "Request da bi huy." };
    }
    console.error("/api/chat error:", error);
    await logChat({
      userMessage: message,
      routeName: "chat-error",
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
      sessionHash: sHash,
    });
    return { statusCode: 500, error: "Lỗi xử lý chatbot." };
  }
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStreamNumberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

async function streamReplyText(res, text, isClosed) {
  const value = String(text || "");
  const chunkSize = getStreamNumberEnv("CHAT_STREAM_CHUNK_SIZE", 14, 4, 80);
  const delayMs = getStreamNumberEnv("CHAT_STREAM_DELAY_MS", 45, 0, 500);
  const chunks =
    value.match(new RegExp(`.{1,${chunkSize}}(\\s|$)|\\S+`, "g")) || [value];
  for (const chunk of chunks) {
    if (isClosed()) return;
    writeSse(res, "token", { text: chunk });
    if (delayMs > 0) await sleep(delayMs);
  }
}

router.post("/api/chat", chatLimiter, async (req, res) => {
  const message = String(req.body.message || "").trim();
  if (!message)
    return res.status(400).json({ error: "Thiếu nội dung câu hỏi." });

  const payload = await processChatMessage(req, message);
  const statusCode = payload.statusCode || 200;
  delete payload.statusCode;
  return res.status(statusCode).json(payload);
});

router.post("/api/chat/stream", chatLimiter, async (req, res) => {
  const message = String(req.body.message || "").trim();

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  let completed = false;
  const abortController = new AbortController();
  res.on("close", () => {
    closed = true;
    if (!completed) abortController.abort("client disconnected");
  });

  const isClosed = () => closed || res.destroyed || res.writableEnded;
  const emit = async (event, data) => {
    if (!isClosed()) writeSse(res, event, data);
  };
  const streamState = { sent: false };
  let heartbeat = null;

  try {
    if (!message) {
      await emit("error", { error: "Thiếu nội dung câu hỏi." });
      return res.end();
    }

    await emit("status", { message: "Đã nhận câu hỏi..." });
    const heartbeatMessages = [
      "Dang cho AI bat dau tra loi...",
      "Dang tron ngu canh va nguon tham khao...",
      "Dang doi token dau tien tu AI...",
    ];
    let heartbeatIndex = 0;
    heartbeat = setInterval(() => {
      if (completed || isClosed() || streamState.sent) return;
      writeSse(res, "status", {
        message: heartbeatMessages[heartbeatIndex % heartbeatMessages.length],
        waitingForFirstToken: true,
      });
      heartbeatIndex += 1;
    }, 5000);
    const payload = await processChatMessage(req, message, emit, {
      signal: abortController.signal,
      isClosed,
      stream: true,
      streamState,
    });
    const statusCode = payload.statusCode || 200;
    delete payload.statusCode;

    if (statusCode >= 400 || payload.error) {
      if (heartbeat) clearInterval(heartbeat);
      if (statusCode === 499 || isClosed()) return res.end();
      await emit("error", payload);
      return res.end();
    }

    await emit("status", { message: "Đang hiển thị câu trả lời..." });
    if (!streamState.sent) {
      await streamReplyText(res, payload.reply || "", isClosed);
    }
    await emit("done", payload);
    completed = true;
    if (heartbeat) clearInterval(heartbeat);
    return res.end();
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    if (isClosed() || abortController.signal.aborted) return res.end();
    console.error("/api/chat/stream error:", error);
    await emit("error", { error: "Lỗi xử lý chatbot stream." });
    completed = true;
    return res.end();
  }
});

export default router;
