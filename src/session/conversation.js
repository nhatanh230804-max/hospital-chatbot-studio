// =============================================================================
// src/session/conversation.js
// =============================================================================
// Quản lý hội thoại nhiều lượt theo từng session:
//   - getSessionId(req)        : lấy sessionId từ request
//   - sessionHash(sessionId)   : hash ngắn để ghi log (không lộ sessionId thật)
//   - loadConversation(id)     : nạp hội thoại từ session store
//   - saveConversation(id,c)   : lưu hội thoại (tự cắt bớt history)
//   - isFollowUp(message)      : phát hiện câu hỏi nối tiếp
//   - buildEffectiveMessage()  : ghép ngữ cảnh lượt trước vào câu follow-up
//
// Mỗi conversation object có dạng:
//   { history: [{q,a,route,ts}], lastQuestion, lastAnswer, lastRoute,
//     sqlContext: {question,sql,rows}|null, updatedAt }
// =============================================================================
import crypto from "crypto";
import { getSessionStore } from "./chat-session-store.js";
import { normalizeVietnamese } from "../utils.js";

const MAX_HISTORY = 6; // giữ tối đa 6 lượt gần nhất
const MAX_ANSWER_IN_CONTEXT = 800; // cắt câu trả lời trước khi nhồi vào prompt

// -----------------------------------------------------------------------------
// Session id & hash
// -----------------------------------------------------------------------------
export function getSessionId(req) {
  // Ưu tiên sessionId frontend gửi lên. Nếu thiếu thì suy ra từ IP + User-Agent
  // để các user chung NAT không lẫn context.
  if (req.body && req.body.sessionId) {
    return String(req.body.sessionId).slice(0, 100);
  }
  const ua = req.get("user-agent") || "no-ua";
  return crypto
    .createHash("sha1")
    .update(`${req.ip}::${ua}`)
    .digest("hex");
}

// Hash ngắn dùng cho log — đủ phân biệt session, không lộ sessionId gốc
export function sessionHash(sessionId) {
  return crypto
    .createHash("sha1")
    .update(String(sessionId || ""))
    .digest("hex")
    .slice(0, 10);
}

// -----------------------------------------------------------------------------
// Load / Save conversation
// -----------------------------------------------------------------------------
function emptyConversation() {
  return {
    history: [],
    lastQuestion: "",
    lastAnswer: "",
    lastRoute: "",
    sqlContext: null,
    updatedAt: Date.now(),
  };
}

export async function loadConversation(sessionId) {
  const store = await getSessionStore();
  const data = await store.get(sessionId);
  if (!data) return emptyConversation();
  // Phòng dữ liệu cũ thiếu field
  return { ...emptyConversation(), ...data };
}

export async function saveConversation(sessionId, conv) {
  const store = await getSessionStore();
  if (Array.isArray(conv.history) && conv.history.length > MAX_HISTORY) {
    conv.history = conv.history.slice(-MAX_HISTORY);
  }
  conv.updatedAt = Date.now();
  await store.set(sessionId, conv);
}

// -----------------------------------------------------------------------------
// Phát hiện câu hỏi follow-up
// -----------------------------------------------------------------------------
// STRONG: chắc chắn là follow-up dù câu dài hay ngắn
const FOLLOWUP_STRONG = [
  "chi tiet hon",
  "noi ro hon",
  "ro hon nua",
  "giai thich them",
  "giai thich ro",
  "giai thich ky hon",
  "cu the hon",
  "noi them",
  "them thong tin",
  "them chi tiet",
  "noi ro them",
  "the con",
  "vay con",
  "con lai thi sao",
  "con gi nua khong",
  "tiep tuc di",
  "noi tiep di",
  "phan tich them",
];

// WEAK: chỉ tính là follow-up khi câu NGẮN (tham chiếu lượt trước)
const FOLLOWUP_WEAK = [
  "tai sao vay",
  "vi sao vay",
  "the nao",
  "nhu the nao",
  "tai sao",
  "vi sao",
  "cho vi du",
  "vi du di",
  "ro hon",
  "lam ro",
  "them di",
  "con nua khong",
  "the a",
  "vay a",
];

// Đại từ tham chiếu — câu ngắn chứa các từ này thường là follow-up
const FOLLOWUP_PRONOUNS = [
  "cai do",
  "cai nay",
  "viec do",
  "viec nay",
  "van de nay",
  "van de do",
  "benh nay",
  "benh do",
  "dieu do",
  "dieu nay",
  "phan do",
  "y do",
];

export function isFollowUp(message) {
  const text = normalizeVietnamese(message);
  if (!text) return false;

  // 1. Cụm STRONG → luôn là follow-up
  if (FOLLOWUP_STRONG.some((p) => text.includes(p))) return true;

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const isShort = wordCount <= 8;

  // 2. Cụm WEAK → chỉ tính khi câu ngắn (tránh nhầm câu hỏi đầy đủ)
  if (isShort && FOLLOWUP_WEAK.some((p) => text.includes(p))) return true;

  // 3. Đại từ tham chiếu trong câu ngắn
  if (isShort && FOLLOWUP_PRONOUNS.some((p) => text.includes(p))) return true;

  return false;
}

// -----------------------------------------------------------------------------
// Ghép ngữ cảnh lượt trước vào câu follow-up → effectiveMessage gửi cho LLM
// -----------------------------------------------------------------------------
export function buildEffectiveMessage(message, conv) {
  if (!conv || !conv.lastQuestion) return message;

  const prevAnswer = String(conv.lastAnswer || "").slice(
    0,
    MAX_ANSWER_IN_CONTEXT,
  );

  return [
    "Đây là một câu hỏi NỐI TIẾP trong cùng một cuộc hội thoại.",
    "",
    `Câu hỏi trước của người dùng: "${conv.lastQuestion}"`,
    "",
    `Câu trả lời trước của bạn:`,
    prevAnswer,
    "",
    `Yêu cầu tiếp theo của người dùng: "${message}"`,
    "",
    "Hãy trả lời yêu cầu tiếp theo, BÁM SÁT chủ đề của câu hỏi trước. " +
      "Nếu người dùng yêu cầu nói chi tiết hơn / rõ hơn / giải thích thêm, " +
      "hãy mở rộng và bổ sung thông tin cho câu trả lời trước, không hỏi lại từ đầu.",
  ].join("\n");
}
