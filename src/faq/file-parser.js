// =============================================================================
// src/faq/file-parser.js — Parse uploaded FAQ files (.txt/.md/.docx/.pdf) → text
// =============================================================================
import fs from "fs";
import mammoth from "mammoth";
import { createRequire } from "module";

// pdf-parse là CJS, dùng createRequire để tránh side-effect khi import
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

export async function parseFaqFile(filePath, ext) {
  const lower = ext.toLowerCase();
  if (lower === ".txt" || lower === ".md") {
    return fs.readFileSync(filePath, "utf8");
  }
  if (lower === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || "";
  }
  if (lower === ".pdf") {
    const buffer = fs.readFileSync(filePath);
    const result = await pdfParse(buffer);
    return result.text || "";
  }
  throw new Error("Định dạng file không hỗ trợ.");
}
