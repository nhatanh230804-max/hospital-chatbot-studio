// =============================================================================
// src/utils.js — Common text / JSON / URL helpers
// =============================================================================

export function normalizeVietnamese(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function assertSafeSqlIdentifier(value, label = "identifier") {
  const text = String(value || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(text)) {
    throw new Error(`${label} khong hop le.`);
  }
  return text;
}

export function quoteMysqlIdentifier(value, label = "identifier") {
  const text = assertSafeSqlIdentifier(value, label);
  return `\`${text.replaceAll("`", "``")}\``;
}

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function isSafeUrlForLink(url) {
  // Chỉ cho phép http/https hoặc đường dẫn nội bộ /...
  if (!url) return false;
  const trimmed = String(url).trim();
  if (trimmed.startsWith("/")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
