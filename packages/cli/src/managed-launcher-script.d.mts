export declare const DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS: number;

export declare function parseManagedLauncherEnvironment(content: string): Readonly<Record<string, string>>;

export declare function buildLauncherScript(options: {
    command: string;
    args: readonly string[];
    managedEnv?: Readonly<Record<string, string>>;
    shutdownGraceMs?: number;
}): string;
