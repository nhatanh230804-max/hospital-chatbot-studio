// =============================================================================
// src/sql/nl2sql.js — NL→SQL via AnythingLLM, using schema_metadata + templates
// =============================================================================
import { dbReady, pool } from "../db.js";
import { safeJsonParse, normalizeVietnamese } from "../utils.js";
import { getDemoToday, getDemoTomorrow, getDemoYesterday } from "../config.js";
import { callAnythingLLM, isAnythingLLMConfigured } from "../anythingllm.js";
import { validateAndPrepareSql } from "./validator.js";
import { loadActiveSqlTemplates, tryAnswerWithTemplate } from "./templates.js";
import { runSqlOnScope } from "./runner.js";
import { summarizeSqlResult } from "./summarizer.js";

export function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Không parse được JSON từ model.");
  }
}

export async function getSchemaPromptBlock() {
  if (!dbReady || !pool) return "";
  try {
    const [rows] = await pool.execute(
      `SELECT s.table_name, s.connection_id, s.connection_database, s.domain,
              s.description, s.columns_json, s.examples_json,
              c.name AS connection_name, c.type AS connection_type
       FROM schema_metadata s
       LEFT JOIN data_connections c ON c.id = s.connection_id
       WHERE s.is_active = TRUE ORDER BY s.id ASC LIMIT 30`
    );
    if (!rows.length) return "";

    // Group theo scope (connection_id, database)
    const groups = new Map();
    for (const row of rows) {
      const scopeLabel = row.connection_id
        ? `Database "${row.connection_database || row.connection_name}" (qua connection #${row.connection_id})`
        : `Database CHÍNH (mặc định)`;
      if (!groups.has(scopeLabel)) groups.set(scopeLabel, []);
      groups.get(scopeLabel).push(row);
    }

    const blocks = [];
    for (const [scopeLabel, tables] of groups.entries()) {
      const tableBlocks = tables.map((row) => {
        const columns = safeJsonParse(row.columns_json, []);
        const examples = safeJsonParse(row.examples_json, []);
        const colText = columns.map((col) => {
          const enumText = col.enum ? ` enum: ${JSON.stringify(col.enum)}` : "";
          return `- ${col.name} ${col.type || ""}: ${col.description || ""}${enumText}`;
        }).join("\n");
        const exText = examples.map((ex) => `Q: ${ex.question}\nSQL: ${ex.sql}`).join("\n");
        return `Bảng ${row.table_name}\nDomain: ${row.domain || ""}\nMô tả: ${row.description || ""}\nCột:\n${colText}\nVí dụ:\n${exText}`;
      }).join("\n\n");
      blocks.push(`### ${scopeLabel} ###\n\n${tableBlocks}`);
    }

    return blocks.join("\n\n---\n\n");
  } catch (error) {
    console.warn("Không đọc được schema_metadata:", error.message);
    return "";
  }
}

// Lookup connection cho 1 bảng cụ thể (dùng khi AI sinh SQL xong, backend xác định pool)
export async function lookupConnectionForTable(tableName) {
  if (!dbReady || !pool) return { connection_id: null, connection_database: null };
  try {
    const [rows] = await pool.execute(
      `SELECT connection_id, connection_database FROM schema_metadata
       WHERE table_name = ? AND is_active = TRUE LIMIT 1`,
      [tableName]
    );
    if (!rows.length) return { connection_id: null, connection_database: null };
    return rows[0];
  } catch {
    return { connection_id: null, connection_database: null };
  }
}

export async function getSqlTemplatesPromptBlock() {
  const templates = await loadActiveSqlTemplates();
  if (!templates.length) return "";
  return templates.slice(0, 15).map((t) => `Q: ${t.question_pattern}\nSQL: ${t.sql_template}`).join("\n\n");
}

