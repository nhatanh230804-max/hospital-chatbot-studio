// =============================================================================
// Keyword Extractor (heuristic + AI enhancement)
// =============================================================================
// Module này có 2 chế độ:
//   1. extractKeywordsHeuristic(text, opts) - sync, instant, không tốn AI
//   2. extractKeywordsWithAI(text, context, callAI) - async, gọi AnythingLLM
// =============================================================================

// Vietnamese stopwords - tránh keyword vô nghĩa
const VN_STOPWORDS = new Set([
  // Articles, prepositions
  "cua",
  "tren",
  "duoi",
  "trong",
  "ngoai",
  "voi",
  "cho",
  "tu",
  "den",
  "khi",
  "thi",
  "neu",
  "hoac",
  "va",
  "hay",
  "nhung",
  "boi",
  "vi",
  "ma",
  // Common verbs
  "co",
  "khong",
  "duoc",
  "phai",
  "moi",
  "lam",
  "den",
  // Pronouns
  "cac",
  "nhung",
  "nay",
  "kia",
  "ay",
  "ban",
  "minh",
  "toi",
  "anh",
  "em",
  // Connectors
  "la",
  "rang",
  "luc",
  "thoi",
  "lan",
  "phan",
  "muc",
  "het",
  // Generic time
  "ngay",
  "thang",
  "nam",
  // Question words (giữ trong câu nhưng không thành keyword)
  "ai",
  "gi",
  "nao",
  "dau",
  "bao",
  "may",
  // Misc
  "mot",
  "hai",
  "ba",
  "bon",
  "nam",
  "sau",
  "bay",
  "tam",
  "chin",
  "muoi",
  "the",
  "do",
  "se",
  "dang",
  "da",
  "roi",
  "den",
  "tat",
  "ca",
]);

// Remove diacritics + lowercase + strip punctuation
function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[?!.,;:'"()\[\]{}<>«»""'']/g, " ") // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

// Split filename: bỏ extension, replace separator bằng space
// KHÔNG strip slash để biết phần nào là folder cha, phần nào là tên file
function splitFilename(filename) {
  return String(filename || "")
    .replace(/\.[^.]+$/, "") // bỏ .pdf, .docx, etc
    .replace(/[-_.\\\s]+/g, " ") // dấu nối (trừ slash) → space
    .trim();
}

// Extract phần cuối của path (tên file thật) — ưu tiên scoring
// vd "ielts/Test 1/Part 1.mp3" → leaf: "Part 1", parent: "ielts/Test 1"
function splitFilenamePathParts(filename) {
  const noExt = String(filename || "").replace(/\.[^.]+$/, "");
  const parts = noExt.split(/[/\\]/);
  const leaf = parts[parts.length - 1] || ""; // "Part 1"
  const parents = parts.slice(0, -1).join(" "); // "ielts Test 1"
  return {
    leaf: leaf.replace(/[-_.\s]+/g, " ").trim(),
    parents: parents.replace(/[-_.\s]+/g, " ").trim(),
  };
}

// Tokenize: tách thành từ, lowercase, normalize, bỏ stopwords + từ quá ngắn
// Đặc biệt: giữ TOKEN SỐ (digits) kể cả 1-2 ký tự vì chúng có nghĩa
// (vd "part 1", "test 2026", "khoa 3")
function tokenize(text, opts = {}) {
  const minLength = opts.minLength || 3;
  const normalized = normalize(text);
  return normalized.split(/\s+/).filter((w) => {
    if (!w) return false;
    if (VN_STOPWORDS.has(w)) return false;
    // Cho phép token chỉ chứa số (1-4 ký tự): "1", "2026"
    if (/^\d{1,5}$/.test(w)) return true;
    // Còn lại: phải đủ minLength
    return w.length >= minLength;
  });
}

// Generate cụm n-gram (1, 2, 3 từ liên tiếp)
function ngrams(tokens, n) {
  const result = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    result.push(tokens.slice(i, i + n).join(" "));
  }
  return result;
}

// =============================================================================
// Heuristic extraction
// =============================================================================

/**
 * Trích keywords từ text dùng heuristic. Trả về array unique tối đa 8 keywords.
 *
 * @param {string} text - source text (filename, question, table name...)
 * @param {object} opts
 *   - source: "filename" | "question" | "tablename" | "general"
 *   - additionalContext: string (extra text để cân nhắc)
 *   - maxKeywords: số keyword tối đa (default 8)
 */
