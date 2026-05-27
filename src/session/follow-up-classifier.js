// =============================================================================
// src/session/follow-up-classifier.js
// =============================================================================
// AI-assisted follow-up detector. Rule-based isFollowUp() remains the cheap
// fast path; this module catches natural follow-up wording that was not listed.
// =============================================================================
import { callAnythingLLM, isAnythingLLMConfigured } from "../anythingllm.js";
import { normalizeVietnamese, safeJsonParse } from "../utils.js";
import { buildEffectiveMessage, isFollowUp } from "./conversation.js";

function extractJsonObject(text) {
  const value = String(text || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};
  return safeJsonParse(value.slice(start, end + 1), {});
}

function likelyStandaloneQuestion(message) {
  const text = normalizeVietnamese(message);
  if (!text) return false;
  if (/\b(dau hieu|trieu chung)\s+(cua|benh|bi|nhiem)\s+\S+/i.test(text)) {
    return true;
  }
  if (/\b(lam sao|cach nao|khi nao)\s+.*\b(biet|nhan biet|kiem tra)\b/i.test(text)) {
    return true;
  }
  const hasTopic =
    /\b(trieu chung|dau hieu|benh|khoa|bac si|dieu duong|lich truc|bao nhieu|tong|danh sach|quy trinh|bhyt|file|tai lieu)\b/.test(
      text,
    );
  const hasNewTopicMarker =
    /\b(la gi|o dau|khi nao|hom nay|ngay mai|cua ai|cua khoa|ve)\b/.test(text);
  return hasTopic && hasNewTopicMarker;
}

function likelyConversationClose(message) {
  const text = normalizeVietnamese(message);
  return /^(ok|oke|cam on|thanks|thank you|khong|khong can|tam biet|bye|chao)$/.test(
    text,
  );
}

function likelyContextDependentShortQuestion(message) {
  const text = normalizeVietnamese(message);
  if (!text || likelyConversationClose(text) || likelyStandaloneQuestion(text)) {
    return false;
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount > 1 && wordCount <= 12;
}

function normalizeRouteHint(value, fallback) {
  const route = String(value || "").trim().toLowerCase();
  if (["research", "nl2sql", "sql-template", "fallback", "faq", "bhyt"].includes(route)) {
    return route;
  }
  return fallback || "";
}

function isWeakRewrite(value) {
  const text = normalizeVietnamese(value);
  return (
    !text ||
    text.length < 12 ||
    text.startsWith("ban muon") ||
    text.startsWith("co phai") ||
    text.startsWith("ban dang")
  );
}

export async function classifyFollowUp(message, conv, options = {}) {
  const hasContext = conv?.lastQuestion && conv?.lastAnswer && conv?.lastRoute;
  if (!hasContext) {
    return {
      isFollowUp: false,
      confidence: 0,
      routeHint: "",
      rewrittenQuestion: message,
      method: "no-context",
    };
  }

  if (isFollowUp(message)) {
    return {
      isFollowUp: true,
      confidence: 1,
      routeHint: conv.lastRoute,
      rewrittenQuestion: buildEffectiveMessage(message, conv),
      method: "rules",
    };
  }

  if (likelyStandaloneQuestion(message) || !isAnythingLLMConfigured()) {
    return {
      isFollowUp: false,
      confidence: 0,
      routeHint: "",
      rewrittenQuestion: message,
      method: "standalone-heuristic",
    };
  }

  const prompt = `
Ban la bo phan loai cau hoi noi tiep trong chatbot benh vien.

Tra ve DUY NHAT JSON hop le:
{
  "isFollowUp": true|false,
  "confidence": 0.0-1.0,
  "routeHint": "research|nl2sql|sql-template|fallback|faq|bhyt",
  "rewrittenQuestion": "cau hoi doc lap bang tieng Viet",
  "reason": "ngan gon"
}

Quy tac:
- isFollowUp=true neu cau hien tai phu thuoc vao cau hoi/cau tra loi truoc.
- Neu user hoi "noi ro hon", "nhieu thong tin hon", "vay can luu y gi", "co nguy hiem khong", "phong tranh the nao" thi thuong la follow-up.
- Neu cau hien tai da co chu de moi ro rang, isFollowUp=false.
- rewrittenQuestion phai la cau hoi doc lap, bo sung chu de tu luot truoc neu la follow-up.
- rewrittenQuestion phai la cau can duoc tra loi, KHONG hoi nguoc lai user.
- Khong tra loi noi dung y khoa. Chi phan loai.

Route truoc: ${conv.lastRoute}
Cau hoi truoc: ${conv.lastQuestion}
Cau tra loi truoc:
${String(conv.lastAnswer || "").slice(0, 900)}

Cau hien tai: ${message}
`.trim();

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `hospital-followup-classifier-${Date.now()}`,
      timeoutMs: 25000,
      signal: options.signal,
    });
    const parsed = extractJsonObject(text);
    const confidence = Math.max(
      0,
      Math.min(1, Number(parsed.confidence || 0)),
    );
    const rewritten = String(parsed.rewrittenQuestion || "").trim();
    const aiSaysFollowUp = parsed.isFollowUp === true && confidence >= 0.7;
    const finalRewrite =
      aiSaysFollowUp && !isWeakRewrite(rewritten)
        ? rewritten
        : buildEffectiveMessage(message, conv);
    return {
      isFollowUp: aiSaysFollowUp,
      confidence,
      routeHint: normalizeRouteHint(parsed.routeHint, conv.lastRoute),
      rewrittenQuestion: aiSaysFollowUp ? finalRewrite : message,
      reason: String(parsed.reason || ""),
      method: "ai",
    };
  } catch (error) {
    console.warn("follow-up classifier fail:", error.message);
    if (likelyContextDependentShortQuestion(message)) {
      return {
        isFollowUp: true,
        confidence: 0.55,
        routeHint: conv.lastRoute,
        rewrittenQuestion: buildEffectiveMessage(message, conv),
        method: "shape-fallback",
      };
    }
    return {
      isFollowUp: false,
      confidence: 0,
      routeHint: "",
      rewrittenQuestion: message,
      method: "ai-error",
    };
  }
}
