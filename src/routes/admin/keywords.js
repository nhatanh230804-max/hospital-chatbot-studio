// =============================================================================
// src/routes/admin/keywords.js — AI-powered keyword/schema suggestion +
//                                list-tables + auto-import-schema
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { quoteMysqlIdentifier, safeJsonParse } from "../../utils.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { asyncHandler } from "../../middleware.js";
import { isAnythingLLMConfigured, callAnythingLLM } from "../../anythingllm.js";
import {
  extractKeywordsHeuristic,
  extractKeywordsWithAI,
  generateSchemaFromDescribe,
} from "../../../lib/keyword-extractor.js";
import {
  getPoolForConnection,
  runQuery,
} from "../../../lib/connection-manager.js";
import { decryptConfigSecrets } from "../../connections/encryption.js";
import { invalidateAllowedTableCache } from "../../sql/validator.js";
import { invalidateDataQuestionCache } from "../../router/data-question.js";

const router = express.Router();

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function loadSchemaImportContext(connectionId, database) {
  if (!connectionId) {
    return { connType: "mysql", externalPool: null };
  }

  const [connRows] = await pool.execute(
    `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
    [connectionId],
  );
  if (!connRows.length) {
    const err = new Error("Connection không tồn tại.");
    err.statusCode = 404;
    throw err;
  }

  const conn = connRows[0];
  const config = decryptConfigSecrets(
    conn.type,
    safeJsonParse(conn.config_json, {}),
  );
  const externalPool = await getPoolForConnection({
    id: conn.id,
    database,
    type: conn.type,
    config,
  });
  return { connType: conn.type, externalPool };
}

async function importOneSchemaTable({
  tableName,
  connectionId,
  database,
  connType,
  externalPool,
}) {
  let describeRows = [];
  if (!connectionId) {
    const [rows] = await pool.query(
      `DESCRIBE ${quoteMysqlIdentifier(tableName, "table_name")}`,
    );
    describeRows = rows;
  } else if (connType === "mysql") {
    describeRows = await runQuery(
      externalPool,
      "mysql",
      `DESCRIBE ${quoteMysqlIdentifier(tableName, "table_name")}`,
    );
  } else if (connType === "postgres") {
    describeRows = await runQuery(
      externalPool,
      "postgres",
      `SELECT column_name AS "Field", data_type AS "Type"
       FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [tableName],
    );
  } else {
    throw new Error(`Type ${connType} không support auto import schema.`);
  }

  if (!describeRows.length) {
    return { table: tableName, status: "skipped", reason: "DESCRIBE trống" };
  }

  const [existingRows] = await pool.execute(
    `SELECT id, columns_json, description, domain, examples_json, is_active FROM schema_metadata
     WHERE table_name = ?
     AND (connection_id ${connectionId ? "= ?" : "IS NULL"})
     ${connectionId && database ? "AND connection_database = ?" : ""}
     LIMIT 1`,
    connectionId
      ? database
        ? [tableName, connectionId, database]
        : [tableName, connectionId]
      : [tableName],
  );

  const generated = generateSchemaFromDescribe(tableName, describeRows);
  const generatedKeywords = extractKeywordsHeuristic(tableName, {
    source: "tablename",
    additionalContext: generated.columns_json.map((c) => c.name).join(" "),
  });

  if (existingRows.length > 0) {
    const old = existingRows[0];
    const wasDisabled = old.is_active === 0 || old.is_active === false;
    const oldColumns = safeJsonParse(old.columns_json, []);
    const oldColumnNames = new Set(
      oldColumns.map((c) => String(c.name).toLowerCase()),
    );
    const newColumns = generated.columns_json.filter(
      (c) => !oldColumnNames.has(String(c.name).toLowerCase()),
    );

    if (newColumns.length === 0 && !wasDisabled) {
      return { table: tableName, status: "skipped", reason: "Schema đã đầy đủ" };
    }

    const mergedColumns =
      newColumns.length > 0 ? [...oldColumns, ...newColumns] : oldColumns;
    await pool.execute(
      `UPDATE schema_metadata SET columns_json = ?, is_active = TRUE, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(mergedColumns), old.id],
    );

    return {
      table: tableName,
      status: wasDisabled ? "revived" : "updated",
      newColumns: newColumns.map((c) => c.name),
      totalColumns: mergedColumns.length,
      revived: wasDisabled,
    };
  }

  await pool.execute(
    `INSERT INTO schema_metadata (table_name, connection_id, connection_database, domain, description, columns_json, examples_json, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [
      tableName,
      connectionId,
      database,
      generated.domain,
      generated.description +
        (generatedKeywords.length
          ? ` Keywords: ${generatedKeywords.join(", ")}`
          : ""),
      JSON.stringify(generated.columns_json),
      JSON.stringify(generated.examples_json),
    ],
  );

  return {
    table: tableName,
    status: "imported",
    columns: generated.columns_json.length,
    keywords: generatedKeywords,
  };
}

// -----------------------------------------------------------------------------
// AI-powered keyword suggestion (chung cho FAQ, Template, File, Schema)
// -----------------------------------------------------------------------------
// Request: { text, source, additionalContext?, existingKeywords? }
// Response: { ok, keywords: string[], method: 'heuristic' | 'ai' }
// -----------------------------------------------------------------------------
router.post("/api/admin/suggest-keywords", requireAdmin, asyncHandler(async (req, res) => {
  const text = String(req.body.text || "").trim();
  const source = String(req.body.source || "general").trim();
  const additionalContext = String(req.body.additionalContext || "").trim();
  const existingKeywords = Array.isArray(req.body.existingKeywords)
    ? req.body.existingKeywords
    : [];
  const useAI = req.body.useAI !== false; // default true

  if (!text) {
    return res.status(400).json({ error: "Thiếu text." });
  }

  // Heuristic luôn chạy
  const heuristic = extractKeywordsHeuristic(text, {
    source,
    additionalContext,
    maxKeywords: 8,
  });

  // Nếu không yêu cầu AI, return heuristic
  if (!useAI || !isAnythingLLMConfigured()) {
    return res.json({ ok: true, keywords: heuristic, method: "heuristic" });
  }

  // Gọi AI bổ sung
  try {
    const aiKeywords = await extractKeywordsWithAI(
      text,
      {
        source,
        additionalContext,
        existingKeywords: [...heuristic, ...existingKeywords],
      },
      callAnythingLLM,
    );

    // Merge: heuristic + AI, dedupe
    const merged = Array.from(new Set([...heuristic, ...aiKeywords])).slice(
      0,
      12,
    );

    res.json({
      ok: true,
      keywords: merged,
      method: aiKeywords.length > 0 ? "heuristic+ai" : "heuristic",
      heuristic,
      ai: aiKeywords,
    });
  } catch (err) {
    console.warn("AI suggest keywords fail, fallback heuristic:", err.message);
    res.json({
      ok: true,
      keywords: heuristic,
      method: "heuristic",
      error: err.message,
    });
  }
}));

// -----------------------------------------------------------------------------
// AI-powered schema auto-generation từ tên bảng + DESCRIBE
// -----------------------------------------------------------------------------
// Request: { connectionId, database?, tableName }
// Response: { ok, schema: { columns_json, description, examples_json, domain, keywords } }
// -----------------------------------------------------------------------------
router.post(
  "/api/admin/suggest-schema",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const connectionId = req.body.connection_id
      ? Number(req.body.connection_id)
      : null;
    const database = req.body.connection_database
      ? String(req.body.connection_database).trim() || null
      : null;
    const tableName = String(req.body.table_name || "").trim();

    if (!tableName) return res.status(400).json({ error: "Thiếu tên bảng." });

    // Lấy DESCRIBE cho bảng
    let describeRows = [];
    try {
      if (!connectionId) {
        // DB chính
        const [rows] = await pool.query(
          `DESCRIBE ${quoteMysqlIdentifier(tableName, "table_name")}`,
        );
        describeRows = rows;
      } else {
        // Connection external
        const [connRows] = await pool.execute(
          `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
          [connectionId],
        );
        if (!connRows.length)
          return res.status(404).json({ error: "Connection không tồn tại." });
        const conn = connRows[0];
        const config = decryptConfigSecrets(
          conn.type,
          safeJsonParse(conn.config_json, {}),
        );
        const externalPool = await getPoolForConnection({
          id: conn.id,
          database,
          type: conn.type,
          config,
        });
        if (conn.type === "mysql") {
          describeRows = await runQuery(
            externalPool,
            "mysql",
            `DESCRIBE ${quoteMysqlIdentifier(tableName, "table_name")}`,
          );
        } else if (conn.type === "postgres") {
          describeRows = await runQuery(
            externalPool,
            "postgres",
            `SELECT column_name AS "Field", data_type AS "Type"
             FROM information_schema.columns
             WHERE table_name = $1 ORDER BY ordinal_position`,
            [tableName],
          );
        } else {
          return res
            .status(400)
            .json({ error: `Type ${conn.type} khong support schema suggest.` });
        }
      }
    } catch (err) {
      return res
        .status(400)
        .json({ error: `Không lấy được schema bảng: ${err.message}` });
    }

    if (!describeRows.length) {
      return res.status(404).json({ error: "Bảng không tồn tại hoặc rỗng." });
    }

    const generated = generateSchemaFromDescribe(tableName, describeRows);

    // Cũng gen keywords từ tên bảng + tên cột
    const columnsText = generated.columns_json
      .map((c) => c.name + " " + (c.description || ""))
      .join(" ");
    const keywords = extractKeywordsHeuristic(tableName, {
      source: "tablename",
      additionalContext: columnsText,
    });

    res.json({
      ok: true,
      schema: { ...generated, keywords },
    });
  }),
);

// -----------------------------------------------------------------------------
// List tables của 1 connection (cho UI checkbox chọn bảng để import)
// -----------------------------------------------------------------------------
// Request: { connection_id, connection_database? }
// Response: { ok, tables: [{ name, alreadyHasSchema }], total }
// -----------------------------------------------------------------------------
router.post(
  "/api/admin/list-tables",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const connectionId = req.body.connection_id
      ? Number(req.body.connection_id)
      : null;
    const database = req.body.connection_database
      ? String(req.body.connection_database).trim() || null
      : null;
    const search = String(req.body.search || "").trim().toLowerCase();
    const wantsPaging =
      req.body.page !== undefined ||
      req.body.pageSize !== undefined ||
      search.length > 0;
    const page = boundedInt(req.body.page, 1, 1, 100000);
    const pageSize = boundedInt(req.body.pageSize, 100, 1, 500);

    // Bảng/prefix cần skip (system, log, tạm)
    const SKIP_PREFIXES = ["sys_", "tmp_", "temp_", "log_", "_", "__"];
    const SKIP_NAMES = new Set([
      // System schemas
      "information_schema",
      "performance_schema",
      "mysql",
      "sys",
      // Chatbot internal tables (không nên import lại chính nó)
      "schema_metadata",
      "sql_templates",
      "approved_medical_faq",
      "chat_logs",
      "chat_feedback",
      "trusted_sources",
      "data_connections",
      "minio_indexed_files",
      "chatbot_documents",
      "research_answer_cache",
    ]);

    try {
      let tableNames = [];

      if (!connectionId) {
        // DB chính
        const [rows] = await pool.query(`SHOW TABLES`);
        tableNames = rows.map((r) => Object.values(r)[0]);
      } else {
        const [connRows] = await pool.execute(
          `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
          [connectionId],
        );
        if (!connRows.length)
          return res.status(404).json({ error: "Connection không tồn tại." });
        const conn = connRows[0];
        const config = decryptConfigSecrets(
          conn.type,
          safeJsonParse(conn.config_json, {}),
        );

        if (conn.type === "mysql") {
          const externalPool = await getPoolForConnection({
            id: conn.id,
            database,
            type: conn.type,
            config,
          });
          const rows = await runQuery(externalPool, "mysql", `SHOW TABLES`);
          tableNames = rows.map((r) => Object.values(r)[0]);
        } else if (conn.type === "postgres") {
          const externalPool = await getPoolForConnection({
            id: conn.id,
            database,
            type: conn.type,
            config,
          });
          const rows = await runQuery(
            externalPool,
            "postgres",
            `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename`,
          );
          tableNames = rows.map((r) => r.tablename);
        } else {
          return res
            .status(400)
            .json({ error: `Type ${conn.type} không support list tables.` });
        }
      }

      // Filter bỏ system tables
      const filtered = tableNames.filter((name) => {
        const lower = String(name).toLowerCase();
        if (SKIP_NAMES.has(lower)) return false;
        if (search && !lower.includes(search)) return false;
        return !SKIP_PREFIXES.some((p) => lower.startsWith(p));
      });

      // Check bảng nào đã có schema metadata (kèm trạng thái)
      const [existing] = await pool.query(
        `SELECT table_name, is_active FROM schema_metadata
       WHERE ${connectionId ? "connection_id = ?" : "connection_id IS NULL"}
       ${database && connectionId ? "AND connection_database = ?" : ""}`,
        connectionId
          ? database
            ? [connectionId, database]
            : [connectionId]
          : [],
      );
      const existingMap = new Map();
      for (const row of existing) {
        existingMap.set(
          row.table_name.toLowerCase(),
          row.is_active === 1 || row.is_active === true,
        );
      }

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, totalPages);
      const visibleNames = wantsPaging
        ? filtered.slice((safePage - 1) * pageSize, safePage * pageSize)
        : filtered;

      const tables = visibleNames.map((name) => {
        const key = String(name).toLowerCase();
        const hasSchema = existingMap.has(key);
        const isActive = existingMap.get(key);
        return {
          name,
          alreadyHasSchema: hasSchema,
          isDisabled: hasSchema && !isActive,
        };
      });

      res.json({
        ok: true,
        tables,
        total,
        page: wantsPaging ? safePage : 1,
        pageSize: wantsPaging ? pageSize : tables.length || pageSize,
        totalPages: wantsPaging ? totalPages : 1,
      });
    } catch (err) {
      console.error("list-tables error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }),
);

// -----------------------------------------------------------------------------
// Auto-import schema cho 1 hoặc nhiều bảng
// -----------------------------------------------------------------------------
// Request: { connection_id, connection_database?, tables: [name1, name2, ...] }
// Response: { ok, imported: N, updated: M, skipped: K, results: [...] }
// -----------------------------------------------------------------------------
router.post(
  "/api/admin/auto-import-schema/stream",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    const emit = (event, data) => {
      if (!closed && !res.destroyed && !res.writableEnded) {
        writeSse(res, event, data);
      }
    };

    const connectionId = req.body.connection_id
      ? Number(req.body.connection_id)
      : null;
    const database = req.body.connection_database
      ? String(req.body.connection_database).trim() || null
      : null;
    const tables = Array.isArray(req.body.tables) ? req.body.tables : [];
    const batchSize = boundedInt(req.body.batchSize, 5, 1, 25);

    if (!tables.length) {
      emit("error", { error: "Thiếu danh sách bảng để import." });
      return res.end();
    }

    try {
      emit("status", {
        message: `Bắt đầu import ${tables.length} bảng...`,
        total: tables.length,
      });
      const context = await loadSchemaImportContext(connectionId, database);

      const results = [];
      let imported = 0;
      let updated = 0;
      let skipped = 0;

      for (let i = 0; i < tables.length; i++) {
        if (closed) break;
        const tableName = tables[i];
        let result;
        try {
          result = await importOneSchemaTable({
            tableName,
            connectionId,
            database,
            ...context,
          });
        } catch (err) {
          console.warn(`auto-import ${tableName} fail:`, err.message);
          result = { table: tableName, status: "error", reason: err.message };
        }

        if (result.status === "imported") imported++;
        else if (result.status === "updated" || result.status === "revived")
          updated++;
        else skipped++;

        results.push(result);
        emit("progress", {
          index: i + 1,
          total: tables.length,
          imported,
          updated,
          skipped,
          result,
        });

        if ((i + 1) % batchSize === 0) {
          emit("status", {
            message: `Đã xử lý ${i + 1}/${tables.length} bảng...`,
            imported,
            updated,
            skipped,
          });
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      invalidateAllowedTableCache();
      invalidateDataQuestionCache();

      emit("done", {
        ok: true,
        imported,
        updated,
        skipped,
        results,
      });
      return res.end();
    } catch (err) {
      emit("error", { error: err.message });
      return res.end();
    }
  }),
);

router.post(
  "/api/admin/auto-import-schema",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const connectionId = req.body.connection_id
      ? Number(req.body.connection_id)
      : null;
    const database = req.body.connection_database
      ? String(req.body.connection_database).trim() || null
      : null;
    const tables = Array.isArray(req.body.tables) ? req.body.tables : [];

    if (!tables.length) {
      return res.status(400).json({ error: "Thiếu danh sách bảng để import." });
    }

    // Lấy connection info (nếu không phải DB chính)
    let connType = "mysql";
    let externalPool = null;
    if (connectionId) {
      const [connRows] = await pool.execute(
        `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
        [connectionId],
      );
      if (!connRows.length)
        return res.status(404).json({ error: "Connection không tồn tại." });
      const conn = connRows[0];
      connType = conn.type;
      const config = decryptConfigSecrets(
        conn.type,
        safeJsonParse(conn.config_json, {}),
      );
      externalPool = await getPoolForConnection({
        id: conn.id,
        database,
        type: conn.type,
        config,
      });
    }

    const results = [];
    let imported = 0,
      updated = 0,
      skipped = 0;

    for (const tableName of tables) {
      try {
        // 1. DESCRIBE table
        let describeRows = [];
        if (!connectionId) {
          const [rows] = await pool.query(
            `DESCRIBE ${quoteMysqlIdentifier(tableName, "table_name")}`,
          );
          describeRows = rows;
        } else if (connType === "mysql") {
          describeRows = await runQuery(
            externalPool,
            "mysql",
            `DESCRIBE ${quoteMysqlIdentifier(tableName, "table_name")}`,
          );
        } else if (connType === "postgres") {
          // Postgres: dùng information_schema
          const pgRows = await runQuery(
            externalPool,
            "postgres",
            `SELECT column_name AS "Field", data_type AS "Type"
           FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
            [tableName],
          );
          describeRows = pgRows;
        }

        if (!describeRows.length) {
          results.push({
            table: tableName,
            status: "skipped",
            reason: "DESCRIBE trống",
          });
          skipped++;
          continue;
        }

        // 2. Check schema cũ
        const [existingRows] = await pool.execute(
          `SELECT id, columns_json, description, domain, examples_json, is_active FROM schema_metadata
         WHERE table_name = ?
         AND (connection_id ${connectionId ? "= ?" : "IS NULL"})
         ${connectionId && database ? "AND connection_database = ?" : ""}
         LIMIT 1`,
          connectionId
            ? database
              ? [tableName, connectionId, database]
              : [tableName, connectionId]
            : [tableName],
        );

        const generated = generateSchemaFromDescribe(tableName, describeRows);
        const generatedKeywords = extractKeywordsHeuristic(tableName, {
          source: "tablename",
          additionalContext: generated.columns_json
            .map((c) => c.name)
            .join(" "),
        });

        if (existingRows.length > 0) {
          // CẬP NHẬT: thêm cột mới nếu DB có, giữ description cũ
          // Auto-revive nếu schema cũ đang bị disabled (is_active = FALSE)
          const old = existingRows[0];
          const wasDisabled = old.is_active === 0 || old.is_active === false;
          const oldColumns = safeJsonParse(old.columns_json, []);
          const oldColumnNames = new Set(
            oldColumns.map((c) => String(c.name).toLowerCase()),
          );

          const newColumns = generated.columns_json.filter(
            (c) => !oldColumnNames.has(String(c.name).toLowerCase()),
          );

          if (newColumns.length === 0 && !wasDisabled) {
            results.push({
              table: tableName,
              status: "skipped",
              reason: "Schema đã đầy đủ",
            });
            skipped++;
            continue;
          }

          const mergedColumns =
            newColumns.length > 0 ? [...oldColumns, ...newColumns] : oldColumns;

          // UPDATE và LUÔN set is_active = TRUE (revive nếu cần)
          await pool.execute(
            `UPDATE schema_metadata SET columns_json = ?, is_active = TRUE, updated_at = NOW() WHERE id = ?`,
            [JSON.stringify(mergedColumns), old.id],
          );

          results.push({
            table: tableName,
            status: wasDisabled ? "revived" : "updated",
            newColumns: newColumns.map((c) => c.name),
            totalColumns: mergedColumns.length,
            revived: wasDisabled,
          });
          updated++;
        } else {
          // TẠO MỚI
          await pool.execute(
            `INSERT INTO schema_metadata (table_name, connection_id, connection_database, domain, description, columns_json, examples_json, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
            [
              tableName,
              connectionId,
              database,
              generated.domain,
              generated.description +
                (generatedKeywords.length
                  ? ` Keywords: ${generatedKeywords.join(", ")}`
                  : ""),
              JSON.stringify(generated.columns_json),
              JSON.stringify(generated.examples_json),
            ],
          );

          results.push({
            table: tableName,
            status: "imported",
            columns: generated.columns_json.length,
            keywords: generatedKeywords,
          });
          imported++;
        }
      } catch (err) {
        console.warn(`auto-import ${tableName} fail:`, err.message);
        results.push({
          table: tableName,
          status: "error",
          reason: err.message,
        });
        skipped++;
      }
    }

    // Invalidate cache
    invalidateAllowedTableCache();
    invalidateDataQuestionCache();

    res.json({ ok: true, imported, updated, skipped, results });
  }),
);

export default router;
