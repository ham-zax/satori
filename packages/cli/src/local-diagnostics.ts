import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = "v1" as const;
const MAX_RESULT_COUNT = 10_000;
const DEFAULT_MAX_EVENTS = 1_000;
const MAX_DIAGNOSTICS_READ_BYTES = 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 50;
const LOCK_RETRY_MS = 5;
// Keep this privacy boundary explicit: arbitrary uppercase response text is not safe diagnostic metadata.
const SAFE_WARNING_CODES = new Set([
    "REINDEX_UNNECESSARY_IGNORE_ONLY",
    "REINDEX_PREFLIGHT_UNKNOWN",
    "IGNORE_POLICY_PROBE_FAILED",
    "FILTER_MUST_UNSATISFIED",
    "RERANKER_FAILED",
    "SEARCH_DIRTY_WORKTREE_NOT_SYNCED",
    "SEARCH_DIRTY_FILE_EVIDENCE_UNAVAILABLE",
    "SEARCH_CHANGED_FILES_BOOST_SKIPPED",
]);
const TOOLS = new Set([
    "list_codebases",
    "manage_index",
    "search_codebase",
    "file_outline",
    "call_graph",
    "read_file",
]);
const LIFECYCLE_ACTIONS = new Set(["create", "reindex", "sync", "status", "clear", "repair"]);
const OUTCOMES = new Set([
    "ok",
    "error",
    "blocked",
    "not_ready",
    "not_indexed",
    "requires_reindex",
    "not_found",
    "unsupported",
    "ambiguous",
    "outside_indexed_root",
    "unknown",
]);

export type LocalDiagnosticTool =
    | "list_codebases"
    | "manage_index"
    | "search_codebase"
    | "file_outline"
    | "call_graph"
    | "read_file"
    | "unknown";
export type LocalDiagnosticOutcome =
    | "ok"
    | "error"
    | "blocked"
    | "not_ready"
    | "not_indexed"
    | "requires_reindex"
    | "not_found"
    | "unsupported"
    | "ambiguous"
    | "outside_indexed_root"
    | "unknown";
export type LocalDiagnosticLifecycleAction = "create" | "reindex" | "sync" | "status" | "clear" | "repair";

export interface LocalDiagnosticEvent {
    schemaVersion: typeof SCHEMA_VERSION;
    kind: "tool_call";
    tool: LocalDiagnosticTool;
    durationMs: number;
    outcome: LocalDiagnosticOutcome;
    /** Number of top-level search results; other tools have intentionally different volume units. */
    resultCount?: number;
    warningCodes?: string[];
    fallbackUsed?: true;
    lifecycleAction?: LocalDiagnosticLifecycleAction;
    recoverySuccess?: boolean;
}

