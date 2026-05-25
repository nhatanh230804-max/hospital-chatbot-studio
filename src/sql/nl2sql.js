// =============================================================================
// src/sql/nl2sql.js - NL to SQL via AnythingLLM, schema retrieval, templates
// =============================================================================
import { dbReady, pool } from "../db.js";
import {
  assertSafeSqlIdentifier,
  normalizeVietnamese,
  quoteMysqlIdentifier,
} from "../utils.js";
import { getDemoToday, getDemoTomorrow, getDemoYesterday } from "../config.js";
import { callAnythingLLM, isAnythingLLMConfigured } from "../anythingllm.js";
import { validateAndPrepareSql } from "./validator.js";
import { loadActiveSqlTemplates, tryAnswerWithTemplate } from "./templates.js";
import { runSqlOnScope } from "./runner.js";
import { summarizeSqlResult } from "./summarizer.js";
import { jsonArray, rankSchemaRows } from "./schema-retriever.js";

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Khong parse duoc JSON tu model.");
  }
}

function replaceDemoDatePlaceholders(sql) {
  return String(sql || "")
    .replaceAll("{DEMO_TODAY}", getDemoToday())
    .replaceAll("{DEMO_TOMORROW}", getDemoTomorrow())
    .replaceAll("{DEMO_YESTERDAY}", getDemoYesterday());
}

export async function getRelevantSchemaRows(question = "") {
  if (!dbReady || !pool) return [];
  try {
    const [rows] = await pool.execute(
      `SELECT s.table_name, s.connection_id, s.connection_database, s.domain,
              s.description, s.columns_json, s.examples_json,
              c.name AS connection_name, c.type AS connection_type
       FROM schema_metadata s
       LEFT JOIN data_connections c ON c.id = s.connection_id
       WHERE s.is_active = TRUE ORDER BY s.id ASC LIMIT 300`,
    );
    if (!rows.length) return [];
    return question ? rankSchemaRows(question, rows, 8) : rows;
  } catch (error) {
    console.warn("Khong doc duoc schema_metadata:", error.message);
    return [];
  }
}

function isTextLikeColumn(col) {
  const type = String(col.type || "").toLowerCase();
  return /char|text|enum|set/.test(type);
}

function shouldSampleColumn(question, row, col) {
  if (!isTextLikeColumn(col)) return false;
  if (Array.isArray(col.enum) && col.enum.length) return true;

  const q = normalizeVietnamese(question);
  const colText = normalizeVietnamese(
    [
      row.table_name,
      row.domain,
      row.description,
      col.name,
      String(col.name || "").replaceAll("_", " "),
      col.description,
    ].join(" "),
  );
  const tokens = q.split(/\s+/).filter((token) => token.length >= 3);
  return tokens.some((token) => colText.includes(token));
}

function quoteIdentifierForScope(value, connectionType) {
  const safe = assertSafeSqlIdentifier(value);
  if (connectionType === "postgres") {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return quoteMysqlIdentifier(safe);
}

async function loadColumnSampleValues(row, col) {
  const connectionType = row.connection_type || "mysql";
  const table = quoteIdentifierForScope(row.table_name, connectionType);
  const column = quoteIdentifierForScope(col.name, connectionType);
  const countSql = `SELECT COUNT(DISTINCT ${column}) AS total FROM ${table} WHERE ${column} IS NOT NULL`;
  const countRows = await runSqlOnScope(
    countSql,
    row.connection_id,
    row.connection_database,
  );
  const total = Number(countRows?.[0]?.total || countRows?.[0]?.count || 0);
  if (!total || total > 50) return [];

  const sampleSql = `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column} LIMIT 20`;
  const rows = await runSqlOnScope(
    sampleSql,
    row.connection_id,
    row.connection_database,
  );
  return rows
    .map((item) => item.value)
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value))
    .slice(0, 20);
}

