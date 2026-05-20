// =============================================================================
// src/connections/minio.js — MinIO connection helpers + file-matching
// =============================================================================
import { dbReady, pool } from "../db.js";
import { safeJsonParse, normalizeVietnamese } from "../utils.js";
import { minioAdapter } from "../../lib/adapters.js";
import { decryptConfigSecrets } from "./encryption.js";

// Helper: lấy MinIO connection theo id, trả về config đã decrypt
export async function getMinioConnection(connectionId) {
  const [rows] = await pool.execute(
    `SELECT id, name, type, config_json FROM data_connections WHERE id = ? AND type = 'minio' AND is_active = TRUE`,
    [connectionId],
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    name: rows[0].name,
    config: decryptConfigSecrets(
      "minio",
      safeJsonParse(rows[0].config_json, {}),
    ),
  };
}

// =============================================================================
// Match MinIO file từ câu hỏi user (gọi trong /api/chat)
// =============================================================================
export async function findMinioFileFromQuestion(question) {
  if (!dbReady || !pool) return null;
  const text = normalizeVietnamese(question);

  try {
    const [rows] = await pool.execute(
      `SELECT f.id, f.connection_id, f.object_key, f.object_name, f.keywords, f.description
       FROM minio_indexed_files f
       JOIN data_connections c ON c.id = f.connection_id
       WHERE f.is_active = TRUE AND c.is_active = TRUE
       ORDER BY f.indexed_at DESC LIMIT 500`,
    );
    if (!rows.length) return null;

    // Match keyword + object_name
    let best = null;
    let bestScore = 0;
    for (const f of rows) {
      const candidates = [];
      if (f.keywords) {
        candidates.push(
          ...String(f.keywords).split("|").map(normalizeVietnamese),
        );
      }
      if (f.object_name) candidates.push(normalizeVietnamese(f.object_name));
      if (f.description) candidates.push(normalizeVietnamese(f.description));

      const matched = candidates.filter((c) => c && text.includes(c));
      const score = matched.reduce((acc, c) => acc + c.length, 0);
      if (score > bestScore) {
        best = f;
        bestScore = score;
      }
    }
    if (!best) return null;

    // Generate presigned URL
    const conn = await getMinioConnection(best.connection_id);
    if (!conn) return null;
    const url = await minioAdapter.presignedUrl(
      conn.config,
      best.object_key,
      3600,
    );
    return {
      fileId: best.id,
      objectKey: best.object_key,
      objectName: best.object_name,
      url,
    };
  } catch (err) {
    console.warn("MinIO match error:", err.message);
    return null;
  }
}
