export type StdoutGuardMode = "drop" | "redirect";

type ConsoleMethodName = "log" | "info" | "warn" | "error" | "debug";

interface ConsolePatchOptions {
    writeToStderr?: (text: string) => void;
}

interface CliStdoutRedirectOptions {
    mode?: StdoutGuardMode;
    stdout?: Record<string, any>;
    writeToStderr?: (text: string) => void;
}

function toLogString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function toChunkText(chunk: unknown): string | null {
    if (typeof chunk === "string") {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return null;
    }
    return String(chunk);
}

function chunkLength(chunk: unknown): number {
    if (typeof chunk === "string") {
        return chunk.length;
    }
    if (chunk instanceof Uint8Array) {
        return chunk.byteLength;
    }
    return String(chunk).length;
}

function ensureTrailingNewline(value: string): string {
    return value.endsWith("\n") ? value : `${value}\n`;
}

export function installConsoleToStderrPatch(options: ConsolePatchOptions = {}): () => void {
    const writeToStderr = options.writeToStderr || ((text: string) => {
        process.stderr.write(text);
    });
    const original: Partial<Record<ConsoleMethodName, (...args: unknown[]) => void>> = {};

    const patchMethod = (method: ConsoleMethodName) => {
        original[method] = console[method];
        console[method] = (...args: unknown[]) => {
            writeToStderr(ensureTrailingNewline(args.map(toLogString).join(" ")));
        };
    };

    patchMethod("log");
    patchMethod("info");
    patchMethod("warn");
    patchMethod("error");
    patchMethod("debug");

    return () => {
        for (const method of Object.keys(original) as ConsoleMethodName[]) {
            const fn = original[method];
            if (fn) {
                console[method] = fn;
            }
        }
    };
}

export function installCliStdoutRedirect(options: CliStdoutRedirectOptions = {}): () => void {
    const stdout = options.stdout || (process.stdout as unknown as Record<string, any>);
    const mode: StdoutGuardMode = options.mode || "drop";
    const writeToStderr = options.writeToStderr || ((text: string) => {
        process.stderr.write(text);
    });

    const originalMethods: Record<string, unknown> = {};

    const blockChunk = (chunk: unknown): void => {
        const text = toChunkText(chunk);
        if (text !== null) {
            if (mode === "redirect") {
                writeToStderr(ensureTrailingNewline(`[STDOUT_BLOCKED] ${text}`));
                return;
            }
            writeToStderr(ensureTrailingNewline(`[STDOUT_BLOCKED] dropped len=${text.length}`));
            return;
        }
        writeToStderr(ensureTrailingNewline(`[STDOUT_BLOCKED_BINARY len=${chunkLength(chunk)}]`));
    };

    const patch = (methodName: string, replacement: (...args: unknown[]) => unknown): void => {
        const original = stdout[methodName];
        if (typeof original !== "function") {
            return;
        }
        originalMethods[methodName] = original;
        stdout[methodName] = replacement;
    };

    patch("write", (...args: unknown[]) => {
        blockChunk(args[0]);
        const maybeCallback = args[args.length - 1];
        if (typeof maybeCallback === "function") {
            (maybeCallback as (error?: Error | null) => void)(null);
        }
        return true;
    });

    patch("end", (...args: unknown[]) => {
        if (args.length > 0) {
            blockChunk(args[0]);
        }
        const maybeCallback = args[args.length - 1];
        if (typeof maybeCallback === "function") {
            (maybeCallback as () => void)();
        }
        return true;
    });

    patch("writev", (...args: unknown[]) => {
        const chunks = Array.isArray(args[0]) ? args[0] : [];
        for (const chunkRecord of chunks) {
            const chunk = (chunkRecord as { chunk?: unknown })?.chunk;
            blockChunk(chunk);
        }
        const maybeCallback = args[args.length - 1];
        if (typeof maybeCallback === "function") {
            (maybeCallback as (error?: Error | null) => void)(null);
        }
        return true;
    });

    return () => {
        for (const [methodName, original] of Object.entries(originalMethods)) {
            stdout[methodName] = original;
        }
    };
}
