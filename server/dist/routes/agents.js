"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * [INPUT]: 依赖 ../db 提供 agent 持久化，依赖 activity/ws 服务提供审计与实时更新。
 * [OUTPUT]: 对外提供 /api/agents CRUD，并支持 project_id 与 profile 扩展字段。
 * [POS]: server agent 资源路由，连接代理状态与多项目归属。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const express_1 = require("express");
const uuid_1 = require("uuid");
const db_1 = require("../db");
const activity_1 = require("../services/activity");
const ws_1 = require("../ws");
const AGENT_TYPES = ["codex", "claude"];
const AGENT_STATUSES = ["idle", "busy", "offline"];
function isAgentType(value) {
    return typeof value === "string" && AGENT_TYPES.includes(value);
}
function isAgentStatus(value) {
    return typeof value === "string" && AGENT_STATUSES.includes(value);
}
function parseSettings(value) {
    if (value && typeof value === "object") {
        return value;
    }
    return {};
}
function withProfile(agent) {
    const base = (0, db_1.mapAgentRow)(agent);
    const profile = db_1.db
        .prepare("SELECT emoji, avatar_url, color, settings FROM agent_profiles WHERE agent_id = ?")
        .get(agent.id);
    if (!profile) {
        return base;
    }
    let settings = {};
    try {
        const parsed = JSON.parse(profile.settings);
        settings = parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        settings = {};
    }
    return {
        ...base,
        emoji: profile.emoji,
        avatar_url: profile.avatar_url,
        color: profile.color,
        settings,
    };
}
const router = (0, express_1.Router)();
router.get("/", (req, res) => {
    const projectId = typeof req.query.project_id === "string" && req.query.project_id.trim().length > 0
        ? req.query.project_id.trim()
        : null;
    const rows = (projectId
        ? db_1.db
            .prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC")
            .all(projectId)
        : db_1.db
            .prepare("SELECT * FROM agents ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC")
            .all());
    res.json(rows.map(withProfile));
});
router.post("/", (req, res) => {
    const body = req.body;
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
        res.status(400).json({ error: "name is required" });
        return;
    }
    if (!isAgentType(body.type)) {
        res.status(400).json({ error: "type must be codex or claude" });
        return;
    }
    if (body.status !== undefined && !isAgentStatus(body.status)) {
        res.status(400).json({ error: "status must be idle, busy, or offline" });
        return;
    }
    if (body.current_task_id !== undefined &&
        body.current_task_id !== null &&
        (typeof body.current_task_id !== "string" || body.current_task_id.trim().length === 0)) {
        res.status(400).json({ error: "current_task_id must be null or string" });
        return;
    }
    const id = (0, uuid_1.v4)();
    const now = (0, db_1.nowIso)();
    const projectId = typeof body.project_id === "string" && body.project_id.trim().length > 0
        ? body.project_id.trim()
        : db_1.DEFAULT_PROJECT_ID;
    db_1.db.prepare(`
      INSERT INTO agents (
        id, project_id, name, type, status, current_task_id,
        total_tasks, success_count, fail_count, avg_duration_min,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
    `).run(id, projectId, body.name.trim(), body.type, body.status ?? "idle", body.current_task_id ?? null, now, now);
    db_1.db.prepare(`
      INSERT INTO agent_profiles (id, agent_id, emoji, avatar_url, color, settings, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run((0, uuid_1.v4)(), id, typeof body.emoji === "string" ? body.emoji : "🤖", typeof body.avatar_url === "string" ? body.avatar_url : "", typeof body.color === "string" ? body.color : "#3b82f6", JSON.stringify(parseSettings(body.settings)), now, now);
    const created = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    const payload = withProfile(created);
    (0, activity_1.recordActivity)({
        projectId,
        agentId: id,
        action: "agent.registered",
        details: { agent_id: id, name: created.name },
    });
    (0, ws_1.broadcast)("agent:status", { agent: payload });
    res.status(201).json(payload);
});
router.get("/:id", (req, res) => {
    const row = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(req.params.id);
    if (!row) {
        res.status(404).json({ error: "agent not found" });
        return;
    }
    res.json(withProfile(row));
});
router.put("/:id", (req, res) => {
    const id = req.params.id;
    const existing = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    if (!existing) {
        res.status(404).json({ error: "agent not found" });
        return;
    }
    const body = req.body;
    const updates = [];
    const params = [];
    if ("name" in body) {
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
            res.status(400).json({ error: "name must be a non-empty string" });
            return;
        }
        updates.push("name = ?");
        params.push(body.name.trim());
    }
    if ("type" in body) {
        if (!isAgentType(body.type)) {
            res.status(400).json({ error: "type must be codex or claude" });
            return;
        }
        updates.push("type = ?");
        params.push(body.type);
    }
    if ("status" in body) {
        if (!isAgentStatus(body.status)) {
            res.status(400).json({ error: "status must be idle, busy, or offline" });
            return;
        }
        updates.push("status = ?");
        params.push(body.status);
    }
    if ("project_id" in body) {
        if (body.project_id !== null && (typeof body.project_id !== "string" || body.project_id.trim().length === 0)) {
            res.status(400).json({ error: "project_id must be null or non-empty string" });
            return;
        }
        updates.push("project_id = ?");
        params.push(body.project_id ? String(body.project_id).trim() : null);
    }
    if ("current_task_id" in body) {
        if (body.current_task_id !== null &&
            (typeof body.current_task_id !== "string" || body.current_task_id.trim().length === 0)) {
            res.status(400).json({ error: "current_task_id must be null or string" });
            return;
        }
        updates.push("current_task_id = ?");
        params.push(body.current_task_id ?? null);
    }
    const now = (0, db_1.nowIso)();
    if (updates.length > 0) {
        updates.push("updated_at = ?");
        params.push(now, id);
        db_1.db.prepare(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...params);
    }
    const profileFields = ["emoji", "avatar_url", "color", "settings"].some((field) => field in body);
    if (profileFields) {
        db_1.db.prepare(`
        INSERT INTO agent_profiles (id, agent_id, emoji, avatar_url, color, settings, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          emoji = COALESCE(?, agent_profiles.emoji),
          avatar_url = COALESCE(?, agent_profiles.avatar_url),
          color = COALESCE(?, agent_profiles.color),
          settings = COALESCE(?, agent_profiles.settings),
          updated_at = excluded.updated_at
      `).run((0, uuid_1.v4)(), id, typeof body.emoji === "string" ? body.emoji : "🤖", typeof body.avatar_url === "string" ? body.avatar_url : "", typeof body.color === "string" ? body.color : "#3b82f6", JSON.stringify(parseSettings(body.settings)), now, now, typeof body.emoji === "string" ? body.emoji : null, typeof body.avatar_url === "string" ? body.avatar_url : null, typeof body.color === "string" ? body.color : null, body.settings !== undefined ? JSON.stringify(parseSettings(body.settings)) : null);
    }
    const updated = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    const payload = withProfile(updated);
    (0, activity_1.recordActivity)({
        projectId: updated.project_id ?? db_1.DEFAULT_PROJECT_ID,
        agentId: id,
        action: "agent.updated",
        details: { agent_id: id },
    });
    (0, ws_1.broadcast)("agent:status", { agent: payload });
    res.json(payload);
});
router.delete("/:id", (req, res) => {
    const row = db_1.db.prepare("SELECT id, project_id FROM agents WHERE id = ?").get(req.params.id);
    if (!row) {
        res.status(404).json({ error: "agent not found" });
        return;
    }
    db_1.db.prepare("DELETE FROM agents WHERE id = ?").run(req.params.id);
    (0, activity_1.recordActivity)({
        projectId: row.project_id ?? db_1.DEFAULT_PROJECT_ID,
        agentId: row.id,
        action: "agent.deleted",
        details: { agent_id: row.id },
    });
    res.status(204).send();
});
exports.default = router;
//# sourceMappingURL=agents.js.map