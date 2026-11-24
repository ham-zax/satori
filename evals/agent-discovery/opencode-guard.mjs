import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const MAX_TOOL_RESULT_BYTES = 32_768;
const TRUNCATION_MARKER = "\n[TRUNCATED AT 32768 UTF-8 BYTES]\n";
// Safety-only ceiling shared with the runner; efficiency is measured, not gated.
export const MAX_AGENT_DISCOVERY_TOOL_CALLS = 24;

export const NATIVE_TOOLS = Object.freeze(["grep", "glob", "read"]);
export const SATORI_TOOLS = Object.freeze([
    "satori_search_codebase",
    "satori_read_file",
    "satori_file_outline",
    "satori_call_graph",
]);
export const HYBRID_TOOLS = Object.freeze([...new Set([...NATIVE_TOOLS, ...SATORI_TOOLS])]);
export const SCOPE_PROFILES = Object.freeze(["production", "production_and_tests"]);
const VALID_ARMS = new Set(["native", "satori", "hybrid"]);

function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}

function isInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value) {
    return path.resolve(value);
}

function validateScopeProfile(scopeProfile = "production") {
    if (!SCOPE_PROFILES.includes(scopeProfile)) {
        throw new Error(`agent_discovery_invalid_scope_profile:${scopeProfile}`);
    }
    return scopeProfile;
}

function allowedToolsForArm(arm) {
    if (arm === undefined) return HYBRID_TOOLS;
    if (!VALID_ARMS.has(arm)) {
        throw new Error(`agent_discovery_invalid_arm:${arm}`);
    }
    if (arm === "native") return NATIVE_TOOLS;
    if (arm === "satori") return SATORI_TOOLS;
    return HYBRID_TOOLS;
}

function resolveArmFromAgent(agentOrArm) {
    if (!agentOrArm) return undefined;
    if (agentOrArm === "satori-eval-native" || agentOrArm === "native") return "native";
    if (agentOrArm === "satori-eval-satori" || agentOrArm === "satori") return "satori";
    if (agentOrArm === "satori-eval-hybrid" || agentOrArm === "hybrid") return "hybrid";
    return undefined;
}

function isProductionSource(repoRoot, candidate, scopeProfile = "production") {
    const absolute = canonicalPath(candidate);
    const sourceRoots = [
        path.join(repoRoot, "packages/core/src"),
        path.join(repoRoot, "packages/mcp/src"),
    ];
    if (!sourceRoots.some((sourceRoot) => isInside(sourceRoot, absolute))) {
        return false;
    }
    if (scopeProfile === "production") {
        return !absolute.endsWith(".test.ts");
    }
    return true;
}

function requireString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`agent_discovery_invalid_${label}`);
    }
    return value;
}

function requireRepoRoot(value, repoRoot, label) {
    const candidate = canonicalPath(requireString(value, label));
    if (candidate !== repoRoot) {
        throw new Error(`agent_discovery_out_of_scope_${label}`);
    }
}

function requireProductionPath(value, repoRoot, label, scopeProfile = "production") {
    const candidate = canonicalPath(requireString(value, label));
    if (!isProductionSource(repoRoot, candidate, scopeProfile)) {
        throw new Error(`agent_discovery_out_of_scope_${label}`);
    }
}

function requireProductionReference(value, repoRoot, label, scopeProfile = "production") {
    const reference = requireString(value, label);
    const candidate = path.isAbsolute(reference)
        ? reference
        : path.join(repoRoot, reference);
    requireProductionPath(candidate, repoRoot, label, scopeProfile);
}

export function validateToolCall(tool, args, repoRoot, options = {}) {
    const scopeProfile = validateScopeProfile(options.scopeProfile);
    const allowedTools = allowedToolsForArm(options.arm);
    if (!allowedTools.includes(tool)) {
        throw new Error(`agent_discovery_forbidden_tool:${tool}`);
    }

    if (NATIVE_TOOLS.includes(tool)) {
        if (tool === "read") {
            requireProductionPath(args?.filePath, repoRoot, "read_path", scopeProfile);
            if (!Number.isSafeInteger(args?.limit) || args.limit < 1 || args.limit > 200) {
                throw new Error("agent_discovery_read_limit_required");
            }
            if (args.offset !== undefined
                && (!Number.isSafeInteger(args.offset) || args.offset < 1)) {
                throw new Error("agent_discovery_invalid_read_offset");
            }
            return;
        }
        requireProductionPath(args?.path, repoRoot, `${tool}_path`, scopeProfile);
        return;
    }

    if (tool === "satori_read_file") {
        requireProductionPath(args?.path, repoRoot, "satori_read_path", scopeProfile);
        return;
    }

    requireRepoRoot(args?.path, repoRoot, `${tool}_root`);
    if (tool === "satori_file_outline") {
        requireProductionReference(args?.file, repoRoot, "outline_file", scopeProfile);
    }
    if (tool === "satori_call_graph") {
        requireProductionReference(args?.symbolRef?.file, repoRoot, "graph_symbol_file", scopeProfile);
    }
}

function trimToUtf8Bytes(value, byteLimit) {
    if (byteLength(value) <= byteLimit) return value;
    let end = Math.min(value.length, byteLimit);
    while (end > 0 && byteLength(value.slice(0, end)) > byteLimit) end -= 1;
    return value.slice(0, end);
}

