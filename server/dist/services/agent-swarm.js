"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnAgent = spawnAgent;
exports.redirectAgent = redirectAgent;
exports.killAgent = killAgent;
exports.getAgentSwarmStatus = getAgentSwarmStatus;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
const SCRIPT_NAMES = {
    spawn: "spawn-agent.sh",
    redirect: "redirect-agent.sh",
    kill: "kill-agent.sh",
    status: "status.sh",
};
function shellEscape(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function scriptCandidates(scriptName) {
    const cwd = process.cwd();
    const home = node_os_1.default.homedir();
    const envRoot = process.env.AGENT_SWARM_SCRIPTS_DIR;
    const roots = [
        envRoot,
        node_path_1.default.resolve(cwd, ".openclaw"),
        node_path_1.default.resolve(cwd, "..", ".openclaw"),
        node_path_1.default.resolve(cwd, "..", "..", ".openclaw"),
        node_path_1.default.join(home, ".openclaw"),
    ].filter((item) => Boolean(item));
    const candidates = [];
    for (const root of roots) {
        candidates.push(node_path_1.default.resolve(root, scriptName), node_path_1.default.resolve(root, "scripts", scriptName), node_path_1.default.resolve(root, "bin", scriptName));
    }
    return candidates;
}
function resolveScript(scriptName) {
    for (const candidate of scriptCandidates(scriptName)) {
        if (node_fs_1.default.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`Could not locate ${scriptName}. Set AGENT_SWARM_SCRIPTS_DIR or place scripts under .openclaw/.`);
}
async function runScript(scriptName, args = []) {
    const scriptPath = resolveScript(scriptName);
    const command = `${shellEscape(scriptPath)} ${args.map(shellEscape).join(" ")}`.trim();
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
    return { command, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function spawnAgent(description, agentType) {
    return runScript(SCRIPT_NAMES.spawn, [description, agentType]);
}
async function redirectAgent(tmuxSession, message) {
    return runScript(SCRIPT_NAMES.redirect, [tmuxSession, message]);
}
async function killAgent(tmuxSession) {
    return runScript(SCRIPT_NAMES.kill, [tmuxSession]);
}
async function getAgentSwarmStatus() {
    return runScript(SCRIPT_NAMES.status);
}
//# sourceMappingURL=agent-swarm.js.map