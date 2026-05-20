// =============================================================================
// src/routes/admin/sql-templates.js — SQL Templates (Class "Dạy SQL") CRUD
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { getDemoToday, getDemoTomorrow, getDemoYesterday } from "../../config.js";
import { validateAndPrepareSql } from "../../sql/validator.js";
import { resolvePlaceholders } from "../../sql/templates.js";
import { runSqlOnScope } from "../../sql/runner.js";
import { summarizeSqlResult } from "../../sql/summarizer.js";
import { extractKeywordsHeuristic, keywordsToString } from "../../../lib/keyword-extractor.js";
import { invalidateDataQuestionCache } from "../../router/data-question.js";

const router = express.Router();

router.get("/api/admin/sql-templates", requireAdmin, requireDb, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.id, t.name, t.connection_id, t.connection_database, t.description,
            t.question_pattern, t.keywords, t.sql_template, t.category,
            t.created_by, t.is_active, t.usage_count, t.last_used_at, t.created_at, t.updated_at,
            c.name AS connection_name, c.type AS connection_type
     FROM sql_templates t
     LEFT JOIN data_connections c ON c.id = t.connection_id
     ORDER BY t.updated_at DESC LIMIT 200`
  );
  res.json(rows);
});

router.post("/api/admin/sql-templates", requireAdmin, requireDb, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const questionPattern = String(req.body.question_pattern || "").trim();
  let keywords = String(req.body.keywords || "").trim();
  const sqlTemplate = String(req.body.sql_template || "").trim();
  const category = String(req.body.category || "").trim();
  const createdBy = String(req.body.created_by || "admin").trim();
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;

  if (!name || !questionPattern || !sqlTemplate) {
    return res.status(400).json({ error: "Thiếu name/question_pattern/sql_template." });
  }

  // Auto-fill keywords từ question_pattern + name nếu admin để trống
  if (!keywords) {
    const auto = extractKeywordsHeuristic(questionPattern, {
      source: "question",
      additionalContext: name + " " + description
    });
    keywords = keywordsToString(auto);
    if (!keywords) {
      return res.status(400).json({ error: "Không tạo được keywords tự động. Vui lòng nhập thủ công." });
    }
  }

  const testSql = sqlTemplate
    .replaceAll("{DEMO_TODAY}", getDemoToday())
    .replaceAll("{DEMO_TOMORROW}", getDemoTomorrow())
    .replaceAll("{DEMO_YESTERDAY}", getDemoYesterday())
    .replaceAll("{department}", "Khoa Test");

  const validation = await validateAndPrepareSql(testSql, connectionId, connectionDatabase);
  if (!validation.ok) {
    return res.status(400).json({
      error: `SQL template không qua validator: ${validation.reason}`,
      hint: "Template phải là SELECT, không có DDL/DML, không có comment, và bảng phải nằm trong schema metadata của DB tương ứng."
    });
  }

  const [result] = await pool.execute(
    `INSERT INTO sql_templates (name, connection_id, connection_database, description, question_pattern, keywords, sql_template, category, created_by, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [name, connectionId, connectionDatabase, description, questionPattern, keywords, sqlTemplate, category, createdBy]
  );
  invalidateDataQuestionCache();
  res.json({ ok: true, id: result.insertId, message: "Đã tạo SQL template." });
});

router.put("/api/admin/sql-templates/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });

  const name = String(req.body.name || "").trim();
  const description = String(req.body.description || "").trim();
  const questionPattern = String(req.body.question_pattern || "").trim();
  const keywords = String(req.body.keywords || "").trim();
  const sqlTemplate = String(req.body.sql_template || "").trim();
  const category = String(req.body.category || "").trim();
  const isActive = req.body.is_active === false ? false : true;
  const connectionId = req.body.connection_id ? Number(req.body.connection_id) : null;
  const connectionDatabase = req.body.connection_database
    ? String(req.body.connection_database).trim() || null
    : null;

  if (!name || !questionPattern || !keywords || !sqlTemplate) {
    return res.status(400).json({ error: "Thiếu thông tin bắt buộc." });
  }

  const testSql = sqlTemplate
    .replaceAll("{DEMO_TODAY}", getDemoToday())
    .replaceAll("{DEMO_TOMORROW}", getDemoTomorrow())
    .replaceAll("{DEMO_YESTERDAY}", getDemoYesterday())
    .replaceAll("{department}", "Khoa Test");
  const validation = await validateAndPrepareSql(testSql, connectionId, connectionDatabase);
  if (!validation.ok) {
    return res.status(400).json({ error: `SQL không hợp lệ: ${validation.reason}` });
  }

  await pool.execute(
    `UPDATE sql_templates SET name = ?, connection_id = ?, connection_database = ?, description = ?, question_pattern = ?, keywords = ?, sql_template = ?, category = ?, is_active = ? WHERE id = ?`,
    [name, connectionId, connectionDatabase, description, questionPattern, keywords, sqlTemplate, category, isActive, id]
  );
  invalidateDataQuestionCache();
  res.json({ ok: true });
});

router.delete("/api/admin/sql-templates/:id", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Thiếu id." });
  await pool.execute(`DELETE FROM sql_templates WHERE id = ?`, [id]);
  invalidateDataQuestionCache();
  res.json({ ok: true });
});

router.post("/api/admin/sql-templates/:id/test", requireAdmin, requireDb, async (req, res) => {
  const id = Number(req.params.id);
  const testQuestion = String(req.body.question || "").trim();
  if (!id) return res.status(400).json({ error: "Thiếu id." });

  const [rows] = await pool.execute(`SELECT * FROM sql_templates WHERE id = ?`, [id]);
  if (!rows[0]) return res.status(404).json({ error: "Không tìm thấy template." });

  const tpl = rows[0];
  const resolvedSql = resolvePlaceholders(tpl.sql_template, testQuestion || tpl.question_pattern);

  const validation = await validateAndPrepareSql(resolvedSql, tpl.connection_id, tpl.connection_database);
  if (!validation.ok) {
    return res.json({ ok: false, sql: resolvedSql, error: validation.reason });
  }

  try {
    const resultRows = await runSqlOnScope(validation.sql, tpl.connection_id, tpl.connection_database);
    res.json({
      ok: true,
      sql: validation.sql,
      rows: resultRows,
      reply: await summarizeSqlResult(testQuestion || tpl.question_pattern, validation.sql, resultRows),
      scope: tpl.connection_id ? `connection #${tpl.connection_id} · ${tpl.connection_database || 'default'}` : 'DB chính'
    });
  } catch (error) {
    res.json({ ok: false, sql: validation.sql, error: error.message });
  }
});

export default router;
