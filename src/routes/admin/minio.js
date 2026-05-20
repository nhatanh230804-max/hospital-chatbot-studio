// =============================================================================
// src/routes/admin/minio.js — MinIO indexed files (Layer 2): sync, list, update,
//                            delete, presigned URL
// =============================================================================
import express from "express";
import { pool } from "../../db.js";
import { requireAdmin, requireDb } from "../../auth.js";
import { minioAdapter } from "../../../lib/adapters.js";
import {
  extractKeywordsHeuristic,
  keywordsToString,
} from "../../../lib/keyword-extractor.js";
import { getMinioConnection } from "../../connections/minio.js";

const router = express.Router();

router.post(
  "/api/admin/minio/:connectionId/sync",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const connectionId = Number(req.params.connectionId);
    const conn = await getMinioConnection(connectionId);
    if (!conn)
      return res
        .status(404)
        .json({ error: "MinIO connection không tồn tại hoặc không active." });

    // Option: nếu admin truyền `forceDeleteMissing=true`, tự động delete file mất
    const forceDelete =
      req.body.forceDeleteMissing === true ||
      req.body.forceDeactivateMissing === true;
    // Option: list cụ thể file IDs admin đồng ý delete (sau khi user confirm trên UI)
    const confirmDeleteIds = Array.isArray(req.body.confirmDeleteIds)
      ? req.body.confirmDeleteIds.map(Number).filter(Boolean)
      : Array.isArray(req.body.confirmDeactivateIds)
        ? req.body.confirmDeactivateIds.map(Number).filter(Boolean)
        : [];

    try {
      const objects = await minioAdapter.listResources(conn.config);
      let inserted = 0,
        updated = 0;

      // Track object_keys hiện có trong bucket
      const currentKeys = new Set(objects.map((o) => o.name));

      // 1. Upsert files hiện có
      for (const obj of objects) {
        const objectName = obj.name.split("/").pop() || obj.name;
        const autoKeywords = keywordsToString(
          extractKeywordsHeuristic(objectName, { source: "filename" }),
        );

        const [existing] = await pool.execute(
          `SELECT id FROM minio_indexed_files WHERE connection_id = ? AND object_key = ? LIMIT 1`,
          [connectionId, obj.name],
        );

        if (existing.length > 0) {
          // UPDATE
          await pool.execute(
            `UPDATE minio_indexed_files SET
             object_name = ?, size_bytes = ?, etag = ?, last_modified = ?,
             is_active = TRUE, indexed_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
            [
              objectName,
              obj.size,
              obj.etag,
              obj.lastModified ? new Date(obj.lastModified) : null,
              existing[0].id,
            ],
          );
          updated++;
        } else {
          // INSERT mới
          await pool.execute(
            `INSERT INTO minio_indexed_files (connection_id, bucket, object_key, object_name, size_bytes, etag, last_modified, keywords, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
            [
              connectionId,
              conn.config.bucket,
              obj.name,
              objectName,
              obj.size,
              obj.etag,
              obj.lastModified ? new Date(obj.lastModified) : null,
              autoKeywords,
            ],
          );
          inserted++;
        }
      }

      // 2. Phát hiện files trong DB nhưng không còn trong bucket
      const [allInDb] = await pool.execute(
        `SELECT id, object_key, object_name FROM minio_indexed_files WHERE connection_id = ?`,
        [connectionId],
      );
      const missingFiles = allInDb.filter(
        (f) => !currentKeys.has(f.object_key),
      );

      let deleted = 0;

      // 3. Xử lý missing files:
      //    - Nếu forceDelete=true → hard delete hết
      //    - Nếu có confirmDeleteIds → hard delete đúng các ID đó
      //    - Else: return list cho admin confirm
      if (forceDelete && missingFiles.length > 0) {
        const ids = missingFiles.map((f) => f.id);
        const placeholders = ids.map(() => "?").join(",");
        await pool.execute(
          `DELETE FROM minio_indexed_files WHERE id IN (${placeholders})`,
          ids,
        );
        deleted = ids.length;
      } else if (confirmDeleteIds.length > 0) {
        const placeholders = confirmDeleteIds.map(() => "?").join(",");
        await pool.execute(
          `DELETE FROM minio_indexed_files WHERE id IN (${placeholders}) AND connection_id = ?`,
          [...confirmDeleteIds, connectionId],
        );
        deleted = confirmDeleteIds.length;
      }

      res.json({
        ok: true,
        total: objects.length,
        inserted,
        updated,
        deleted,
        missingFiles:
          forceDelete || confirmDeleteIds.length > 0 ? [] : missingFiles,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// List indexed files
router.get(
  "/api/admin/minio-files",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const [rows] = await pool.query(
      `SELECT f.id, f.connection_id, c.name AS connection_name, f.bucket, f.object_key, f.object_name,
            f.size_bytes, f.content_type, f.keywords, f.description, f.last_modified, f.is_active, f.indexed_at
     FROM minio_indexed_files f
     JOIN data_connections c ON c.id = f.connection_id
     ORDER BY f.indexed_at DESC LIMIT 500`,
    );
    res.json(rows);
  },
);

// Update metadata (keywords, description) cho file
router.put(
  "/api/admin/minio-files/:id",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });
    const keywords = String(req.body.keywords || "").trim();
    const description = String(req.body.description || "").trim();
    const isActive = req.body.is_active === false ? false : true;
    await pool.execute(
      `UPDATE minio_indexed_files SET keywords = ?, description = ?, is_active = ? WHERE id = ?`,
      [keywords, description, isActive, id],
    );
    res.json({ ok: true });
  },
);

// Delete (chỉ xoá khỏi index, không xoá object thật trên MinIO)
router.delete(
  "/api/admin/minio-files/:id",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });
    await pool.execute(`DELETE FROM minio_indexed_files WHERE id = ?`, [id]);
    res.json({ ok: true });
  },
);

// Generate presigned URL cho 1 file (dùng để test trong admin)
router.post(
  "/api/admin/minio-files/:id/url",
  requireAdmin,
  requireDb,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Thiếu id." });
    const [rows] = await pool.execute(
      `SELECT f.connection_id, f.object_key FROM minio_indexed_files f WHERE f.id = ?`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: "Không tìm thấy." });
    const conn = await getMinioConnection(rows[0].connection_id);
    if (!conn)
      return res.status(404).json({ error: "MinIO connection không tồn tại." });

    try {
      const url = await minioAdapter.presignedUrl(
        conn.config,
        rows[0].object_key,
        3600,
      );
      res.json({ ok: true, url, expiresIn: 3600 });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

export default router;
