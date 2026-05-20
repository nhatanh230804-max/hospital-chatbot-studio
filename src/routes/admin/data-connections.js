// =============================================================================
// src/routes/admin/data-connections.js — Data Connections CRUD + test/resources
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { safeJsonParse } from "../../utils.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { getAdapter, listAdapters } from "../../../lib/adapters.js";
import { invalidatePool } from "../../../lib/connection-manager.js";
import {
  encryptSecret,
  decryptSecret,
  encryptConfigSecrets,
  decryptConfigSecrets,
  redactConfigForRead
} from "../../connections/encryption.js";
import { invalidateAllowedTableCache } from "../../sql/validator.js";
import { invalidateDataQuestionCache } from "../../router/data-question.js";

const router = express.Router();

// List available adapter types (cho UI form động)
router.get("/api/admin/data-connections/adapters", requireAdmin, (req, res) => {
  res.json(listAdapters());
});

// List connections
router.get("/api/admin/data-connections", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, type, description, config_json, is_active, last_test_at, last_test_status, last_test_message, created_at, updated_at
     FROM data_connections ORDER BY updated_at DESC LIMIT 200`
  );
  res.json(rows.map((r) => ({
    ...r,
    config_json: redactConfigForRead(r.type, safeJsonParse(r.config_json, {}))
  })));
});

// Create
router.post("/api/admin/data-connections", requireAdmin, requireDb, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const type = String(req.body.type || "").trim();
  const description = String(req.body.description || "").trim();
  const config = req.body.config_json || {};

  if (!name || !type) return res.status(400).json({ error: "Thiếu name hoặc type." });
  try { getAdapter(type); } catch (err) { return res.status(400).json({ error: err.message }); }

  const encConfig = encryptConfigSecrets(type, config);
  try {
    const [result] = await pool.execute(
      `INSERT INTO data_connections (name, type, description, config_json, is_active, created_by)
       VALUES (?, ?, ?, ?, TRUE, 'admin')`,
      [name, type, description, JSON.stringify(encConfig)]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: `Tên "${name}" đã tồn tại.` });
    res.status(500).json({ error: err.message });
  }
});

// Update
router.put("/api/admin/data-connections/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const name = String(req.body.name || "").trim();
  const type = String(req.body.type || "").trim();
  const description = String(req.body.description || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  const config = req.body.config_json || {};
  if (!name || !type) return res.status(400).json({ error: "Thiếu name hoặc type." });

  // Nếu password = "••••••••" (placeholder UI) thì giữ nguyên password cũ
  const [oldRows] = await pool.execute(`SELECT type, config_json FROM data_connections WHERE id = ?`, [id]);
  if (!oldRows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const oldConfig = safeJsonParse(oldRows[0].config_json, {});

  try {
    const adapter = getAdapter(type);
    for (const field of adapter.configSchema) {
      if (field.type === "password" && config[field.key] === "••••••••") {
        config[field.key] = decryptSecret(oldConfig[field.key]); // restore plain để re-encrypt
      }
    }
  } catch {}

  const encConfig = encryptConfigSecrets(type, config);
  await pool.execute(
    `UPDATE data_connections SET name = ?, type = ?, description = ?, config_json = ?, is_active = ? WHERE id = ?`,
    [name, type, description, JSON.stringify(encConfig), isActive, id]
  );
  // Invalidate external pool + table cache vì config có thể đã đổi
  await invalidatePool(id);
  invalidateAllowedTableCache();
  invalidateDataQuestionCache();
  res.json({ ok: true });
});

// Delete
router.delete("/api/admin/data-connections/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM data_connections WHERE id = ?`, [id]);
  await invalidatePool(id);
  invalidateAllowedTableCache();
  invalidateDataQuestionCache();
  res.json({ ok: true });
});

// Test connection
router.post("/api/admin/data-connections/:id/test", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const [rows] = await pool.execute(`SELECT type, config_json FROM data_connections WHERE id = ?`, [id]);
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const type = rows[0].type;
  const config = decryptConfigSecrets(type, safeJsonParse(rows[0].config_json, {}));

  try {
    const adapter = getAdapter(type);
    const result = await adapter.testConnection(config);
    await pool.execute(
      `UPDATE data_connections SET last_test_at = NOW(), last_test_status = ?, last_test_message = ? WHERE id = ?`,
      [result.ok ? "ok" : "fail", result.message, id]
    );
    res.json(result);
  } catch (err) {
    await pool.execute(
      `UPDATE data_connections SET last_test_at = NOW(), last_test_status = 'fail', last_test_message = ? WHERE id = ?`,
      [err.message, id]
    );
    res.status(500).json({ ok: false, message: err.message });
  }
});

// List resources (bảng cho SQL, object cho MinIO)
router.get("/api/admin/data-connections/:id/resources", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  const [rows] = await pool.execute(`SELECT type, config_json FROM data_connections WHERE id = ?`, [id]);
  if (!rows.length) return res.status(404).json({ error: "Không tìm thấy." });
  const type = rows[0].type;
  const config = decryptConfigSecrets(type, safeJsonParse(rows[0].config_json, {}));
  try {
    const adapter = getAdapter(type);
    const list = await adapter.listResources(config);
    res.json({ ok: true, type, count: list.length, items: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
