"use strict";
/**
 * [INPUT]: Depends on express Router, SQLite db, and parsing/error helpers from ./shared.
 * [OUTPUT]: Exposes project activity feed route under /api/projects/:id/activities.
 * [POS]: Read-only project sub-router for activity stream retrieval.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../db");
const shared_1 = require("./shared");
const router = (0, express_1.Router)({ mergeParams: true });
router.get("/activities", (0, shared_1.withProjectRouteError)("getting project activities", "Failed to get project activities", (req, res) => {
    const limit = (0, shared_1.parsePositiveLimit)(req.query.limit, 50);
    const activities = db_1.db
        .prepare(`
      SELECT a.*, ag.name as agent_name, ag.type as agent_type
      FROM activities a
      JOIN agents ag ON a.agent_id = ag.id
      WHERE a.project_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?
    `)
        .all(req.params.id, limit);
    res.json(activities);
}));
exports.default = router;
//# sourceMappingURL=activities.js.map