import fs from "node:fs";
import path from "node:path";
import { probeCurrentPublicationForPath, type PublicationPathProbe } from "@satori-code/core/integration";

/**
 * Claude Code SessionStart hook body, loaded by the installer-managed
 * ~/.satori/bin/satori-hook.js shim. It tells the agent whether the session
 * directory already has a ready Satori Publication or is being indexed in the
 * background. Fail-open: any error prints nothing, so a session never waits on
 * or fails because of Satori.
 */

const STDIN_LIMIT_BYTES = 256 * 1024;

export interface SessionStartHookOutput {
    hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
    systemMessage?: string;
}

function findGitRoot(start: string): string | null {
    let candidate = start;
    for (;;) {
        if (fs.existsSync(path.join(candidate, ".git"))) return candidate;
        const parent = path.dirname(candidate);
        if (parent === candidate) return null;
        candidate = parent;
    }
}

function contextFor(probe: PublicationPathProbe, cwd: string): SessionStartHookOutput | null {
    if (probe.kind === "current") {
        return {
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: `[satori] ${probe.canonicalRoot} is indexed by Satori. When ownership, behavior location, or callers are not yet known, call search_codebase with path="${probe.canonicalRoot}"; use native tools for known paths and literals. The satori skill has the full workflow.`,
            },
        };
    }
    if (probe.kind === "incompatible") {
        return {
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: `[satori] ${probe.canonicalRoot} has an older Satori index format; Satori rebuilds repositories within its automatic byte budgets in the background (check manage_index status for indexing.mode="auto_indexing"). Use native read/grep tools while not_ready; only ask the user before action="reindex" if status stays requires_reindex on >8 MiB paid/connected API repos or >150 MiB / >50k-file monorepos.`,
            },
        };
    }
    const repoRoot = findGitRoot(cwd);
    if (!repoRoot) return null;
    return {
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `[satori] ${repoRoot} is not indexed yet. Satori auto-indexes <=20 MiB offline Git workspaces on startup and <=150 MiB offline (or <=8 MiB connected/Voyage) workspaces on first search_codebase call (indexing.mode="auto_indexing")—do not ask the user whether to index or migrate. Use native read/grep tools while not_ready; only ask the user before manage_index action="create" on >8 MiB paid/connected API repos or >150 MiB / >50k-file monorepos.`,
        },
    };
}

/** Build the hook output for one hook payload; null means print nothing. */
export function buildSessionStartHookOutput(
    payload: unknown,
    options: { stateRoot?: string; fallbackCwd?: string } = {},
): SessionStartHookOutput | null {
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
    const rawCwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : options.fallbackCwd;
    if (!rawCwd || !path.isAbsolute(rawCwd)) return null;
    let cwd: string;
    try {
        cwd = fs.realpathSync.native(rawCwd);
    } catch {
        return null;
    }
    return contextFor(probeCurrentPublicationForPath(cwd, { stateRoot: options.stateRoot }), cwd);
}

async function readBoundedStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
    if (stdin.isTTY) return "";
    let text = "";
    for await (const chunk of stdin) {
        text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
        if (text.length > STDIN_LIMIT_BYTES) throw new Error("Hook payload exceeds the stdin limit.");
    }
    return text;
}

export async function runSessionStartHook(io: {
    stdin: NodeJS.ReadableStream & { isTTY?: boolean };
    stdout: { write(text: string): unknown };
    cwd: string;
}): Promise<void> {
    try {
        const text = await readBoundedStdin(io.stdin);
        const output = buildSessionStartHookOutput(text.trim() ? JSON.parse(text) : {}, { fallbackCwd: io.cwd });
        if (output) io.stdout.write(`${JSON.stringify(output)}\n`);
    } catch {
        // Fail-open by contract: the session starts without Satori context.
    }
}
