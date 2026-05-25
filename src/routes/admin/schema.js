// =============================================================================
// src/routes/admin/schema.js - SCHEMA CRUD
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { assertSafeSqlIdentifier, safeJsonParse } from "../../utils.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { asyncHandler } from "../../middleware.js";
import { invalidateAllowedTableCache } from "../../sql/validator.js";
import { invalidateDataQuestionCache } from "../../router/data-question.js";

const router = express.Router();

function safeJsonArray(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJsonArrayField(value, label, options = {}) {
  const parsed =
    typeof value === "string" ? JSON.parse(value || "[]") : value || [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} phai la JSON array.`);
  }
  if (options.requireColumnNames) {
    const invalid = parsed.find(
      (item) =>
        !item ||
        typeof item !== "object" ||
        !String(item.name || "").trim(),
    );
    if (invalid) {
      throw new Error(`${label} phai gom cac object co truong name.`);
    }
  }
  return parsed;
}

router.get(
  "/api/admin/schema",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT s.id, s.table_name, s.connection_id, s.connection_database, s.domain,
              s.description, s.columns_json, s.examples_json, s.is_active, s.updated_at,
              c.name AS connection_name, c.type AS connection_type
       FROM schema_metadata s
       LEFT JOIN data_connections c ON c.id = s.connection_id
       ORDER BY s.updated_at DESC LIMIT 200`,
    );
    res.json(
      rows.map((r) => ({
        ...r,
        columns_json: safeJsonArray(r.columns_json),
        examples_json: safeJsonArray(r.examples_json),
      })),
    );
  }),
);

router.post(
  "/api/admin/schema",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const tableName = String(req.body.table_name || "").trim();
    const domain = String(req.body.domain || "").trim();
    const description = String(req.body.description || "").trim();
    const connectionId = req.body.connection_id
      ? Number(req.body.connection_id)
      : null;
    const connectionDatabase = req.body.connection_database
      ? String(req.body.connection_database).trim() || null
      : null;
    if (!tableName || !description || !req.body.columns_json) {
      return res.status(400).json({ error: "Thieu thong tin." });
    }
    try {
      assertSafeSqlIdentifier(tableName, "table_name");
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    let columnsStr;
    let examplesStr;
    try {
      columnsStr = JSON.stringify(
        parseJsonArrayField(req.body.columns_json, "columns_json", {
          requireColumnNames: true,
        }),
      );
      examplesStr = JSON.stringify(
        parseJsonArrayField(req.body.examples_json || [], "examples_json"),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const [result] = await pool.execute(
      `INSERT INTO schema_metadata (table_name, connection_id, connection_database, domain, description, columns_json, examples_json, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        tableName,
        connectionId,
        connectionDatabase,
        domain,
        description,
        columnsStr,
        examplesStr,
      ],
    );
    invalidateAllowedTableCache();
    invalidateDataQuestionCache();
    res.json({ ok: true, id: result.insertId });
  }),
);

router.put(
  "/api/admin/schema/:id",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const tableName = String(req.body.table_name || "").trim();
    const domain = String(req.body.domain || "").trim();
    const description = String(req.body.description || "").trim();
    const isActive = req.body.is_active === false ? false : true;
    const connectionId = req.body.connection_id
      ? Number(req.body.connection_id)
      : null;
    const connectionDatabase = req.body.connection_database
      ? String(req.body.connection_database).trim() || null
      : null;
    if (!id || !tableName || !description || !req.body.columns_json) {
      return res.status(400).json({ error: "Thieu thong tin." });
    }
    try {
      assertSafeSqlIdentifier(tableName, "table_name");
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    let columnsStr;
    let examplesStr;
    try {
      columnsStr = JSON.stringify(
        parseJsonArrayField(req.body.columns_json, "columns_json", {
          requireColumnNames: true,
        }),
      );
      examplesStr = JSON.stringify(
        parseJsonArrayField(req.body.examples_json || [], "examples_json"),
      );
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    await pool.execute(
      `UPDATE schema_metadata SET table_name = ?, connection_id = ?, connection_database = ?, domain = ?, description = ?, columns_json = ?, examples_json = ?, is_active = ? WHERE id = ?`,
      [
        tableName,
        connectionId,
        connectionDatabase,
        domain,
        description,
        columnsStr,
        examplesStr,
        isActive,
        id,
      ],
    );
    invalidateAllowedTableCache();
    invalidateDataQuestionCache();
    res.json({ ok: true });
  }),
);

router.delete(
  "/api/admin/schema/:id",
  requireAdmin,
  requireDb,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thieu id." });
    await pool.execute(`DELETE FROM schema_metadata WHERE id = ?`, [id]);
    invalidateAllowedTableCache();
    invalidateDataQuestionCache();
    res.json({ ok: true });
  }),
);

export default router;
