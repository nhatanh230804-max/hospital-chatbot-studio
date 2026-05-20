// =============================================================================
// src/router/data-question.js — Dynamic data-question detector (Phương án B)
// =============================================================================
// Gom keyword từ:
//   - sql_templates.keywords (admin tự viết)
//   - schema_metadata: domain, description, table_name, column names
// + 1 base safety net nhỏ (~5 keyword trụ cột)
// + fuzzy match theo tên bảng/cột raw (vd "invoices" trong câu user)
// Cache 60s để không query DB mỗi request.
// =============================================================================
import { dbReady, pool } from "../db.js";
import { normalizeVietnamese, safeJsonParse } from "../utils.js";

export let dataQuestionCache = { keywords: [], rawIdentifiers: new Set(), at: 0 };

// Base safety net — luôn có hiệu lực dù admin chưa kịp dạy template
export const BASE_DATA_KEYWORDS = [
  "sql",
  "query",
  "database",
  "du lieu",
  "truy van",
  "su dung sql"  // explicit trigger cho dev
];

// Stopwords tiếng Việt cơ bản — tránh keyword vô nghĩa (vd "cua", "tren", "voi")
export const STOPWORDS = new Set([
  "cua", "tren", "duoi", "trong", "ngoai", "voi", "cho", "tu", "den", "den",
  "khi", "thi", "neu", "hoac", "va", "hay", "nhung", "boi", "vi", "ma",
  "co", "khong", "duoc", "phai", "moi", "tat", "ca", "moi", "moi",
  "cac", "nhung", "nay", "kia", "ay", "kia", "ban", "minh", "toi", "anh", "em",
  "la", "thi", "rang", "hay", "luc", "thoi", "lan", "phan", "muc",
  "thong", "tin", "luu", "ghi", "nhan", "moi", "ngay", "thang", "nam"
]);

export function invalidateDataQuestionCache() {
  dataQuestionCache.at = 0;
}

export async function refreshDataQuestionKeywords() {
  if (!dbReady || !pool) return;
  try {
    const keywords = new Set(BASE_DATA_KEYWORDS);
    const identifiers = new Set();

    // 1. Lấy keywords từ sql_templates
    const [tplRows] = await pool.execute(
      `SELECT keywords FROM sql_templates WHERE is_active = TRUE`
    );
    for (const row of tplRows) {
      const parts = String(row.keywords || "")
        .split("|")
        .map((kw) => normalizeVietnamese(kw))
        .filter((kw) => kw && kw.length >= 3);
      parts.forEach((kw) => keywords.add(kw));
    }

    // 2. Lấy keywords từ schema_metadata: domain, description, table_name, column names
    const [schRows] = await pool.execute(
      `SELECT table_name, domain, description, columns_json
       FROM schema_metadata WHERE is_active = TRUE`
    );
    for (const row of schRows) {
      // Tên bảng raw (không normalize) để fuzzy match
      if (row.table_name) {
        const name = row.table_name.toLowerCase();
        identifiers.add(name);
        // Số ít (bỏ 's' cuối nếu là plural)
        if (name.endsWith('s') && name.length > 3) {
          identifiers.add(name.slice(0, -1));
        }
        // Số nhiều (thêm 's' nếu là singular)
        if (!name.endsWith('s')) {
          identifiers.add(name + 's');
        }
        // Snake_case → space (vd staff_schedules → staff schedules)
        if (name.includes('_')) {
          identifiers.add(name.replaceAll('_', ' '));
        }
      }

      // Tên bảng đã normalize
      if (row.table_name) {
        const t = normalizeVietnamese(row.table_name);
        if (t.length >= 3) keywords.add(t);
      }

      // Domain
      if (row.domain) {
        const d = normalizeVietnamese(row.domain);
        if (d.length >= 3) keywords.add(d);
      }

      // Description: tách thành từ đơn, lấy từ có nghĩa (>3 ký tự, không phải stopword)
      if (row.description) {
        const words = normalizeVietnamese(row.description)
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
        // Lấy cụm 2 từ liền nhau cho match tốt hơn (vd "hoa don", "doanh thu")
        for (let i = 0; i < words.length - 1; i++) {
          const phrase = `${words[i]} ${words[i + 1]}`;
          if (phrase.length >= 6) keywords.add(phrase);
        }
        // Cụm 1 từ cho fallback
        words.forEach((w) => keywords.add(w));
      }

      // Column names
      const columns = safeJsonParse(row.columns_json, []);
      for (const col of columns) {
        if (col.name) {
          const colName = String(col.name).toLowerCase();
          identifiers.add(colName);
          // Snake_case → space
          if (colName.includes('_')) {
            identifiers.add(colName.replaceAll('_', ' '));
          }
          const n = normalizeVietnamese(col.name);
          if (n.length >= 3) keywords.add(n);
        }
        // Enum values: nếu cột có enum → add từng value vào identifiers
        // Vd status enum ['paid', 'pending', 'cancelled'] → user hỏi "hóa đơn pending" sẽ match
        if (Array.isArray(col.enum)) {
          for (const v of col.enum) {
            const val = String(v).toLowerCase();
            if (val.length >= 3) identifiers.add(val);
          }
        }
        // Cũng tách description của cột
        if (col.description) {
          const words = normalizeVietnamese(col.description)
            .split(/\s+/)
            .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
          for (let i = 0; i < words.length - 1; i++) {
            keywords.add(`${words[i]} ${words[i + 1]}`);
          }
        }
      }
    }

    dataQuestionCache.keywords = Array.from(keywords);
    dataQuestionCache.rawIdentifiers = identifiers;
    dataQuestionCache.at = Date.now();
  } catch (err) {
    console.warn("refreshDataQuestionKeywords fail:", err.message);
  }
}

export async function isHospitalDataQuestion(message) {
  // Refresh cache nếu hết hạn (60s)
  if (Date.now() - dataQuestionCache.at >= 60000) {
    await refreshDataQuestionKeywords();
  }

  const text = normalizeVietnamese(message);
  const textRaw = String(message || "").toLowerCase();

  // 1. Match keyword đã chuẩn hoá
  if (dataQuestionCache.keywords.some((kw) => text.includes(kw))) {
    return true;
  }

  // 2. Fuzzy match: câu hỏi có tên bảng/cột raw (vd "invoices", "patient_name")
  for (const ident of dataQuestionCache.rawIdentifiers) {
    if (textRaw.includes(ident)) return true;
  }

  return false;
}

// Detect câu hỏi có signal data RÕ RÀNG (có số, có pattern data query)
// Dùng để break tie khi vừa match medical vừa match data keyword
export function hasStrongDataSignal(message) {
  const text = normalizeVietnamese(message);

  // Pattern câu hỏi data: "có bao nhiêu", "top X", "tổng", "trung bình", "thống kê"
  const dataPatterns = [
    "co bao nhieu", "bao nhieu", "tong so", "tong cong", "tong tien",
    "top ", "trung binh", "thong ke", "danh sach", "liet ke",
    "doanh thu", "luot kham", "hoa don", "ca truc", "lich truc",
    "duoc bao nhieu", "thuc te la", "report", "bao cao"
  ];
  if (dataPatterns.some((p) => text.includes(p))) return true;

  // Có chứa con số rõ ràng (vd "5 hóa đơn", "10 lượt khám")
  if (/\b\d+\b/.test(text)) return true;

  return false;
}
