"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * [INPUT]: 依赖 ../db 的任务持久化能力与 ../services/prompt-parser 的语义解析能力。
 * [OUTPUT]: 对外提供 tasks 全生命周期 REST 路由，包括 Prompt-to-Task 创建入口。
 * [POS]: server 路由层任务核心编排器，连接 API 输入、数据库写入与活动广播。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const express_1 = require("express");
const uuid_1 = require("uuid");
const db_1 = require("../db");
const agent_swarm_1 = require("../services/agent-swarm");
const activity_1 = require("../services/activity");
const prompt_parser_1 = require("../services/prompt-parser");
const task_scheduler_1 = require("../services/task-scheduler");
const ws_1 = require("../ws");
const TASK_QUERY_STATUSES = [
    "blocked",
    "queued",
    "running",
    "pr_open",
    "completed",
    "failed",
    "archived",
];
const TASK_MUTABLE_STATUSES = [
    "queued",
    "running",
    "pr_open",
    "completed",
    "failed",
    "archived",
];
const TASK_PRIORITIES = ["low", "medium", "high", "urgent"];
const CI_STATUSES = ["pending", "passing", "failing"];
const REVIEW_STATUSES = ["pending", "approved", "rejected"];
function isTaskStatus(value) {
    return typeof value === "string" && TASK_QUERY_STATUSES.includes(value);
}
function isMutableTaskStatus(value) {
    return typeof value === "string" && TASK_MUTABLE_STATUSES.includes(value);
}
function isTaskPriority(value) {
    return typeof value === "string" && TASK_PRIORITIES.includes(value);
}
function isCiStatus(value) {
    return typeof value === "string" && CI_STATUSES.includes(value);
}
function isReviewStatus(value) {
    return typeof value === "string" && REVIEW_STATUSES.includes(value);
}
function isAgentType(value) {
    return value === "codex" || value === "claude";
}
function parseIsoField(value) {
    if (value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new Error("must be ISO8601 string or null");
    }
    const iso = (0, db_1.normalizeIso)(value);
    if (!iso) {
        throw new Error("invalid ISO8601 timestamp");
    }
    return iso;
}
function parseNonNegativeInt(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a non-negative number`);
    }
    return Math.trunc(value);
}
function parseNullableInt(value, field) {
    if (value === null) {
        return null;
    }
    return parseNonNegativeInt(value, field);
}
function parseDependsOn(value) {
    if (!Array.isArray(value)) {
        throw new Error("depends_on must be an array");
    }
    const deduped = new Set();
    for (const item of value) {
        if (typeof item !== "string" || item.trim().length === 0) {
            throw new Error("depends_on must only contain non-empty strings");
        }
        deduped.add(item.trim());
    }
    return [...deduped];
}
function assertDependencyTasksExist(dependsOn, projectId) {
    if (dependsOn.length === 0) {
        return;
    }
    const placeholders = dependsOn.map(() => "?").join(", ");
    const rows = db_1.db
        .prepare(`SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`)
        .all(...dependsOn);
    const found = new Set(rows.map((row) => row.id));
    const missing = dependsOn.filter((taskId) => !found.has(taskId));
    if (missing.length > 0) {
        throw new Error(`depends_on contains unknown task ids: ${missing.join(", ")}`);
    }
    const crossProject = rows.filter((row) => row.project_id !== projectId).map((row) => row.id);
    if (crossProject.length > 0) {
        throw new Error(`depends_on must reference tasks in same project: ${crossProject.join(", ")}`);
    }
}
function hasDependencyPath(fromTaskId, toTaskId) {
    const row = db_1.db
        .prepare(`
        WITH RECURSIVE walk(task_id) AS (
          SELECT ?
          UNION
          SELECT td.depends_on_task_id
          FROM task_dependencies td
          JOIN walk ON td.task_id = walk.task_id
        )
        SELECT 1 AS found
        FROM walk
        WHERE task_id = ?
        LIMIT 1
      `)
        .get(fromTaskId, toTaskId);
    return Boolean(row?.found);
}
function validateTaskDependencies(taskId, projectId, dependsOn) {
    if (dependsOn.includes(taskId)) {
        throw new Error("task cannot depend on itself");
    }
    assertDependencyTasksExist(dependsOn, projectId);
    for (const dependencyId of dependsOn) {
        if (hasDependencyPath(dependencyId, taskId)) {
            throw new Error(`dependency cycle detected: ${taskId} -> ${dependencyId} -> ${taskId}`);
        }
    }
}
function buildTaskDependencyTree(taskId) {
    const edges = db_1.db
        .prepare(`
        WITH RECURSIVE dep_tree(from_task_id, to_task_id, depth, path) AS (
          SELECT
            td.task_id,
            td.depends_on_task_id,
            1 AS depth,
            td.task_id || '>' || td.depends_on_task_id AS path
          FROM task_dependencies td
          WHERE td.task_id = ?

          UNION ALL

          SELECT
            td.task_id,
            td.depends_on_task_id,
            dep_tree.depth + 1,
            dep_tree.path || '>' || td.depends_on_task_id
          FROM task_dependencies td
          JOIN dep_tree ON td.task_id = dep_tree.to_task_id
          WHERE instr(dep_tree.path, td.depends_on_task_id) = 0
        )
        SELECT from_task_id, to_task_id, depth
        FROM dep_tree
        ORDER BY depth ASC, from_task_id ASC, to_task_id ASC
      `)
        .all(taskId);
    const nodeIds = new Set([taskId]);
    for (const edge of edges) {
        nodeIds.add(edge.from_task_id);
        nodeIds.add(edge.to_task_id);
    }
    const nodes = [];
    for (const nodeId of nodeIds) {
        const task = (0, db_1.getTaskById)(nodeId);
        if (!task) {
            continue;
        }
        nodes.push({
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
        });
    }
    const mappedEdges = edges.map((edge) => ({
        from: edge.from_task_id,
        to: edge.to_task_id,
        depth: edge.depth,
    }));
    const rootTask = (0, db_1.getTaskById)(taskId);
    return {
        task_id: taskId,
        blocked_by: rootTask?.blocked_by ?? [],
        nodes,
        edges: mappedEdges,
    };
}
function resolveProjectId(input, fallback) {
    return typeof input === "string" && input.trim().length > 0 ? input.trim() : fallback;
}
function parseReviews(value) {
    if (!value || typeof value !== "object") {
        throw new Error("reviews must be an object");
    }
    const reviews = value;
    const codex = reviews.codex;
    const gemini = reviews.gemini;
    const claude = reviews.claude;
    if (!isReviewStatus(codex) || !isReviewStatus(gemini) || !isReviewStatus(claude)) {
        throw new Error("reviews entries must be pending/approved/rejected");
    }
    return {
        codex,
        gemini,
        claude,
    };
}
function deriveDurationMinutes(startedAt, completedAt) {
    if (!startedAt || !completedAt) {
        return null;
    }
    const start = Date.parse(startedAt);
    const end = Date.parse(completedAt);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return null;
    }
    return Math.round((end - start) / 60000);
}
function taskEvent(taskId, type, oldValue, newValue) {
    db_1.db.prepare("INSERT INTO task_events (task_id, event_type, old_value, new_value, timestamp) VALUES (?, ?, ?, ?, ?)").run(taskId, type, oldValue, newValue, (0, db_1.nowIso)());
}
function broadcastAgentStatus(agentId) {
    if (!agentId) {
        return;
    }
    const row = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!row) {
        return;
    }
    (0, ws_1.broadcast)("agent:status", { agent: (0, db_1.mapAgentRow)(row) });
}
function updateAgentForTransition(taskId, oldStatus, nextStatus, agentId, actualDurationMin) {
    if (!agentId) {
        return;
    }
    const now = (0, db_1.nowIso)();
    if (nextStatus === "running") {
        db_1.db.prepare("UPDATE agents SET status = 'busy', current_task_id = ?, updated_at = ? WHERE id = ?").run(taskId, now, agentId);
        broadcastAgentStatus(agentId);
        return;
    }
    if ((nextStatus === "completed" || nextStatus === "failed") &&
        oldStatus !== "completed" &&
        oldStatus !== "failed") {
        const successInc = nextStatus === "completed" ? 1 : 0;
        const failInc = nextStatus === "failed" ? 1 : 0;
        db_1.db.prepare(`
        UPDATE agents
        SET
          total_tasks = total_tasks + 1,
          success_count = success_count + ?,
          fail_count = fail_count + ?,
          avg_duration_min = CASE
            WHEN ? IS NULL THEN avg_duration_min
            WHEN total_tasks = 0 THEN ?
            ELSE ROUND(((avg_duration_min * total_tasks) + ?) / (total_tasks + 1), 2)
          END,
          status = 'idle',
          current_task_id = NULL,
          updated_at = ?
        WHERE id = ?
      `).run(successInc, failInc, actualDurationMin, actualDurationMin, actualDurationMin, now, agentId);
        broadcastAgentStatus(agentId);
        return;
    }
    if (oldStatus === "running") {
        db_1.db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, agentId);
        broadcastAgentStatus(agentId);
    }
}
function parseSpawnOutput(stdout) {
    const lines = stdout.split(/\r?\n/);
    const pick = (regex) => {
        for (const line of lines) {
            const match = line.match(regex);
            if (match?.[1]) {
                return match[1].trim();
            }
        }
        return null;
    };
    return {
        tmuxSession: pick(/(?:tmux\s*session|session)\s*[:=]\s*([\w.-]+)/i),
        branch: pick(/branch\s*[:=]\s*([^\s]+)/i),
        worktreePath: pick(/worktree(?:\s*path)?\s*[:=]\s*(.+)$/i),
        logPath: pick(/log(?:\s*path)?\s*[:=]\s*(.+)$/i),
    };
}
function createTaskFromDraft(draft, projectId, options) {
    const id = (0, uuid_1.v4)();
    const now = (0, db_1.nowIso)();
    const status = options?.status ?? "queued";
    const agentId = options?.agentId ?? null;
    const reviews = { codex: "pending", gemini: "pending", claude: "pending" };
    validateTaskDependencies(id, projectId, draft.depends_on);
    const tx = db_1.db.transaction(() => {
        db_1.db.prepare(`
        INSERT INTO tasks (
          id, project_id, title, description, status, priority, agent_type, agent_id,
          review_codex, review_gemini, review_claude,
          retry_count, max_retries, scheduled_at,
          estimated_duration_min,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3, ?, 30, ?, ?)
      `).run(id, projectId, draft.title, draft.description, status, draft.priority, draft.agent_type, agentId, reviews.codex, reviews.gemini, reviews.claude, draft.scheduled_at, now, now);
        if (draft.depends_on.length > 0) {
            const depStmt = db_1.db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
            for (const dependsOnId of draft.depends_on) {
                depStmt.run(id, dependsOnId);
            }
        }
        taskEvent(id, "created", null, status);
    });
    tx();
    return (0, db_1.getTaskById)(id);
}
const router = (0, express_1.Router)();
router.get("/", (req, res) => {
    const { status, date, project_id } = req.query;
    const where = [];
    const params = [];
    let statusFilter;
    const queryProjectId = typeof project_id === "string" ? project_id : undefined;
    const effectiveProjectId = resolveProjectId(queryProjectId, req.apiKey?.project_id ?? db_1.DEFAULT_PROJECT_ID);
    where.push("project_id = ?");
    params.push(effectiveProjectId);
    if (status !== undefined) {
        if (typeof status !== "string" || !isTaskStatus(status)) {
            res.status(400).json({ error: "status must be a valid task status" });
            return;
        }
        statusFilter = status;
        if (statusFilter === "blocked" || statusFilter === "queued") {
            where.push("status = 'queued'");
        }
        else {
            where.push("status = ?");
            params.push(statusFilter);
        }
    }
    if (date !== undefined) {
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            res.status(400).json({ error: "date must be YYYY-MM-DD" });
            return;
        }
        where.push("date(COALESCE(scheduled_at, started_at, created_at)) = date(?)");
        params.push(date);
    }
    const sql = `
    SELECT *
    FROM tasks
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY datetime(COALESCE(scheduled_at, started_at, created_at)) DESC
  `;
    const tasks = (0, db_1.listTasksByQuery)(sql, params);
    if (statusFilter === "blocked") {
        res.json(tasks.filter((task) => task.status === "blocked"));
        return;
    }
    if (statusFilter === "queued") {
        res.json(tasks.filter((task) => task.status === "queued"));
        return;
    }
    res.json(tasks);
});
router.post("/", (req, res) => {
    const body = req.body;
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
        res.status(400).json({ error: "title is required" });
        return;
    }
    if (body.agent_type !== undefined && !isAgentType(body.agent_type)) {
        res.status(400).json({ error: "agent_type must be codex or claude" });
        return;
    }
    if (body.status !== undefined && !isMutableTaskStatus(body.status)) {
        res.status(400).json({ error: "status is invalid" });
        return;
    }
    if (body.priority !== undefined && !isTaskPriority(body.priority)) {
        res.status(400).json({ error: "priority is invalid" });
        return;
    }
    let dependsOn = [];
    if (body.depends_on !== undefined) {
        try {
            dependsOn = parseDependsOn(body.depends_on);
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "invalid depends_on" });
            return;
        }
    }
    let scheduledAt = null;
    if (body.scheduled_at !== undefined) {
        try {
            scheduledAt = parseIsoField(body.scheduled_at);
        }
        catch (error) {
            res.status(400).json({ error: `scheduled_at ${String(error)}` });
            return;
        }
    }
    const estimatedDuration = body.estimated_duration_min === undefined
        ? 30
        : (() => {
            try {
                return parseNonNegativeInt(body.estimated_duration_min, "estimated_duration_min");
            }
            catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "invalid estimate" });
                return null;
            }
        })();
    if (estimatedDuration === null) {
        return;
    }
    const maxRetries = body.max_retries === undefined
        ? 3
        : (() => {
            try {
                return parseNonNegativeInt(body.max_retries, "max_retries");
            }
            catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "invalid max_retries" });
                return null;
            }
        })();
    if (maxRetries === null) {
        return;
    }
    const reviews = body.reviews === undefined
        ? { codex: "pending", gemini: "pending", claude: "pending" }
        : (() => {
            try {
                return parseReviews(body.reviews);
            }
            catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "invalid reviews" });
                return null;
            }
        })();
    if (!reviews) {
        return;
    }
    const id = (0, uuid_1.v4)();
    const now = (0, db_1.nowIso)();
    const description = typeof body.description === "string" ? body.description : "";
    const projectId = resolveProjectId(body.project_id, req.apiKey?.project_id ?? db_1.DEFAULT_PROJECT_ID);
    try {
        validateTaskDependencies(id, projectId, dependsOn);
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "invalid dependencies" });
        return;
    }
    const tx = db_1.db.transaction(() => {
        db_1.db.prepare(`
        INSERT INTO tasks (
          id, project_id, title, description, status, priority, agent_type, agent_id,
          review_codex, review_gemini, review_claude,
          retry_count, max_retries, scheduled_at,
          estimated_duration_min,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(id, projectId, body.title, description, body.status ?? "queued", body.priority ?? "medium", body.agent_type ?? "codex", body.agent_id ?? null, reviews.codex, reviews.gemini, reviews.claude, maxRetries, scheduledAt, estimatedDuration, now, now);
        const depStmt = db_1.db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
        for (const dependsOnId of dependsOn) {
            depStmt.run(id, dependsOnId);
        }
        taskEvent(id, "created", null, String(body.status ?? "queued"));
    });
    tx();
    const task = (0, db_1.getTaskById)(id);
    if (!task) {
        res.status(500).json({ error: "task creation failed" });
        return;
    }
    (0, ws_1.broadcast)("task:created", { task });
    (0, activity_1.recordActivity)({
        projectId,
        agentId: task.agent_id,
        action: "task.created",
        details: {
            task_id: task.id,
            title: task.title,
            status: task.status,
        },
    });
    void (0, task_scheduler_1.triggerTaskScheduler)();
    res.status(201).json(task);
});
router.post("/from-prompt", async (req, res) => {
    const body = req.body;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
        res.status(400).json({ error: "prompt is required" });
        return;
    }
    if (body.project_id !== undefined && (typeof body.project_id !== "string" || !body.project_id.trim())) {
        res.status(400).json({ error: "project_id must be a non-empty string when provided" });
        return;
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== "boolean") {
        res.status(400).json({ error: "dry_run must be a boolean when provided" });
        return;
    }
    const dryRun = body.dry_run === true;
    const projectId = resolveProjectId(body.project_id, req.apiKey?.project_id ?? db_1.DEFAULT_PROJECT_ID);
    let parsedResult;
    try {
        parsedResult = await (0, prompt_parser_1.parsePromptToTaskDraft)(prompt);
    }
    catch (error) {
        res.status(502).json({
            error: error instanceof Error ? error.message : "failed to parse prompt",
        });
        return;
    }
    if (dryRun) {
        res.json({
            parsed: parsedResult.parsed,
            parser: parsedResult.parser,
            dry_run: true,
        });
        return;
    }
    let task;
    try {
        task = createTaskFromDraft(parsedResult.parsed, projectId);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "task creation failed";
        if (typeof message === "string" &&
            (message.includes("depends_on") || message.includes("dependency cycle"))) {
            res.status(400).json({ error: message });
            return;
        }
        res.status(500).json({ error: message });
        return;
    }
    if (!task) {
        res.status(500).json({ error: "task creation failed" });
        return;
    }
    (0, ws_1.broadcast)("task:created", { task });
    (0, activity_1.recordActivity)({
        projectId,
        agentId: task.agent_id,
        action: "task.created",
        details: {
            task_id: task.id,
            title: task.title,
            status: task.status,
            source: "from_prompt",
            parser_provider: parsedResult.parser.provider,
            parser_fallback: parsedResult.parser.fallback,
        },
    });
    void (0, task_scheduler_1.triggerTaskScheduler)();
    res.status(201).json({
        task,
        parsed: parsedResult.parsed,
        parser: parsedResult.parser,
        dry_run: false,
    });
});
router.get("/:id/dependencies", (req, res) => {
    const task = (0, db_1.getTaskById)(req.params.id);
    if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
    }
    res.json(buildTaskDependencyTree(task.id));
});
router.get("/:id", (req, res) => {
    const task = (0, db_1.getTaskById)(req.params.id);
    if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
    }
    res.json(task);
});
router.put("/:id", (req, res) => {
    const id = req.params.id;
    const existing = (0, db_1.getTaskRowById)(id);
    if (!existing) {
        res.status(404).json({ error: "task not found" });
        return;
    }
    const body = req.body;
    const updates = [];
    const params = [];
    const updatedColumns = new Set();
    const setUpdate = (column, value) => {
        if (updatedColumns.has(column)) {
            return;
        }
        updatedColumns.add(column);
        updates.push(`${column} = ?`);
        params.push(value);
    };
    let nextStatus = existing.status;
    let nextAgentId = existing.agent_id;
    let nextProjectId = existing.project_id || db_1.DEFAULT_PROJECT_ID;
    let nextStartedAt = (0, db_1.normalizeIso)(existing.started_at);
    let nextCompletedAt = (0, db_1.normalizeIso)(existing.completed_at);
    let nextActualDuration = existing.actual_duration_min;
    let nextDependsOn = null;
    try {
        if ("title" in body) {
            if (typeof body.title !== "string" || body.title.trim().length === 0) {
                throw new Error("title must be non-empty string");
            }
            setUpdate("title", body.title.trim());
        }
        if ("description" in body) {
            if (typeof body.description !== "string") {
                throw new Error("description must be string");
            }
            setUpdate("description", body.description);
        }
        if ("status" in body) {
            if (!isMutableTaskStatus(body.status)) {
                throw new Error("status is invalid");
            }
            nextStatus = body.status;
            setUpdate("status", nextStatus);
        }
        if ("priority" in body) {
            if (!isTaskPriority(body.priority)) {
                throw new Error("priority is invalid");
            }
            setUpdate("priority", body.priority);
        }
        if ("agent_type" in body) {
            if (!isAgentType(body.agent_type)) {
                throw new Error("agent_type must be codex or claude");
            }
            setUpdate("agent_type", body.agent_type);
        }
        if ("agent_id" in body) {
            if (body.agent_id !== null &&
                (typeof body.agent_id !== "string" || body.agent_id.trim().length === 0)) {
                throw new Error("agent_id must be null or string");
            }
            nextAgentId = body.agent_id ? String(body.agent_id) : null;
            setUpdate("agent_id", nextAgentId);
        }
        if ("project_id" in body) {
            if (typeof body.project_id !== "string" || body.project_id.trim().length === 0) {
                throw new Error("project_id must be non-empty string");
            }
            nextProjectId = body.project_id.trim();
            setUpdate("project_id", nextProjectId);
        }
        if ("branch" in body) {
            if (body.branch !== null && typeof body.branch !== "string") {
                throw new Error("branch must be null or string");
            }
            setUpdate("branch", body.branch ?? null);
        }
        if ("pr_url" in body) {
            if (body.pr_url !== null && typeof body.pr_url !== "string") {
                throw new Error("pr_url must be null or string");
            }
            setUpdate("pr_url", body.pr_url ?? null);
        }
        if ("pr_number" in body) {
            setUpdate("pr_number", parseNullableInt(body.pr_number, "pr_number"));
        }
        if ("ci_status" in body) {
            if (body.ci_status !== null && !isCiStatus(body.ci_status)) {
                throw new Error("ci_status must be pending/passing/failing/null");
            }
            setUpdate("ci_status", body.ci_status ?? null);
        }
        if ("reviews" in body) {
            const reviews = parseReviews(body.reviews);
            setUpdate("review_codex", reviews.codex);
            setUpdate("review_gemini", reviews.gemini);
            setUpdate("review_claude", reviews.claude);
        }
        if ("retry_count" in body) {
            setUpdate("retry_count", parseNonNegativeInt(body.retry_count, "retry_count"));
        }
        if ("max_retries" in body) {
            setUpdate("max_retries", parseNonNegativeInt(body.max_retries, "max_retries"));
        }
        if ("scheduled_at" in body) {
            setUpdate("scheduled_at", parseIsoField(body.scheduled_at));
        }
        if ("started_at" in body) {
            nextStartedAt = parseIsoField(body.started_at);
            setUpdate("started_at", nextStartedAt);
        }
        if ("completed_at" in body) {
            nextCompletedAt = parseIsoField(body.completed_at);
            setUpdate("completed_at", nextCompletedAt);
        }
        if ("estimated_duration_min" in body) {
            setUpdate("estimated_duration_min", parseNonNegativeInt(body.estimated_duration_min, "estimated_duration_min"));
        }
        if ("actual_duration_min" in body) {
            nextActualDuration = parseNullableInt(body.actual_duration_min, "actual_duration_min");
            setUpdate("actual_duration_min", nextActualDuration);
        }
        if ("tmux_session" in body) {
            if (body.tmux_session !== null && typeof body.tmux_session !== "string") {
                throw new Error("tmux_session must be null or string");
            }
            setUpdate("tmux_session", body.tmux_session ?? null);
        }
        if ("worktree_path" in body) {
            if (body.worktree_path !== null && typeof body.worktree_path !== "string") {
                throw new Error("worktree_path must be null or string");
            }
            setUpdate("worktree_path", body.worktree_path ?? null);
        }
        if ("log_path" in body) {
            if (body.log_path !== null && typeof body.log_path !== "string") {
                throw new Error("log_path must be null or string");
            }
            setUpdate("log_path", body.log_path ?? null);
        }
        if ("depends_on" in body) {
            nextDependsOn = parseDependsOn(body.depends_on);
        }
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "invalid payload" });
        return;
    }
    if (nextDependsOn || ("project_id" in body && typeof body.project_id === "string")) {
        const effectiveDependsOn = nextDependsOn ?? (0, db_1.getTaskDependencies)(id);
        try {
            validateTaskDependencies(id, nextProjectId, effectiveDependsOn);
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "invalid dependencies" });
            return;
        }
    }
    const now = (0, db_1.nowIso)();
    if (nextStatus === "running" && !nextStartedAt) {
        nextStartedAt = now;
        setUpdate("started_at", nextStartedAt);
    }
    if ((nextStatus === "completed" || nextStatus === "failed") && !nextCompletedAt) {
        nextCompletedAt = now;
        setUpdate("completed_at", nextCompletedAt);
    }
    if ((nextStatus === "completed" || nextStatus === "failed") && !updatedColumns.has("actual_duration_min")) {
        nextActualDuration = deriveDurationMinutes(nextStartedAt, nextCompletedAt);
        if (nextActualDuration !== null) {
            setUpdate("actual_duration_min", nextActualDuration);
        }
    }
    const tx = db_1.db.transaction(() => {
        if (updates.length > 0) {
            setUpdate("updated_at", now);
            db_1.db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...params, id);
        }
        if (nextDependsOn) {
            db_1.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(id);
            const depStmt = db_1.db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
            for (const dep of nextDependsOn) {
                depStmt.run(id, dep);
            }
        }
        if (existing.status !== nextStatus) {
            taskEvent(id, "status_changed", existing.status, nextStatus);
        }
        updateAgentForTransition(id, existing.status, nextStatus, nextAgentId, nextActualDuration);
    });
    tx();
    const updatedTask = (0, db_1.getTaskById)(id);
    if (!updatedTask) {
        res.status(500).json({ error: "task update failed" });
        return;
    }
    if (updatedTask.status === "completed") {
        (0, ws_1.broadcast)("task:completed", { task: updatedTask });
        (0, activity_1.recordActivity)({
            projectId: updatedTask.project_id,
            agentId: updatedTask.agent_id,
            action: "task.completed",
            details: { task_id: updatedTask.id, title: updatedTask.title },
        });
    }
    else if (updatedTask.status === "failed") {
        (0, ws_1.broadcast)("task:failed", { task: updatedTask });
        (0, activity_1.recordActivity)({
            projectId: updatedTask.project_id,
            agentId: updatedTask.agent_id,
            action: "task.failed",
            details: { task_id: updatedTask.id, title: updatedTask.title },
        });
    }
    else {
        (0, ws_1.broadcast)("task:updated", { task: updatedTask });
        (0, activity_1.recordActivity)({
            projectId: nextProjectId,
            agentId: nextAgentId,
            action: "task.updated",
            details: { task_id: updatedTask.id, status: updatedTask.status },
        });
    }
    if (existing.status !== nextStatus || nextDependsOn !== null) {
        void (0, task_scheduler_1.triggerTaskScheduler)();
    }
    res.json(updatedTask);
});
router.delete("/:id", (req, res) => {
    const id = req.params.id;
    const existing = (0, db_1.getTaskRowById)(id);
    if (!existing) {
        res.status(404).json({ error: "task not found" });
        return;
    }
    const tx = db_1.db.transaction(() => {
        db_1.db.prepare("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?").run(id, id);
        db_1.db.prepare("DELETE FROM task_logs WHERE task_id = ?").run(id);
        db_1.db.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
        db_1.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
        updateAgentForTransition(id, existing.status, "archived", existing.agent_id, existing.actual_duration_min);
    });
    tx();
    (0, activity_1.recordActivity)({
        projectId: existing.project_id || db_1.DEFAULT_PROJECT_ID,
        agentId: existing.agent_id,
        action: "task.deleted",
        details: { task_id: id, title: existing.title },
    });
    void (0, task_scheduler_1.triggerTaskScheduler)();
    res.status(204).send();
});
router.post("/:id/spawn", async (req, res, next) => {
    try {
        const id = req.params.id;
        const existing = (0, db_1.getTaskRowById)(id);
        if (!existing) {
            res.status(404).json({ error: "task not found" });
            return;
        }
        const body = req.body;
        let agentId = existing.agent_id;
        if ("agent_id" in body) {
            if (body.agent_id !== null && typeof body.agent_id !== "string") {
                res.status(400).json({ error: "agent_id must be null or string" });
                return;
            }
            agentId = body.agent_id ? String(body.agent_id) : null;
        }
        const gate = (0, task_scheduler_1.canTaskStart)(id);
        if (!gate.ok) {
            res.status(409).json({
                error: gate.reason ?? "task cannot be started",
                blocked_by: gate.blocked_by,
                queue: (0, task_scheduler_1.getQueueStatus)(),
            });
            return;
        }
        const description = existing.description || existing.title;
        const execution = await (0, agent_swarm_1.spawnAgent)(description, existing.agent_type);
        const parsed = parseSpawnOutput(execution.stdout);
        const now = (0, db_1.nowIso)();
        db_1.db.prepare(`
        UPDATE tasks
        SET
          status = 'running',
          agent_id = ?,
          tmux_session = COALESCE(?, tmux_session),
          branch = COALESCE(?, branch),
          worktree_path = COALESCE(?, worktree_path),
          log_path = COALESCE(?, log_path),
          started_at = COALESCE(started_at, ?),
          updated_at = ?
        WHERE id = ?
      `).run(agentId, parsed.tmuxSession, parsed.branch, parsed.worktreePath, parsed.logPath, now, now, id);
        taskEvent(id, "spawned", existing.status, "running");
        updateAgentForTransition(id, existing.status, "running", agentId, existing.actual_duration_min);
        const updatedTask = (0, db_1.getTaskById)(id);
        if (!updatedTask) {
            res.status(500).json({ error: "failed to reload task" });
            return;
        }
        (0, ws_1.broadcast)("task:updated", { task: updatedTask });
        (0, activity_1.recordActivity)({
            projectId: updatedTask.project_id,
            agentId: updatedTask.agent_id,
            action: "task.started",
            details: {
                task_id: updatedTask.id,
                tmux_session: updatedTask.tmux_session,
            },
        });
        res.json({ task: updatedTask, execution });
    }
    catch (error) {
        next(error);
    }
});
router.post("/:id/redirect", async (req, res, next) => {
    try {
        const id = req.params.id;
        const task = (0, db_1.getTaskById)(id);
        if (!task) {
            res.status(404).json({ error: "task not found" });
            return;
        }
        const body = req.body;
        if (typeof body.message !== "string" || body.message.trim().length === 0) {
            res.status(400).json({ error: "message is required" });
            return;
        }
        const tmuxSession = typeof body.tmux_session === "string" && body.tmux_session.trim().length > 0
            ? body.tmux_session.trim()
            : task.tmux_session;
        if (!tmuxSession) {
            res.status(400).json({ error: "tmux_session is required for redirect" });
            return;
        }
        const execution = await (0, agent_swarm_1.redirectAgent)(tmuxSession, body.message.trim());
        const now = (0, db_1.nowIso)();
        db_1.db.prepare("INSERT INTO task_logs (task_id, timestamp, level, message) VALUES (?, ?, ?, ?)").run(id, now, "info", `redirect: ${body.message.trim()}`);
        taskEvent(id, "redirected", null, body.message.trim());
        (0, ws_1.broadcast)("log:append", { task_id: id, line: body.message.trim() });
        (0, activity_1.recordActivity)({
            projectId: task.project_id,
            agentId: task.agent_id,
            action: "task.redirected",
            details: { task_id: id, message: body.message.trim() },
        });
        res.json({ ok: true, execution });
    }
    catch (error) {
        next(error);
    }
});
router.post("/:id/kill", async (req, res, next) => {
    try {
        const id = req.params.id;
        const existing = (0, db_1.getTaskRowById)(id);
        if (!existing) {
            res.status(404).json({ error: "task not found" });
            return;
        }
        const tmuxSession = existing.tmux_session;
        if (!tmuxSession) {
            res.status(400).json({ error: "tmux_session is missing for this task" });
            return;
        }
        const execution = await (0, agent_swarm_1.killAgent)(tmuxSession);
        const now = (0, db_1.nowIso)();
        const startedAt = (0, db_1.normalizeIso)(existing.started_at);
        const completedAt = now;
        const duration = deriveDurationMinutes(startedAt, completedAt);
        db_1.db.prepare(`
        UPDATE tasks
        SET
          status = 'failed',
          completed_at = ?,
          actual_duration_min = COALESCE(actual_duration_min, ?),
          updated_at = ?
        WHERE id = ?
      `).run(completedAt, duration, now, id);
        taskEvent(id, "killed", existing.status, "failed");
        updateAgentForTransition(id, existing.status, "failed", existing.agent_id, duration);
        const task = (0, db_1.getTaskById)(id);
        if (!task) {
            res.status(500).json({ error: "failed to reload task" });
            return;
        }
        (0, ws_1.broadcast)("task:failed", { task, error: "Task killed manually" });
        (0, activity_1.recordActivity)({
            projectId: task.project_id,
            agentId: task.agent_id,
            action: "task.failed",
            details: { task_id: task.id, reason: "killed" },
        });
        void (0, task_scheduler_1.triggerTaskScheduler)();
        res.json({ task, execution });
    }
    catch (error) {
        next(error);
    }
});
router.post("/:id/retry", (req, res) => {
    const id = req.params.id;
    const existing = (0, db_1.getTaskRowById)(id);
    if (!existing) {
        res.status(404).json({ error: "task not found" });
        return;
    }
    if (existing.retry_count >= existing.max_retries) {
        res.status(400).json({
            error: `max retries reached (${existing.retry_count}/${existing.max_retries})`,
        });
        return;
    }
    const now = (0, db_1.nowIso)();
    db_1.db.prepare(`
      UPDATE tasks
      SET
        status = 'queued',
        retry_count = retry_count + 1,
        started_at = NULL,
        completed_at = NULL,
        actual_duration_min = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(now, id);
    taskEvent(id, "retried", existing.status, "queued");
    updateAgentForTransition(id, existing.status, "queued", existing.agent_id, existing.actual_duration_min);
    const task = (0, db_1.getTaskById)(id);
    if (!task) {
        res.status(500).json({ error: "failed to reload task" });
        return;
    }
    (0, ws_1.broadcast)("task:updated", { task });
    (0, activity_1.recordActivity)({
        projectId: task.project_id,
        agentId: task.agent_id,
        action: "task.retried",
        details: { task_id: task.id, retry_count: task.retry_count },
    });
    void (0, task_scheduler_1.triggerTaskScheduler)();
    res.json(task);
});
exports.default = router;
//# sourceMappingURL=tasks.js.map