// =============================================================================
// src/router/faq.js — FAQ matching for approved_medical_faq
// =============================================================================
import { dbReady, pool } from "../db.js";
import { normalizeVietnamese } from "../utils.js";

export function matchFaqFromList(message, list) {
  const text = normalizeVietnamese(message);
  return (
    list.find((item) => {
      const keywords = String(item.keywords || "")
        .split("|")
        .map((kw) => normalizeVietnamese(kw))
        .filter(Boolean);
      return keywords.some((kw) => text.includes(kw));
    }) || null
  );
}

export async function findApprovedMedicalFaq(message) {
  if (!dbReady || !pool) return null;
  try {
    const [rows] = await pool.execute(
      `SELECT id, topic, keywords, answer FROM approved_medical_faq
       WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 200`,
    );
    return matchFaqFromList(message, rows);
  } catch (error) {
    console.warn("FAQ unavailable:", error.message);
    return null;
  }
}
