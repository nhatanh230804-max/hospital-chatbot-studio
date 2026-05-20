// =============================================================================
// src/faq/dedupe.js — FAQ dedupe (hybrid: keyword overlap + AI similarity check)
// =============================================================================
// Strategy:
//   - <40% keyword overlap → khác biệt rõ, không trùng
//   - >=70% overlap → chắc chắn trùng, cảnh báo ngay
//   - 40-70% overlap → mơ hồ, hỏi AI confirm
// =============================================================================
import { pool } from "../db.js";
import { normalizeVietnamese } from "../utils.js";
import { callAnythingLLM, isAnythingLLMConfigured } from "../anythingllm.js";

export function keywordOverlap(kwStr1, kwStr2) {
  const set1 = new Set(String(kwStr1 || "").split("|").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const set2 = new Set(String(kwStr2 || "").split("|").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!set1.size || !set2.size) return 0;
  let intersection = 0;
  for (const w of set1) if (set2.has(w)) intersection++;
  const union = new Set([...set1, ...set2]).size;
  return union === 0 ? 0 : intersection / union;
}

export function topicSimilarity(topic1, topic2) {
  const n1 = normalizeVietnamese(topic1);
  const n2 = normalizeVietnamese(topic2);
  if (n1 === n2) return 1;
  if (n1.includes(n2) || n2.includes(n1)) return 0.85;
  const w1 = new Set(n1.split(/\s+/).filter((w) => w.length >= 3));
  const w2 = new Set(n2.split(/\s+/).filter((w) => w.length >= 3));
  if (!w1.size || !w2.size) return 0;
  let overlap = 0;
  for (const w of w1) if (w2.has(w)) overlap++;
  return overlap / Math.max(w1.size, w2.size);
}

export async function checkFaqSimilarityWithAI(newFaq, candidates) {
  if (!isAnythingLLMConfigured() || !candidates.length) return null;

  const prompt = `Bạn cần kiểm tra FAQ mới có trùng nội dung với FAQ nào sẵn có không.

FAQ MỚI:
- Chủ đề: ${newFaq.topic}
- Nội dung: ${(newFaq.answer || "").slice(0, 300)}

DANH SÁCH FAQ SẴN CÓ:
${candidates.map((c, i) => `[${i + 1}] Chủ đề: ${c.topic}\n     Nội dung: ${(c.answer || "").slice(0, 200)}`).join("\n\n")}

Trả lời CHỈ 1 dòng theo format:
- "DUPLICATE: <số FAQ trùng>" nếu trùng (vd "DUPLICATE: 2")
- "UNIQUE" nếu không trùng cái nào

KHÔNG giải thích, KHÔNG markdown.`;

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `faq-dedupe-${Date.now()}`,
      timeoutMs: 20000
    });
    const match = String(text || "").match(/DUPLICATE:\s*(\d+)/i);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (candidates[idx]) return candidates[idx];
    }
    return null;
  } catch (err) {
    console.warn("AI dedupe fail:", err.message);
    return null;
  }
}

export async function findSimilarFaqs(newFaq, opts = {}) {
  const useAI = opts.useAI !== false;

  const [rows] = await pool.query(
    `SELECT id, topic, keywords, answer FROM approved_medical_faq WHERE is_active = TRUE`
  );

  const duplicates = [];
  const ambiguous = [];

  for (const row of rows) {
    const kwScore = keywordOverlap(newFaq.keywords || "", row.keywords || "");
    const topicScore = topicSimilarity(newFaq.topic || "", row.topic || "");
    const maxScore = Math.max(kwScore, topicScore);

    if (maxScore >= 0.7) {
      duplicates.push({ ...row, score: maxScore, reason: "keyword+topic" });
    } else if (maxScore >= 0.4) {
      ambiguous.push({ ...row, score: maxScore });
    }
  }

  if (useAI && ambiguous.length > 0 && ambiguous.length <= 5) {
    const aiDup = await checkFaqSimilarityWithAI(newFaq, ambiguous);
    if (aiDup) {
      duplicates.push({ ...aiDup, score: 0.65, reason: "ai-confirmed" });
    }
  }

  return {
    duplicates,
    ambiguous: ambiguous.filter((a) => !duplicates.find((d) => d.id === a.id)),
    method: useAI ? "hybrid" : "keyword"
  };
}
