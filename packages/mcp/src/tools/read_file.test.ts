import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
    type SymbolRegistry,
} from "@satori-code/core";
import { readFileInputSchema, readFileTool } from "./read_file.js";
import type { ToolContext } from "./types.js";
import { createSessionWorkspacePolicy } from "../core/session-workspace-policy.js";
import {
    composeSymbolContext,
    type ComposeSymbolContextInput,
    type PreparedSymbolContextSnapshot,
} from "../core/symbol-context-composer.js";

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function buildRegistry(root: string, symbols: SymbolRecord[]): SymbolRegistry {
    const symbolsByInstanceId = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry]));
    const symbolsByKey = new Map<string, SymbolRecord[]>();
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const symbolsByLabel = new Map<string, SymbolRecord[]>();
    const symbolsByQualifiedName = new Map<string, SymbolRecord[]>();
    for (const entry of symbols) {
        for (const [map, key] of [
            [symbolsByKey, entry.symbolKey],
            [symbolsByFile, entry.file],
            [symbolsByLabel, entry.label],
            [symbolsByQualifiedName, entry.qualifiedName],
        ] as const) {
            map.set(key, [...(map.get(key) || []), entry]);
        }
    }
    return {
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root,
            rootFingerprint: "root-fp",
            indexPolicyHash: "policy-hash",
            languageRouterVersion: "router",
            extractorVersion: "extractor",
            relationshipVersion: "relationships",
            builtAt: "2026-11-24T00:00:00.000Z",
            files: [],
        },
        symbols,
        symbolsByInstanceId,
        symbolsByKey,
        symbolsByFile,
        symbolsByLabel,
        symbolsByQualifiedName,
        warnings: [],
    };
}

function createExactReadHarness(t: test.TestContext, fileContent: string) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-read-format-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const relFile = "src/service.ts";
    const absFile = path.join(root, relFile);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(absFile, fileContent, "utf8");

    const fileBytes = Buffer.from(fileContent, "utf8");
    const fileHash = sha256(fileBytes);
    const totalLines = fileContent.split(/\r?\n/).length;
    const symbolRecord: SymbolRecord = {
        symbolInstanceId: "sym_handle_batch",
        symbolKey: "key:handleBatch",
        name: "handleBatch",
        label: "export async function handleBatch(items: string[])",
        kind: "function",
        language: "typescript",
        qualifiedName: "handleBatch",
        file: relFile,
        span: { startLine: 1, endLine: totalLines },
        parentQualifiedNamePath: [],
        fileHash,
        extractorVersion: "typescript-extractor-fixture",
    };

    const snapshot: PreparedSymbolContextSnapshot = {
        canonicalRoot: root,
        registryManifestIdentity: "reg-manifest-1",
        registry: buildRegistry(root, [symbolRecord]),
        navigationAuthority: "remote_generation_proven",
        relationships: {
            status: "available",
            authority: "remote_generation_proven",
            manifestIdentity: "rel-manifest-1",
            callers: {
                edges: [{
                    srcSymbolId: "sym_route_post",
                    dstSymbolId: "sym_handle_batch",
                    kind: "call",
                    site: { file: "src/router.ts", startLine: 42 },
                    confidence: 0.95,
                }],
                availableCount: 1,
                suppressedCount: 0,
                suppressionNotes: [],
            },
            callees: {
                edges: [{
                    srcSymbolId: "sym_handle_batch",
                    dstSymbolId: "sym_commit_tx",
                    kind: "call",
                    site: { file: relFile, startLine: 3 },
                    confidence: 0.91,
                }],
                availableCount: 1,
                suppressedCount: 0,
                suppressionNotes: [],
            },
        },
        validateAuthority: async () => true,
    };

    const publication = { publication: { canonicalRoot: root } };
    const ctx = {
        readFileMaxLines: 200,
        workspacePolicy: createSessionWorkspacePolicy({
            roots: [root],
            homeDirectory: "/home/user",
            stateRoot: "/state",
        }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes: [[relFile, fileHash]] }),
            hasSearchableGeneration: () => true,
            getCurrentSearchGeneration: () => ({ generationId: "gen-1", compatibility: "compatible" }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
        toolHandlers: {
            composeSymbolContext: async (input: ComposeSymbolContextInput) => composeSymbolContext(input, {
                prepareSnapshot: async () => ({ status: "ready", snapshot }),
                prepareSource: async () => ({
                    status: "available",
                    evidence: {
                        canonicalRoot: root,
                        relativeFile: relFile,
                        sourceBytes: fileBytes,
                        source: fileContent,
                        sourceByteLength: fileBytes.length,
                        observedHash: fileHash,
                        identity: {
                            platform: "linux",
                            stableIdentity: "fixture-id",
                            canonicalRelativePath: relFile,
                            strength: "target_only",
                        },
                        selectionCapabilities: {
                            localLexical: "available",
                            lineWindows: "available",
                            syntaxBoundaries: "unavailable_streaming_source",
                            controlFlowAnchors: "unavailable_streaming_source",
                        },
                    },
                    finalizer: {
                        finalize: async () => ({
                            status: "available",
                            freshness: "current_at_final_observation",
                        }),
                        release: async () => undefined,
                    },
                }),
            }),
        },
    } as unknown as ToolContext;

    return { root, absFile, ctx };
}

