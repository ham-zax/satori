import fs from "node:fs";
import path from "node:path";
import { probeCurrentPublicationForPath, type PublicationPathProbe } from "@satori-code/core/integration";
import { CODEMODE_AGENT_GUIDANCE } from "./codemode/tool-guide.js";

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

/**
 * Strips ANSI escape sequences, ASCII/C1 control characters, Unicode bidi
 * override/isolate controls, zero-width format chars, and Unicode Tag block
 * characters (U+E0000-U+E007F) before embedding a repository path into agent
 * context.
 */
function sanitizeHookPath(value: string): string {
    // Strip ANSI CSI/OSC sequences without control-character regexes, plus
    // ASCII/C1 controls, bidi overrides/isolates, zero-width chars, and
    // Unicode Tags (U+E0000-U+E007F).
    let strippedAnsi = "";
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x1b) {
            const sequenceType = value.charCodeAt(index + 1);
            if (sequenceType === 0x5b) {
                index += 2;
                while (index < value.length) {
                    const sequenceCode = value.charCodeAt(index);
                    if (sequenceCode >= 0x40 && sequenceCode <= 0x7e) break;
                    index += 1;
                }
            } else if (sequenceType === 0x5d) {
                index += 2;
                while (index < value.length) {
                    const sequenceCode = value.charCodeAt(index);
                    if (sequenceCode === 0x07) break;
                    if (sequenceCode === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
                        index += 1;
                        break;
                    }
                    index += 1;
                }
            }
            continue;
        }
        strippedAnsi += value[index];
    }

    let result = "";
    for (const char of strippedAnsi) {
        const cp = char.codePointAt(0)!;
        if (
            (cp >= 0xe0000 && cp <= 0xe007f)
            || (cp >= 0x200b && cp <= 0x200f)
            || (cp >= 0x202a && cp <= 0x202e)
            || (cp >= 0x2066 && cp <= 0x2069)
            || cp === 0x061c
            || cp === 0xfeff
        ) {
            continue;
        }
        if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
            result += " ";
            continue;
        }
        result += char;
    }
    return result.replace(/\s+/g, " ").trim();
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
        const safeRoot = sanitizeHookPath(probe.canonicalRoot);
        return {
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: `[satori] ${safeRoot} is indexed by Satori. When ownership, behavior location, or callers are not yet known, call search_codebase with path=${JSON.stringify(safeRoot)}; use native tools for known paths and literals. The satori skill has the full workflow.`,
            },
        };
    }
    if (probe.kind === "incompatible") {
        const safeRoot = sanitizeHookPath(probe.canonicalRoot);
        return {
            hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: `[satori] ${safeRoot} has an older Satori index format; Satori rebuilds repositories within its automatic byte budgets in the background (check manage_index status for indexing.mode="auto_indexing"). Use native read/grep tools while not_ready; only ask the user before action="reindex" if status stays requires_reindex on >8 MiB paid/connected API repos or >150 MiB / >50k-file monorepos.`,
            },
        };
    }
    const repoRoot = findGitRoot(cwd);
    if (!repoRoot) return null;
    const safeRepoRoot = sanitizeHookPath(repoRoot);
    return {
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `[satori] ${safeRepoRoot} is not indexed yet. Satori auto-indexes <=20 MiB offline Git workspaces on startup and <=150 MiB offline (or <=8 MiB connected/Voyage) workspaces on first search_codebase call (indexing.mode="auto_indexing")—do not ask the user whether to index or migrate. Use native read/grep tools while not_ready; only ask the user before manage_index action="create" on >8 MiB paid/connected API repos or >150 MiB / >50k-file monorepos.`,
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
    const output = contextFor(probeCurrentPublicationForPath(cwd, { stateRoot: options.stateRoot }), cwd);
    // The hook process and the MCP server can have different environments.
    if (output) output.hookSpecificOutput.additionalContext += ` ${CODEMODE_AGENT_GUIDANCE}`;
    return output;
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
