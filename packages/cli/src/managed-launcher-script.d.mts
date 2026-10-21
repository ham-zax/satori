export declare const DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS: number;
export declare const MANAGED_LAUNCHER_SCOPE_HEX_LENGTH: number;
export declare const MANAGED_LAUNCHER_TITLE_TOKEN_HEX_LENGTH: number;

export declare function parseManagedLauncherEnvironment(content: string): Readonly<Record<string, string>>;

export declare function parseManagedLauncherCohortToken(content: string): string;

export declare function parseManagedLauncherDescriptor(content: string): Readonly<{
    command: string;
    args: readonly string[];
    managedEnv: Readonly<Record<string, string>>;
}>;

export declare function buildLauncherScript(options: {
    command: string;
    args: readonly string[];
    managedEnv?: Readonly<Record<string, string>>;
    managedRuntimeRoot?: string;
    managedLauncherPath?: string;
    shutdownGraceMs?: number;
}): string;

export declare const MANAGED_SESSION_HOOK_FILE: string;
export declare const MANAGED_SESSION_HOOK_MARKER: string;

export declare function buildSessionHookShimScript(): string;
