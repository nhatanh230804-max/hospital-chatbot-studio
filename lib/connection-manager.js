// =============================================================================
// Connection Pool Manager (Layer 2.5)
// =============================================================================
// Mỗi data_connections (type=mysql/postgres) khi được dùng cho query thì
// manager này cache 1 pool riêng. Pool re-use cho mọi query trên cùng connection
// để tránh overhead tạo connection mới.
//
// Lifecycle:
//   - getPoolForConnection(id, database?, getConfig) → trả pool, tạo nếu chưa có
//   - invalidatePool(id) → đóng pool khi admin sửa/xoá connection
//   - closeAll() → graceful shutdown
// =============================================================================

import mysql from "mysql2/promise";

const pools = new Map(); // key = `${id}::${database || ''}` → { pool, type, key }

function makeKey(id, database) {
  return `${id}::${database || ''}`;
}

export async function getPoolForConnection({ id, database, type, config }) {
  const key = makeKey(id, database);
  const cached = pools.get(key);
  if (cached) return cached.pool;

  if (type !== "mysql" && type !== "postgres") {
    throw new Error(`Type ${type} không support query trực tiếp (chỉ mysql/postgres).`);
  }

  let pool;
  if (type === "mysql") {
    pool = mysql.createPool({
      host: config.host,
      port: Number(config.port || 3306),
      user: config.user,
      password: config.password,
      database: database || config.database,
      charset: "utf8mb4_unicode_ci",
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 10000
    });
    // Set timeout
    await pool.query("SET SESSION MAX_EXECUTION_TIME = 5000").catch(() => {});
  } else if (type === "postgres") {
    // Lazy import postgres to avoid bundle if not used
    const pg = (await import("pg")).default;
    pool = new pg.Pool({
      host: config.host,
      port: Number(config.port || 5432),
      user: config.user,
      password: config.password,
      database: database || config.database,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }

  pools.set(key, { pool, type, id, database });
  return pool;
}

export async function invalidatePool(id) {
  // Đóng mọi pool liên quan tới connection id này (có thể có nhiều database)
  const keysToRemove = [];
  for (const [key, entry] of pools.entries()) {
    if (entry.id === id) {
      try {
        if (entry.type === "mysql") await entry.pool.end();
        else if (entry.type === "postgres") await entry.pool.end();
      } catch (err) {
        console.warn(`Close pool ${key} fail:`, err.message);
      }
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => pools.delete(key));
}

export async function closeAllPools() {
  for (const [key, entry] of pools.entries()) {
    try {
      if (entry.type === "mysql") await entry.pool.end();
      else if (entry.type === "postgres") await entry.pool.end();
    } catch {}
  }
  pools.clear();
}

// Helper: chạy query trên 1 pool, trả về `rows` consistent giữa mysql/pg
export async function runQuery(pool, type, sql, params = []) {
  if (type === "mysql") {
    const [rows] = await pool.query(sql, params);
    return rows;
  } else if (type === "postgres") {
    const result = await pool.query(sql, params);
    return result.rows;
  }
  throw new Error(`Unknown type ${type}`);
}