export async function enrichSchemaRowsWithSamples(question, rows) {
  const enriched = [];
  for (const row of rows.slice(0, 5)) {
    const columns = jsonArray(row.columns_json);
    const nextColumns = [];
    let sampled = 0;
    for (const col of columns) {
      const nextCol = { ...col };
      if (shouldSampleColumn(question, row, col) && sampled < 6) {
        try {
          const samples = await loadColumnSampleValues(row, col);
          if (samples.length) {
            nextCol.sample_values = Array.from(
              new Set([...(jsonArray(col.sample_values) || []), ...samples]),
            ).slice(0, 20);
            sampled++;
          }
        } catch (error) {
          console.warn(
            `Khong lay duoc sample values cho ${row.table_name}.${col.name}:`,
            error.message,
          );
        }
      }
      nextColumns.push(nextCol);
    }
    enriched.push({ ...row, columns_json: nextColumns });
  }
  return [...enriched, ...rows.slice(enriched.length)];
}

function getKnownColumnValues(schemaRows) {
  const valuesByColumn = new Map();
  for (const row of schemaRows || []) {
    for (const col of jsonArray(row.columns_json)) {
      const values = [
        ...(Array.isArray(col.enum) ? col.enum : []),
        ...(Array.isArray(col.sample_values) ? col.sample_values : []),
      ].map((value) => String(value));
      if (!values.length) continue;
      const key = String(col.name || "").toLowerCase();
      if (!valuesByColumn.has(key)) valuesByColumn.set(key, []);
      valuesByColumn.get(key).push(...values);
    }
  }
  return valuesByColumn;
}

function findKnownValueMatch(rawValue, knownValues) {
  const normalizedRaw = normalizeVietnamese(rawValue);
  if (!normalizedRaw) return null;
  for (const known of knownValues || []) {
    const normalizedKnown = normalizeVietnamese(known);
    if (
      normalizedKnown === normalizedRaw ||
      normalizedKnown.includes(normalizedRaw) ||
      normalizedRaw.includes(normalizedKnown)
    ) {
      return known;
    }
  }
  return null;
}

function repairSqlWithKnownValues(sql, schemaRows) {
  const knownValues = getKnownColumnValues(schemaRows);
  return String(sql || "").replace(
    /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*'([^']+)'/g,
    (match, column, value) => {
      const replacement = findKnownValueMatch(
        value,
        knownValues.get(String(column).toLowerCase()),
      );
      if (!replacement || replacement === value) return match;
      return `${column} = '${String(replacement).replace(/'/g, "''")}'`;
    },
  );
}

export function buildSchemaPromptBlock(relevantRows) {
  if (!Array.isArray(relevantRows) || !relevantRows.length) return "";

  const groups = new Map();
  for (const row of relevantRows) {
    const scopeLabel = row.connection_id
      ? `Database "${row.connection_database || row.connection_name}" (connection #${row.connection_id})`
      : "Database CHINH";
    if (!groups.has(scopeLabel)) groups.set(scopeLabel, []);
    groups.get(scopeLabel).push(row);
  }

  const blocks = [];
  for (const [scopeLabel, tables] of groups.entries()) {
    const tableBlocks = tables
      .map((row) => {
        const columns = jsonArray(row.columns_json);
        const examples = jsonArray(row.examples_json);
        const colText = columns
          .map((col) => {
            const enumText = Array.isArray(col.enum)
              ? ` enum: ${JSON.stringify(col.enum)}`
              : "";
            const sampleText = Array.isArray(col.sample_values)
              ? ` sample_values: ${JSON.stringify(col.sample_values)}`
              : "";
            return `- ${col.name} ${col.type || ""}: ${col.description || ""}${enumText}${sampleText}`;
          })
          .join("\n");
        const exText = examples
          .map((ex) => `Q: ${ex.question}\nSQL: ${ex.sql}`)
          .join("\n");
        return [
          `Bang ${row.table_name}`,
          `Domain: ${row.domain || ""}`,
          `Mo ta: ${row.description || ""}`,
          "Cot:",
          colText,
          "Vi du:",
          exText,
        ].join("\n");
      })
      .join("\n\n");
    blocks.push(`### ${scopeLabel} ###\n\n${tableBlocks}`);
  }

  return blocks.join("\n\n---\n\n");
}

