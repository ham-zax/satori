import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_READ_ONLY_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_ONLY_GIT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/**
 * Global flags enforced on every read-only Git invocation in Satori MCP:
 * - `--no-pager`: never spawn a pager process.
 * - `--no-optional-locks`: never acquire `.git/index.lock` or rewrite `.git/index`
 *   during read-only probes (`SECURITY.md` read-only contract).
 * - `-c core.fsmonitor=false`: never execute repository-local `core.fsmonitor`
 *   commands from an untrusted `.git/config`.
 * - `-c core.untrackedCache=false` & `-c core.preloadIndex=false`: avoid optional
 *   index/cache refreshes.
 */
export const READ_ONLY_GIT_GLOBAL_ARGS: readonly string[] = Object.freeze([
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.preloadIndex=false",
]);

export function buildReadOnlyGitArgs(
    codebaseRoot: string,
    subcommandArgs: readonly string[],
): string[] {
    return [
        ...READ_ONLY_GIT_GLOBAL_ARGS,
        "-C",
        codebaseRoot,
        ...subcommandArgs,
    ];
}

export type ReadOnlyGitOptions = Readonly<{
    timeoutMs?: number;
    maxBufferBytes?: number;
}>;

/** Authoritative synchronous runner for read-only Git queries in MCP tools. */
export function execReadOnlyGitTextSync(
    codebaseRoot: string,
    subcommandArgs: readonly string[],
    options: ReadOnlyGitOptions = {},
): string {
    return execFileSync("git", buildReadOnlyGitArgs(codebaseRoot, subcommandArgs), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs ?? DEFAULT_READ_ONLY_GIT_TIMEOUT_MS,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_READ_ONLY_GIT_MAX_BUFFER_BYTES,
    });
}

/** Authoritative async UTF-8 runner for read-only Git queries in MCP tools. */
export async function execReadOnlyGitText(
    codebaseRoot: string,
    subcommandArgs: readonly string[],
    options: ReadOnlyGitOptions = {},
): Promise<string> {
    const result = await execFileAsync("git", buildReadOnlyGitArgs(codebaseRoot, subcommandArgs), {
        encoding: "utf8",
        timeout: options.timeoutMs ?? DEFAULT_READ_ONLY_GIT_TIMEOUT_MS,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_READ_ONLY_GIT_MAX_BUFFER_BYTES,
    });
    return result.stdout;
}

/** Authoritative async binary runner for read-only Git object reads (e.g. `git show`). */
export async function execReadOnlyGitBuffer(
    codebaseRoot: string,
    subcommandArgs: readonly string[],
    options: ReadOnlyGitOptions = {},
): Promise<Buffer> {
    const result = await execFileAsync("git", buildReadOnlyGitArgs(codebaseRoot, subcommandArgs), {
        encoding: "buffer",
        timeout: options.timeoutMs ?? DEFAULT_READ_ONLY_GIT_TIMEOUT_MS,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_READ_ONLY_GIT_MAX_BUFFER_BYTES,
    });
    return result.stdout;
}
