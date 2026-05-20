// =============================================================================
// Data Connection Adapters (Layer 1)
// =============================================================================
// Mỗi adapter implement chung interface:
//   - testConnection(config) → { ok, message, details? }
//   - listResources(config) → list bảng (SQL) hoặc list object (MinIO)
// Thêm loại mới: chỉ cần thêm 1 case vào factory + 1 file adapter
// =============================================================================

import mysql from "mysql2/promise";
import pg from "pg";
import { Client as MinioClient } from "minio";

// -----------------------------------------------------------------------------
// MySQL adapter
// -----------------------------------------------------------------------------
export const mysqlAdapter = {
  type: "mysql",
  label: "MySQL",
  configSchema: [
    { key: "host", label: "Host", default: "127.0.0.1", required: true },
    {
      key: "port",
      label: "Port",
      default: 3306,
      type: "number",
      required: true,
    },
    { key: "user", label: "User", required: true },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "database", label: "Database", required: true },
  ],

  async testConnection(config) {
    let conn;
    try {
      conn = await mysql.createConnection({
        host: config.host,
        port: Number(config.port || 3306),
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: 5000,
      });
      const [rows] = await conn.query("SELECT VERSION() AS version");
      await conn.end();
      return {
        ok: true,
        message: `Kết nối OK`,
        details: { version: rows[0].version },
      };
    } catch (err) {
      if (conn) await conn.end().catch(() => {});
      return { ok: false, message: err.message };
    }
  },

  async listResources(config) {
    const conn = await mysql.createConnection({
      host: config.host,
      port: Number(config.port || 3306),
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 5000,
    });
    try {
      // Lấy list bảng
      const [tables] = await conn.query(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        [config.database],
      );
      // COUNT(*) thật cho từng bảng. Giới hạn 50 bảng để không quá chậm.
      const results = [];
      for (const t of tables.slice(0, 50)) {
        try {
          const [countRows] = await conn.query(
            `SELECT COUNT(*) AS cnt FROM \`${t.TABLE_NAME}\``,
          );
          results.push({
            name: t.TABLE_NAME,
            type: "table",
            rowCount: Number(countRows[0].cnt),
          });
        } catch {
          results.push({ name: t.TABLE_NAME, type: "table", rowCount: null });
        }
      }
      return results;
    } finally {
      await conn.end();
    }
  },
};

// -----------------------------------------------------------------------------
// PostgreSQL adapter
// -----------------------------------------------------------------------------
export const postgresAdapter = {
  type: "postgres",
  label: "PostgreSQL",
  configSchema: [
    { key: "host", label: "Host", default: "127.0.0.1", required: true },
    {
      key: "port",
      label: "Port",
      default: 5432,
      type: "number",
      required: true,
    },
    { key: "user", label: "User", required: true },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "database", label: "Database", required: true },
  ],

  async testConnection(config) {
    const client = new pg.Client({
      host: config.host,
      port: Number(config.port || 5432),
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      const { rows } = await client.query("SELECT version()");
      await client.end();
      return {
        ok: true,
        message: "Kết nối OK",
        details: { version: rows[0].version },
      };
    } catch (err) {
      await client.end().catch(() => {});
      return { ok: false, message: err.message };
    }
  },

  async listResources(config) {
    const client = new pg.Client({
      host: config.host,
      port: Number(config.port || 5432),
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      );
      return rows.map((r) => ({ name: r.table_name, type: "table" }));
    } finally {
      await client.end();
    }
  },
};

// -----------------------------------------------------------------------------
// MinIO adapter
// -----------------------------------------------------------------------------
export const minioAdapter = {
  type: "minio",
  label: "MinIO (S3-compatible storage)",
  configSchema: [
    {
      key: "endpoint",
      label: "Endpoint host",
      default: "127.0.0.1",
      required: true,
      help: "Chỉ host, không có http://",
    },
    {
      key: "port",
      label: "Port",
      default: 9000,
      type: "number",
      required: true,
    },
    { key: "useSSL", label: "Use SSL", default: false, type: "boolean" },
    { key: "accessKey", label: "Access Key", required: true },
    { key: "secretKey", label: "Secret Key", type: "password", required: true },
    { key: "bucket", label: "Bucket name", required: true },
    { key: "region", label: "Region", default: "us-east-1" },
  ],

  _makeClient(config) {
    return new MinioClient({
      endPoint: config.endpoint,
      port: Number(config.port || 9000),
      useSSL: Boolean(config.useSSL),
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region || "us-east-1",
    });
  },

  async testConnection(config) {
    try {
      const client = this._makeClient(config);
      // Test bucket exists
      const exists = await client.bucketExists(config.bucket);
      if (!exists) {
        return {
          ok: false,
          message: `Bucket "${config.bucket}" không tồn tại trên MinIO. Hãy tạo bucket trước.`,
        };
      }
      return {
        ok: true,
        message: `Kết nối OK · bucket "${config.bucket}" hợp lệ`,
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async listResources(config) {
    const client = this._makeClient(config);
    const objects = [];
    return new Promise((resolve, reject) => {
      const stream = client.listObjectsV2(config.bucket, "", true);
      stream.on("data", (obj) =>
        objects.push({
          name: obj.name,
          type: "object",
          size: obj.size,
          lastModified: obj.lastModified,
          etag: obj.etag,
        }),
      );
      stream.on("end", () => resolve(objects));
      stream.on("error", reject);
    });
  },

  // Helper riêng cho MinIO
  async presignedUrl(config, objectKey, expirySeconds = 3600) {
    const client = this._makeClient(config);
    return await client.presignedGetObject(
      config.bucket,
      objectKey,
      expirySeconds,
    );
  },

  async ensureBucket(config) {
    const client = this._makeClient(config);
    const exists = await client.bucketExists(config.bucket);
    if (!exists) {
      await client.makeBucket(config.bucket, config.region || "us-east-1");
    }
    return true;
  },
};

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------
const adapters = {
  mysql: mysqlAdapter,
  postgres: postgresAdapter,
  minio: minioAdapter,
};

export function getAdapter(type) {
  const adapter = adapters[type];
  if (!adapter) throw new Error(`Không hỗ trợ loại kết nối: ${type}`);
  return adapter;
}

export function listAdapters() {
  return Object.values(adapters).map((a) => ({
    type: a.type,
    label: a.label,
    configSchema: a.configSchema,
  }));
}