export async function getSchemaPromptBlock(question = "") {
  return buildSchemaPromptBlock(await getRelevantSchemaRows(question));
}

export async function lookupConnectionForTable(tableName, schemaRows = null) {
  const normalizedTable = String(tableName || "").toLowerCase();
  const scopedMatches = Array.isArray(schemaRows)
    ? schemaRows.filter(
        (row) => String(row.table_name || "").toLowerCase() === normalizedTable,
      )
    : [];
  if (scopedMatches.length === 1) {
    const scopedMatch = scopedMatches[0];
    return {
      connection_id: scopedMatch.connection_id,
      connection_database: scopedMatch.connection_database,
    };
  }
  if (scopedMatches.length > 1) {
    return {
      connection_id: null,
      connection_database: null,
      ambiguous: true,
      matches: scopedMatches.map((row) => ({
        connection_id: row.connection_id,
        connection_database: row.connection_database,
      })),
    };
  }

  if (!dbReady || !pool) {
    return { connection_id: null, connection_database: null };
  }
  try {
    const [rows] = await pool.execute(
      `SELECT connection_id, connection_database FROM schema_metadata
       WHERE table_name = ? AND is_active = TRUE`,
      [tableName],
    );
    if (!rows.length) return { connection_id: null, connection_database: null };
    if (rows.length > 1) {
      return {
        connection_id: null,
        connection_database: null,
        ambiguous: true,
        matches: rows,
      };
    }
    return rows[0];
  } catch {
    return { connection_id: null, connection_database: null };
  }
}

export async function getSqlTemplatesPromptBlock() {
  const templates = await loadActiveSqlTemplates();
  if (!templates.length) return "";
  return templates
    .slice(0, 15)
    .map((t) => `Q: ${t.question_pattern}\nSQL: ${t.sql_template}`)
    .join("\n\n");
}

export async function generateSqlFromQuestion(question, context = null) {
  const safeQuestion = String(question || "").replaceAll('"', '\\"');
  const schemaRows = await enrichSchemaRowsWithSamples(
    question,
    await getRelevantSchemaRows(question),
  );
  const schemaBlock = buildSchemaPromptBlock(schemaRows);
  const templatesBlock = await getSqlTemplatesPromptBlock();

  const shouldUseContext =
    context &&
    /con lai|the con|cac khoa con lai/i.test(normalizeVietnamese(question));
  const contextBlock = shouldUseContext
    ? `
Ngu canh cau hoi truoc:
- Cau hoi truoc: ${context.question}
- SQL truoc: ${context.sql}
Neu cau hoi hien tai la follow-up nhu "con lai", "the con", hay dung ngu canh tren.
`
    : "";

  const prompt = `
Ban la bo chuyen cau hoi tieng Viet thanh MySQL SELECT query cho he thong benh vien da database.

CHI tra ve JSON hop le dung format:
{"sql":"SELECT ...","reason":null}

Neu khong lien quan database benh vien:
{"sql":null,"reason":"Cau hoi khong lien quan database"}

Schema duoc phep dung:

${schemaBlock || "(khong co schema metadata)"}

${templatesBlock ? `Cac SQL mau admin da day:\n\n${templatesBlock}\n` : ""}

Ngay demo:
- Hom nay = '${getDemoToday()}'
- Ngay mai = '${getDemoTomorrow()}'
- Hom qua = '${getDemoYesterday()}'

Luat bat buoc:
- Chi tao SELECT. Khong INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/SET.
- Chi dung cac bang trong schema metadata phia tren.
- Khong JOIN bang giua 2 database khac nhau.
- Ten bang khong duoc prefix database. Backend se route dung database.
- Uu tien SQL mau va vi du trong schema metadata neu khop y dinh cau hoi.
- Voi cot enum, chi dung dung gia tri enum da ghi trong schema metadata.
- Voi cot co sample_values, dung dung gia tri gan nhat trong sample_values khi loc WHERE.
- Neu hoi so luong/tong so/bao nhieu ban ghi, dung COUNT(*) AS total khi phu hop.
- Neu hoi tong tien/tong luot/tong gia tri, dung SUM(cot so phu hop) khi schema co cot tuong ung.
- Neu hoi cao nhat/nhieu nhat/top, dung ORDER BY cot phu hop DESC LIMIT N.
- Neu hoi thap nhat/it nhat, dung ORDER BY cot phu hop ASC LIMIT N.
- Neu khong hoi so luong/tong, them LIMIT 20.

${contextBlock}

Cau hoi: "${safeQuestion}"
`.trim();

  const { text } = await callAnythingLLM(prompt, {
    mode: "chat",
    sessionId: `hospital-nl2sql-${Date.now()}`,
    timeoutMs: 45000,
  });
  const parsed = extractJsonObject(text);
  return {
    sql: parsed.sql ? replaceDemoDatePlaceholders(parsed.sql) : null,
    reason: parsed.reason || null,
    raw: text,
    schemaRows,
  };
}