test("readFileInputSchema accepts format json/text and rejects invalid format values", () => {
    assert.equal(readFileInputSchema.safeParse({ path: "/repo/a.ts" }).success, true);
    assert.equal(readFileInputSchema.safeParse({ path: "/repo/a.ts", format: "json" }).success, true);
    assert.equal(readFileInputSchema.safeParse({ path: "/repo/a.ts", format: "text" }).success, true);
    assert.equal(readFileInputSchema.safeParse({ path: "/repo/a.ts", format: "xml" }).success, false);
});

test("omitted format and format='json' preserve exact legacy JSON parity on open_symbol and range reads", async (t) => {
    const lines = [
        "export async function handleBatch(items: string[]) {",
        "  const normalized = items.map((item) => item.trim());",
        "  return commitTx(normalized);",
        "}",
        ...Array.from({ length: 45 }, (_, idx) => `const extra_${idx + 5} = ${idx + 5};`),
    ];
    const { root, absFile, ctx } = createExactReadHarness(t, `${lines.join("\n")}\n`);

    const exactBaseArgs = {
        path: absFile,
        codebaseRoot: root,
        mode: "plain" as const,
        open_symbol: {
            contractVersion: 2 as const,
            symbolId: "sym_handle_batch",
            context: { preset: "implementation" as const },
        },
    };
    const exactOmitted = await readFileTool.execute(exactBaseArgs, ctx);
    const exactExplicitJson = await readFileTool.execute({ ...exactBaseArgs, format: "json" }, ctx);
    assert.deepEqual(exactExplicitJson, exactOmitted);
    assert.equal(JSON.parse(exactOmitted.content[0].text).kind, "symbol_context");

    const rangeBaseArgs = {
        path: absFile,
        codebaseRoot: root,
        start_line: 1,
        end_line: 45,
    };
    const rangeOmitted = await readFileTool.execute(rangeBaseArgs, ctx);
    const rangeExplicitJson = await readFileTool.execute({ ...rangeBaseArgs, format: "json" }, ctx);
    assert.deepEqual(rangeExplicitJson, rangeOmitted);
    assert.equal("structuredContent" in rangeOmitted, false);
    assert.equal(rangeOmitted.content[0]?.text, lines.slice(0, 45).join("\n"));

    const rangeExplicitCompact = await readFileTool.execute({ ...rangeBaseArgs, presentation: "compact" }, ctx);
    assert.equal("structuredContent" in rangeExplicitCompact, false);
    const compactPayload = JSON.parse(rangeExplicitCompact.content[0]?.text ?? "{}");
    assert.equal(compactPayload.presentation, "compact");
    assert.equal(compactPayload.startLine, 1);
    assert.equal(compactPayload.endLine, 45);
    assert.equal(compactPayload.source, lines.slice(0, 45).join("\n"));

    const exactStringVersion = await readFileTool.execute({
        ...exactBaseArgs,
        open_symbol: {
            ...exactBaseArgs.open_symbol,
            contractVersion: "2",
        },
    }, ctx);
    assert.deepEqual(exactStringVersion, exactOmitted);
});

