"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncFromActiveTasksFile = syncFromActiveTasksFile;
exports.startSyncScheduler = startSyncScheduler;
exports.stopSyncScheduler = stopSyncScheduler;
exports.triggerManualSync = triggerManualSync;
/**
 * [INPUT]: Depends on active-tasks JSON projection, DB persistence helpers, and WS broadcast service.
 * [OUTPUT]: Provides periodic/manual sync from external task projection into local SQLite tables.
 * [POS]: Compatibility ingest bridge between external orchestrators and AgentCal task records.
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const db_1 = require("../db");
const ws_1 = require("../ws");
let syncTimer = null;
let syncInFlight = false;
function fileCandidates() {
    const cwd = process.cwd();
    const home = node_os_1.default.homedir();
    return [
        process.env.ACTIVE_TASKS_PATH,
        node_path_1.default.resolve(cwd, "active-tasks.json"),
        node_path_1.default.resolve(cwd, ".openclaw", "active-tasks.json"),
        node_path_1.default.resolve(cwd, "..", "active-tasks.json"),
        node_path_1.default.resolve(cwd, "..", ".openclaw", "active-tasks.json"),
        node_path_1.default.resolve(cwd, "..", "..", "active-tasks.json"),
        node_path_1.default.resolve(cwd, "..", "..", ".openclaw", "active-tasks.json"),
        node_path_1.default.join(home, ".openclaw", "active-tasks.json"),
    ].filter((candidate) => Boolean(candidate));
}
function resolveActiveTasksPath() {
    for (const candidate of fileCandidates()) {
        if (node_fs_1.default.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
function asString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function asInteger(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        return Number.parseInt(value.trim(), 10);
    }
    return null;
}
function asIso(value) {
    if (value === null || value === undefined) {
        return null;
    }
    return (0, db_1.normalizeIso)(String(value));
}
function asStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(asString).filter((item) => Boolean(item));
}
function mapTaskStatus(value) {
    const raw = String(value ?? "").toLowerCase();
    if (["blocked", "blocked_by_dependency"].includes(raw)) {
        return "queued";
    }
    if (["queued", "queue", "pending"].includes(raw)) {
        return "queued";
    }
    if (["running", "active", "in_progress", "busy"].includes(raw)) {
        return "running";
    }
    if (["pr_open", "pr-open", "pr", "review"].includes(raw)) {
        return "pr_open";
    }
    if (["completed", "done", "success", "finished"].includes(raw)) {
        return "completed";
    }
    if (["failed", "error", "killed", "cancelled", "canceled"].includes(raw)) {
        return "failed";
    }
    if (["archived"].includes(raw)) {
        return "archived";
    }
    return "queued";
}
function mapTaskPriority(value) {
    const raw = String(value ?? "").toLowerCase();
    if (["low", "medium", "high", "urgent"].includes(raw)) {
        return raw;
    }
    return "medium";
}
function mapAgentType(value) {
    const raw = String(value ?? "").toLowerCase();
    if (raw.includes("claude")) {
        return "claude";
    }
    return "codex";
}
function mapCiStatus(value) {
    const raw = String(value ?? "").toLowerCase();
    if (["pending", "waiting"].includes(raw)) {
        return "pending";
    }
    if (["pass", "passing", "passed", "success"].includes(raw)) {
        return "passing";
    }
    if (["fail", "failed", "failing", "error"].includes(raw)) {
        return "failing";
    }
    return null;
}
function readRecordValue(record, keys) {
    for (const key of keys) {
        if (key in record) {
            return record[key];
        }
    }
    return undefined;
}
function normalizeTask(record) {
    const idFromRecord = asString(readRecordValue(record, ["id", "task_id", "taskId"]));
    const tmuxSession = asString(readRecordValue(record, ["tmux_session", "tmuxSession", "session"]));
    const fallbackId = tmuxSession ? `tmux:${tmuxSession}` : null;
    const id = idFromRecord ?? fallbackId ?? null;
    if (!id) {
        return null;
    }
    const description = asString(readRecordValue(record, ["description", "task", "prompt", "message"])) ?? "";
    const title = asString(readRecordValue(record, ["title", "name"])) ??
        (description ? description.slice(0, 96) : `Task ${id.slice(0, 8)}`);
    const status = mapTaskStatus(readRecordValue(record, ["status", "state"]));
    const priority = mapTaskPriority(readRecordValue(record, ["priority"]));
    const agentType = mapAgentType(readRecordValue(record, ["agent_type", "agentType", "agent"]));
    return {
        id,
        projectId: asString(readRecordValue(record, ["project_id", "projectId", "workspace_id", "workspaceId"])) ??
            db_1.DEFAULT_PROJECT_ID,
        title,
        description,
        status,
        priority,
        agentType,
        agentId: asString(readRecordValue(record, ["agent_id", "agentId"])),
        agentName: asString(readRecordValue(record, ["agent_name", "agentName"])),
        branch: asString(readRecordValue(record, ["branch"])),
        prUrl: asString(readRecordValue(record, ["pr_url", "prUrl"])),
        prNumber: asInteger(readRecordValue(record, ["pr_number", "prNumber"])),
        ciStatus: mapCiStatus(readRecordValue(record, ["ci_status", "ciStatus"])),
        retryCount: asInteger(readRecordValue(record, ["retry_count", "retryCount"])) ?? 0,
        maxRetries: asInteger(readRecordValue(record, ["max_retries", "maxRetries"])) ?? 3,
        scheduledAt: asIso(readRecordValue(record, ["scheduled_at", "scheduledAt"])),
        startedAt: asIso(readRecordValue(record, ["started_at", "startedAt"])),
        completedAt: asIso(readRecordValue(record, ["completed_at", "completedAt"])),
        estimatedDurationMin: asInteger(readRecordValue(record, ["estimated_duration_min", "estimatedDurationMin"])) ?? 30,
        actualDurationMin: asInteger(readRecordValue(record, ["actual_duration_min", "actualDurationMin"])) ?? null,
        tmuxSession,
        worktreePath: asString(readRecordValue(record, ["worktree_path", "worktreePath"])),
        logPath: asString(readRecordValue(record, ["log_path", "logPath"])),
        dependsOn: asStringArray(readRecordValue(record, ["depends_on", "dependsOn", "dependencies"])),
    };
}
function extractTaskRecords(payload) {
    if (Array.isArray(payload)) {
        return payload.filter((item) => Boolean(item) && typeof item === "object");
    }
    if (payload && typeof payload === "object") {
        const data = payload;
        for (const key of ["tasks", "active_tasks", "items", "data"]) {
            if (Array.isArray(data[key])) {
                return data[key].filter((item) => Boolean(item) && typeof item === "object");
            }
        }
    }
    return [];
}
function taskChanged(existing, nextTask) {
    const comparablePairs = [
        [existing.title, nextTask.title],
        [existing.description, nextTask.description],
        [existing.status, nextTask.status],
        [existing.priority, nextTask.priority],
        [existing.agent_type, nextTask.agentType],
        [existing.agent_id, nextTask.agentId],
        [existing.branch, nextTask.branch],
        [existing.pr_url, nextTask.prUrl],
        [existing.pr_number, nextTask.prNumber],
        [existing.ci_status, nextTask.ciStatus],
        [existing.retry_count, nextTask.retryCount],
        [existing.max_retries, nextTask.maxRetries],
        [(0, db_1.normalizeIso)(existing.scheduled_at), nextTask.scheduledAt],
        [(0, db_1.normalizeIso)(existing.started_at), nextTask.startedAt],
        [(0, db_1.normalizeIso)(existing.completed_at), nextTask.completedAt],
        [existing.estimated_duration_min, nextTask.estimatedDurationMin],
        [existing.actual_duration_min, nextTask.actualDurationMin],
        [existing.tmux_session, nextTask.tmuxSession],
        [existing.worktree_path, nextTask.worktreePath],
        [existing.log_path, nextTask.logPath],
    ];
    return comparablePairs.some(([a, b]) => a !== b);
}
function ensureAgent(nextTask, now) {
    if (!nextTask.agentId) {
        return;
    }
    const status = nextTask.status === "running" ? "busy" : "idle";
    const currentTaskId = nextTask.status === "running" ? nextTask.id : null;
    const before = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(nextTask.agentId);
    db_1.db.prepare(`
      INSERT INTO agents (
        id, project_id, name, type, status, current_task_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        name = COALESCE(excluded.name, agents.name),
        type = excluded.type,
        status = excluded.status,
        current_task_id = excluded.current_task_id,
        updated_at = excluded.updated_at
    `).run(nextTask.agentId, nextTask.projectId, nextTask.agentName ?? `Agent ${nextTask.agentId.slice(0, 8)}`, nextTask.agentType, status, currentTaskId, now, now);
    const after = db_1.db.prepare("SELECT * FROM agents WHERE id = ?").get(nextTask.agentId);
    if (!after) {
        return;
    }
    if (!before ||
        before.status !== after.status ||
        before.current_task_id !== after.current_task_id ||
        before.type !== after.type) {
        (0, ws_1.broadcast)("agent:status", { agent: (0, db_1.mapAgentRow)(after), source: "sync" });
    }
}
async function syncFromActiveTasksFile() {
    const now = (0, db_1.nowIso)();
    const source = resolveActiveTasksPath();
    if (!source) {
        return {
            source: null,
            scanned: 0,
            upserted: 0,
            created: 0,
            updated: 0,
            skipped: 0,
            errors: ["active-tasks.json not found"],
            synced_at: now,
        };
    }
    const result = {
        source,
        scanned: 0,
        upserted: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        synced_at: now,
    };
    let parsedPayload;
    try {
        const raw = node_fs_1.default.readFileSync(source, "utf8");
        parsedPayload = JSON.parse(raw);
    }
    catch (error) {
        result.errors.push(error instanceof Error ? error.message : "Unable to parse active-tasks.json");
        return result;
    }
    const records = extractTaskRecords(parsedPayload);
    result.scanned = records.length;
    const upsertTaskStmt = db_1.db.prepare(`
      INSERT INTO tasks (
        id, project_id, title, description, status, priority, agent_type, agent_id,
        branch, pr_url, pr_number, ci_status,
        review_codex, review_gemini, review_claude,
        retry_count, max_retries,
        scheduled_at, started_at, completed_at,
        estimated_duration_min, actual_duration_min,
        tmux_session, worktree_path, log_path,
        created_at, updated_at
      )
      VALUES (
        @id, @project_id, @title, @description, @status, @priority, @agent_type, @agent_id,
        @branch, @pr_url, @pr_number, @ci_status,
        'pending', 'pending', 'pending',
        @retry_count, @max_retries,
        @scheduled_at, @started_at, @completed_at,
        @estimated_duration_min, @actual_duration_min,
        @tmux_session, @worktree_path, @log_path,
        @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        agent_type = excluded.agent_type,
        agent_id = excluded.agent_id,
        branch = excluded.branch,
        pr_url = excluded.pr_url,
        pr_number = excluded.pr_number,
        ci_status = excluded.ci_status,
        retry_count = excluded.retry_count,
        max_retries = excluded.max_retries,
        scheduled_at = excluded.scheduled_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        estimated_duration_min = excluded.estimated_duration_min,
        actual_duration_min = excluded.actual_duration_min,
        tmux_session = excluded.tmux_session,
        worktree_path = excluded.worktree_path,
        log_path = excluded.log_path,
        updated_at = excluded.updated_at
    `);
    const deleteDepsStmt = db_1.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?");
    const insertDepStmt = db_1.db.prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)");
    const insertEventStmt = db_1.db.prepare("INSERT INTO task_events (task_id, event_type, old_value, new_value, timestamp) VALUES (?, ?, ?, ?, ?)");
    const tx = db_1.db.transaction((tasks) => {
        for (const record of tasks) {
            const normalized = normalizeTask(record);
            if (!normalized) {
                result.skipped += 1;
                continue;
            }
            const existing = (0, db_1.getTaskRowById)(normalized.id);
            const changed = existing ? taskChanged(existing, normalized) : true;
            const previousDependsOn = existing ? (0, db_1.getTaskDependencies)(normalized.id) : [];
            ensureAgent(normalized, now);
            upsertTaskStmt.run({
                id: normalized.id,
                project_id: normalized.projectId,
                title: normalized.title,
                description: normalized.description,
                status: normalized.status,
                priority: normalized.priority,
                agent_type: normalized.agentType,
                agent_id: normalized.agentId,
                branch: normalized.branch,
                pr_url: normalized.prUrl,
                pr_number: normalized.prNumber,
                ci_status: normalized.ciStatus,
                retry_count: normalized.retryCount,
                max_retries: normalized.maxRetries,
                scheduled_at: normalized.scheduledAt,
                started_at: normalized.startedAt,
                completed_at: normalized.completedAt,
                estimated_duration_min: normalized.estimatedDurationMin,
                actual_duration_min: normalized.actualDurationMin,
                tmux_session: normalized.tmuxSession,
                worktree_path: normalized.worktreePath,
                log_path: normalized.logPath,
                created_at: existing ? existing.created_at : now,
                updated_at: now,
            });
            deleteDepsStmt.run(normalized.id);
            for (const dependsOnId of normalized.dependsOn) {
                insertDepStmt.run(normalized.id, dependsOnId);
            }
            const dependenciesChanged = previousDependsOn.join(",") !== normalized.dependsOn.join(",");
            if (!existing) {
                result.created += 1;
                result.upserted += 1;
                insertEventStmt.run(normalized.id, "synced_created", null, normalized.status, now);
                const createdTask = (0, db_1.getTaskById)(normalized.id);
                if (createdTask) {
                    (0, ws_1.broadcast)("task:created", { task: createdTask, source: "sync" });
                }
                continue;
            }
            if (changed || dependenciesChanged) {
                result.updated += 1;
                result.upserted += 1;
                if (existing.status !== normalized.status) {
                    insertEventStmt.run(normalized.id, "status_changed", existing.status, normalized.status, now);
                }
                const updatedTask = (0, db_1.getTaskById)(normalized.id);
                if (updatedTask) {
                    if (updatedTask.status === "completed") {
                        (0, ws_1.broadcast)("task:completed", { task: updatedTask, source: "sync" });
                    }
                    else if (updatedTask.status === "failed") {
                        (0, ws_1.broadcast)("task:failed", { task: updatedTask, source: "sync" });
                    }
                    else {
                        (0, ws_1.broadcast)("task:updated", { task: updatedTask, source: "sync" });
                    }
                }
            }
        }
    });
    try {
        tx(records);
    }
    catch (error) {
        result.errors.push(error instanceof Error ? error.message : "Sync transaction failed");
    }
    return result;
}
function runScheduledSync() {
    if (syncInFlight) {
        return;
    }
    syncInFlight = true;
    void syncFromActiveTasksFile()
        .catch((error) => {
        const reason = error instanceof Error ? error.message : "unknown sync error";
        console.error(`[agentcal] sync failed: ${reason}`);
    })
        .finally(() => {
        syncInFlight = false;
    });
}
function startSyncScheduler(intervalMs = 10_000) {
    if (syncTimer) {
        return;
    }
    runScheduledSync();
    syncTimer = setInterval(runScheduledSync, intervalMs);
}
function stopSyncScheduler() {
    if (!syncTimer) {
        return;
    }
    clearInterval(syncTimer);
    syncTimer = null;
}
async function triggerManualSync() {
    return syncFromActiveTasksFile();
}
//# sourceMappingURL=sync.js.map