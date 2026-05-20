// =============================================================================
// src/sql/validator.js — SQL validator with multi-DB whitelist
// =============================================================================
// Cache lookup: với mỗi (connection_id, database) trả về Set<table_name>
//   - connection_id = null → DB chính (.env)
//   - connection_id = X, database = Y → connection X, schema Y
// =============================================================================
import { dbReady, pool } from "../db.js";

export function scopeKey(connectionId, database) {
  return `${connectionId || 'main'}::${database || ''}`;
}

export let allowedTableCache = {
  // Map<scopeKey, Set<tableName>>
  map: new Map([
    // Mặc định DB chính có 3 bảng seed
    [scopeKey(null, null), new Set(["departments", "hospital_procedures", "staff_schedules"])]
  ]),
  at: 0
};

export async function getAllowedTables(connectionId = null, database = null) {
  // Cache 30s
  if (Date.now() - allowedTableCache.at >= 30000) {
    await refreshAllowedTableCache();
  }
  return allowedTableCache.map.get(scopeKey(connectionId, database)) || new Set();
}

export async function refreshAllowedTableCache() {
  if (!dbReady || !pool) return;
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT table_name, connection_id, connection_database
       FROM schema_metadata WHERE is_active = TRUE`
    );
    const map = new Map();
    // Luôn giữ các bảng seed cho DB chính
    map.set(scopeKey(null, null), new Set(["departments", "hospital_procedures", "staff_schedules"]));

    for (const r of rows) {
      const key = scopeKey(r.connection_id, r.connection_database);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(r.table_name);
    }
    allowedTableCache.map = map;
    allowedTableCache.at = Date.now();
  } catch (error) {
    console.warn("Không tải được allowed_tables:", error.message);
  }
}

// Invalidate cache (used by admin routes after schema changes)
export function invalidateAllowedTableCache() {
  allowedTableCache.at = 0;
}

export function normalizeSql(sql) {
  return String(sql || "").replace(/```sql/gi, "").replace(/```/g, "").trim();
}

export async function validateAndPrepareSql(sql, connectionId = null, database = null) {
  let cleaned = normalizeSql(sql);
  if (!cleaned) return { ok: false, reason: "SQL rỗng." };

  cleaned = cleaned.replace(/;\s*$/, "").trim();
  const lower = cleaned.toLowerCase();

  // Banned patterns: chỉ chặn ở dạng word boundary, KHÔNG chặn từ trong string literal
  // → bóc string literal trước khi check
  const withoutStrings = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");

  const bannedKeywords = [
    "insert", "update", "delete", "drop", "alter", "create", "truncate",
    "grant", "revoke", "outfile", "execute", "prepare"
  ];
  for (const kw of bannedKeywords) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(withoutStrings)) {
      return { ok: false, reason: `SQL chứa keyword không cho phép: ${kw}` };
    }
  }

  // Chặn dangerous schema/function ngoài string
  const bannedRefs = [
    /\binformation_schema\b/i,
    /\bperformance_schema\b/i,
    /\bmysql\.\w/i,
    /\bsys\.\w/i,
    /\bload_file\s*\(/i,
    /\bbenchmark\s*\(/i,
    /\bsleep\s*\(/i
  ];
  if (bannedRefs.some((re) => re.test(withoutStrings))) {
    return { ok: false, reason: "SQL chứa tham chiếu hoặc function không cho phép." };
  }

  // Chặn comment để không bypass parser
  if (/--/.test(withoutStrings) || /\/\*/.test(withoutStrings) || /#/.test(withoutStrings)) {
    return { ok: false, reason: "SQL chứa comment, không cho phép." };
  }

  // Phải bắt đầu bằng SELECT
  if (!lower.startsWith("select")) return { ok: false, reason: "Chỉ cho phép SELECT query." };
  // Không cho nhiều câu
  if (cleaned.includes(";")) return { ok: false, reason: "Không cho phép nhiều câu SQL." };

  // Whitelist động: lấy từ schema_metadata
  const allowedTables = await getAllowedTables(connectionId, database);
  const tableRefs = [...cleaned.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi)].map(
    (match) => match[1].toLowerCase()
  );
  if (tableRefs.length === 0) return { ok: false, reason: "Không tìm thấy bảng FROM/JOIN hợp lệ." };

  const invalidTable = tableRefs.find((table) => !allowedTables.has(table));
  if (invalidTable) {
    const scope = connectionId ? `connection #${connectionId} (db: ${database || 'default'})` : 'DB chính';
    return { ok: false, reason: `Bảng "${invalidTable}" không nằm trong whitelist của ${scope}.` };
  }

  // Tự thêm LIMIT nếu cần (outer query level)
  // Check LIMIT ở cuối câu (không count sub-query)
  const trimmedForLimit = cleaned.replace(/\)\s*$/, "");
  const hasOuterLimit = /\)\s*limit\s+\d+\s*$/i.test(cleaned) || /^[^()]*limit\s+\d+\s*$/i.test(trimmedForLimit) || /\blimit\s+\d+\s*$/i.test(cleaned);
  const isAggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(cleaned);
  if (!hasOuterLimit && !isAggregate) {
    cleaned += " LIMIT 50";
  }

  return { ok: true, sql: cleaned };
}