export function normalizeToolOutput(rawOutput, tool, options = {}) {
    const scopeProfile = validateScopeProfile(options.scopeProfile);
    const withoutTests = scopeProfile === "production" && NATIVE_TOOLS.includes(tool)
        ? rawOutput
            .split("\n")
            .filter((line) => !/\.test\.ts(?::|\)|\]|\s|$)/.test(line))
            .join("\n")
        : rawOutput;
    if (byteLength(withoutTests) <= MAX_TOOL_RESULT_BYTES) {
        return { output: withoutTests, truncated: false };
    }

    const contentBudget = MAX_TOOL_RESULT_BYTES - byteLength(TRUNCATION_MARKER);
    let prefix = trimToUtf8Bytes(withoutTests, contentBudget);
    const lastNewline = prefix.lastIndexOf("\n");
    if (lastNewline >= 0) prefix = prefix.slice(0, lastNewline);
    return {
        output: `${prefix}${TRUNCATION_MARKER}`,
        truncated: true,
    };
}

function stableValue(value, seen = new WeakSet()) {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => stableValue(entry, seen));
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, stableValue(value[key], seen)]),
    );
}

function appendRecord(file, record) {
    if (!file) return;
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function toolJsonSchema(parameters, configDir) {
    try {
        const requireFromConfig = createRequire(path.join(configDir, "package.json"));
        const { Schema } = requireFromConfig("effect");
        const standard = Schema.toStandardJSONSchemaV1(parameters);
        return {
            format: "json-schema-draft-07",
            value: standard["~standard"].jsonSchema.input({ target: "draft-07" }),
        };
    } catch {
        return { format: "opencode-runtime-schema", value: stableValue(parameters) };
    }
}

export function createAgentDiscoveryGuard(environment = process.env) {
    const runId = environment.SATORI_AGENT_DISCOVERY_RUN_ID;
    if (!runId) return {};
    const repoRoot = canonicalPath(requireString(
        environment.SATORI_AGENT_DISCOVERY_REPO_ROOT,
        "repo_root",
    ));
    const ledgerFile = environment.SATORI_AGENT_DISCOVERY_TOOL_LEDGER;
    const definitionsFile = environment.SATORI_AGENT_DISCOVERY_TOOL_DEFINITIONS;
    const configDir = environment.OPENCODE_CONFIG_DIR ?? process.cwd();
    const scopeProfile = validateScopeProfile(
        environment.SATORI_AGENT_DISCOVERY_SCOPE_PROFILE ?? "production",
    );
    const defaultArm = environment.SATORI_AGENT_DISCOVERY_ARM
        ? (allowedToolsForArm(environment.SATORI_AGENT_DISCOVERY_ARM), environment.SATORI_AGENT_DISCOVERY_ARM)
        : undefined;
    const callCounts = new Map();
    const startedCalls = new Map();
    // OpenCode does not always attach the agent to tool calls; remember the
    // per-session agent seen in chat.params before falling back to the run arm.
    const sessionArms = new Map();

    return {
        "tool.definition": async (input, output) => {
            appendRecord(definitionsFile, {
                kind: "tool_definition",
                runId,
                tool: input.toolID,
                description: output.description,
                parameters: toolJsonSchema(output.parameters, configDir),
            });
        },
        "chat.params": async (input) => {
            const arm = resolveArmFromAgent(input.agent);
            if (arm && typeof input.sessionID === "string" && input.sessionID.length > 0) {
                sessionArms.set(input.sessionID, arm);
            }
        },
        "tool.execute.before": async (input, output) => {
            const count = (callCounts.get(input.sessionID) ?? 0) + 1;
            callCounts.set(input.sessionID, count);
            if (count > MAX_AGENT_DISCOVERY_TOOL_CALLS) {
                throw new Error("agent_discovery_tool_budget_exhausted");
            }
            const arm = resolveArmFromAgent(input.agent)
                ?? sessionArms.get(input.sessionID)
                ?? defaultArm;
            validateToolCall(input.tool, output.args, repoRoot, { scopeProfile, arm });
            startedCalls.set(input.callID, Date.now());
            appendRecord(ledgerFile, {
                kind: "tool_start",
                runId,
                sessionId: input.sessionID,
                callId: input.callID,
                tool: input.tool,
                startedAtMs: Date.now(),
                input: output.args,
            });
        },
        "tool.execute.after": async (input, output) => {
            if (typeof output.output !== "string") {
                appendRecord(ledgerFile, {
                    kind: "tool_end",
                    runId,
                    sessionId: input.sessionID,
                    callId: input.callID,
                    tool: input.tool,
                    startedAtMs: startedCalls.get(input.callID) ?? null,
                    endedAtMs: Date.now(),
                    rawBytes: null,
                    visibleBytes: null,
                    truncated: null,
                    outputUnavailableInHook: true,
                });
                startedCalls.delete(input.callID);
                return;
            }
            const rawOutput = output.output;
            const normalized = normalizeToolOutput(rawOutput, input.tool, { scopeProfile });
            output.output = normalized.output;
            output.metadata = {
                ...(output.metadata ?? {}),
                agentDiscovery: {
                    rawBytes: byteLength(rawOutput),
                    visibleBytes: byteLength(normalized.output),
                    truncated: normalized.truncated,
                },
            };
            appendRecord(ledgerFile, {
                kind: "tool_end",
                runId,
                sessionId: input.sessionID,
                callId: input.callID,
                tool: input.tool,
                startedAtMs: startedCalls.get(input.callID) ?? null,
                endedAtMs: Date.now(),
                rawBytes: byteLength(rawOutput),
                visibleBytes: byteLength(normalized.output),
                truncated: normalized.truncated,
                rawOutput,
            });
            startedCalls.delete(input.callID);
        },
    };
}

export default async function agentDiscoveryGuard() {
    return createAgentDiscoveryGuard(process.env);
}
