"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * [INPUT]: 依赖 ../db 提供 webhooks 持久化，依赖 api-auth 进行远程调用鉴权。
 * [OUTPUT]: 对外提供 /api/webhooks 资源路由与 /api/webhooks/events 远程事件入口。
 * [POS]: server 远程 agent 集成路由，负责 webhook 管理与事件落库广播。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const express_1 = require("express");
const uuid_1 = require("uuid");
const db_1 = require("../db");
const api_auth_1 = require("../middleware/api-auth");
const activity_1 = require("../services/activity");
function parseEvents(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === "string");
}
function parseWebhookEvents(raw) {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return parseEvents(parsed);
    }
    catch {
        return [];
    }
}
function mapWebhookRow(row) {
    return {
        id: row.id,
        project_id: row.project_id,
        url: row.url,
        events: parseWebhookEvents(row.events),
        active: Boolean(row.active),
        created_at: row.created_at,
    };
}
const router = (0, express_1.Router)();
router.get("/", api_auth_1.optionalApiAuth, (req, res) => {
    const projectId = req.query.project_id ?? req.apiKey?.project_id;
    if (!projectId) {
        res.status(400).json({ error: "project_id is required" });
        return;
    }
    const rows = db_1.db
        .prepare(`
        SELECT id, project_id, url, events, active, created_at, updated_at
        FROM webhooks
        WHERE project_id = ?
        ORDER BY datetime(created_at) DESC
      `)
        .all(projectId);
    res.json(rows.map(mapWebhookRow));
});
router.post("/", api_auth_1.optionalApiAuth, (req, res) => {
    const body = req.body;
    const projectId = (typeof body.project_id === "string" && body.project_id.trim().length > 0
        ? body.project_id.trim()
        : null) ??
        req.apiKey?.project_id ??
        db_1.DEFAULT_PROJECT_ID;
    if (typeof body.url !== "string" || body.url.trim().length === 0) {
        res.status(400).json({ error: "url is required" });
        return;
    }
    const now = (0, db_1.nowIso)();
    const id = (0, uuid_1.v4)();
    const events = parseEvents(body.events);
    const active = body.active === undefined ? true : Boolean(body.active);
    db_1.db.prepare(`
      INSERT INTO webhooks (id, project_id, url, events, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, body.url.trim(), JSON.stringify(events), active ? 1 : 0, now, now);
    (0, activity_1.recordActivity)({
        projectId,
        action: "webhook.created",
        details: { webhook_id: id, url: body.url.trim() },
    });
    const created = db_1.db
        .prepare("SELECT id, project_id, url, events, active, created_at, updated_at FROM webhooks WHERE id = ?")
        .get(id);
    res.status(201).json(mapWebhookRow(created));
});
function updateWebhook(req, res) {
    const body = req.body;
    const existing = db_1.db
        .prepare("SELECT id, project_id, url, events, active, created_at, updated_at FROM webhooks WHERE id = ?")
        .get(req.params.id);
    if (!existing) {
        res.status(404).json({ error: "webhook not found" });
        return;
    }
    const updates = [];
    const params = [];
    if (body.url !== undefined) {
        if (typeof body.url !== "string" || body.url.trim().length === 0) {
            res.status(400).json({ error: "url must be non-empty string" });
            return;
        }
        updates.push("url = ?");
        params.push(body.url.trim());
    }
    if (body.events !== undefined) {
        if (!Array.isArray(body.events) || body.events.some((item) => typeof item !== "string")) {
            res.status(400).json({ error: "events must be string array" });
            return;
        }
        updates.push("events = ?");
        params.push(JSON.stringify(body.events));
    }
    if (body.active !== undefined) {
        updates.push("active = ?");
        params.push(body.active ? 1 : 0);
    }
    if (updates.length > 0) {
        updates.push("updated_at = ?");
        params.push((0, db_1.nowIso)(), req.params.id);
        db_1.db.prepare(`UPDATE webhooks SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }
    const updated = db_1.db
        .prepare("SELECT id, project_id, url, events, active, created_at, updated_at FROM webhooks WHERE id = ?")
        .get(req.params.id);
    (0, activity_1.recordActivity)({
        projectId: updated.project_id,
        action: "webhook.updated",
        details: { webhook_id: updated.id },
    });
    res.json(mapWebhookRow(updated));
}
router.patch("/:id", api_auth_1.optionalApiAuth, updateWebhook);
router.put("/:id", api_auth_1.optionalApiAuth, updateWebhook);
router.delete("/:id", api_auth_1.optionalApiAuth, (req, res) => {
    const row = db_1.db
        .prepare("SELECT id, project_id FROM webhooks WHERE id = ?")
        .get(req.params.id);
    if (!row) {
        res.status(404).json({ error: "webhook not found" });
        return;
    }
    db_1.db.prepare("DELETE FROM webhooks WHERE id = ?").run(req.params.id);
    (0, activity_1.recordActivity)({
        projectId: row.project_id,
        action: "webhook.deleted",
        details: { webhook_id: row.id },
    });
    res.status(204).send();
});
// Remote agents can post events authenticated by API key.
router.post("/events", api_auth_1.requireApiAuth, (req, res) => {
    const body = req.body;
    if (typeof body.action !== "string" || body.action.trim().length === 0) {
        res.status(400).json({ error: "action is required" });
        return;
    }
    const projectId = typeof body.project_id === "string" && body.project_id.trim().length > 0
        ? body.project_id.trim()
        : req.apiKey?.project_id ?? db_1.DEFAULT_PROJECT_ID;
    const details = body.details && typeof body.details === "object"
        ? body.details
        : {};
    const agentId = typeof body.agent_id === "string" ? body.agent_id : null;
    const activity = (0, activity_1.recordActivity)({
        projectId,
        agentId,
        action: body.action.trim(),
        details,
    });
    res.status(201).json({ ok: true, activity });
});
exports.default = router;
//# sourceMappingURL=webhooks.js.map