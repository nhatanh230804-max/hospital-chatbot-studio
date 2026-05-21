// =============================================================================
// src/session/chat-session-store.js
// =============================================================================
// Lớp lưu trữ session hội thoại ngắn hạn (short-term memory).
//
// Thiết kế abstraction: code gọi chỉ dùng get / set / delete — KHÔNG biết
// bên dưới là Redis hay in-memory. Muốn đổi backend chỉ sửa đúng file này.
//
//   - Nếu .env có REDIS_URL  → dùng Redis (chuẩn cho production nhiều instance)
//   - Nếu không có           → dùng Map in-memory (đủ cho 1 instance / dev / test)
//   - Nếu REDIS_URL có nhưng kết nối fail → tự fallback in-memory, không crash app
//
// TTL = SESSION_TTL_SECONDS (mặc định 300s). TTL "trượt": mỗi lần get/set lại
// gia hạn thêm 300s → "5 phút không tương tác thì phiên hết hạn".
// =============================================================================
import { REDIS_URL, SESSION_TTL_SECONDS } from "../config.js";

const TTL_SECONDS = SESSION_TTL_SECONDS;
const TTL_MS = TTL_SECONDS * 1000;
const KEY_PREFIX = "chatsess:";

// -----------------------------------------------------------------------------
// Backend 1: In-memory (Map) — dùng khi không có Redis
// -----------------------------------------------------------------------------
function createMemoryStore() {
  const map = new Map(); // sessionId -> { data, expiresAt }

  // Quét xoá session hết hạn mỗi 60s để không leak bộ nhớ
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of map.entries()) {
      if (now > value.expiresAt) map.delete(key);
    }
  }, 60 * 1000).unref();

  return {
    backend: "memory",
    async get(sessionId) {
      const entry = map.get(sessionId);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        map.delete(sessionId);
        return null;
      }
      entry.expiresAt = Date.now() + TTL_MS; // TTL trượt
      return entry.data;
    },
    async set(sessionId, data) {
      map.set(sessionId, { data, expiresAt: Date.now() + TTL_MS });
    },
    async delete(sessionId) {
      map.delete(sessionId);
    },
  };
}

// -----------------------------------------------------------------------------
// Backend 2: Redis — dùng khi có REDIS_URL
// -----------------------------------------------------------------------------
async function createRedisStore() {
  // import động: chỉ nạp package 'redis' khi thực sự cần
  const { createClient } = await import("redis");
  const client = createClient({ url: REDIS_URL });
  client.on("error", (err) => console.warn("Redis client error:", err.message));
  await client.connect();
  console.log("✅ Redis connected — chat session store dùng Redis");

  return {
    backend: "redis",
    async get(sessionId) {
      try {
        const raw = await client.get(KEY_PREFIX + sessionId);
        if (!raw) return null;
        await client.expire(KEY_PREFIX + sessionId, TTL_SECONDS); // TTL trượt
        return JSON.parse(raw);
      } catch (err) {
        console.warn("Redis session get fail:", err.message);
        return null;
      }
    },
    async set(sessionId, data) {
      try {
        await client.set(KEY_PREFIX + sessionId, JSON.stringify(data), {
          EX: TTL_SECONDS,
        });
      } catch (err) {
        console.warn("Redis session set fail:", err.message);
      }
    },
    async delete(sessionId) {
      try {
        await client.del(KEY_PREFIX + sessionId);
      } catch {}
    },
  };
}

// -----------------------------------------------------------------------------
// Factory — chọn backend 1 lần, cache lại promise
// -----------------------------------------------------------------------------
let storePromise = null;

async function buildStore() {
  if (REDIS_URL) {
    try {
      return await createRedisStore();
    } catch (err) {
      console.warn(
        "⚠️ Không kết nối được Redis, tạm dùng in-memory session store:",
        err.message,
      );
      return createMemoryStore();
    }
  }
  console.log(
    "ℹ️ REDIS_URL chưa được cấu hình — chat session store dùng in-memory.",
  );
  return createMemoryStore();
}

// Trả về store (Promise). Lazy init — chỉ kết nối Redis ở lần gọi đầu tiên.
export function getSessionStore() {
  if (!storePromise) storePromise = buildStore();
  return storePromise;
}
