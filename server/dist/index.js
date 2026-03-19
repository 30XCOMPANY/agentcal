"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * [INPUT]: Depends on route modules, DB lifecycle, sync scheduler, and task scheduler services.
 * [OUTPUT]: Boots the HTTP/WebSocket server and wires graceful shutdown hooks.
 * [POS]: Server runtime entrypoint coordinating middleware, routers, and background schedulers.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const node_http_1 = __importDefault(require("node:http"));
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const db_1 = require("./db");
const api_auth_1 = require("./middleware/api-auth");
const agents_1 = __importDefault(require("./routes/agents"));
const auth_1 = __importDefault(require("./routes/auth"));
const calendar_1 = __importDefault(require("./routes/calendar"));
const projects_1 = __importDefault(require("./routes/projects"));
const system_1 = require("./routes/system");
const tasks_1 = __importDefault(require("./routes/tasks"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const sync_1 = require("./services/sync");
const task_scheduler_1 = require("./services/task-scheduler");
const ws_1 = require("./ws");
const app = (0, express_1.default)();
const allowedOrigins = (process.env.AGENTCAL_CORS_ORIGINS ?? "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
app.use((0, cors_1.default)({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error(`CORS origin denied: ${origin}`));
    },
}));
app.use(express_1.default.json({ limit: "2mb" }));
app.use(api_auth_1.optionalApiAuth);
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "agentcal-backend" });
});
app.use("/api/agents", agents_1.default);
app.use("/api/auth", auth_1.default);
app.use("/api/projects", projects_1.default);
app.use("/api/tasks", tasks_1.default);
app.use("/api/calendar", calendar_1.default);
app.use("/api/webhooks", webhooks_1.default);
app.use("/api/system", (0, system_1.createSystemRouter)({ runSync: sync_1.triggerManualSync }));
app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
});
app.use((error, _req, res, _next) => {
    const message = error instanceof Error ? error.message : "internal server error";
    console.error("[agentcal] error", error);
    res.status(500).json({ error: message });
});
const server = node_http_1.default.createServer(app);
(0, ws_1.setupWebSocketServer)(server);
const port = Number.parseInt(process.env.PORT ?? "3100", 10);
server.listen(port, () => {
    console.log(`[agentcal] server listening on http://localhost:${port}`);
    console.log(`[agentcal] sqlite database: ${db_1.DB_PATH}`);
    (0, sync_1.startSyncScheduler)(10_000);
    (0, task_scheduler_1.startTaskScheduler)(30_000);
});
function shutdown(signal) {
    console.log(`[agentcal] received ${signal}, shutting down`);
    (0, sync_1.stopSyncScheduler)();
    (0, task_scheduler_1.stopTaskScheduler)();
    server.close(() => {
        (0, db_1.closeDb)();
        process.exit(0);
    });
    setTimeout(() => {
        process.exit(1);
    }, 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
//# sourceMappingURL=index.js.map