export interface LocalDiagnosticsSummary {
    schemaVersion: typeof SCHEMA_VERSION;
    storage: "local_only";
    privacy: string;
    eventsRead: number;
    malformedEventsSkipped: number;
    totalDurationMs: number;
    toolCalls: Array<{
        tool: LocalDiagnosticTool;
        count: number;
        errorCount: number;
        durationMs: number;
        resultBearingCalls: number;
        resultCount: number;
        zeroResultCalls: number;
    }>;
    warningCodes: Array<{ code: string; count: number }>;
    fallbackUses: number;
    lifecycleOutcomes: Array<{ action: LocalDiagnosticLifecycleAction; outcome: LocalDiagnosticOutcome; count: number }>;
    recovery: { attempts: number; successes: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noFollowFlag(): number {
    return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function symlinkPathError(targetPath: string): NodeJS.ErrnoException {
    const error = new Error(`Refusing symlinked diagnostics path: ${targetPath}`) as NodeJS.ErrnoException;
    error.code = "ELOOP";
    return error;
}

function assertNoSymlinkComponents(targetPath: string): void {
    const absolutePath = path.resolve(targetPath);
    const parsed = path.parse(absolutePath);
    const relativeParts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let currentPath = parsed.root;
    for (const part of relativeParts) {
        currentPath = path.join(currentPath, part);
        try {
            if (fs.lstatSync(currentPath).isSymbolicLink()) {
                throw symlinkPathError(currentPath);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return;
            }
            throw error;
        }
    }
}

function readRegularFileNoFollow(filePath: string): { text: string; truncated: boolean } {
    assertNoSymlinkComponents(filePath);
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
            const error = new Error(`Diagnostics path is not a regular file: ${filePath}`) as NodeJS.ErrnoException;
            error.code = "EINVAL";
            throw error;
        }
        const bytesToRead = Math.min(stat.size, MAX_DIAGNOSTICS_READ_BYTES);
        const buffer = Buffer.alloc(bytesToRead);
        const start = Math.max(0, stat.size - bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        const truncated = start > 0;
        if (truncated) {
            const firstNewline = text.indexOf("\n");
            text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
        }
        return { text, truncated };
    } finally {
        fs.closeSync(fd);
    }
}

function sleepSync(durationMs: number): void {
    if (durationMs <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

interface DiagnosticsLock {
    fd: number;
    lockPath: string;
    stat: fs.Stats;
}

function acquireDiagnosticsLock(diagnosticsPath: string, timeoutMs: number): DiagnosticsLock | null {
    const lockPath = `${diagnosticsPath}.lock`;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
        assertNoSymlinkComponents(path.dirname(lockPath));
        try {
            const fd = fs.openSync(
                lockPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
                0o600,
            );
            try {
                fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
                return { fd, lockPath, stat: fs.fstatSync(fd) };
            } catch (error) {
                fs.closeSync(fd);
                fs.rmSync(lockPath, { force: true });
                throw error;
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") throw error;
            if (fs.lstatSync(lockPath).isSymbolicLink()) throw symlinkPathError(lockPath);
            if (Date.now() >= deadline) return null;
            sleepSync(Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
        }
    }
}

function releaseDiagnosticsLock(lock: DiagnosticsLock): void {
    try {
        fs.closeSync(lock.fd);
    } finally {
        try {
            const current = fs.lstatSync(lock.lockPath);
            if (!current.isSymbolicLink() && current.dev === lock.stat.dev && current.ino === lock.stat.ino) {
                fs.unlinkSync(lock.lockPath);
            }
        } catch {
            // The lock is advisory and may already have been removed after publication.
        }
    }
}

function firstTextEnvelope(result: unknown): Record<string, unknown> | null {
    if (!isRecord(result) || !Array.isArray(result.content)) {
        return null;
    }
    const text = result.content.find((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string");
    if (!isRecord(text) || typeof text.text !== "string") {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(text.text);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeDuration(durationMs: number): number {
    return Number.isFinite(durationMs) && durationMs >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(durationMs))
        : 0;
}

function normalizeOutcome(result: unknown, envelope: Record<string, unknown> | null): LocalDiagnosticOutcome {
    if (isRecord(result) && result.isError === true) {
        return "error";
    }
    const status = envelope?.status;
    return typeof status === "string" && OUTCOMES.has(status)
        ? status as LocalDiagnosticOutcome
        : "unknown";
}

function normalizeWarningCodes(envelope: Record<string, unknown> | null): string[] {
    if (!Array.isArray(envelope?.warnings)) {
        return [];
    }
    const codes = envelope.warnings.flatMap((warning): string[] => {
        const candidate = typeof warning === "string"
            ? warning
            : isRecord(warning) && typeof warning.code === "string"
                ? warning.code
                : "";
        return SAFE_WARNING_CODES.has(candidate) ? [candidate] : [];
    });
    return [...new Set(codes)].sort();
}

function hasFallbackEvidence(envelope: Record<string, unknown> | null, warningCodes: readonly string[]): boolean {
    return Boolean(
        envelope?.fallbackUsed === true
        || warningCodes.includes("RERANKER_FAILED"),
    );
}

export function buildLocalDiagnosticEvent(input: {
    toolName: string;
    args: Record<string, unknown>;
    result: unknown;
    durationMs: number;
}): LocalDiagnosticEvent {
    const tool = TOOLS.has(input.toolName) ? input.toolName as LocalDiagnosticTool : "unknown";
    const envelope = firstTextEnvelope(input.result);
    const warningCodes = normalizeWarningCodes(envelope);
    const resultCount = tool === "search_codebase" && Array.isArray(envelope?.results)
        ? Math.min(MAX_RESULT_COUNT, envelope.results.length)
        : undefined;
    const lifecycleAction = tool === "manage_index"
        && typeof input.args.action === "string"
        && LIFECYCLE_ACTIONS.has(input.args.action)
        ? input.args.action as LocalDiagnosticLifecycleAction
        : undefined;
    const outcome = normalizeOutcome(input.result, envelope);

    return {
        schemaVersion: SCHEMA_VERSION,
        kind: "tool_call",
        tool,
        durationMs: normalizeDuration(input.durationMs),
        outcome,
        ...(resultCount === undefined ? {} : { resultCount }),
        ...(warningCodes.length === 0 ? {} : { warningCodes }),
        ...(hasFallbackEvidence(envelope, warningCodes) ? { fallbackUsed: true as const } : {}),
        ...(lifecycleAction ? { lifecycleAction } : {}),
        ...(lifecycleAction === "repair" ? { recoverySuccess: outcome === "ok" } : {}),
    };
}

function parseEvent(value: unknown): LocalDiagnosticEvent | null {
    if (
        !isRecord(value)
        || value.schemaVersion !== SCHEMA_VERSION
        || value.kind !== "tool_call"
        || typeof value.tool !== "string"
        || (!TOOLS.has(value.tool) && value.tool !== "unknown")
        || typeof value.durationMs !== "number"
        || !Number.isSafeInteger(value.durationMs)
        || value.durationMs < 0
        || typeof value.outcome !== "string"
        || !OUTCOMES.has(value.outcome)
    ) {
        return null;
    }
    const warningCodes = Array.isArray(value.warningCodes)
        && value.warningCodes.every((code) => typeof code === "string" && SAFE_WARNING_CODES.has(code))
        ? [...new Set(value.warningCodes)].sort()
        : undefined;
    const lifecycleAction = typeof value.lifecycleAction === "string" && LIFECYCLE_ACTIONS.has(value.lifecycleAction)
        ? value.lifecycleAction as LocalDiagnosticLifecycleAction
        : undefined;
    return {
        schemaVersion: SCHEMA_VERSION,
        kind: "tool_call",
        tool: value.tool as LocalDiagnosticTool,
        durationMs: value.durationMs,
        outcome: value.outcome as LocalDiagnosticOutcome,
        ...(value.tool === "search_codebase"
            && typeof value.resultCount === "number"
            && Number.isSafeInteger(value.resultCount)
            && value.resultCount >= 0
            ? { resultCount: Math.min(MAX_RESULT_COUNT, value.resultCount) }
            : {}),
        ...(warningCodes && warningCodes.length > 0 ? { warningCodes } : {}),
        ...(value.fallbackUsed === true ? { fallbackUsed: true as const } : {}),
        ...(lifecycleAction ? { lifecycleAction } : {}),
        ...(lifecycleAction === "repair" && typeof value.recoverySuccess === "boolean"
            ? { recoverySuccess: value.recoverySuccess }
            : {}),
    };
}

export function recordLocalDiagnosticEvent(
    diagnosticsPath: string,
    event: LocalDiagnosticEvent,
    options: { maxEvents?: number; lockTimeoutMs?: number } = {},
): void {
    const parsed = parseEvent(event);
    if (!parsed) {
        return;
    }
    const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    let lock: DiagnosticsLock | null = null;
    let temporaryPath: string | null = null;
    try {
        const directory = path.dirname(diagnosticsPath);
        assertNoSymlinkComponents(directory);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertNoSymlinkComponents(directory);
        assertNoSymlinkComponents(diagnosticsPath);

        lock = acquireDiagnosticsLock(diagnosticsPath, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
        if (!lock) return;

        let existingText = "";
        try {
            existingText = readRegularFileNoFollow(diagnosticsPath).text;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const retained = existingText
            .split("\n")
            .filter(Boolean)
            .flatMap((line): LocalDiagnosticEvent[] => {
                try {
                    const existingEvent = parseEvent(JSON.parse(line));
                    return existingEvent ? [existingEvent] : [];
                } catch {
                    return [];
                }
            })
            .slice(-Math.max(0, maxEvents - 1));
        const contents = `${[...retained, parsed].map((item) => JSON.stringify(item)).join("\n")}\n`;

        temporaryPath = path.join(
            directory,
            `.${path.basename(diagnosticsPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
        );
        const temporaryFd = fs.openSync(
            temporaryPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
            0o600,
        );
        try {
            fs.writeFileSync(temporaryFd, contents, "utf8");
            fs.fsyncSync(temporaryFd);
        } finally {
            fs.closeSync(temporaryFd);
        }

        assertNoSymlinkComponents(directory);
        assertNoSymlinkComponents(diagnosticsPath);
        fs.renameSync(temporaryPath, diagnosticsPath);
        temporaryPath = null;
    } catch {
        // Diagnostics are best-effort and must never change tool behavior.
    } finally {
        if (temporaryPath) {
            fs.rmSync(temporaryPath, { force: true });
        }
        if (lock) {
            releaseDiagnosticsLock(lock);
        }
    }
}

export function readLocalDiagnosticsSummary(diagnosticsPath: string): LocalDiagnosticsSummary {
    const events: LocalDiagnosticEvent[] = [];
    let malformedEventsSkipped = 0;
    try {
        const bounded = readRegularFileNoFollow(diagnosticsPath);
        malformedEventsSkipped += bounded.truncated ? 1 : 0;
        for (const line of bounded.text.split("\n")) {
            if (!line) continue;
            try {
                const event = parseEvent(JSON.parse(line));
                if (event) events.push(event);
                else malformedEventsSkipped += 1;
            } catch {
                malformedEventsSkipped += 1;
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            malformedEventsSkipped += 1;
        }
    }
    if (events.length > DEFAULT_MAX_EVENTS) {
        events.splice(0, events.length - DEFAULT_MAX_EVENTS);
    }

    const tools = new Map<LocalDiagnosticTool, {
        count: number;
        errorCount: number;
        durationMs: number;
        resultBearingCalls: number;
        resultCount: number;
        zeroResultCalls: number;
    }>();
    const warnings = new Map<string, number>();
    const lifecycle = new Map<string, number>();
    let fallbackUses = 0;
    let recoveryAttempts = 0;
    let recoverySuccesses = 0;
    for (const event of events) {
        const tool = tools.get(event.tool) || {
            count: 0,
            errorCount: 0,
            durationMs: 0,
            resultBearingCalls: 0,
            resultCount: 0,
            zeroResultCalls: 0,
        };
        tool.count += 1;
        tool.errorCount += event.outcome === "error" ? 1 : 0;
        tool.durationMs += event.durationMs;
        if (event.resultCount !== undefined) {
            tool.resultBearingCalls += 1;
            tool.resultCount += event.resultCount;
            tool.zeroResultCalls += event.resultCount === 0 ? 1 : 0;
        }
        tools.set(event.tool, tool);
        for (const code of event.warningCodes || []) warnings.set(code, (warnings.get(code) || 0) + 1);
        if (event.fallbackUsed) fallbackUses += 1;
        if (event.lifecycleAction) {
            const key = `${event.lifecycleAction}\0${event.outcome}`;
            lifecycle.set(key, (lifecycle.get(key) || 0) + 1);
        }
        if (event.lifecycleAction === "repair") {
            recoveryAttempts += 1;
            recoverySuccesses += event.recoverySuccess ? 1 : 0;
        }
    }

    return {
        schemaVersion: SCHEMA_VERSION,
        storage: "local_only",
        privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
        eventsRead: events.length,
        malformedEventsSkipped,
        totalDurationMs: events.reduce((sum, event) => sum + event.durationMs, 0),
        toolCalls: [...tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, value]) => ({ tool, ...value })),
        warningCodes: [...warnings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
        fallbackUses,
        lifecycleOutcomes: [...lifecycle.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
            const [action, outcome] = key.split("\0") as [LocalDiagnosticLifecycleAction, LocalDiagnosticOutcome];
            return { action, outcome, count };
        }),
        recovery: { attempts: recoveryAttempts, successes: recoverySuccesses },
    };
}