export async function generateSqlFromQuestion(question, context = null) {
  const safeQuestion = String(question || "").replaceAll('"', '\\"');
  const schemaBlock = await getSchemaPromptBlock();
  const templatesBlock = await getSqlTemplatesPromptBlock();

  const shouldUseContext = context && /con lai|còn lại|the con|thế còn|cac khoa con lai|các khoa còn lại/i.test(normalizeVietnamese(question));
  const contextBlock = shouldUseContext ? `
Ngữ cảnh câu hỏi trước:
- Câu hỏi trước: ${context.question}
- SQL trước: ${context.sql}
Nếu câu hỏi hiện tại là follow-up như "còn lại", "thế còn", hãy dùng ngữ cảnh trên.
` : "";

  const prompt = `
Bạn là bộ chuyển câu hỏi tiếng Việt thành MySQL SELECT query cho hệ thống bệnh viện đa database.

CHỈ trả về JSON hợp lệ đúng format:
{"sql":"SELECT ...","reason":null}

Nếu không liên quan database bệnh viện:
{"sql":null,"reason":"Câu hỏi không liên quan database"}

Schema được phép dùng (chú ý mỗi bảng thuộc 1 database cụ thể):

${schemaBlock || "(không có schema metadata)"}

${templatesBlock ? `Các SQL mẫu admin đã dạy:\n\n${templatesBlock}\n` : ""}

Ngày demo:
- Hôm nay = '${getDemoToday()}'
- Ngày mai = '${getDemoTomorrow()}'
- Hôm qua = '${getDemoYesterday()}'

Luật bắt buộc:
- Chỉ tạo SELECT (KHÔNG INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/SET).
- Chỉ dùng các bảng trong schema metadata phía trên.
- KHÔNG được JOIN bảng giữa 2 database khác nhau — câu hỏi chỉ liên quan tới đúng 1 database.
- Tên bảng KHÔNG được prefix database (vd dùng "invoices" KHÔNG dùng "hospital_billing.invoices") — backend sẽ tự route đúng database.
- Nếu hỏi lượt khám của khoa, dùng departments.name và departments.visits.
- Nếu hỏi tổng lượt khám, dùng COALESCE(SUM(visits), 0) AS total_visits.
- "trực" hoặc "đang trực" = status = 'Đang trực'.
- "sắp trực" = status = 'Sắp trực'.
- Nếu hỏi "bao nhiêu nhân sự", dùng COUNT(*) AS total.
- Nếu hỏi "cao nhất/nhiều nhất", dùng ORDER BY ... DESC LIMIT 1.
- Nếu không hỏi số lượng/tổng, thêm LIMIT 20.

${contextBlock}

Câu hỏi: "${safeQuestion}"
`.trim();

  const { text } = await callAnythingLLM(prompt, {
    mode: "chat",
    sessionId: `hospital-nl2sql-${Date.now()}`,
    timeoutMs: 45000
  });
  const parsed = extractJsonObject(text);
  return { sql: parsed.sql || null, reason: parsed.reason || null, raw: text };
}

export async function answerWithSqlPlan(question, plan) {
  if (!dbReady || !pool) return { ok: false, reply: "MySQL chưa kết nối nên chưa kiểm tra được dữ liệu." };
  if (!plan || !plan.sql) return { ok: false, reply: plan?.reason || "Không tạo được SQL." };

  // Phát hiện bảng từ SQL → suy ra connection cần dùng
  const tableMatch = plan.sql.match(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/i);
  let connectionId = null;
  let database = null;
  if (tableMatch) {
    const info = await lookupConnectionForTable(tableMatch[1]);
    connectionId = info.connection_id;
    database = info.connection_database;
  }

  const validation = await validateAndPrepareSql(plan.sql, connectionId, database);
  if (!validation.ok) return { ok: false, reply: `SQL bị chặn: ${validation.reason}` };

  try {
    const rows = await runSqlOnScope(validation.sql, connectionId, database);
    return {
      ok: true,
      reply: await summarizeSqlResult(question, validation.sql, rows),
      sql: validation.sql,
      rows,
      originalSql: plan.sql,
      connectionId,
      database
    };
  } catch (dbError) {
    console.error("DB error:", dbError.message);
    return { ok: false, reply: "Không truy vấn được dữ liệu. Vui lòng thử câu hỏi khác." };
  }
}

export async function answerWithSql(question, context = null) {
  // Bước 1: thử match SQL template trước (nhanh, không tốn AI call)
  const tplResult = await tryAnswerWithTemplate(question);
  if (tplResult && tplResult.ok) {
    return {
      ok: true,
      reply: tplResult.reply,
      sql: tplResult.sql,
      rows: tplResult.rows,
      originalSql: `[template #${tplResult.templateId}: ${tplResult.templateName}]`,
      viaTemplate: true
    };
  }

  // Bước 2: gọi AnythingLLM để tạo SQL
  if (!isAnythingLLMConfigured()) {
    return { ok: false, reply: "Chưa cấu hình AnythingLLM trong .env." };
  }
  try {
    const plan = await generateSqlFromQuestion(question, context);
    if (!plan.sql) return { ok: false, reply: plan.reason || "Model không tạo được SQL." };
    return await answerWithSqlPlan(question, plan);
  } catch (error) {
    return { ok: false, reply: `Lỗi khi gọi AI tạo SQL: ${error.message}` };
  }
}
