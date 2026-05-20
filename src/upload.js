// =============================================================================
// src/upload.js — Multer config for FAQ file uploads
// =============================================================================
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root = parent of src/
const projectRoot = path.resolve(__dirname, "..");

export const FAQ_UPLOAD_DIR = path.join(projectRoot, "uploads", "faq");
if (!fs.existsSync(FAQ_UPLOAD_DIR))
  fs.mkdirSync(FAQ_UPLOAD_DIR, { recursive: true });

const faqStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FAQ_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeBase = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 80);
    const ext = path.extname(file.originalname).toLowerCase();
    const id = crypto.randomBytes(6).toString("hex");
    cb(null, `${Date.now()}_${id}_${safeBase}${ext}`);
  },
});

export const ALLOWED_FAQ_EXT = new Set([".txt", ".md", ".docx", ".pdf"]);

export const faqUpload = multer({
  storage: faqStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_FAQ_EXT.has(ext)) {
      return cb(
        new Error(`Chỉ hỗ trợ file ${[...ALLOWED_FAQ_EXT].join(", ")}`),
      );
    }
    cb(null, true);
  },
});
