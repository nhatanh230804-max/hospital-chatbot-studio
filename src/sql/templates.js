// =============================================================================
// src/sql/templates.js - SQL Templates
// =============================================================================
import { dbReady, pool } from "../db.js";
import { normalizeVietnamese } from "../utils.js";
import { getDemoToday, getDemoTomorrow, getDemoYesterday } from "../config.js";
import { validateAndPrepareSql } from "./validator.js";
import { runSqlOnScope } from "./runner.js";
import { summarizeSqlResult } from "./summarizer.js";

const TEMPLATE_STOPWORDS = new Set([
  "ai",
  "co",
  "cua",
  "cac",
  "cho",
  "hom",
  "nay",
  "ngay",
  "nao",
  "khoa",
  "moi",
  "mot",
  "tung",
  "theo",
]);

const DEPARTMENT_STOPWORDS = new Set([
  "co",
  "nao",
  "moi",
  "tung",
  "cac",
  "bao",
  "nhieu",
  "luot",
  "kham",
  "dang",
  "truc",
  "hom",
  "nay",
]);

function tokenizeTemplateText(value) {
  return normalizeVietnamese(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !TEMPLATE_STOPWORDS.has(token));
}

function looksLikeEntityKeyword(keyword) {
  const kw = normalizeVietnamese(keyword);
  return (
    /^khoa\s+[a-z0-9\s]+$/.test(kw) ||
    /^benh\s+nhan\s+[a-z0-9\s]+$/.test(kw) ||
    /^hoa\s+don\s+[a-z0-9\s]+$/.test(kw)
  );
}

function templateIntentScore(text, tpl) {
  const intentText = [
    tpl.name,
    tpl.description,
    tpl.question_pattern,
    tpl.category,
  ].join(" ");
  const tokens = new Set(tokenizeTemplateText(intentText));
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += token.length;
  }
  return score;
}

function requiresDepartmentName(tpl) {
  return (
    String(tpl.sql_template || "").includes("{department}") &&
    /departments|khoa/i.test(
      [tpl.name, tpl.question_pattern, tpl.sql_template].join(" "),
    )
  );
}

export function matchSqlTemplate(question, templates) {
  const text = normalizeVietnamese(question);
  let best = null;
  let bestScore = 0;

  for (const tpl of templates) {
    if (requiresDepartmentName(tpl) && !extractDepartmentName(question)) {
      continue;
    }

    const keywords = String(tpl.keywords || "")
      .split("|")
      .map((kw) => normalizeVietnamese(kw))
      .filter(Boolean);
    if (!keywords.length) continue;

    const matched = keywords.filter((kw) => text.includes(kw));
    if (!matched.length) continue;

    const strongMatched = matched.filter((kw) => !looksLikeEntityKeyword(kw));
    const intentScore = templateIntentScore(text, tpl);
    if (!strongMatched.length && intentScore <= 0) continue;

    const score =
      matched.reduce((acc, kw) => acc + kw.length, 0) +
      strongMatched.length * 25 +
      intentScore;
    if (score > bestScore) {
      best = tpl;
      bestScore = score;
    }
  }
  return best;
}

export function extractDepartmentName(question) {
  const match = String(question || "").match(
    /khoa\s+([A-Za-zÀ-ỹà-ỹ]+(?:\s+[A-Za-zÀ-ỹà-ỹ]+)?)/i,
  );
  if (!match) return null;
  const words = match[1]
    .split(/\s+/)
    .filter((word) => !DEPARTMENT_STOPWORDS.has(normalizeVietnamese(word)));
  if (!words.length) return null;
  const name = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return `Khoa ${name}`;
}

export function resolvePlaceholders(sqlTemplate, question) {
  let sql = String(sqlTemplate || "");
  sql = sql.replaceAll("{DEMO_TODAY}", getDemoToday());
  sql = sql.replaceAll("{DEMO_TOMORROW}", getDemoTomorrow());
  sql = sql.replaceAll("{DEMO_YESTERDAY}", getDemoYesterday());

  if (sql.includes("{department}")) {
    const dept = extractDepartmentName(question);
    if (dept) {
      const safe = dept.replace(/'/g, "''");
      sql = sql.replaceAll("{department}", safe);
    } else {
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
    console.warn("Khong tai duoc sql_templates:", error.message);
    return [];
  }
}

export async function tryAnswerWithTemplate(question, options = {}) {
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
      `Template #${match.id} tao SQL khong hop le:`,
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
      reply: await summarizeSqlResult(question, validation.sql, rows, options),
      connectionId: match.connection_id,
      database: match.connection_database,
    };
  } catch (error) {
    console.warn(`Template #${match.id} chay fail:`, error.message);
    return null;
  }
}
