"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSystemRouter = createSystemRouter;
/**
 * [INPUT]: Depends on system metrics, DB aggregate queries, sync trigger, and task scheduler config/queue services.
 * [OUTPUT]: Exposes system status/stats APIs and queue/config management endpoints.
 * [POS]: System route gateway for operational introspection and scheduler controls.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const node_os_1 = __importDefault(require("node:os"));
const express_1 = require("express");
const db_1 = require("../db");
const agent_swarm_1 = require("../services/agent-swarm");
const task_scheduler_1 = require("../services/task-scheduler");
function createSystemRouter(options) {
    const router = (0, express_1.Router)();
    router.get("/status", async (_req, res) => {
        const memoryTotal = node_os_1.default.totalmem();
        const memoryFree = node_os_1.default.freemem();
        const memoryUsed = memoryTotal - memoryFree;
        const activeAgents = db_1.db
            .prepare("SELECT COUNT(*) AS count FROM agents WHERE status = 'busy'")
            .get();
        const totalAgents = db_1.db.prepare("SELECT COUNT(*) AS count FROM agents").get();
        const runningTasks = db_1.db
            .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'")
            .get();
        let swarmStatus = null;
        try {
            const status = await (0, agent_swarm_1.getAgentSwarmStatus)();
            swarmStatus = { stdout: status.stdout, stderr: status.stderr };
        }
        catch {
            swarmStatus = null;
        }
        res.json({
            timestamp: (0, db_1.nowIso)(),
            cpu: {
                cores: node_os_1.default.cpus().length,
                load_avg: node_os_1.default.loadavg(),
            },
            memory: {
                total_mb: Math.round(memoryTotal / 1024 / 1024),
                free_mb: Math.round(memoryFree / 1024 / 1024),
                used_mb: Math.round(memoryUsed / 1024 / 1024),
                usage_percent: Number(((memoryUsed / memoryTotal) * 100).toFixed(2)),
            },
            agents: {
                active: activeAgents.count,
                total: totalAgents.count,
            },
            tasks: {
                running: runningTasks.count,
            },
            process: {
                uptime_sec: Math.round(process.uptime()),
                pid: process.pid,
            },
            swarm: swarmStatus,
        });
    });
    router.post("/sync", async (_req, res, next) => {
        try {
            const result = await options.runSync();
            res.json(result);
        }
        catch (error) {
            next(error);
        }
    });
    router.get("/stats", (_req, res) => {
        const totals = db_1.db.prepare(`
        SELECT
          COUNT(*) AS total_tasks,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_tasks,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_tasks,
          AVG(actual_duration_min) AS avg_duration_min
        FROM tasks
      `).get();
        const byStatus = db_1.db.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status").all();
        const days30Ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const completionTrend = db_1.db
            .prepare(`
          SELECT
            substr(completed_at, 1, 10) AS date,
            COUNT(*) AS count
          FROM tasks
          WHERE completed_at IS NOT NULL
            AND completed_at >= ?
          GROUP BY substr(completed_at, 1, 10)
          ORDER BY date ASC
        `)
            .all(days30Ago);
        const agentUtilization = db_1.db
            .prepare(`
          SELECT
            a.id,
            a.name,
            a.type,
            a.status,
            a.total_tasks,
            a.success_count,
            a.fail_count,
            a.avg_duration_min,
            SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END) AS running_tasks
          FROM agents a
          LEFT JOIN tasks t ON t.agent_id = a.id
          GROUP BY a.id
          ORDER BY a.name ASC
        `)
            .all();
        const completed = totals.completed_tasks ?? 0;
        const failed = totals.failed_tasks ?? 0;
        const successRate = completed + failed === 0 ? 0 : Number((completed / (completed + failed)).toFixed(4));
        res.json({
            generated_at: (0, db_1.nowIso)(),
            totals: {
                total_tasks: totals.total_tasks,
                completed_tasks: completed,
                failed_tasks: failed,
                avg_duration_min: totals.avg_duration_min === null ? null : Number(totals.avg_duration_min.toFixed(2)),
                success_rate: successRate,
            },
            by_status: byStatus,
            completion_trend_30d: completionTrend,
            agent_utilization: agentUtilization,
        });
    });
    router.get("/queue", (_req, res) => {
        res.json((0, task_scheduler_1.getQueueStatus)());
    });
    router.get("/config", (_req, res) => {
        res.json((0, task_scheduler_1.getSystemConfig)());
    });
    router.put("/config", (req, res) => {
        const body = req.body;
        if ("max_concurrent_agents" in body && typeof body.max_concurrent_agents !== "number") {
            res.status(400).json({ error: "max_concurrent_agents must be a number" });
            return;
        }
        try {
            const config = (0, task_scheduler_1.updateSystemConfig)({
                max_concurrent_agents: typeof body.max_concurrent_agents === "number" ? body.max_concurrent_agents : undefined,
            });
            res.json(config);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "invalid config payload";
            res.status(400).json({ error: message });
        }
    });
    return router;
}
//# sourceMappingURL=system.js.map