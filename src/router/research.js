// =============================================================================
// src/router/research.js — Research Mode + Fallback chat (cùng dùng trusted_sources)
// =============================================================================
import { dbReady, pool } from "../db.js";
import { normalizeVietnamese } from "../utils.js";
import { callAnythingLLM, isAnythingLLMConfigured } from "../anythingllm.js";
import { shouldUseResearchAgent } from "./health-question.js";
import { isUrgentOrTreatmentSeeking } from "./medical-safety.js";
import {
  getTrustedSources,
  buildTrustedSourcesPromptBlock,
  filterAnswerByTrustedDomains
} from "./trusted-sources.js";

export function normalizeResearchQuestion(message) {
  return normalizeVietnamese(message)
    .replace(/^cho\s+(toi|minh|em)\s+hoi\s+/, "")
    .replace(/^toi\s+muon\s+hoi\s+/, "")
    .replace(/^cach\s+de\s+/, "cach ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

export function extractWeightsFromMessage(message) {
  // Tách rõ tuổi/chiều cao/cân nặng để không lẫn
  const text = normalizeVietnamese(message);
  // Bỏ qua các số đi kèm "tuoi", "cao", "cm"
  const cleaned = text
    .replace(/\d+\s*tuoi/g, " ")
    .replace(/\d+\s*cm/g, " ")
    .replace(/cao\s*\d+/g, " ");
  return [...cleaned.matchAll(/\b(\d{2,3})\s*(?:kg|can|ky|kilogram)?\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 30 && n <= 250);
}

export function buildResearchCacheKey(message) {
  const text = normalizeVietnamese(message);
  const weights = extractWeightsFromMessage(message);

  const isWeight =
    text.includes("giam can") ||
    text.includes("tang can") ||
    (text.includes("giam") && text.includes("can")) ||
    (text.includes("tang") && text.includes("can")) ||
    text.includes("calo") ||
    text.includes("thuc don") ||
    text.includes("dinh duong");

  if (isWeight) {
    const isLoss = text.includes("giam can") || text.includes("giam xuong") || (text.includes("giam") && text.includes("can"));
    const isGain = text.includes("tang can") || (text.includes("tang") && text.includes("can"));
    if (weights.length >= 2) {
      const [from, to] = weights;
      if (isLoss || from > to) return `wellness:giam-can:${from}-to-${to}`;
      if (isGain || from < to) return `wellness:tang-can:${from}-to-${to}`;
    }
    if (isLoss) return "wellness:giam-can:general";
    if (isGain) return "wellness:tang-can:general";
    return "wellness:weight:general";
  }
  if (text.includes("gian co") || text.includes("keo gian")) return "wellness:gian-co:general";
  if (text.includes("giac ngu") || text.includes("mat ngu")) return "wellness:giac-ngu:general";

  return normalizeResearchQuestion(message);
}

export async function getCachedResearchAnswer(message) {
  if (!dbReady || !pool) return null;
  const key = buildResearchCacheKey(message);
  try {
    const [rows] = await pool.execute(
      `SELECT answer, source FROM research_answer_cache WHERE normalized_question = ? AND expires_at > NOW() LIMIT 1`,
      [key]
    );
    return rows[0] || null;
  } catch (error) {
    console.warn("Research cache unavailable:", error.message);
    return null;
  }
}

export async function saveResearchAnswerCache(message, answer) {
  if (!dbReady || !pool) return;
  const key = buildResearchCacheKey(message);
  try {
    await pool.execute(
      `INSERT INTO research_answer_cache (normalized_question, original_question, answer, source, expires_at)
       VALUES (?, ?, ?, 'anythingllm-research', DATE_ADD(NOW(), INTERVAL 7 DAY))
       ON DUPLICATE KEY UPDATE original_question = VALUES(original_question), answer = VALUES(answer),
       expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP`,
      [key, message, answer]
    );
  } catch (error) {
    console.warn("Không lưu được research cache:", error.message);
  }
}

export async function handleResearchMode(message) {
  if (!(await shouldUseResearchAgent(message))) return null;

  // Cache
  const cached = await getCachedResearchAnswer(message);
  if (cached) return { source: "research-cache", reply: cached.answer };

  // Chặn nếu là câu cấp cứu/kê thuốc
  if (isUrgentOrTreatmentSeeking(message)) {
    return {
      source: "medical-safety-rule",
      reply: [
        "Tình trạng này cần được nhân viên y tế đánh giá trực tiếp.",
        "",
        "- Mình không thể kê thuốc, chỉ định thuốc hoặc đưa liều dùng.",
        "- Nếu triệu chứng nặng, đau dữ dội, khó thở, ngất, co giật, sốt cao hoặc nôn liên tục, hãy đến cơ sở y tế hoặc khoa cấp cứu.",
        "- Nếu có thể, hãy đi cùng người thân và mang theo giấy tờ y tế/thuốc đang dùng."
      ].join("\n")
    };
  }

  // Lấy whitelist trusted sources
  const sources = await getTrustedSources();
  if (!sources.length) {
    return {
      source: "no-trusted-sources",
      reply: "Hiện tại chưa có nguồn tra cứu nào được admin cho phép. Vui lòng liên hệ admin để bổ sung."
    };
  }

  const sourcesBlock = buildTrustedSourcesPromptBlock(sources);

  const prompt = `
@agent

Bạn là trợ lý nghiên cứu nhanh thông tin sức khỏe/wellness cho website bệnh viện.

QUY TẮC NGUỒN TRA CỨU (BẮT BUỘC):
- CHỈ ĐƯỢC tham khảo thông tin từ các nguồn dưới đây.
- KHÔNG ĐƯỢC trích dẫn, tham khảo, hoặc dùng thông tin từ bất kỳ website nào KHÔNG nằm trong danh sách này.
- KHÔNG được suy diễn từ nguồn ngoài danh sách.
- Nếu không tìm thấy thông tin trong các nguồn cho phép, hãy nói rõ là chưa có thông tin và đề nghị người dùng hỏi nhân viên y tế.

Danh sách nguồn được cho phép:
${sourcesBlock}

Nhiệm vụ:
- Tìm kiếm trong các nguồn trên để trả lời câu hỏi của người dùng.
- Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng, dễ hiểu.
- Tối đa 2 nguồn, tối đa 500 từ.
- Cuối câu trả lời, ghi mục "Nguồn tham khảo" với URL đầy đủ của các nguồn đã dùng (URL phải thuộc các domain trong danh sách trên).
- Không chẩn đoán bệnh, không kê thuốc, không thay thế bác sĩ.
- Không bịa nguồn, không bịa số liệu.

Câu hỏi của người dùng:
${message}
`.trim();

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `hospital-research-${Date.now()}`,
      timeoutMs: 120000
    });

    // Detect tool call rác — model output JSON tool call thay vì câu trả lời thật
    // Vd: 'ronics {"name": "web-browsing", "arguments": {"query": "..."}}'
    const looksLikeRawToolCall =
      /\{\s*"name"\s*:\s*"[a-z-]+"\s*,\s*"arguments"\s*:/i.test(text) &&
      text.length < 500;

    if (looksLikeRawToolCall) {
      console.warn("Research Mode: AI output raw tool call (model lệch), không cache:", text.slice(0, 200));
      return {
        source: "research-error",
        reply: "Hệ thống nghiên cứu chưa xử lý xong câu hỏi này. Bạn vui lòng thử lại hoặc đặt lại câu hỏi rõ hơn."
      };
    }

    // Detect output rỗng hoặc quá ngắn (model fail)
    if (!text || text.trim().length < 30) {
      console.warn("Research Mode: AI output quá ngắn:", text);
      return {
        source: "research-error",
        reply: "Hệ thống nghiên cứu chưa có thông tin phù hợp cho câu hỏi này. Bạn có thể hỏi nhân viên y tế."
      };
    }

    // Post-check: nếu có URL ngoài whitelist, cảnh báo
    const check = filterAnswerByTrustedDomains(text, sources);
    let finalReply = text;
    if (check.hasViolations) {
      finalReply +=
        `\n\n⚠️ Lưu ý: câu trả lời có nhắc tới ${check.violatingUrls.length} nguồn ngoài danh sách được duyệt. ` +
        `Vui lòng kiểm tra lại với nhân viên y tế.`;
    }

    await saveResearchAnswerCache(message, finalReply);
    return { source: "anythingllm-research", reply: finalReply, trustedSourcesCount: sources.length };
  } catch (error) {
    console.warn("Research Mode lỗi:", error.message);
    return {
      source: "research-error",
      reply: [
        "Research Mode phản hồi quá lâu hoặc chưa lấy được nguồn phù hợp.",
        "",
        "Bạn có thể thử hỏi lại ngắn hơn hoặc hỏi nhân viên y tế."
      ].join("\n")
    };
  }
}

export async function answerWithFallbackChat(message) {
  // Fallback chat cũng phải dùng trusted_sources làm whitelist
  const sources = await getTrustedSources();
  const sourcesBlock = buildTrustedSourcesPromptBlock(sources);

  const hospitalContext = `
Bạn là chatbot hỗ trợ website bệnh viện.
Chỉ hỗ trợ thông tin hành chính, quy trình và tài liệu đã được cung cấp.
Không chẩn đoán bệnh, không kê thuốc, không thay thế bác sĩ.
Nếu không chắc hoặc không có dữ liệu, hãy nói chưa có thông tin phù hợp.
Trả lời ngắn gọn, rõ ràng, thân thiện.

QUY TẮC NGUỒN TRA CỨU (BẮT BUỘC):
- Nếu cần tham khảo nguồn bên ngoài, CHỈ được dùng các nguồn trong danh sách dưới đây.
- KHÔNG được dùng nguồn ngoài danh sách này.

Danh sách nguồn được cho phép:
${sourcesBlock}
`.trim();

  if (!isAnythingLLMConfigured()) {
    return { source: "local-demo", reply: "Backend chưa có AnythingLLM API key/workspace slug." };
  }

  try {
    const { text } = await callAnythingLLM(`${hospitalContext}\n\nCâu hỏi của người dùng: ${message}`, {
      sessionId: `hospital-fallback-${Date.now()}`,
      timeoutMs: 60000
    });

    const check = filterAnswerByTrustedDomains(text, sources);
    let finalReply = text;
    if (check.hasViolations) {
      finalReply +=
        `\n\n⚠️ Lưu ý: câu trả lời có nhắc tới nguồn ngoài danh sách được duyệt.`;
    }
    return { source: "anythingllm-fallback", reply: finalReply };
  } catch (error) {
    return { source: "fallback-error", reply: `Không gọi được AI: ${error.message}` };
  }
}
