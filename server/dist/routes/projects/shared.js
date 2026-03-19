"use strict";
/**
 * [INPUT]: Depends on express request/response handlers and route modules under server/src/routes/projects.
 * [OUTPUT]: Exposes shared project-route helpers for id generation, safe parsing, and consistent error handling.
 * [POS]: Infrastructure utility layer for project sub-routes, reducing duplication across members/keys/webhooks/activities handlers.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.withProjectRouteError = withProjectRouteError;
exports.createEntityId = createEntityId;
exports.parsePositiveLimit = parsePositiveLimit;
exports.parseStringArray = parseStringArray;
exports.mapStoredWebhook = mapStoredWebhook;
function withProjectRouteError(context, fallbackMessage, handler) {
    return (req, res) => {
        try {
            handler(req, res);
        }
        catch (error) {
            console.error(`Error ${context}:`, error);
            res.status(500).json({ error: fallbackMessage });
        }
    };
}
function createEntityId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function parsePositiveLimit(value, fallback = 50) {
    if (typeof value !== "string") {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}
function parseStringArray(value) {
    if (!Array.isArray(value)) {
        throw new Error("events must be an array");
    }
    const events = value.map((item) => {
        if (typeof item !== "string") {
            throw new Error("events must only contain strings");
        }
        return item;
    });
    return events;
}
function parseStoredJsonArray(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return [];
    }
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.filter((item) => typeof item === "string");
}
function mapStoredWebhook(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const row = value;
    return {
        id: row.id,
        project_id: row.project_id,
        url: row.url,
        events: parseStoredJsonArray(row.events),
        active: Boolean(row.active),
        created_at: row.created_at,
    };
}
//# sourceMappingURL=shared.js.map