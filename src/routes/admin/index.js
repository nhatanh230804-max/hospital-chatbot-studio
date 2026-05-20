// =============================================================================
// src/routes/admin/index.js — Aggregates all /api/admin/* routers + adminLimiter
// =============================================================================
import express from "express";
import { adminLimiter } from "../../middleware.js";
import summaryRouter from "./summary.js";
import feedbackRouter from "./feedback.js";
import keywordsRouter from "./keywords.js";
import faqsRouter from "./faqs.js";
import schemaRouter from "./schema.js";
import sqlTemplatesRouter from "./sql-templates.js";
import trustedSourcesRouter from "./trusted-sources.js";
import miscRouter from "./misc.js";
import dataConnectionsRouter from "./data-connections.js";
import minioRouter from "./minio.js";

const router = express.Router();

// Áp adminLimiter cho mọi route admin
router.use("/api/admin", adminLimiter);

router.use(summaryRouter);
router.use(feedbackRouter);
router.use(keywordsRouter);
router.use(faqsRouter);
router.use(schemaRouter);
router.use(sqlTemplatesRouter);
router.use(trustedSourcesRouter);
router.use(miscRouter);
router.use(dataConnectionsRouter);
router.use(minioRouter);

export default router;
