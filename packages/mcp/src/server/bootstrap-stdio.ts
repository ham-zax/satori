import { installCliStdoutRedirect, installConsoleToStderrPatch, StdoutGuardMode } from "./stdio-safety.js";

type BootstrapRunMode = "mcp" | "cli";

interface BootstrapStdioSafetyOptions {
    runMode: BootstrapRunMode;
    guardMode: StdoutGuardMode | "off";
    stdout?: Record<string, any>;
    writeToStderr?: (text: string) => void;
    onGuardDisabled?: () => void;
}

export function installBootstrapStdioSafety(options: BootstrapStdioSafetyOptions): () => void {
    const restoreConsole = installConsoleToStderrPatch({
        writeToStderr: options.writeToStderr,
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
