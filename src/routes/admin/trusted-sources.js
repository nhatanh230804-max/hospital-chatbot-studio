// =============================================================================
// src/routes/admin/trusted-sources.js — Trusted Sources CRUD
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { extractDomain, isSafeUrlForLink } from "../../utils.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { invalidateTrustedSourcesCache } from "../../router/trusted-sources.js";

const router = express.Router();

router.get(
  "/api/admin/trusted-sources",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, name, url, domain, description, category, language, trust_level,
            added_by, is_active, created_at, updated_at
     FROM trusted_sources ORDER BY trust_level DESC, name ASC LIMIT 500`,
    );
    res.json(rows);
  },
);

router.post(
  "/api/admin/trusted-sources",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const name = String(req.body.name || "").trim();
    const url = String(req.body.url || "").trim();
    const description = String(req.body.description || "").trim();
    const category = String(req.body.category || "medical").trim();
    const language = String(req.body.language || "vi").trim();
    const trustLevel = String(req.body.trust_level || "medium").trim();
    const addedBy = String(req.body.added_by || "admin").trim();

    if (!name || !url)
      return res.status(400).json({ error: "Thiếu name hoặc url." });
    if (!isSafeUrlForLink(url))
      return res
        .status(400)
        .json({ error: "URL không hợp lệ (phải là http/https)." });

    const domain = extractDomain(url);
    if (!domain)
      return res.status(400).json({ error: "Không parse được domain từ URL." });

    if (!["low", "medium", "high"].includes(trustLevel)) {
      return res
        .status(400)
        .json({ error: "trust_level phải là low/medium/high." });
    }

    const [result] = await pool.execute(
      `INSERT INTO trusted_sources (name, url, domain, description, category, language, trust_level, added_by, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [name, url, domain, description, category, language, trustLevel, addedBy],
    );
    // Invalidate cache
    invalidateTrustedSourcesCache();
    res.json({ ok: true, id: result.insertId, domain });
  },
);

router.put(
  "/api/admin/trusted-sources/:id",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });

    const name = String(req.body.name || "").trim();
    const url = String(req.body.url || "").trim();
    const description = String(req.body.description || "").trim();
    const category = String(req.body.category || "medical").trim();
    const language = String(req.body.language || "vi").trim();
    const trustLevel = String(req.body.trust_level || "medium").trim();
    const isActive = req.body.is_active === false ? false : true;

    if (!name || !url)
      return res.status(400).json({ error: "Thiếu name hoặc url." });
    if (!isSafeUrlForLink(url))
      return res.status(400).json({ error: "URL không hợp lệ." });
    const domain = extractDomain(url);
    if (!domain)
      return res.status(400).json({ error: "Không parse được domain." });

    await pool.execute(
      `UPDATE trusted_sources SET name = ?, url = ?, domain = ?, description = ?, category = ?, language = ?, trust_level = ?, is_active = ? WHERE id = ?`,
      [
        name,
        url,
        domain,
        description,
        category,
        language,
        trustLevel,
        isActive,
        id,
      ],
    );
    invalidateTrustedSourcesCache();
    res.json({ ok: true });
  },
);

router.delete(
  "/api/admin/trusted-sources/:id",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });
    await pool.execute(`DELETE FROM trusted_sources WHERE id = ?`, [id]);
    invalidateTrustedSourcesCache();
    res.json({ ok: true });
  },
);

export default router;
