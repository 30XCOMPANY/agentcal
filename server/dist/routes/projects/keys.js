"use strict";
/**
 * [INPUT]: Depends on express Router, SQLite db timestamps, and shared project-route helpers.
 * [OUTPUT]: Exposes API key management routes under /api/projects/:id/keys.
 * [POS]: Project sub-router for listing, creating, and deleting project-scoped API keys.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../db");
const shared_1 = require("./shared");
const router = (0, express_1.Router)({ mergeParams: true });
router.get("/keys", (0, shared_1.withProjectRouteError)("getting API keys", "Failed to get API keys", (req, res) => {
    const keys = db_1.db
        .prepare(`
      SELECT id, project_id, key, label, created_at, expires_at
      FROM api_keys
      WHERE project_id = ?
      ORDER BY created_at DESC
    `)
        .all(req.params.id);
    res.json(keys);
}));
router.post("/keys", (0, shared_1.withProjectRouteError)("creating API key", "Failed to create API key", (req, res) => {
    const { label = "", expires_at } = req.body;
    if (label !== undefined && typeof label !== "string") {
        res.status(400).json({ error: "label must be a string" });
        return;
    }
    if (expires_at !== undefined && expires_at !== null && typeof expires_at !== "string") {
        res.status(400).json({ error: "expires_at must be a string or null" });
        return;
    }
    const id = (0, shared_1.createEntityId)("key");
    const key = `agc_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
    const createdAt = (0, db_1.nowIso)();
    const normalizedLabel = typeof label === "string" ? label : "";
    const normalizedExpiresAt = typeof expires_at === "string" ? expires_at : null;
    const responseExpiresAt = typeof expires_at === "string" ? expires_at : undefined;
    db_1.db.prepare(`
      INSERT INTO api_keys (id, project_id, key, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.id, key, normalizedLabel, createdAt, normalizedExpiresAt);
    res.status(201).json({
        id,
        project_id: req.params.id,
        key,
        label: normalizedLabel,
        created_at: createdAt,
        expires_at: responseExpiresAt,
    });
}));
router.delete("/keys/:keyId", (0, shared_1.withProjectRouteError)("deleting API key", "Failed to delete API key", (req, res) => {
    db_1.db.prepare("DELETE FROM api_keys WHERE id = ?").run(req.params.keyId);
    res.status(204).send();
}));
exports.default = router;
//# sourceMappingURL=keys.js.map