"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateApiToken = generateApiToken;
exports.createApiKey = createApiKey;
exports.parseApiToken = parseApiToken;
exports.getApiKeyByToken = getApiKeyByToken;
exports.redactApiKey = redactApiKey;
/**
 * [INPUT]: 依赖 node:crypto 生成安全 token，依赖 ../db 访问 api_keys 表。
 * [OUTPUT]: 对外提供 API key 生成、校验、提取与脱敏能力。
 * [POS]: server 远程 agent 认证服务，被 auth/webhooks/routes 复用。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const node_crypto_1 = __importDefault(require("node:crypto"));
const uuid_1 = require("uuid");
const db_1 = require("../db");
function mapApiKeyRow(row) {
    return {
        id: row.id,
        project_id: row.project_id,
        key: row.key,
        label: row.label,
        created_at: row.created_at,
        expires_at: row.expires_at,
    };
}
function generateApiToken() {
    return `agc_${node_crypto_1.default.randomBytes(24).toString("hex")}`;
}
function createApiKey(input) {
    const now = (0, db_1.nowIso)();
    const key = {
        id: (0, uuid_1.v4)(),
        project_id: input.projectId,
        key: generateApiToken(),
        label: input.label?.trim() ?? "",
        created_at: now,
        expires_at: input.expiresAt ?? null,
    };
    db_1.db.prepare(`
      INSERT INTO api_keys (id, project_id, key, label, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(key.id, key.project_id, key.key, key.label, key.created_at, key.expires_at);
    return key;
}
function parseApiToken(req) {
    const bearer = req.header("authorization");
    if (bearer && /^bearer\s+/i.test(bearer)) {
        return bearer.replace(/^bearer\s+/i, "").trim() || null;
    }
    const xApiKey = req.header("x-api-key");
    if (xApiKey && xApiKey.trim().length > 0) {
        return xApiKey.trim();
    }
    return null;
}
function getApiKeyByToken(token) {
    const row = db_1.db.prepare("SELECT * FROM api_keys WHERE key = ? LIMIT 1").get(token);
    if (!row) {
        return null;
    }
    if (row.expires_at) {
        const expiresAt = Date.parse(row.expires_at);
        if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
            return null;
        }
    }
    return mapApiKeyRow(row);
}
function redactApiKey(apiKey) {
    const visibleHead = apiKey.key.slice(0, 8);
    const visibleTail = apiKey.key.slice(-4);
    return {
        ...apiKey,
        key: `${visibleHead}...${visibleTail}`,
    };
}
//# sourceMappingURL=auth.js.map