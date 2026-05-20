// =============================================================================
// src/sql/templates.js — SQL Templates (Class "Dạy SQL")
// =============================================================================
// Mỗi template có:
//   - keywords: pipe-separated, dùng để match câu hỏi user
//   - sql_template: SELECT mẫu, có thể chứa placeholder {DEMO_TODAY},
//     {DEMO_TOMORROW}, {department}, ... — backend resolve trước khi chạy
// Có 2 cách dùng:
//   1. Match trực tiếp: nếu câu hỏi match keywords của 1 template → resolve placeholder
//      và chạy SQL ngay, không gọi AI
//   2. Đưa vào prompt AI làm few-shot examples
// =============================================================================
import { dbReady, pool } from "../db.js";
import { normalizeVietnamese } from "../utils.js";
import { getDemoToday, getDemoTomorrow, getDemoYesterday } from "../config.js";
import { validateAndPrepareSql } from "./validator.js";
import { runSqlOnScope } from "./runner.js";
import { summarizeSqlResult } from "./summarizer.js";

export function matchSqlTemplate(question, templates) {
  const text = normalizeVietnamese(question);
  let best = null;
  let bestScore = 0;

  for (const tpl of templates) {
    const keywords = String(tpl.keywords || "")
      .split("|")
      .map((kw) => normalizeVietnamese(kw))
      .filter(Boolean);
    if (!keywords.length) continue;

    const matched = keywords.filter((kw) => text.includes(kw));
    if (matched.length === 0) continue;
    // Ưu tiên template có nhiều keyword match nhất, ưu tiên keyword dài hơn (cụ thể hơn)
    const score = matched.reduce((acc, kw) => acc + kw.length, 0);
    if (score > bestScore) {
      best = tpl;
      bestScore = score;
    }
  }
  return best;
}

export function extractDepartmentName(question) {
  // Tìm "khoa X" trong câu hỏi
  const match = String(question).match(/khoa\s+([A-Za-zÀ-ỹà-ỹ]+)/i);
  if (!match) return null;
  // Capitalize: "ngoại" → "Ngoại", "noi" → "Nội" (đơn giản hoá)
  const word = match[1];
  return `Khoa ${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

export function resolvePlaceholders(sqlTemplate, question) {
  let sql = String(sqlTemplate || "");
  sql = sql.replaceAll("{DEMO_TODAY}", getDemoToday());
  sql = sql.replaceAll("{DEMO_TOMORROW}", getDemoTomorrow());
  sql = sql.replaceAll("{DEMO_YESTERDAY}", getDemoYesterday());

  // {department}: thử bắt tên khoa từ câu hỏi
  if (sql.includes("{department}")) {
    const dept = extractDepartmentName(question);
    if (dept) {
      // Escape single quotes phòng injection (template đã trong quotes)
      const safe = dept.replace(/'/g, "''");
      sql = sql.replaceAll("{department}", safe);
    } else {
      // Không tìm được tên khoa → bỏ wildcard cho khỏi match-all
      sql = sql.replaceAll("{department}", "__NO_MATCH__");
    }
  }

  return sql;
}

export async function loadActiveSqlTemplates() {
  if (!dbReady || !pool) return [];
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, connection_id, connection_database, description,
              question_pattern, keywords, sql_template, category
       FROM sql_templates WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 100`,
    );
    return rows;
  } catch (error) {
    console.warn("Không tải được sql_templates:", error.message);
    return [];
  }
}

export async function tryAnswerWithTemplate(question) {
  const templates = await loadActiveSqlTemplates();
  if (!templates.length) return null;

  const match = matchSqlTemplate(question, templates);
  if (!match) return null;

  const resolvedSql = resolvePlaceholders(match.sql_template, question);
  if (resolvedSql.includes("__NO_MATCH__")) return null;

  const validation = await validateAndPrepareSql(
    resolvedSql,
    match.connection_id,
    match.connection_database,
  );
  if (!validation.ok) {
    console.warn(
      `Template #${match.id} tạo SQL không hợp lệ:`,
      validation.reason,
    );
    return null;
  }

  try {
    const rows = await runSqlOnScope(
      validation.sql,
      match.connection_id,
      match.connection_database,
    );
    // Update usage stats
    pool
      .execute(
        `UPDATE sql_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ?`,
        [match.id],
      )
      .catch((err) => console.warn("Update usage_count fail:", err.message));

    return {
      ok: true,
      templateId: match.id,
      templateName: match.name,
      sql: validation.sql,
      rows,
      reply: await summarizeSqlResult(question, validation.sql, rows),
      connectionId: match.connection_id,
      database: match.connection_database,
    };
  } catch (error) {
    console.warn(`Template #${match.id} chạy fail:`, error.message);
    return null;
  }
}
