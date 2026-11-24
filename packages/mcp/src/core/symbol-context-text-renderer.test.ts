import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test from "node:test";
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
    type SymbolRegistry,
} from "@satori-code/core";
import {
    composeSymbolContext,
    type ComposedSymbolContext,
    type ComposeSymbolContextInput,
    type SymbolContextComposerDependencies,
} from "./symbol-context-composer.js";
import {
    composePublicSymbolContextEnvelope,
    exactSymbolOpenRequestSchema,
    resolveSymbolContextOperation,
} from "./symbol-context-public-contract.js";
import {
    renderOrdinaryRangeText,
    renderSymbolContextText,
} from "./symbol-context-text-renderer.js";
import { readFileInputSchema } from "../tools/read_file.js";

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeSymbol(
    input: Partial<SymbolRecord> & Pick<SymbolRecord, "symbolInstanceId" | "name" | "label" | "span">,
): SymbolRecord {
    return {
        symbolKey: `key:${input.name}`,
        language: "typescript",
        kind: "function",
        qualifiedName: input.name,
        file: "src/worker.ts",
        parentQualifiedNamePath: [],
        fileHash: "0".repeat(64),
        extractorVersion: "typescript-extractor-fixture",
        ...input,
    };
}

function makeRegistry(symbols: SymbolRecord[]): SymbolRegistry {
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
            normalizedRootPath: "/repo",
            rootFingerprint: "root",
            indexPolicyHash: "policy",
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

function makeComposerDeps(source: string, symbols: SymbolRecord[]): SymbolContextComposerDependencies {
    const sourceBytes = Buffer.from(source, "utf8");
    return {
        prepareSnapshot: async () => ({
            status: "ready",
            snapshot: {
                canonicalRoot: "/repo",
                registryManifestIdentity: "registry-manifest",
                registry: makeRegistry(symbols),
                navigationAuthority: "remote_generation_proven",
                relationships: {
                    status: "available",
                    authority: "remote_generation_proven",
                    manifestIdentity: "relationship-manifest",
                    callers: {
                        edges: [{
                            srcSymbolId: "sym_caller_1",
                            dstSymbolId: "sym_target",
                            kind: "call",
                            site: { file: "src/entry.ts", startLine: 18 },
                            confidence: 0.96,
                        }],
                        availableCount: 3,
                        suppressedCount: 1,
                        suppressionNotes: [],
                    },
                    callees: {
                        edges: [{
                            srcSymbolId: "sym_target",
                            dstSymbolId: "sym_callee_1",
                            kind: "call",
                            site: { file: "src/worker.ts", startLine: 229 },
                            confidence: 0.92,
                        }],
                        availableCount: 1,
                        suppressedCount: 0,
                        suppressionNotes: [],
                    },
                },
                validateAuthority: async () => true,
            },
        }),
        prepareSource: async () => ({
            status: "available",
            evidence: {
                canonicalRoot: "/repo",
                relativeFile: "src/worker.ts",
                sourceBytes,
                source,
                sourceByteLength: sourceBytes.length,
                observedHash: sha256(sourceBytes),
                identity: {
                    platform: "linux",
                    stableIdentity: "fixture-identity",
                    canonicalRelativePath: "src/worker.ts",
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
    };
}

test("renderSymbolContextText formats metadata, CRLF-normalized line numbers, gap markers, relationships, and copyable continuations", () => {
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: { preset: "call_context" },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", format: "text", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;

    const context: ComposedSymbolContext = {
        status: "ok",
        symbol: {
            symbolId: "sym_target",
            symbolKey: "key:runTask",
            name: "runTask",
            qualifiedName: "Worker.runTask",
            symbolLabel: "method runTask(task: Task)",
            kind: "method",
            language: "typescript",
            file: "src/worker.ts",
            span: { startLine: 227, endLine: 245 },
            parentQualifiedNamePath: ["Worker"],
            parentResolution: "resolved",
            parentSymbolId: "sym_worker",
        },
        outline: {
            siblings: {
                items: [{
                    symbolId: "sym_sibling",
                    symbolKey: "key:stopTask",
                    name: "stopTask",
                    qualifiedName: "Worker.stopTask",
                    symbolLabel: "method stopTask()",
                    kind: "method",
                    language: "typescript",
                    file: "src/worker.ts",
                    span: { startLine: 247, endLine: 255 },
                    parentQualifiedNamePath: ["Worker"],
                    parentResolution: "resolved",
                    parentSymbolId: "sym_worker",
                }],
                returnedCount: 1,
                availableCount: 2,
                truncated: true,
            },
        },
        source: {
            selectionPolicyVersion: "bounded_source_selection_v3",
            mode: "bounded",
            status: "available",
            span: { startLine: 227, endLine: 245, startByte: 0, endByte: 200 },
            completeSymbolReturned: false,
            totalLines: 19,
            totalBytes: 200,
            returnedLines: 3,
            returnedBytes: 60,
            excerptCount: 2,
            excerpts: [
                {
                    startLine: 227,
                    endLine: 228,
                    startByte: 0,
                    endByte: 40,
                    reason: "declaration",
                    selectionBases: ["declaration"],
                    content: "  async runTask(task: Task) {\r\n    const label = \"你好 🚀\";\r\n",
                },
                {
                    startLine: 245,
                    endLine: 245,
                    startByte: 180,
                    endByte: 200,
                    reason: "terminal",
                    selectionBases: ["terminal"],
                    content: "  }",
                },
            ],
            omittedRanges: [
                { startLine: 229, endLine: 244, startByte: 40, endByte: 180 },
            ],
            truncated: true,
            selectionCapabilities: {
                localLexical: "available",
                lineWindows: "available",
                syntaxBoundaries: "unavailable_streaming_source",
                controlFlowAnchors: "unavailable_streaming_source",
            },
            limitations: [],
        },
        relationships: {
            callers: {
                status: "ok",
                projectionPolicyVersion: "relationship_evidence_v1",
                confidencePolicyVersion: "call_graph_score_bands_v1",
                completeness: "bounded_static",
                relationship: "caller",
                items: [{
                    symbolId: "sym_caller_1",
                    relationship: "caller",
                    source: "relationship_graph",
                    confidenceClass: "high",
                    confidenceBasis: "stored_static_relationship",
                    calibrated: false,
                    sites: {
                        status: "current_source_validated",
                        items: [{ file: "src/entry.ts", startLine: 18 }],
                    },
                }],
                returnedCount: 1,
                availableCount: 3,
                truncated: true,
                terminal: false,
                suppressedCount: 1,
                suppressionNotes: [],
                limitations: ["low_confidence_relationships_suppressed"],
            },
            callees: {
                status: "unavailable",
                projectionPolicyVersion: "relationship_evidence_v1",
                confidencePolicyVersion: "call_graph_score_bands_v1",
                relationship: "callee",
                reason: "relationship_index_missing",
                items: [],
                returnedCount: 0,
                truncated: false,
                suppressedCount: 0,
                suppressionNotes: [],
                limitations: [],
            },
        },
        authority: {
            vector: "not_required",
            navigation: "remote_generation_proven",
            source: {
                freshness: "current_at_final_observation",
                spanResolution: "index_snapshot_matched",
            },
            relationships: "remote_generation_proven",
        },
        continuations: [
            {
                kind: "source_range",
                domains: ["symbol", "source"],
                fingerprint: "sha256_source_fp",
                startLine: 229,
                endLine: 244,
            },
            {
                kind: "caller_page",
                domains: ["symbol", "relationships"],
                fingerprint: "sha256_caller_fp",
                cursor: "cursor_page_2",
                pageSize: 20,
                terminal: false,
            },
        ],
        limitations: ["dynamic_relationships_unknown"],
    };

    const envelope = composePublicSymbolContextEnvelope({
        effectiveRequest: resolved.effectiveRequest,
        context,
    });
    const rendered = renderSymbolContextText({ codebaseRoot: "/repo", envelope });

    assert.equal(rendered.includes("\r"), false, "CRLF must be normalized without stray \\r");
    assert.ok("selectionPolicyVersion" in envelope.source);
    const bareCr = renderSymbolContextText({ codebaseRoot: "/repo", envelope: {
        ...envelope,
        source: { ...envelope.source, excerpts: envelope.source.excerpts.map((excerpt) => ({
            ...excerpt, content: excerpt.content.replaceAll("\r\n", "\r"),
        })) },
    } });
    assert.equal(bareCr, rendered);
    assert.match(rendered, /^# src\/worker\.ts:227-245 \| method runTask\(task: Task\)/);
    assert.match(rendered, /\nsymbolId: sym_target\n/);
    assert.match(rendered, /\ncodebaseRoot: \/repo\n/);
    assert.match(rendered, /\n227\| {3}async runTask\(task: Task\) \{\n228\| {5}const label = "你好 🚀";\n\.\.\. omitted lines 229-244 \.\.\.\n245\| {3}\}\n/);
    assert.match(rendered, /Callers \(1\/3, truncated, suppressed=1\):\n- sym_caller_1 @ src\/entry\.ts:18 \[high, relationship_graph, current_source_validated\]/);
    assert.match(rendered, /Callees: unavailable \(relationship_index_missing\)/);
    assert.match(rendered, /Siblings \(1\/2, truncated\):\n- method stopTask\(\) \(src\/worker\.ts:247-255\) \[sym_sibling\]/);

    const jsonBlocks = Array.from(rendered.matchAll(/```json\n([^\n]+)\n```/g), (match) => JSON.parse(match[1]!));
    assert.equal(jsonBlocks.length, 2);
    for (const block of jsonBlocks) {
        const parsedArgs = readFileInputSchema.parse(block);
        assert.equal(parsedArgs.path, "/repo/src/worker.ts");
        assert.equal(parsedArgs.codebaseRoot, "/repo");
        assert.equal(parsedArgs.format, "text");
    }
    assert.deepEqual(jsonBlocks[0].open_symbol, {
        contractVersion: 2,
        symbolId: "sym_target",
        continuation: {
            kind: "source_range",
            fingerprint: "sha256_source_fp",
            startLine: 229,
            endLine: 244,
        },
    });
});

test("renderSymbolContextText renders stale and unavailable source states cleanly", () => {
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: { preset: "definition" },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", format: "text", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;

    const envelope = composePublicSymbolContextEnvelope({
        effectiveRequest: resolved.effectiveRequest,
        context: {
            status: "ok",
            symbol: {
                symbolId: "sym_target",
                symbolKey: "key:fn",
                name: "fn",
                qualifiedName: "fn",
                symbolLabel: "function fn()",
                kind: "function",
                language: "typescript",
                file: "src/worker.ts",
                span: { startLine: 1, endLine: 10 },
                parentQualifiedNamePath: [],
                parentResolution: "not_applicable",
            },
            outline: { siblings: { items: [], returnedCount: 0, availableCount: 0, truncated: false } },
            source: {
                mode: "bounded",
                status: "stale",
                completeSymbolReturned: false,
                excerpts: [],
                omittedRanges: [],
                truncated: true,
                emptyReason: "source_changed_during_inspection",
            },
            relationships: {
                callers: { status: "not_requested", relationship: "caller" },
                callees: { status: "not_requested", relationship: "callee" },
            },
            authority: {
                vector: "not_required",
                navigation: "remote_generation_proven",
                source: { freshness: "stale", spanResolution: "unavailable" },
                relationships: "not_requested",
            },
            continuations: [],
            limitations: [],
        },
    });

    const rendered = renderSymbolContextText({ codebaseRoot: "/repo", envelope });
    assert.match(rendered, /limitations: source:stale:source_changed_during_inspection/);
    assert.match(rendered, /Source: stale \(source_changed_during_inspection\)/);
});

test("renderOrdinaryRangeText handles empty files, CRLF lines, and continuation hints", () => {
    assert.equal(
        renderOrdinaryRangeText({
            absolutePath: "/repo/empty.ts",
            codebaseRoot: "/repo",
            startLine: 1,
            endLine: 0,
            lines: [],
        }),
        "# /repo/empty.ts (empty file) | codebaseRoot: /repo",
    );

    const rendered = renderOrdinaryRangeText({
        absolutePath: "/repo/sample.ts",
        codebaseRoot: "/repo",
        startLine: 10,
        endLine: 11,
        lines: ["const a = 1;\r", "const b = \"🚀\";"],
        nextStartLine: 12,
    });
    assert.equal(rendered.includes("\r"), false);
    assert.equal(
        rendered,
        [
            "# /repo/sample.ts:10-11 | codebaseRoot: /repo",
            "10| const a = 1;",
            "11| const b = \"🚀\";",
            "",
            "(File truncated at line 11. To read more, call read_file with {\"path\":\"/repo/sample.ts\",\"codebaseRoot\":\"/repo\",\"start_line\":12,\"format\":\"text\"}.)",
        ].join("\n"),
    );
});

test("composer-aware text budgeting strictly bounds rendered UTF-8 bytes and preserves source_range continuation", async () => {
    const bodyLines = Array.from(
        { length: 40 },
        (_, index) => `  const item_${index + 1} = "こんにちは世界-🚀-${index + 1}";`,
    );
    const source = [
        "export function processUnicodeBatch() {",
        ...bodyLines,
        "  return true;",
        "}",
    ].join("\n");
    const sourceHash = sha256(Buffer.from(source, "utf8"));
    const target = makeSymbol({
        symbolInstanceId: "sym_target",
        name: "processUnicodeBatch",
        label: "function processUnicodeBatch()",
        span: { startLine: 1, endLine: 43 },
        fileHash: sourceHash,
    });

    const hardLimit = 1_150;
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: {
            preset: "implementation",
            budgets: { totalResponseBytes: hardLimit },
        },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", format: "text", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;

    const composerInput: ComposeSymbolContextInput = {
        codebaseRoot: "/repo",
        relativeFile: "src/worker.ts",
        symbolId: "sym_target",
        include: resolved.include,
        budgets: resolved.budgets,
        measureResponseBytes: (context) => Buffer.byteLength(
            renderSymbolContextText({
                codebaseRoot: "/repo",
                envelope: composePublicSymbolContextEnvelope({
                    effectiveRequest: resolved.effectiveRequest,
                    context,
                }),
            }),
            "utf8",
        ),
    };

    const result = await composeSymbolContext(composerInput, makeComposerDeps(source, [target]));
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    const rendered = renderSymbolContextText({
        codebaseRoot: "/repo",
        envelope: composePublicSymbolContextEnvelope({
            effectiveRequest: resolved.effectiveRequest,
            context: result.context,
        }),
    });
    const renderedBytes = Buffer.byteLength(rendered, "utf8");
    assert.ok(renderedBytes <= hardLimit, `Expected ${renderedBytes} <= ${hardLimit}`);
    assert.match(rendered, /\.\.\. omitted lines \d+-\d+ \.\.\./);
    assert.ok(result.context.continuations.some((entry) => entry.kind === "source_range"));

    const split = await composeSymbolContext({
        ...composerInput,
        query: "item_20",
        budgets: {
            ...composerInput.budgets,
            maxSerializedResponseBytes: 8192,
            source: {
                ...composerInput.budgets.source,
                maxSourceLines: 3, maxExcerptLines: 1, maxExcerpts: 3, contextLines: 0,
                maxSerializedSourceBytes: 8192,
            },
        },
    }, makeComposerDeps(source, [target]));
    assert.equal(split.status, "ok");
    assert.ok("selectionPolicyVersion" in split.context.source);
    assert.ok(split.context.source.omittedRanges.length > 1, JSON.stringify(split.context.source.excerpts));
    assert.deepEqual(
        split.context.continuations.flatMap((entry) => entry.kind === "source_range"
            ? [{ startLine: entry.startLine, endLine: entry.endLine }]
            : []),
        split.context.source.omittedRanges.map(({ startLine, endLine }) => ({ startLine, endLine })),
    );
});

test("text budgeting tries the minimum when continuation overhead consumes the candidate's serialized source budget", async () => {
    const source = ["function runBatch() {",
        ...Array.from({ length: 40 }, (_, index) => `  const row_${index} = ${index};`),
        "  return row_20;", "}",
    ].join("\n");
    const target = makeSymbol({
        symbolInstanceId: "sym_target", name: "runBatch", label: "function runBatch()",
        span: { startLine: 1, endLine: 43 }, fileHash: sha256(Buffer.from(source, "utf8")),
    });
    const hardLimit = 3_700;
    const operation = resolveSymbolContextOperation({ mode: "plain", format: "text", request: exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: target.symbolInstanceId,
        context: { preset: "implementation", query: "row_20", budgets: { totalResponseBytes: hardLimit } },
    }) });
    assert.equal(operation.kind, "context");
    const codebaseRoot = `/repo${"/nested-workspace".repeat(51)}`;
    const measureResponseBytes = (context: ComposedSymbolContext) => Buffer.byteLength(renderSymbolContextText({
        codebaseRoot,
        envelope: composePublicSymbolContextEnvelope({ context, effectiveRequest: operation.effectiveRequest }),
    }), "utf8");
    const result = await composeSymbolContext({
        codebaseRoot: "/repo", relativeFile: target.file, symbolId: target.symbolInstanceId,
        include: operation.include, query: operation.query, measureResponseBytes,
        budgets: { ...operation.budgets, source: {
            ...operation.budgets.source,
            maxSourceLines: 3, maxExcerptLines: 1, maxExcerpts: 3, contextLines: 0,
        } },
    }, makeComposerDeps(source, [target]));
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.ok(measureResponseBytes(result.context) <= hardLimit);
    assert.ok(result.context.continuations.some((entry) => entry.kind === "source_range"));
});

test("composer-aware text budgeting fails cleanly with resource_limit when a single multi-byte line exceeds hardLimit", async () => {
    const hugeMultibyteLine = `export const banner = "${"🚀日本語".repeat(250)}";`;
    const sourceHash = sha256(Buffer.from(hugeMultibyteLine, "utf8"));
    const target = makeSymbol({
        symbolInstanceId: "sym_target",
        name: "banner",
        label: "const banner",
        kind: "config",
        span: { startLine: 1, endLine: 1 },
        fileHash: sourceHash,
    });

    const hardLimit = 1_024;
    const request = exactSymbolOpenRequestSchema.parse({
        contractVersion: 2,
        symbolId: "sym_target",
        context: {
            preset: "definition",
            budgets: { totalResponseBytes: hardLimit },
        },
    });
    const resolved = resolveSymbolContextOperation({ mode: "plain", format: "text", request });
    assert.equal(resolved.kind, "context");
    if (resolved.kind !== "context") return;

    const result = await composeSymbolContext(
        {
            codebaseRoot: "/repo",
            relativeFile: "src/worker.ts",
            symbolId: "sym_target",
            include: resolved.include,
            budgets: resolved.budgets,
            measureResponseBytes: (context) => Buffer.byteLength(
                renderSymbolContextText({
                    codebaseRoot: "/repo",
                    envelope: composePublicSymbolContextEnvelope({
                        effectiveRequest: resolved.effectiveRequest,
                        context,
                    }),
                }),
                "utf8",
            ),
        },
        makeComposerDeps(hugeMultibyteLine, [target]),
    );

    assert.equal(result.status, "resource_limit");
    if (result.status !== "resource_limit") return;
    assert.equal(result.symbolId, "sym_target");
    assert.equal(result.hardResponseLimitBytes, hardLimit);
    assert.ok(result.minimumRequiredResponseBytes > hardLimit);
});