export async function answerWithSqlPlan(question, plan) {
  if (!dbReady || !pool) {
    return {
      ok: false,
      reply: "MySQL chua ket noi nen chua kiem tra duoc du lieu.",
    };
  }
  if (!plan || !plan.sql) {
    return { ok: false, reply: plan?.reason || "Khong tao duoc SQL." };
  }

  const executableSql = repairSqlWithKnownValues(plan.sql, plan.schemaRows);
  const tableMatch = executableSql.match(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/i);
  let connectionId = null;
  let database = null;
  if (tableMatch) {
    const info = await lookupConnectionForTable(tableMatch[1], plan.schemaRows);
    if (info.ambiguous) {
      return {
        ok: false,
        reply: `Bang "${tableMatch[1]}" ton tai o nhieu database, nen he thong khong route truy van de tranh doc sai du lieu. Vui long hoi cu the hon hoac cap nhat schema metadata/template cho bang nay.`,
      };
    }
    connectionId = info.connection_id;
    database = info.connection_database;
  }

  const validation = await validateAndPrepareSql(
    executableSql,
    connectionId,
    database,
  );
  if (!validation.ok) {
    return { ok: false, reply: `SQL bi chan: ${validation.reason}` };
  }

  try {
    const rows = await runSqlOnScope(validation.sql, connectionId, database);
    return {
      ok: true,
      reply: await summarizeSqlResult(question, validation.sql, rows),
      sql: validation.sql,
      rows,
      originalSql: plan.sql,
      connectionId,
      database,
    };
  } catch (dbError) {
    console.error("DB error:", dbError.message);
    return {
      ok: false,
      reply: "Khong truy van duoc du lieu. Vui long thu cau hoi khac.",
    };
  }
}

export async function answerWithSql(question, context = null) {
  const tplResult = await tryAnswerWithTemplate(question);
  if (tplResult && tplResult.ok) {
    return {
      ok: true,
      reply: tplResult.reply,
      sql: tplResult.sql,
      rows: tplResult.rows,
      originalSql: `[template #${tplResult.templateId}: ${tplResult.templateName}]`,
      viaTemplate: true,
    };
  }

  if (!isAnythingLLMConfigured()) {
    return { ok: false, reply: "Chua cau hinh AnythingLLM trong .env." };
  }
  try {
    const plan = await generateSqlFromQuestion(question, context);
    if (!plan.sql) {
      return { ok: false, reply: plan.reason || "Model khong tao duoc SQL." };
    }
    return await answerWithSqlPlan(question, plan);
  } catch (error) {
    return { ok: false, reply: `Loi khi goi AI tao SQL: ${error.message}` };
  }
}
