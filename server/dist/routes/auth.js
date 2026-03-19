"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * [INPUT]: 依赖 ../services/auth 生成 api key，依赖 ../db 校验项目存在。
 * [OUTPUT]: 对外提供 /api/auth/token 用于远程 agent 鉴权 token 申请。
 * [POS]: server 认证路由入口，聚焦 token 生命周期创建。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const express_1 = require("express");
const db_1 = require("../db");
const auth_1 = require("../services/auth");
const activity_1 = require("../services/activity");
const router = (0, express_1.Router)();
router.post("/token", (req, res) => {
    const body = req.body;
    const projectId = typeof body.project_id === "string" && body.project_id.trim().length > 0
        ? body.project_id.trim()
        : db_1.DEFAULT_PROJECT_ID;
    const project = db_1.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) {
        res.status(404).json({ error: "project not found" });
        return;
    }
    const apiKey = (0, auth_1.createApiKey)({
        projectId,
        label: typeof body.label === "string" ? body.label : "Remote agent token",
        expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
    });
    (0, activity_1.recordActivity)({
        projectId,
        action: "auth.token_created",
        details: { key_id: apiKey.id, label: apiKey.label },
    });
    res.status(201).json(apiKey);
});
exports.default = router;
//# sourceMappingURL=auth.js.map