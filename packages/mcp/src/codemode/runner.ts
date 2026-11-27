import type { CodemodeSandbox, CodemodeTool } from "@earendil-works/pi-codemode";
import type { ToolContext, ToolResponse } from "../tools/types.js";
import { configureDownstream } from "./downstream.js";
import { SCRIPT_TOOL_GUIDE } from "./tool-guide.js";

const LOCAL_TOOLS = [
    "architecture_overview",
    "call_graph",
    "continue_search",
    "detect_changes",
    "file_outline",
    "find_references",
    "list_codebases",
    "manage_index",
    "read_file",
    "search_codebase",
    "trace_path",
] as const;
const MAX_SCRIPTS = 4;
const MAX_CALLS = 32;
const MAX_PARALLEL_CALLS = 4;
const TIMEOUT_MS = 30_000;
const HEAP_BYTES = 256 * 1024 * 1024;
const OUTPUT_BYTES = 16 * 1024;
const ERROR_BYTES = 1024;
const TOOL_RESULT_BYTES = 1024 * 1024;

let activeScripts = 0;
let activeWorkers = 0;

function bound(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text) <= maxBytes) return text;
    const suffix = "\n[truncated]";
    const bytes = Buffer.from(text);
    let end = maxBytes - suffix.length;
    while ((bytes[end] & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end).toString("utf8") + suffix;
}

function errorMessage(error: unknown): string {
    return bound(error instanceof Error ? error.message : String(error), ERROR_BYTES);
}

type ScriptToolResult = {
    content?: ReadonlyArray<{ type: string; text?: unknown }>;
    isError?: boolean;
    structuredContent?: unknown;
};

function nestedValue(name: string, result: ScriptToolResult, decodeJson: boolean): unknown {
    const text = (result.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text).join("\n");
    if (result.isError) throw new Error(bound(text || `Tool '${name}' failed.`, ERROR_BYTES));
    if (result.structuredContent !== undefined) {
        if (Buffer.byteLength(JSON.stringify(result.structuredContent)) > TOOL_RESULT_BYTES) {
            throw new Error("Nested tool result exceeds 1 MiB.");
        }
        return result.structuredContent;
    }
    if (Buffer.byteLength(text) > TOOL_RESULT_BYTES) throw new Error("Nested tool result exceeds 1 MiB.");
    if (decodeJson) {
        try {
            return JSON.parse(text) as unknown;
        } catch {
            // Some Satori requests explicitly choose text presentation.
        }
    }
    return text;
}

function scriptResult(text: string, isError = false): ToolResponse {
    return {
        content: [{ type: "text", text: bound(text, OUTPUT_BYTES) }],
        ...(isError ? { isError: true } : {}),
    };
}

export async function runScript(options: {
    code: string;
    callSessionTool: NonNullable<ToolContext["callSessionTool"]>;
    configPath?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<ToolResponse> {
    if (activeScripts >= MAX_SCRIPTS) return scriptResult("All CodeMode script slots are busy.", true);
    activeScripts += 1;
    const scope = new AbortController();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Script timed out.")), options.timeoutMs ?? TIMEOUT_MS);
    timer.unref();
    const signal = AbortSignal.any([scope.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
    const pending: Promise<void>[] = [];
    const active = new Set<Promise<void>>();
    let sandbox: CodemodeSandbox | undefined;
    let downstream: Awaited<ReturnType<typeof configureDownstream>> | undefined;

    function tool(name: string, invoke: (args: unknown, signal: AbortSignal) => Promise<unknown>): CodemodeTool {
        return {
            name,
            description: SCRIPT_TOOL_GUIDE.get(name),
            inputSchema: { type: "object", additionalProperties: true },
            execute(args, context) {
                const callSignal = AbortSignal.any([signal, context.signal]);
                callSignal.throwIfAborted();
                if (pending.length >= MAX_CALLS) throw new Error(`Script tool call limit reached (${MAX_CALLS}).`);
                const work = (async () => {
                    while (active.size >= MAX_PARALLEL_CALLS) {
                        await Promise.race(active);
                        callSignal.throwIfAborted();
                    }
                    callSignal.throwIfAborted();
                    // Start on the next microtask so the active set owns the call before dispatch.
                    const invocation = Promise.resolve().then(() => {
                        callSignal.throwIfAborted();
                        return invoke(args, callSignal);
                    });
                    const settled = invocation.then(() => undefined, () => undefined);
                    active.add(settled);
                    try {
                        return await invocation;
                    } catch (error) {
                        throw new Error(errorMessage(error), { cause: error });
                    } finally {
                        active.delete(settled);
                    }
                })();
                // The sandbox may discard its own promise on abort or unawaited script completion.
                // Keep the actual dispatcher work owned until it settles.
                pending.push(work.then(() => undefined, () => undefined));
                return work;
            },
        };
    }

    try {
        signal.throwIfAborted();
        const { CodemodeSandbox, toCodemodeIdentifier } = await import("@earendil-works/pi-codemode");
        if (options.configPath) {
            downstream = await configureDownstream(options.configPath, LOCAL_TOOLS, toCodemodeIdentifier, signal);
        }
        const tools = LOCAL_TOOLS.map((name) => tool(name, async (args, callSignal) => {
            if (name === "manage_index"
                && (args === null || typeof args !== "object" || !("action" in args) || args.action !== "status")) {
                throw new Error("CodeMode supports only manage_index action='status'. Call manage_index directly for index mutations.");
            }
            return nestedValue(name, await options.callSessionTool(name, args, callSignal), true);
        }));
        for (const [name, invoke] of downstream?.tools ?? []) {
            tools.push(tool(name, async (args, callSignal) =>
                nestedValue(name, await invoke(args ?? {}, callSignal), false)));
        }
        sandbox = new CodemodeSandbox({
            tools,
            timeoutMs: Infinity,
            memoryLimitBytes: HEAP_BYTES,
            acquireWorker() {
                signal.throwIfAborted();
                if (activeWorkers >= MAX_SCRIPTS) throw new Error("All CodeMode worker slots are busy.");
                activeWorkers += 1;
                return () => { activeWorkers -= 1; };
            },
        });
        const result = await sandbox.execute(options.code, { signal });
        if (timeout.signal.aborted) return scriptResult("Script timed out.", true);
        if (!result.ok) return scriptResult(`Script ${result.error.kind}: ${errorMessage(result.error.message)}`, true);
        const parts = result.output.map((item) => item.type === "text" ? item.text : "[image omitted]");
        if (result.value !== undefined) {
            parts.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value));
        }
        return scriptResult(parts.join("\n"));
    } catch (error) {
        return scriptResult(errorMessage(error), true);
    } finally {
        clearTimeout(timer);
        scope.abort();
        // Close downstream pipes before waiting for callbacks. The local dispatcher work
        // can outlive the sandbox, and the outer MCP operation owns its session resources.
        try {
            await Promise.allSettled([sandbox?.close(), downstream?.close(), ...pending]);
        } finally {
            activeScripts -= 1;
        }
    }
}