test("ordinary annotated text stays in annotated mode on continuation", async (t) => {
    const lines = Array.from({ length: 400 }, (_, index) => `const row_${index + 1} = ${index + 1};`);
    const { root, absFile, ctx } = createExactReadHarness(t, `${lines.join("\n")}\n`);
    const response = await readFileTool.execute({ path: absFile, codebaseRoot: root, mode: "annotated", format: "text" }, ctx);
    assert.equal(response.content.length, 1);
    assert.equal(response.structuredContent, undefined);
    const text = response.content[0].text;
    assert.match(text, /^# .*:1-\d+ \| codebaseRoot:/);
    assert.match(text, /^1\| const row_1 = 1;$/m);
    assert.match(text, /^Outline: /m);
    const nextArgs = JSON.parse(text.match(/call read_file with (\{[^\n]+\})\./)?.[1] ?? "null");
    assert.equal(nextArgs.mode, "annotated");
    assert.equal(nextArgs.format, "text");
    const next = await readFileTool.execute(nextArgs, ctx);
    assert.ok(next.content[0].text.includes(`${nextArgs.start_line}| ${lines[nextArgs.start_line - 1]}`));
});

test("format='text' on open_symbol returns a single text block without structuredContent and supports continuation round-trip", async (t) => {
    const body = Array.from(
        { length: 45 },
        (_, idx) => `  const step_${idx + 1} = "step-${idx + 1}-🚀";`,
    );
    const fileContent = [
        "export async function handleBatch(items: string[]) {",
        ...body,
        "  return items.length;",
        "}",
        "",
    ].join("\n");
    const { root, absFile, ctx } = createExactReadHarness(t, fileContent);

    const firstResponse = await readFileTool.execute({
        path: absFile,
        codebaseRoot: root,
        mode: "plain",
        format: "text",
        open_symbol: {
            contractVersion: 2,
            symbolId: "sym_handle_batch",
            context: {
                preset: "call_context",
                budgets: { totalResponseBytes: 1_300 },
            },
        },
    }, ctx);

    assert.notEqual(firstResponse.isError, true);
    assert.equal(firstResponse.content.length, 1);
    assert.equal(firstResponse.content[0]?.type, "text");
    assert.equal("structuredContent" in firstResponse, false);

    const text = firstResponse.content[0].text;
    assert.ok(Buffer.byteLength(text, "utf8") <= 1_300);
    assert.match(text, /^# src\/service\.ts:1-49 \| function export async function handleBatch\(items: string\[\]\)/);
    assert.match(text, /\n1\| export async function handleBatch\(items: string\[\]\) \{\n/);
    assert.match(text, /\.\.\. omitted lines (\d+)-(\d+) \.\.\./);
    assert.match(text, /Callers \(1\/1\):\n- sym_route_post @ src\/router\.ts:42/);

    const omittedMatch = text.match(/\.\.\. omitted lines (\d+)-(\d+) \.\.\./);
    assert.ok(omittedMatch);
    const omittedStart = Number(omittedMatch[1]);

    const jsonMatch = text.match(/```json\n([^\n]+)\n```/);
    assert.ok(jsonMatch, "Expected copyable JSON continuation block");
    const continuationArgs = JSON.parse(jsonMatch[1]!);
    assert.equal(continuationArgs.codebaseRoot, root);
    assert.equal(continuationArgs.format, "text");

    const continuedResponse = await readFileTool.execute(continuationArgs, ctx);
    assert.notEqual(continuedResponse.isError, true);
    assert.equal(continuedResponse.content.length, 1);
    assert.equal("structuredContent" in continuedResponse, false);
    const continuedText = continuedResponse.content[0].text;
    assert.match(continuedText, new RegExp(`\\n${omittedStart}\\| `));
});

test("format='text' on ordinary >40-line ranges emits clean line-numbered raw text without structuredContent", async (t) => {
    const lines = Array.from(
        { length: 55 },
        (_, idx) => `export const line_${idx + 1} = "value_${idx + 1}";`,
    );
    const { root, absFile, ctx } = createExactReadHarness(t, `${lines.join("\n")}\n`);

    const response = await readFileTool.execute({
        path: absFile,
        codebaseRoot: root,
        start_line: 1,
        end_line: 55,
        format: "text",
    }, ctx);

    assert.notEqual(response.isError, true);
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0]?.type, "text");
    assert.equal("structuredContent" in response, false);

    const text = response.content[0].text;
    assert.match(text, new RegExp(`^# ${absFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1-55 \\| codebaseRoot: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(text, /\n1\| export const line_1 = "value_1";\n/);
    assert.match(text, /\n55\| export const line_55 = "value_55";$/);
    assert.equal(text.includes("\"presentation\":\"compact\""), false);
});

test("annotated read_file checks .cls content so ObjectScript UDL and VB6 return unsupported while Apex invokes handleFileOutline", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-read-cls-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const files: Record<string, string> = {
        "src/Widget.cls": "Class Demo.Widget Extends %RegisteredObject {\n  Method Run() As %Status {\n    Quit $$$OK\n  }\n}\n",
        "src/Customer.cls": "VERSION 1.0 CLASS\nBEGIN\n  MultiUse = -1\nEND\nAttribute VB_Name = \"Customer\"\n",
        "src/AccountService.cls": "public with sharing class AccountService {\n    public static void run() {}\n}\n",
    };

    const fileHashes: Array<[string, string]> = [];
    for (const [relPath, body] of Object.entries(files)) {
        const absPath = path.join(root, relPath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, body, "utf8");
        fileHashes.push([relPath, sha256(Buffer.from(body, "utf8"))]);
    }

    const outlineCalls: string[] = [];
    const publication = { publication: { canonicalRoot: root } };
    const ctx = {
        readFileMaxLines: 200,
        workspacePolicy: createSessionWorkspacePolicy({
            roots: [root],
            homeDirectory: "/home/user",
            stateRoot: "/state",
        }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes }),
            hasSearchableGeneration: () => true,
            getCurrentSearchGeneration: () => ({ generationId: "gen-1", compatibility: "compatible" }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
        toolHandlers: {
            handleFileOutline: async (input: { file: string }) => {
                outlineCalls.push(input.file);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "ok",
                            outline: { language: "apex", symbols: [] },
                            hasMore: false,
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    const udlResponse = await readFileTool.execute({
        path: path.join(root, "src/Widget.cls"),
        codebaseRoot: root,
        mode: "annotated",
    }, ctx);
    assert.equal(JSON.parse(udlResponse.content[0].text).outlineStatus, "unsupported");
    assert.deepEqual(outlineCalls, []);

    const vb6Response = await readFileTool.execute({
        path: path.join(root, "src/Customer.cls"),
        codebaseRoot: root,
        mode: "annotated",
    }, ctx);
    assert.equal(JSON.parse(vb6Response.content[0].text).outlineStatus, "unsupported");
    assert.deepEqual(outlineCalls, []);

    const apexResponse = await readFileTool.execute({
        path: path.join(root, "src/AccountService.cls"),
        codebaseRoot: root,
        mode: "annotated",
    }, ctx);
    assert.equal(JSON.parse(apexResponse.content[0].text).outlineStatus, "ok");
    assert.deepEqual(outlineCalls, ["src/AccountService.cls"]);
});

test("live read_file admission rejects dirty VB6 .cls while admitting dirty Apex and ObjectScript UDL .cls", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-read-live-cls-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const trackedBody = "export const ok = true;\n";
    fs.writeFileSync(path.join(root, "src/index.ts"), trackedBody, "utf8");
    execFileSync("git", ["add", "src/index.ts"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

    // Dirty untracked .cls files (absent from published fileHashes manifest)
    fs.writeFileSync(path.join(root, "src/Customer.cls"), "VERSION 1.0 CLASS\nBEGIN\n  MultiUse = -1\nEND\nAttribute VB_Name = \"Customer\"\n", "utf8");
    fs.writeFileSync(path.join(root, "src/Widget.cls"), "Class Demo.Widget Extends %RegisteredObject {\n  Method Run() As %Status {\n    Quit $$$OK\n  }\n}\n", "utf8");
    fs.writeFileSync(path.join(root, "src/AccountService.cls"), "public with sharing class AccountService {\n    public static void run() {}\n}\n", "utf8");

    const publication = { publication: { canonicalRoot: root } };
    const ctx = {
        readFileMaxLines: 200,
        workspacePolicy: createSessionWorkspacePolicy({
            roots: [root],
            homeDirectory: "/home/user",
            stateRoot: "/state",
        }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({
                fileHashes: [["src/index.ts", sha256(Buffer.from(trackedBody, "utf8"))]],
            }),
            hasSearchableGeneration: () => true,
            getCurrentSearchGeneration: () => ({ generationId: "gen-1", compatibility: "compatible" }),
            getActiveIgnorePatterns: () => ["node_modules/**"],
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
    } as unknown as ToolContext;

    const vb6Res = await readFileTool.execute({ path: path.join(root, "src/Customer.cls"), codebaseRoot: root }, ctx);
    assert.equal(vb6Res.isError, true, "dirty VB6 .cls must be rejected by live read admission");

    const udlRes = await readFileTool.execute({ path: path.join(root, "src/Widget.cls"), codebaseRoot: root }, ctx);
    assert.notEqual(udlRes.isError, true, "dirty ObjectScript UDL .cls must be admitted");
    assert.match(udlRes.content[0].text, /Class Demo\.Widget/);

    const apexRes = await readFileTool.execute({ path: path.join(root, "src/AccountService.cls"), codebaseRoot: root }, ctx);
    assert.notEqual(apexRes.isError, true, "dirty Apex .cls must be admitted");
    assert.match(apexRes.content[0].text, /class AccountService/);
});
