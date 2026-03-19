"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordActivity = recordActivity;
exports.listActivities = listActivities;
/**
 * [INPUT]: 依赖 ../db 提供存储与时间函数，依赖 ../ws 提供实时广播能力。
 * [OUTPUT]: 对外提供活动写入与项目活动流读取能力。
 * [POS]: server 活动审计服务，被 tasks/agents/projects/webhooks 路由复用。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const uuid_1 = require("uuid");
const db_1 = require("../db");
const ws_1 = require("../ws");
const SYSTEM_AGENT_ID = "agentcal_system";
function parseDetails(raw) {
    if (!raw) {
        return {};
    }
    try {
        const value = JSON.parse(raw);
        return value && typeof value === "object" ? value : {};
    }
    catch {
        return {};
    }
}
function mapActivityRow(row) {
    return {
        id: row.id,
        project_id: row.project_id,
        agent_id: row.agent_id,
        action: row.action,
        details: parseDetails(row.details),
        created_at: row.created_at,
        agent_name: row.agent_name,
        agent_type: row.agent_type,
    };
}
function ensureSystemAgent(projectId) {
    const now = (0, db_1.nowIso)();
    db_1.db.prepare(`
      INSERT INTO agents (
        id, project_id, name, type, status, current_task_id, total_tasks, success_count, fail_count, avg_duration_min, created_at, updated_at
      )
      VALUES (?, ?, 'System', 'codex', 'idle', NULL, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        updated_at = excluded.updated_at
    `).run(SYSTEM_AGENT_ID, projectId, now, now);
    return SYSTEM_AGENT_ID;
}
function recordActivity(input) {
    const projectId = input.projectId || db_1.DEFAULT_PROJECT_ID;
    const now = (0, db_1.nowIso)();
    const id = (0, uuid_1.v4)();
    const actorId = input.agentId ?? ensureSystemAgent(projectId);
    db_1.db.prepare(`
      INSERT INTO activities (id, project_id, agent_id, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, actorId, input.action, JSON.stringify(input.details ?? {}), now);
    const row = db_1.db
        .prepare(`
        SELECT a.*, ag.name AS agent_name, ag.type AS agent_type
        FROM activities a
        LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE a.id = ?
      `)
        .get(id);
    const activity = row
        ? mapActivityRow(row)
        : {
            id,
            project_id: projectId,
            agent_id: actorId,
            action: input.action,
            details: input.details ?? {},
            created_at: now,
        };
    (0, ws_1.broadcast)("activity:created", { activity });
    return activity;
}
function listActivities(projectId, limit = 50) {
    const rows = db_1.db
        .prepare(`
        SELECT a.*, ag.name AS agent_name, ag.type AS agent_type
        FROM activities a
        LEFT JOIN agents ag ON a.agent_id = ag.id
        WHERE a.project_id = ?
        ORDER BY datetime(a.created_at) DESC
        LIMIT ?
      `)
        .all(projectId, limit);
    return rows.map(mapActivityRow);
}
//# sourceMappingURL=activity.js.map