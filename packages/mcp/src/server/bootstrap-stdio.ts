import { installCliStdoutRedirect, installConsoleToStderrPatch, StdoutGuardMode, WritableStdoutLike } from "./stdio-safety.js";

type BootstrapRunMode = "mcp" | "cli" | "postflight";

interface BootstrapStdioSafetyOptions {
    runMode: BootstrapRunMode;
    guardMode: StdoutGuardMode | "off";
    stdout?: WritableStdoutLike;
    writeToStderr?: (text: string) => void;
    onGuardDisabled?: () => void;
}

export function installBootstrapStdioSafety(options: BootstrapStdioSafetyOptions): () => void {
    const restoreConsole = installConsoleToStderrPatch({
        writeToStderr: options.writeToStderr,
        methods: options.runMode === "mcp" ? ["log", "info", "warn", "error", "debug"] : undefined,
    });
    let restoreStdout = () => { };

    if (options.guardMode !== "off") {
        restoreStdout = installCliStdoutRedirect({
            mode: options.guardMode,
            stdout: options.stdout,
            writeToStderr: options.writeToStderr,
        });
    } else {
        options.onGuardDisabled?.();
    }

    return () => {
        restoreStdout();
        restoreConsole();
    };
}
