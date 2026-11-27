import path from "node:path";

export type WorkspaceAuthorizationCode =
    | "ROOT_NOT_AUTHORIZED"
    | "BROAD_ROOT_NOT_ALLOWED"
    | "INVALID_WORKSPACE_ROOT"
    | "WORKSPACE_POLICY_NOT_BOUND";

export class WorkspaceAuthorizationError extends Error {
    readonly code: WorkspaceAuthorizationCode;

    constructor(code: WorkspaceAuthorizationCode, message: string) {
        super(message);
        this.name = "WorkspaceAuthorizationError";
        this.code = code;
    }
}

/**
 * Session workspace root rule: SATORI_SESSION_ROOTS_JSON when present,
 * otherwise [process.cwd()]. Returns the same roots for direct stdio sessions
 * and for the shared-runtime launcher, so both paths construct identical
 * session workspace policies.
 *
 * Broad roots (filesystem root, home directory, state root) are rejected
 * unless SATORI_ALLOW_BROAD_ROOTS=true explicitly opts in.
 */
export const SESSION_WORKSPACE_ROOTS_MAX = 16;

export function resolveSessionWorkspaceRoots(env: NodeJS.ProcessEnv): readonly string[] {
    const raw = env.SATORI_SESSION_ROOTS_JSON;
    if (raw === undefined || raw === "") {
        return [process.cwd()];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new WorkspaceAuthorizationError(
            "INVALID_WORKSPACE_ROOT",
            "SATORI_SESSION_ROOTS_JSON must be a JSON array of 1-16 absolute path strings.",
        );
    }
    if (
        !Array.isArray(parsed)
        || parsed.length < 1
        || parsed.length > SESSION_WORKSPACE_ROOTS_MAX
    ) {
        throw new WorkspaceAuthorizationError(
            "INVALID_WORKSPACE_ROOT",
            `SATORI_SESSION_ROOTS_JSON must be a JSON array of 1-${SESSION_WORKSPACE_ROOTS_MAX} absolute path strings.`,
        );
    }
    for (const entry of parsed) {
        if (typeof entry !== "string" || !path.isAbsolute(entry)) {
            throw new WorkspaceAuthorizationError(
                "INVALID_WORKSPACE_ROOT",
                "SATORI_SESSION_ROOTS_JSON entries must be absolute path strings.",
            );
        }
    }
    return parsed;
}

export function hasExplicitSessionWorkspaceRoots(env: NodeJS.ProcessEnv): boolean {
    const raw = env.SATORI_SESSION_ROOTS_JSON;
    return raw !== undefined && raw !== "";
}

export function resolveAllowBroadRoots(env: NodeJS.ProcessEnv): boolean {
    return env.SATORI_ALLOW_BROAD_ROOTS?.toLowerCase() === "true";
}
