// =============================================================================
// src/routes/admin/schema.js — SCHEMA (Dạy chatbot hiểu bảng)
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { safeJsonParse } from "../../utils.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { invalidateAllowedTableCache } from "../../sql/validator.js";
import { invalidateDataQuestionCache } from "../../router/data-question.js";

const router = express.Router();

router.get("/api/admin/schema", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT s.id, s.table_name, s.connection_id, s.connection_database, s.domain,
            s.description, s.columns_json, s.examples_json, s.is_active, s.updated_at,
            c.name AS connection_name, c.type AS connection_type
     FROM schema_metadata s
     LEFT JOIN data_connections c ON c.id = s.connection_id
     ORDER BY s.updated_at DESC LIMIT 200`
  );
  res.json(rows.map((r) => ({
    ...r,
    columns_json: safeJsonParse(r.columns_json, []),
    examples_json: safeJsonParse(r.examples_json, [])
  })));
});

router.post("/api/admin/schema", requireAdmin, requireDb, async (req, res) => {
  const tableName = String(req.body.table_name || "").trim();
  const domain = String(req.body.domain || "").trim();
  const description = String(req.body.description || "").trim();
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;
  if (!tableName || !description || !req.body.columns_json) {
    return res.status(400).json({ error: "Thiếu thông tin." });
  }
  let columnsStr, examplesStr;
  try {
    columnsStr = JSON.stringify(typeof req.body.columns_json === "string" ? JSON.parse(req.body.columns_json) : req.body.columns_json);
    examplesStr = JSON.stringify(typeof req.body.examples_json === "string" ? JSON.parse(req.body.examples_json || "[]") : (req.body.examples_json || []));
  } catch {
    return res.status(400).json({ error: "JSON không hợp lệ." });
  }
  const [result] = await pool.execute(
    `INSERT INTO schema_metadata (table_name, connection_id, connection_database, domain, description, columns_json, examples_json, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [tableName, connectionId, connectionDatabase, domain, description, columnsStr, examplesStr]
  );
  invalidateAllowedTableCache();
  invalidateDataQuestionCache();
  res.json({ ok: true, id: result.insertId });
});

router.put("/api/admin/schema/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const tableName = String(req.body.table_name || "").trim();
  const domain = String(req.body.domain || "").trim();
  const description = String(req.body.description || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;
  if (!id || !tableName || !description || !req.body.columns_json) {
    return res.status(400).json({ error: "Thiếu thông tin." });
  }
  let columnsStr, examplesStr;
  try {
    columnsStr = JSON.stringify(typeof req.body.columns_json === "string" ? JSON.parse(req.body.columns_json) : req.body.columns_json);
    examplesStr = JSON.stringify(typeof req.body.examples_json === "string" ? JSON.parse(req.body.examples_json || "[]") : (req.body.examples_json || []));
  } catch {
    return res.status(400).json({ error: "JSON không hợp lệ." });
  }
  await pool.execute(
    `UPDATE schema_metadata SET table_name = ?, connection_id = ?, connection_database = ?, domain = ?, description = ?, columns_json = ?, examples_json = ?, is_active = ? WHERE id = ?`,
    [tableName, connectionId, connectionDatabase, domain, description, columnsStr, examplesStr, isActive, id]
  );
  invalidateAllowedTableCache();
  invalidateDataQuestionCache();
  res.json({ ok: true });
});

router.delete("/api/admin/schema/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM schema_metadata WHERE id = ?`, [id]);
  invalidateAllowedTableCache();
  invalidateDataQuestionCache();
  res.json({ ok: true });
});

export default router;
