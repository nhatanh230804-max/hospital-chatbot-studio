// =============================================================================
// src/connections/encryption.js — AES-256-GCM for connection config secrets
// =============================================================================
// Mã hoá password trong config_json bằng AES-256-GCM. Key derive từ ADMIN_TOKEN
// (nếu ADMIN_TOKEN đổi → các connection cũ phải tạo lại). Đơn giản nhưng đủ
// để tránh password plain-text trong DB.
// =============================================================================
import crypto from "crypto";
import { ADMIN_TOKEN } from "../config.js";
import { getAdapter } from "../../lib/adapters.js";

const ENC_KEY = crypto
  .createHash("sha256")
  .update(ADMIN_TOKEN || "no-token-set-12345")
  .digest();

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([
    cipher.update(String(plain), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(encoded) {
  if (!encoded || !String(encoded).startsWith("enc:")) return encoded;
  try {
    const [, ivHex, tagHex, encHex] = encoded.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  } catch (err) {
    console.warn("Decrypt fail:", err.message);
    return null;
  }
}

export function encryptConfigSecrets(type, config) {
  const out = { ...config };
  const adapter = getAdapter(type);
  for (const field of adapter.configSchema) {
    if (field.type === "password" && out[field.key]) {
      out[field.key] = encryptSecret(out[field.key]);
    }
  }
  return out;
}

export function decryptConfigSecrets(type, config) {
  const out = { ...config };
  try {
    const adapter = getAdapter(type);
    for (const field of adapter.configSchema) {
      if (field.type === "password" && out[field.key]) {
        out[field.key] = decryptSecret(out[field.key]);
      }
    }
  } catch {}
  return out;
}

export function redactConfigForRead(type, config) {
  const out = { ...config };
  try {
    const adapter = getAdapter(type);
    for (const field of adapter.configSchema) {
      if (field.type === "password" && out[field.key]) {
        out[field.key] = "••••••••";
      }
    }
  } catch {}
  return out;
}
