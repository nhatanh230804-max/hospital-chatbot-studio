// =============================================================================
// src/sql/summarizer.js — Heuristic + AI-powered SQL result summarizer
// =============================================================================
import { normalizeVietnamese } from "../utils.js";
import { getDemoToday } from "../config.js";
import { callAnythingLLM, isAnythingLLMConfigured } from "../anythingllm.js";

const CJK_PATTERN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

export function containsCJK(text) {
  return CJK_PATTERN.test(String(text || ""));
}

export function formatValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// Legacy heuristic summarizer - dùng làm fallback nếu AI fail
export function summarizeSqlResultHeuristic(question, sql, rows) {
  if (!rows || rows.length === 0)
    return "Mình chưa tìm thấy dữ liệu phù hợp với câu hỏi này.";

  const text = normalizeVietnamese(question);
  const row = rows[0];
  const keys = Object.keys(row);

  const has = (k) => keys.some((key) => key.toLowerCase() === k.toLowerCase());

  if (has("reply")) {
    if (rows.length === 1) return String(row.reply);
    return rows.map((r) => `- ${r.reply}`).join("\n");
  }

  if (has("name") && has("visits")) {
    if (rows.length > 1) {
      return [
        "Số lượt khám của các khoa:",
        "",
        ...rows.map((item) => `- ${item.name}: ${item.visits} lượt`),
      ].join("\n");
    }
    if (
      text.includes("cao nhat") ||
      text.includes("nhieu nhat") ||
      text.includes("dong nhat")
    )
      return `${row.name} có lượt khám cao nhất với ${row.visits} lượt.`;
    if (text.includes("thap nhat") || text.includes("it nhat"))
      return `${row.name} có lượt khám thấp nhất với ${row.visits} lượt.`;
    return `${row.name} có ${row.visits} lượt khám.`;
  }

  if (has("total")) {
    if (
      text.includes("nhan su") ||
      text.includes("nguoi") ||
      text.includes("truc")
    ) {
      const today = getDemoToday();
      if (text.includes("hom nay")) {
        if (text.includes("sap truc"))
          return `Hôm nay có ${row.total} nhân sự sắp trực.`;
        if (text.includes("du kien"))
          return `Hôm nay có ${row.total} nhân sự dự kiến.`;
        return `Hôm nay (${today}) có ${row.total} nhân sự đang trực.`;
      }
      if (text.includes("ngay mai") || text.includes("mai")) {
        return `Ngày mai có ${row.total} nhân sự trong lịch trực.`;
      }
      return `Có ${row.total} nhân sự phù hợp.`;
    }
    return `Tổng số là ${row.total}.`;
  }

  if (has("total_visits"))
    return `Tổng lượt khám hiện có là ${Number(row.total_visits || 0)} lượt.`;

  if (has("staff_name")) {
    const lines = rows.map(
      (item) =>
        `- ${item.staff_name}${item.role_name ? ` (${item.role_name})` : ""}` +
        `${item.department ? ` - ${item.department}` : ""}` +
        `${item.shift_time ? `, ca ${item.shift_time}` : ""}` +
        `${item.status ? `, trạng thái: ${item.status}` : ""}`,
    );
    const header =
      rows.length === 1
        ? "Có 1 nhân sự phù hợp:"
        : `Có ${rows.length} nhân sự phù hợp:`;
    return [header, "", ...lines].join("\n");
  }

  if (has("title") && has("steps"))
    return [`${row.title}:`, "", formatValue(row.steps)].join("\n");

  return rows
    .map((item, index) => {
      const values = Object.entries(item)
        .map(([key, value]) => `${key}: ${formatValue(value)}`)
        .join("; ");
      return `- Dòng ${index + 1}: ${values}`;
    })
    .join("\n");
}

// AI-powered summarizer: gọi AnythingLLM diễn giải kết quả SQL thành câu trả lời tự nhiên
export async function summarizeSqlResult(question, sql, rows, options = {}) {
  if (!rows || rows.length === 0)
    return "Mình chưa tìm thấy dữ liệu phù hợp với câu hỏi này.";

  // Convention: nếu admin đã viết SQL trả về cột "reply" → in thẳng, không gọi AI
  const firstRow = rows[0];
  const keysLower = Object.keys(firstRow).map((k) => k.toLowerCase());
  if (keysLower.includes("reply")) {
    if (rows.length === 1) return String(firstRow.reply);
    return rows.map((r) => `- ${r.reply}`).join("\n");
  }

  // Nếu AnythingLLM chưa cấu hình → dùng heuristic cũ
  if (!isAnythingLLMConfigured()) {
    return summarizeSqlResultHeuristic(question, sql, rows);
  }

  const limitedRows = rows.slice(0, 20);
  const rowsJson = JSON.stringify(
    limitedRows,
    (key, value) => {
      if (typeof value === "bigint") return value.toString();
      return value;
    },
    2,
  );

  const moreNote =
    rows.length > 20
      ? `\n(Có tổng cộng ${rows.length} dòng, chỉ hiển thị 20 dòng đầu.)`
      : "";

  const prompt = `
Bạn là trợ lý diễn giải kết quả truy vấn database thành câu trả lời tự nhiên bằng tiếng Việt cho user của bệnh viện.

Câu hỏi user: "${question}"

Kết quả SQL trả về (JSON):
${rowsJson}${moreNote}

Yêu cầu trả lời:
- Diễn giải kết quả thành câu tiếng Việt rõ ràng, tự nhiên, ngắn gọn.
- CHỈ được trả lời bằng tiếng Việt. TUYỆT ĐỐI KHÔNG dùng tiếng Trung, tiếng Nhật, tiếng Hàn.
- Không thêm câu xã giao/cuối câu như "còn gì khác không", "tôi có thể giúp gì", hoặc bất kỳ ngôn ngữ khác.
- KHÔNG nhắc tên cột (như "total_amount", "patient_name") trong câu trả lời — dùng từ tiếng Việt tự nhiên.
- Định dạng số tiền VND với dấu phẩy ngăn cách hàng nghìn (vd: 10,760,000 VND).
- Nếu có nhiều dòng (>3), liệt kê dạng gạch đầu dòng. Nếu 1-3 dòng, viết thành câu hoàn chỉnh.
- KHÔNG bịa thêm thông tin ngoài data trên.
- KHÔNG nói "Theo dữ liệu...", "Kết quả truy vấn..." — trả lời trực tiếp.
- KHÔNG dùng dấu "**" markdown, chỉ dùng plaintext + dấu xuống dòng.

Câu trả lời:
`.trim();

  try {
    const { text } = await callAnythingLLM(prompt, {
      mode: "chat",
      sessionId: `hospital-sql-summary-${Date.now()}`,
      timeoutMs: 30000,
      signal: options.signal,
    });
    const cleaned = String(text || "").trim();
    if (!cleaned) return summarizeSqlResultHeuristic(question, sql, rows);
    if (containsCJK(cleaned)) {
      console.warn(
        "AI summarize returned mixed CJK output, fallback heuristic:",
        cleaned.slice(0, 200),
      );
      return summarizeSqlResultHeuristic(question, sql, rows);
    }
    return cleaned;
  } catch (err) {
    console.warn("AI summarize fail, fallback heuristic:", err.message);
    return summarizeSqlResultHeuristic(question, sql, rows);
  }
}
