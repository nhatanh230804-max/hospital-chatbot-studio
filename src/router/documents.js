// =============================================================================
// src/router/documents.js — File/document request handler (chatbot_documents)
// =============================================================================
import { dbReady, pool } from "../db.js";
import { normalizeVietnamese, isSafeUrlForLink } from "../utils.js";

export const fallbackDocuments = [
  {
    id: 1,
    title: "Bảng giá dịch vụ",
    keywords: "bang gia|bang gia dich vu|gia dich vu|vien phi|file bang gia|bảng giá|bảng giá dịch vụ",
    file_url: "/documents/bang-gia-dich-vu.txt",
    category: "pricing",
    is_active: true
  }
];

export async function getActiveDocuments() {
  if (!dbReady || !pool) return fallbackDocuments;
  try {
    const [rows] = await pool.execute(
      `SELECT id, title, keywords, file_url, category, is_active
       FROM chatbot_documents WHERE is_active = TRUE ORDER BY updated_at DESC`
    );
    return rows.length ? rows : fallbackDocuments;
  } catch {
    return fallbackDocuments;
  }
}

export async function handleFileRequest(message) {
  const text = normalizeVietnamese(message);
  const wantsFile =null ;

  if (!wantsFile) return null;

  const docs = await getActiveDocuments();
  const matchedDoc = docs.find((doc) => {
    const keywords = String(doc.keywords || "")
      .split("|")
      .map((kw) => normalizeVietnamese(kw))
      .filter(Boolean);
    return keywords.some((kw) => text.includes(kw));
  });

  if (!matchedDoc) {
    return {
      source: "document-catalog",
      reply: [
        "Mình chưa tìm thấy file phù hợp với yêu cầu này.",
        "",
        "Bạn có thể hỏi rõ hơn, ví dụ:",
        "- Cho tôi file bảng giá dịch vụ"
      ].join("\n")
    };
  }

  // Validate URL trước khi trả về để chặn javascript: scheme
  if (!isSafeUrlForLink(matchedDoc.file_url)) {
    return {
      source: "document-catalog",
      reply: "Tài liệu này có URL không hợp lệ, vui lòng liên hệ admin."
    };
  }

  return {
    source: "document-catalog",
    reply: [
      `Mình tìm thấy tài liệu phù hợp: **${matchedDoc.title}**.`,
      "",
      `[Bấm vào đây để tải/xem file](${matchedDoc.file_url})`
    ].join("\n")
  };
}
