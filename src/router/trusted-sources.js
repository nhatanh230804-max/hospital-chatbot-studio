// =============================================================================
// src/router/trusted-sources.js — Class "Nguồn tra cứu"
// =============================================================================
// Chatbot CHỈ được tham khảo các URL/domain trong bảng trusted_sources cho:
//   - Research Mode (câu hỏi sức khỏe/wellness)
//   - Fallback chat (câu hỏi không phải SQL/FAQ/file)
// Backend áp dụng theo 2 lớp:
//   1. Đưa danh sách domain vào prompt, yêu cầu AI chỉ dùng các domain này
//   2. Post-check: parse câu trả lời, nếu có URL không nằm trong whitelist
//      thì cảnh báo / strip ra
// =============================================================================
import { dbReady, pool } from "../db.js";
import { extractDomain } from "../utils.js";

export let trustedSourcesCache = { list: [], at: 0 };

export async function getTrustedSources() {
  if (Date.now() - trustedSourcesCache.at < 30000)
    return trustedSourcesCache.list;
  if (!dbReady || !pool) return [];
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, url, domain, description, category, language, trust_level
       FROM trusted_sources WHERE is_active = TRUE ORDER BY trust_level DESC, name ASC`,
    );
    trustedSourcesCache.list = rows;
    trustedSourcesCache.at = Date.now();
    return rows;
  } catch (error) {
    console.warn("Không tải được trusted_sources:", error.message);
    return [];
  }
}

export function invalidateTrustedSourcesCache() {
  trustedSourcesCache.at = 0;
}

export function buildTrustedSourcesPromptBlock(sources) {
  if (!sources.length) return "(chưa có nguồn nào được duyệt)";
  return sources
    .map(
      (s) => `- ${s.name} (${s.domain}) — ${s.description || s.category || ""}`,
    )
    .join("\n");
}

export function extractUrlsFromText(text) {
  const urlRegex = /https?:\/\/[^\s\)\]\}<>"']+/g;
  return String(text || "").match(urlRegex) || [];
}

export function isSubdomainOfAllowed(domain, allowedDomains) {
  for (const allowed of allowedDomains) {
    if (domain === allowed || domain.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export function filterAnswerByTrustedDomains(answer, sources) {
  const allowedDomains = new Set(sources.map((s) => s.domain.toLowerCase()));
  const urls = extractUrlsFromText(answer);
  const violatingUrls = urls.filter((url) => {
    const domain = extractDomain(url);
    if (!domain) return false;
    return (
      !allowedDomains.has(domain) &&
      !isSubdomainOfAllowed(domain, allowedDomains)
    );
  });
  return {
    hasViolations: violatingUrls.length > 0,
    violatingUrls,
    allUrls: urls,
  };
}