function extractKeywordsHeuristic(text, opts = {}) {
  if (!text) return [];

  const maxKeywords = opts.maxKeywords || (opts.source === "filename" ? 10 : 8);
  const source = opts.source || "general";

  // Pre-process tùy source
  let leafTokens = [];
  let parentTokens = [];
  let processedText = String(text || "").trim();

  if (source === "filename") {
    // Tách leaf (tên file) khỏi parent (folder cha)
    const { leaf, parents } = splitFilenamePathParts(processedText);
    leafTokens = tokenize(leaf);
    parentTokens = tokenize(parents);
    processedText = leaf + " " + parents;
  }

  // Combine với additional context
  if (opts.additionalContext) {
    processedText += " " + String(opts.additionalContext);
  }

  const tokens =
    source === "filename"
      ? [
          ...leafTokens,
          ...parentTokens,
          ...tokenize(opts.additionalContext || ""),
        ]
      : tokenize(processedText);
  if (tokens.length === 0) return [];

  // Build keyword candidates
  const candidates = new Map(); // keyword → score

  // Helper: score boost cho keyword chứa token từ leaf (tên file thật)
  const leafSet = new Set(leafTokens);
  function isFromLeaf(kw) {
    return kw.split(" ").some((t) => leafSet.has(t));
  }

  // Single words (1-gram) - score 1, boost 2x nếu từ leaf
  for (const t of tokens) {
    const boost = leafSet.has(t) ? 2 : 1;
    candidates.set(t, (candidates.get(t) || 0) + boost);
  }

  // Bigrams (2-gram) - score 3 (ưu tiên cụm cao hơn)
  // Boost lên 6 nếu bigram chứa token từ leaf (vd "part 1" trong "Test 1/Part 1.mp3")
  for (const bg of ngrams(tokens, 2)) {
    const parts = bg.split(" ");
    const allValid = parts.every((p) => p.length >= 3 || /^\d{1,4}$/.test(p));
    if (!allValid) continue;

    // Bỏ noise: bigram bắt đầu bằng số đơn (vd "1 ielts", "7 actual")
    // Vì pattern thường là "<từ> <số>" (vd "part 1") chứ không phải "<số> <từ>"
    if (/^\d{1,4}\s/.test(bg)) continue;

    const score = isFromLeaf(bg) ? 6 : 3;
    candidates.set(bg, (candidates.get(bg) || 0) + score);
  }

  // Trigrams ít quan trọng, chỉ score nhẹ
  for (const tg of ngrams(tokens, 3)) {
    candidates.set(tg, (candidates.get(tg) || 0) + 1);
  }

  // Sort by score desc, lấy top
  const sorted = Array.from(candidates.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([kw]) => kw);

  // Dedupe: nếu bigram chứa unigram, ưu tiên bigram, bỏ unigram
  // Vd: ["hoa don", "hoa", "don"] → giữ "hoa don", bỏ "hoa", "don"
  const final = [];
  for (const kw of sorted) {
    const isContainedInExisting = final.some(
      (existing) => existing.length > kw.length && existing.includes(kw),
    );
    if (isContainedInExisting) continue;

    // Cũng dedupe ngược: nếu kw chứa 1 cái đã có trong final với nội dung đầy đủ → skip kw
    const containsExisting = final.some(
      (existing) =>
        kw.length > existing.length &&
        kw.includes(existing) &&
        existing.split(" ").length >= 2,
    );
    if (containsExisting) continue;

    final.push(kw);
    if (final.length >= maxKeywords) break;
  }

  return final;
}

/**
 * Convert array keywords → string format "kw1|kw2|kw3" cho admin field.
 */
function keywordsToString(keywords) {
  return keywords.join("|");
}

// =============================================================================
// AI Enhancement
// =============================================================================

/**
 * Gọi AnythingLLM để extract keywords cao cấp hơn (synonym, related).
 *
 * @param {string} text
 * @param {object} context
 *   - source: "filename" | "question" | "tablename" | "faq"
 *   - additionalContext: extra info
 *   - existingKeywords: array keywords admin đã có (AI bổ sung, không trùng)
 * @param {function} callAI - function gọi AnythingLLM, signature: (prompt, opts) → Promise<{text}>
 * @returns {Promise<string[]>} array keywords mới
 */
