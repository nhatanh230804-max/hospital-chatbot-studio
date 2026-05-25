// =============================================================================
// src/sql/runner.js — Run SQL on the correct connection (main DB or external)
// =============================================================================
import { pool } from "../db.js";
import { safeJsonParse } from "../utils.js";
import {
  getPoolForConnection,
  runQuery,
} from "../../lib/connection-manager.js";
import { decryptConfigSecrets } from "../connections/encryption.js";

export async function runSqlOnScope(sql, connectionId, database) {
  // connectionId = null → DB chính (.env)
  if (!connectionId) {
    const [rows] = await pool.query({ sql, timeout: 5000 });
    return rows;
  }
  // connectionId có → lấy connection từ DB, tạo pool external
  const [connRows] = await pool.execute(
    `SELECT id, type, config_json FROM data_connections WHERE id = ? AND is_active = TRUE`,
    [connectionId],
  );
  if (!connRows.length)
    throw new Error(
      `Connection #${connectionId} không tồn tại hoặc đã disabled.`,
    );
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
  return await runQuery(externalPool, conn.type, sql);
}
