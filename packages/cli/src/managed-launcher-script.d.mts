export declare const DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS: number;

export declare function buildLauncherScript(options: {
    command: string;
    args: readonly string[];
    shutdownGraceMs?: number;
}): string;