async function extractKeywordsWithAI(text, context, callAI) {
  if (!text || !callAI) return [];

  const source = context.source || "general";
  const existing = context.existingKeywords || [];

  const sourceDescription =
    {
      filename: "tên file PDF/tài liệu trong kho lưu trữ",
      question: "câu hỏi mẫu của template SQL",
      tablename: "tên bảng và cột của database",
      faq: "câu hỏi thường gặp + câu trả lời",
      general: "đoạn văn bản chung",
    }[source] || "văn bản";

  const existingStr = existing.length
    ? `\n\nKeywords admin đã có (KHÔNG sinh trùng): ${existing.join(", ")}`
    : "";

  const additionalStr = context.additionalContext
    ? `\n\nThông tin bổ sung:\n${context.additionalContext}`
    : "";

  const prompt = `
Bạn là trợ lý phân tích văn bản tiếng Việt cho chatbot bệnh viện. Nhiệm vụ: trích xuất các từ khóa (keywords) mà user có thể dùng khi hỏi về chủ đề này.

Nguồn: ${sourceDescription}
Nội dung: "${String(text).slice(0, 500)}"${additionalStr}${existingStr}

Yêu cầu:
- Đề xuất 5-8 keywords TIẾNG VIỆT KHÔNG DẤU, viết thường (vd: "bang gia" thay vì "bảng giá").
- Bao gồm cả synonym/từ đồng nghĩa user thực tế hay dùng.
- Mỗi keyword là 1-3 từ.
- KHÔNG sinh từ chung chung như "the", "moi", "co".
- Tách bằng dấu "|", không có dấu cách thừa.
- Chỉ output các keywords, KHÔNG giải thích, KHÔNG tiêu đề, KHÔNG markdown.

Output:
`.trim();

  try {
    const { text: aiResponse } = await callAI(prompt, {
      mode: "chat",
      sessionId: `keyword-extract-${Date.now()}`,
      timeoutMs: 30000,
    });

    if (!aiResponse) return [];

    // Parse output: tách bằng |, trim, normalize, bỏ trống/quá dài
    const cleaned = String(aiResponse)
      .replace(/```[a-z]*\n?/gi, "")
      .replace(/```/g, "")
      .trim();

    const keywords = cleaned
      .split(/[|,\n]+/)
      .map((kw) => normalize(kw).trim())
      .filter((kw) => {
        if (!kw) return false;
        if (kw.length < 3 || kw.length > 50) return false;
        // Bỏ stopwords single-word
        if (kw.split(" ").length === 1 && VN_STOPWORDS.has(kw)) return false;
        // Bỏ giống existing
        if (existing.includes(kw)) return false;
        return true;
      });

    // Dedupe + limit
    return Array.from(new Set(keywords)).slice(0, 10);
  } catch (err) {
    console.warn("AI keyword extract fail:", err.message);
    return [];
  }
}

// =============================================================================
// Schema auto-generation từ MySQL DESCRIBE
// =============================================================================

/**
 * Từ kết quả DESCRIBE table của MySQL, generate columns_json + description sơ bộ
 * @param {string} tableName
 * @param {Array} describeRows - [{Field, Type, Null, Key, Default, Extra}, ...]
 * @returns {object} { columns_json, description, examples_json, domain }
 */
function generateSchemaFromDescribe(tableName, describeRows) {
  if (!Array.isArray(describeRows) || describeRows.length === 0) {
    return { columns_json: [], description: "", examples_json: [], domain: "" };
  }

  const columns = describeRows.map((row) => {
    const name = row.Field || row.field;
    const type = String(row.Type || row.type || "").toUpperCase();
    // Lấy base type (vd "varchar(255)" → "VARCHAR")
    const baseType = type.replace(/\(.*\)/, "").trim();

    // Auto-generate description từ tên cột
    const colDesc = humanizeColumnName(name);

    return {
      name,
      type: baseType,
      description: colDesc,
    };
  });

  // Auto-generate table description từ tableName
  const description = `Bảng ${humanizeColumnName(tableName)} - chứa ${columns.length} cột`;

  // Auto-generate examples (basic SELECT)
  const examples = [
    {
      question: `Có bao nhiêu ${humanizeColumnName(tableName)}?`,
      sql: `SELECT COUNT(*) AS total FROM ${tableName}`,
    },
  ];

  // Auto domain từ tên bảng
  const domain =
    normalize(humanizeColumnName(tableName)).split(" ")[0] || "data";

  return {
    columns_json: columns,
    description,
    examples_json: examples,
    domain,
  };
}

// Convert snake_case / camelCase → human readable
// vd: "patient_name" → "tên bệnh nhân"... thực tế chỉ split + capitalize
function humanizeColumnName(name) {
  if (!name) return "";
  return String(name)
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}

export {
  extractKeywordsHeuristic,
  extractKeywordsWithAI,
  keywordsToString,
  generateSchemaFromDescribe,
  humanizeColumnName,
  normalize as normalizeText,
};
