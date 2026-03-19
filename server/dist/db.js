"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB_PATH = exports.db = exports.DEFAULT_PROJECT_NAME = exports.DEFAULT_PROJECT_ID = void 0;
exports.nowIso = nowIso;
exports.normalizeIso = normalizeIso;
exports.mapAgentRow = mapAgentRow;
exports.mapTaskRow = mapTaskRow;
exports.getTaskDependencies = getTaskDependencies;
exports.getUnmetTaskDependencies = getUnmetTaskDependencies;
exports.getTaskRowById = getTaskRowById;
exports.getTaskById = getTaskById;
exports.listTasksByQuery = listTasksByQuery;
exports.closeDb = closeDb;
/**
 * [INPUT]: 依赖 better-sqlite3 提供 SQLite 访问，依赖 ./types 提供行模型类型。
 * [OUTPUT]: 对外提供 db 连接、schema/migration 初始化、行映射与通用查询辅助函数。
 * [POS]: server 数据访问层核心入口，被 routes 与 services 共享。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const DATA_DIR = node_path_1.default.resolve(__dirname, "..", "data");
const DB_PATH = process.env.AGENTCAL_DB_PATH
    ? node_path_1.default.resolve(process.env.AGENTCAL_DB_PATH)
    : node_path_1.default.join(DATA_DIR, "agentcal.db");
exports.DB_PATH = DB_PATH;
exports.DEFAULT_PROJECT_ID = process.env.AGENTCAL_DEFAULT_PROJECT_ID ?? "project_default";
exports.DEFAULT_PROJECT_NAME = process.env.AGENTCAL_DEFAULT_PROJECT_NAME ?? "Default Workspace";
node_fs_1.default.mkdirSync(node_path_1.default.dirname(DB_PATH), { recursive: true });
exports.db = new better_sqlite3_1.default(DB_PATH);
exports.db.pragma("journal_mode = WAL");
exports.db.pragma("foreign_keys = ON");
exports.db.pragma("busy_timeout = 5000");
function hasColumn(table, column) {
    const rows = exports.db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((row) => row.name === column);
}
function ensureColumn(table, column, sqlType) {
    if (!hasColumn(table, column)) {
        exports.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
    }
}
function initSchema() {
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('codex', 'claude')),
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'offline')),
      current_task_id TEXT,
      total_tasks INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      avg_duration_min REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (current_task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued', 'running', 'pr_open', 'completed', 'failed', 'archived')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      agent_type TEXT NOT NULL DEFAULT 'codex'
        CHECK(agent_type IN ('codex', 'claude')),
      agent_id TEXT,
      branch TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      ci_status TEXT CHECK(ci_status IN ('pending', 'passing', 'failing')),
      review_codex TEXT DEFAULT 'pending' CHECK(review_codex IN ('pending', 'approved', 'rejected')),
      review_gemini TEXT DEFAULT 'pending' CHECK(review_gemini IN ('pending', 'approved', 'rejected')),
      review_claude TEXT DEFAULT 'pending' CHECK(review_claude IN ('pending', 'approved', 'rejected')),
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      scheduled_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      estimated_duration_min INTEGER DEFAULT 30,
      actual_duration_min INTEGER,
      tmux_session TEXT,
      worktree_path TEXT,
      log_path TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      level TEXT DEFAULT 'info' CHECK(level IN ('info', 'warn', 'error', 'debug')),
      message TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'member')),
      joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      UNIQUE(project_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      emoji TEXT DEFAULT '🤖',
      avatar_url TEXT DEFAULT '',
      color TEXT DEFAULT '#3b82f6',
      settings TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      label TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_at ON tasks(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent_id ON tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agents_project_id ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_activities_project_id ON activities(project_id);
    CREATE INDEX IF NOT EXISTS idx_activities_agent_id ON activities(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activities_created_at ON activities(created_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);
    CREATE INDEX IF NOT EXISTS idx_webhooks_project_id ON webhooks(project_id);
  `);
    ensureColumn("agents", "project_id", "TEXT REFERENCES projects(id) ON DELETE SET NULL");
    ensureColumn("tasks", "project_id", "TEXT REFERENCES projects(id) ON DELETE CASCADE");
    ensureColumn("webhooks", "updated_at", "TEXT");
}
function seedDefaults() {
    const now = nowIso();
    exports.db.prepare(`
      INSERT INTO projects (id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(projects.name, excluded.name),
        updated_at = excluded.updated_at
    `).run(exports.DEFAULT_PROJECT_ID, exports.DEFAULT_PROJECT_NAME, "Default multi-agent workspace", now, now);
    exports.db.prepare("UPDATE agents SET project_id = ? WHERE project_id IS NULL OR project_id = ''").run(exports.DEFAULT_PROJECT_ID);
    exports.db.prepare("UPDATE tasks SET project_id = ? WHERE project_id IS NULL OR project_id = ''").run(exports.DEFAULT_PROJECT_ID);
    exports.db.prepare("UPDATE webhooks SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL").run(now);
}
initSchema();
seedDefaults();
const dependencyByTaskStmt = exports.db.prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY rowid ASC");
const unmetDependencyByTaskStmt = exports.db.prepare(`
    SELECT td.depends_on_task_id
    FROM task_dependencies td
    JOIN tasks t ON t.id = td.depends_on_task_id
    WHERE td.task_id = ? AND t.status != 'completed'
    ORDER BY td.rowid ASC
  `);
const taskByIdStmt = exports.db.prepare("SELECT * FROM tasks WHERE id = ?");
function nowIso() {
    return new Date().toISOString();
}
function normalizeIso(value) {
    if (!value) {
        return null;
    }
    const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return date.toISOString();
}
function mapAgentRow(row) {
    return {
        id: row.id,
        project_id: row.project_id,
        name: row.name,
        type: row.type,
        status: row.status,
        current_task_id: row.current_task_id,
        stats: {
            total_tasks: Number(row.total_tasks) || 0,
            success_count: Number(row.success_count) || 0,
            fail_count: Number(row.fail_count) || 0,
            avg_duration_min: Number(row.avg_duration_min) || 0,
        },
        created_at: normalizeIso(row.created_at) ?? nowIso(),
        updated_at: normalizeIso(row.updated_at) ?? nowIso(),
    };
}
function mapTaskRow(row, dependsOn = [], blockedBy = []) {
    const status = row.status === "queued" && blockedBy.length > 0 ? "blocked" : row.status;
    return {
        id: row.id,
        project_id: row.project_id || exports.DEFAULT_PROJECT_ID,
        title: row.title,
        description: row.description,
        status,
        priority: row.priority,
        agent_type: row.agent_type,
        agent_id: row.agent_id,
        branch: row.branch,
        pr_url: row.pr_url,
        pr_number: row.pr_number,
        ci_status: row.ci_status,
        reviews: {
            codex: row.review_codex,
            gemini: row.review_gemini,
            claude: row.review_claude,
        },
        retry_count: Number(row.retry_count) || 0,
        max_retries: Number(row.max_retries) || 3,
        depends_on: dependsOn,
        blocked_by: blockedBy,
        scheduled_at: normalizeIso(row.scheduled_at),
        started_at: normalizeIso(row.started_at),
        completed_at: normalizeIso(row.completed_at),
        estimated_duration_min: Number(row.estimated_duration_min) || 30,
        actual_duration_min: row.actual_duration_min === null || row.actual_duration_min === undefined
            ? null
            : Number(row.actual_duration_min),
        tmux_session: row.tmux_session,
        worktree_path: row.worktree_path,
        log_path: row.log_path,
        created_at: normalizeIso(row.created_at) ?? nowIso(),
        updated_at: normalizeIso(row.updated_at) ?? nowIso(),
    };
}
function getTaskDependencies(taskId) {
    const rows = dependencyByTaskStmt.all(taskId);
    return rows.map((row) => row.depends_on_task_id);
}
function getUnmetTaskDependencies(taskId) {
    const rows = unmetDependencyByTaskStmt.all(taskId);
    return rows.map((row) => row.depends_on_task_id);
}
function getTaskRowById(taskId) {
    const row = taskByIdStmt.get(taskId);
    return row ?? null;
}
function getTaskById(taskId) {
    const row = getTaskRowById(taskId);
    if (!row) {
        return null;
    }
    const dependsOn = getTaskDependencies(taskId);
    const blockedBy = getUnmetTaskDependencies(taskId);
    return mapTaskRow(row, dependsOn, blockedBy);
}
function listTasksByQuery(sql, params = []) {
    const rows = exports.db.prepare(sql).all(...params);
    return rows.map((row) => {
        const dependsOn = getTaskDependencies(row.id);
        const blockedBy = getUnmetTaskDependencies(row.id);
        return mapTaskRow(row, dependsOn, blockedBy);
    });
}
function closeDb() {
    exports.db.close();
}
//# sourceMappingURL=db.js.map