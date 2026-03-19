"use strict";
/**
 * [INPUT]: Depends on express Router, SQLite db, and shared route helpers from ./shared.
 * [OUTPUT]: Exposes project agent-member routes for listing, adding, and removing project members.
 * [POS]: Project sub-router focused on project-agent membership management under /api/projects/:id/members.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../db");
const shared_1 = require("./shared");
const router = (0, express_1.Router)({ mergeParams: true });
router.get("/members", (0, shared_1.withProjectRouteError)("getting project members", "Failed to get project members", (req, res) => {
    const members = db_1.db
        .prepare(`
      SELECT pm.*, a.name as agent_name, a.type as agent_type, a.status as agent_status
      FROM project_members pm
      JOIN agents a ON pm.agent_id = a.id
      WHERE pm.project_id = ?
      ORDER BY pm.joined_at DESC
    `)
        .all(req.params.id);
    res.json(members);
}));
router.post("/members", (0, shared_1.withProjectRouteError)("adding project member", "Failed to add project member", (req, res) => {
    const { agent_id, role = "member" } = req.body;
    if (typeof agent_id !== "string" || agent_id.trim().length === 0) {
        res.status(400).json({ error: "agent_id is required" });
        return;
    }
    const normalizedRole = role ?? "member";
    if (normalizedRole !== "owner" && normalizedRole !== "member") {
        res.status(400).json({ error: "role must be owner or member" });
        return;
    }
    const id = (0, shared_1.createEntityId)("pm");
    const joinedAt = (0, db_1.nowIso)();
    db_1.db.prepare(`
      INSERT INTO project_members (id, project_id, agent_id, role, joined_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, agent_id.trim(), normalizedRole, joinedAt);
    const member = db_1.db
        .prepare(`
      SELECT pm.*, a.name as agent_name, a.type as agent_type
      FROM project_members pm
      JOIN agents a ON pm.agent_id = a.id
      WHERE pm.id = ?
    `)
        .get(id);
    res.status(201).json(member);
}));
router.delete("/members/:agentId", (0, shared_1.withProjectRouteError)("removing project member", "Failed to remove project member", (req, res) => {
    db_1.db.prepare("DELETE FROM project_members WHERE project_id = ? AND agent_id = ?").run(req.params.id, req.params.agentId);
    res.status(204).send();
}));
exports.default = router;
//# sourceMappingURL=agents.js.map