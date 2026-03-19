"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePromptToTaskDraft = parsePromptToTaskDraft;
/**
 * [INPUT]: 依赖全局环境变量中的 LLM key/model 配置，依赖 ../db 的 ISO 归一化能力。
 * [OUTPUT]: 对外提供 parsePromptToTaskDraft，将自然语言 prompt 解析为结构化任务草案。
 * [POS]: server Prompt-to-Task 核心语义层，被 tasks 路由复用并对接 LLM/fallback 双路径。
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
const db_1 = require("../db");
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";
function isTaskPriority(value) {
    return value === "low" || value === "medium" || value === "high" || value === "urgent";
}
function isAgentType(value) {
    return value === "codex" || value === "claude";
}
function safeJsonParse(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            return JSON.parse(fenced[1]);
        }
        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        }
        throw new Error("unable to parse LLM JSON response");
    }
}
function parseDependsOnFromPrompt(prompt) {
    const ids = new Set();
    for (const match of prompt.matchAll(/\btask-[a-z0-9_-]+\b/gi)) {
        ids.add(match[0].toLowerCase());
    }
    for (const match of prompt.matchAll(/\b(?:depends on|blocked by|after)\s+([a-z0-9_-]{3,})\b/gi)) {
        ids.add(match[1].toLowerCase());
    }
    return [...ids];
}
function parseTimeFromPrompt(prompt) {
    const meridiem = prompt.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (meridiem) {
        const rawHour = Number.parseInt(meridiem[1], 10);
        const minute = Number.parseInt(meridiem[2] ?? "0", 10);
        const isPm = meridiem[3].toLowerCase() === "pm";
        const hour = rawHour % 12 + (isPm ? 12 : 0);
        return { hour, minute };
    }
    const twentyFourHour = prompt.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (twentyFourHour) {
        return {
            hour: Number.parseInt(twentyFourHour[1], 10),
            minute: Number.parseInt(twentyFourHour[2], 10),
        };
    }
    return null;
}
function parseDateFromPrompt(prompt, now) {
    const lowered = prompt.toLowerCase();
    const absolute = prompt.match(/\b(\d{4}-\d{2}-\d{2})(?:[\sT](\d{1,2})(?::(\d{2}))?)?\b/);
    if (absolute) {
        const year = Number.parseInt(absolute[1].slice(0, 4), 10);
        const month = Number.parseInt(absolute[1].slice(5, 7), 10) - 1;
        const day = Number.parseInt(absolute[1].slice(8, 10), 10);
        const hour = absolute[2] ? Number.parseInt(absolute[2], 10) : 9;
        const minute = absolute[3] ? Number.parseInt(absolute[3], 10) : 0;
        return new Date(year, month, day, hour, minute, 0, 0);
    }
    const base = new Date(now);
    base.setSeconds(0, 0);
    if (lowered.includes("tomorrow")) {
        base.setDate(base.getDate() + 1);
        return base;
    }
    if (lowered.includes("today")) {
        return base;
    }
    if (lowered.includes("next week")) {
        base.setDate(base.getDate() + 7);
        return base;
    }
    const dayNames = [
        { name: "sunday", day: 0 },
        { name: "monday", day: 1 },
        { name: "tuesday", day: 2 },
        { name: "wednesday", day: 3 },
        { name: "thursday", day: 4 },
        { name: "friday", day: 5 },
        { name: "saturday", day: 6 },
    ];
    for (const dayName of dayNames) {
        if (!lowered.includes(dayName.name)) {
            continue;
        }
        const offset = (dayName.day - base.getDay() + 7) % 7 || 7;
        base.setDate(base.getDate() + offset);
        return base;
    }
    return null;
}
function parseScheduledAtFromPrompt(prompt, now) {
    const baseDate = parseDateFromPrompt(prompt, now);
    if (!baseDate) {
        return null;
    }
    const time = parseTimeFromPrompt(prompt);
    if (time) {
        baseDate.setHours(time.hour, time.minute, 0, 0);
    }
    else {
        baseDate.setHours(9, 0, 0, 0);
    }
    return (0, db_1.normalizeIso)(baseDate.toISOString());
}
function inferPriority(prompt) {
    const lowered = prompt.toLowerCase();
    if (/\b(urgent|asap|immediately|critical|p0)\b/.test(lowered)) {
        return "urgent";
    }
    if (/\b(high priority|high-priority|priority high|important)\b/.test(lowered)) {
        return "high";
    }
    if (/\b(low priority|priority low)\b/.test(lowered)) {
        return "low";
    }
    if (/\b(medium priority|priority medium)\b/.test(lowered)) {
        return "medium";
    }
    return "medium";
}
function inferAgentType(prompt) {
    const lowered = prompt.toLowerCase();
    if (lowered.includes("claude") || lowered.includes("anthropic")) {
        return "claude";
    }
    return "codex";
}
function inferTitle(prompt) {
    const line = prompt.split(/\r?\n/)[0]?.trim() ?? "";
    let title = line;
    title = title.replace(/\bwith\s+(?:low|medium|high|urgent)\s+priority\b/gi, "");
    title = title.replace(/\b(?:using|with)\s+(?:codex|claude)\b/gi, "");
    title = title.replace(/\b(?:depends on|blocked by|after)\s+task-[a-z0-9_-]+\b/gi, "");
    title = title.replace(/\b(?:today|tomorrow|next week)\b(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, "");
    title = title.replace(/[\s,;.-]+$/g, "").trim();
    if (!title) {
        const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 8);
        title = words.join(" ");
    }
    return title || "Untitled task";
}
function fallbackParsePrompt(prompt, now) {
    return {
        title: inferTitle(prompt),
        description: prompt,
        priority: inferPriority(prompt),
        agent_type: inferAgentType(prompt),
        scheduled_at: parseScheduledAtFromPrompt(prompt, now),
        depends_on: parseDependsOnFromPrompt(prompt),
    };
}
function normalizeDependsOn(value, fallback) {
    if (!Array.isArray(value)) {
        return fallback;
    }
    const deduped = new Set();
    for (const item of value) {
        if (typeof item !== "string") {
            continue;
        }
        const cleaned = item.trim();
        if (!cleaned) {
            continue;
        }
        deduped.add(cleaned);
    }
    return [...deduped];
}
function normalizeScheduledAt(value, prompt, now) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    if (typeof value === "string") {
        const normalized = (0, db_1.normalizeIso)(value);
        if (normalized) {
            return normalized;
        }
        return parseScheduledAtFromPrompt(`${prompt}\n${value}`, now);
    }
    return parseScheduledAtFromPrompt(prompt, now);
}
function normalizeCandidate(candidate, prompt, now) {
    const fallback = fallbackParsePrompt(prompt, now);
    const title = typeof candidate.title === "string" && candidate.title.trim().length > 0
        ? candidate.title.trim()
        : fallback.title;
    const description = typeof candidate.description === "string" && candidate.description.trim().length > 0
        ? candidate.description.trim()
        : fallback.description;
    const priority = isTaskPriority(candidate.priority) ? candidate.priority : fallback.priority;
    const agentType = isAgentType(candidate.agent_type) ? candidate.agent_type : fallback.agent_type;
    return {
        title,
        description,
        priority,
        agent_type: agentType,
        scheduled_at: normalizeScheduledAt(candidate.scheduled_at, prompt, now),
        depends_on: normalizeDependsOn(candidate.depends_on, fallback.depends_on),
    };
}
async function parseWithOpenAI(prompt, now) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is missing");
    }
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: "You parse product task prompts. Return only JSON with keys: title, description, priority, agent_type, scheduled_at, depends_on. priority: low|medium|high|urgent. agent_type: codex|claude. scheduled_at must be ISO8601 or null. depends_on must be array of task IDs.",
                },
                {
                    role: "user",
                    content: `Current time: ${now.toISOString()}\nPrompt: ${prompt}`,
                },
            ],
        }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI parse failed: ${response.status} ${errorBody}`);
    }
    const body = (await response.json());
    const content = body.choices?.[0]?.message?.content;
    const text = typeof content === "string"
        ? content
        : Array.isArray(content)
            ? content
                .map((item) => (typeof item.text === "string" ? item.text : ""))
                .join("\n")
                .trim()
            : "";
    const parsed = safeJsonParse(text);
    return {
        parsed: normalizeCandidate(parsed, prompt, now),
        parser: {
            provider: "openai",
            model: OPENAI_MODEL,
            fallback: false,
        },
    };
}
async function parseWithAnthropic(prompt, now) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY is missing");
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 300,
            temperature: 0,
            system: "Return JSON only. Required keys: title, description, priority, agent_type, scheduled_at, depends_on. priority must be low|medium|high|urgent. agent_type must be codex|claude. scheduled_at ISO8601 or null. depends_on array of task IDs.",
            messages: [{ role: "user", content: `Current time: ${now.toISOString()}\nPrompt: ${prompt}` }],
        }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic parse failed: ${response.status} ${errorBody}`);
    }
    const body = (await response.json());
    const text = body.content
        ?.map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : ""))
        .join("\n")
        .trim() ?? "";
    const parsed = safeJsonParse(text);
    return {
        parsed: normalizeCandidate(parsed, prompt, now),
        parser: {
            provider: "anthropic",
            model: ANTHROPIC_MODEL,
            fallback: false,
        },
    };
}
function preferredProvider() {
    const raw = (process.env.AGENTCAL_LLM_PROVIDER ?? "auto").toLowerCase();
    if (raw === "openai" || raw === "anthropic") {
        return raw;
    }
    return "auto";
}
function providerOrder() {
    const preferred = preferredProvider();
    if (preferred === "openai") {
        return ["openai", "anthropic"];
    }
    if (preferred === "anthropic") {
        return ["anthropic", "openai"];
    }
    if (process.env.OPENAI_API_KEY) {
        return ["openai", "anthropic"];
    }
    return ["anthropic", "openai"];
}
function fallbackResult(prompt, now, reason) {
    const parser = {
        provider: "fallback",
        model: null,
        fallback: true,
        reason,
    };
    return {
        parsed: fallbackParsePrompt(prompt, now),
        parser,
    };
}
async function parsePromptToTaskDraft(prompt) {
    const trimmedPrompt = prompt.trim();
    const now = new Date();
    if (!trimmedPrompt) {
        return fallbackResult(prompt, now, "prompt is empty");
    }
    const errors = [];
    for (const provider of providerOrder()) {
        try {
            if (provider === "openai" && process.env.OPENAI_API_KEY) {
                return await parseWithOpenAI(trimmedPrompt, now);
            }
            if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
                return await parseWithAnthropic(trimmedPrompt, now);
            }
        }
        catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    const reason = errors.length > 0
        ? `llm parse unavailable: ${errors.join(" | ")}`
        : "llm parse unavailable: missing OPENAI_API_KEY/ANTHROPIC_API_KEY";
    return fallbackResult(trimmedPrompt, now, reason);
}
//# sourceMappingURL=prompt-parser.js.map