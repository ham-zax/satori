import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    buildSymbolRegistry,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
} from "@satori-code/core";
import type { CurrentSourceEvidence } from "./current-source-symbols.js";
import {
    SEARCH_RERANK_DOCUMENT_POLICY,
} from "./search-rerank-document.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import {
    createSearchRerankProjectionRequestCache,
    projectPublicationBoundSearchRerankDocument,
    searchRerankCandidateId,
    VerifiedRerankSourceCache,
} from "./search-rerank-projection.js";

const source = [
    "export function owner() {",
    "  const first = prepare();",
    "  return execute(first);",
    "}",
].join("\n");
const fileHash = crypto.createHash("sha256").update(source, "utf8").digest("hex");
const owner: SymbolRecord = {
    symbolKey: "typescript:src/owner.ts:owner",
    symbolInstanceId: "symbol-owner",
    language: "typescript",
    kind: "function",
    name: "owner",
    qualifiedName: "owner",
    label: "owner",
    file: "src/owner.ts",
    span: { startLine: 1, endLine: 4 },
    parentQualifiedNamePath: [],
    fileHash,
    extractorVersion: "test",
};

function registry() {
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: "/repo",
            rootFingerprint: "fingerprint",
            indexPolicyHash: "policy",
            languageRouterVersion: "test",
            extractorVersion: "test",
            relationshipVersion: "test",
            builtAt: "2026-08-04T00:00:00.000Z",
            files: [{
                path: owner.file,
                hash: fileHash,
                language: "typescript",
                symbolCount: 1,
                definitionStatus: "definitions_present",
            }],
        },
        symbols: [owner],
    });
}

const candidateId = searchRerankCandidateId({
    relativePath: owner.file,
    startLine: 1,
    endLine: 4,
});

test("publication-bound projection adds same-file textual references without published CALLS", async () => {
    const current = `${source}\nfunction useEffect() { return owner(); }`;
    const hash = crypto.createHash("sha256").update(current).digest("hex");
    const base = registry();
    const currentOwner = { ...owner, fileHash: hash };
    const caller = { ...currentOwner, name: "useEffect", qualifiedName: "useEffect", label: "function useEffect",
        symbolKey: "useEffect", symbolInstanceId: "effect", span: { startLine: 5, endLine: 5 } };
    const currentRegistry = buildSymbolRegistry({ manifest: { ...base.manifest,
        files: [{ ...base.manifest.files[0], hash, symbolCount: 2 }] }, symbols: [currentOwner, caller] });
    const outcome = await projectPublicationBoundSearchRerankDocument({
        candidateId, codebaseRoot: "/repo", semanticQuery: "useEffect owner", result: ownedResult(),
        registry: currentRegistry, relationships: [],
        readSourceEvidence: async () => evidence({ source: current, sourceBytes: Buffer.from(current), observedHash: hash }),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.ok(!outcome.document.includes("\ncallers: "));
    assert.match(outcome.document, /\nreferences:\nsrc\/owner\.ts:5 \(function useEffect\): function useEffect\(\) \{ return owner\(\); \}/);
});

function ownedResult(overrides: Partial<SearchResultLike> = {}): SearchResultLike {
    return {
        content: source,
        relativePath: owner.file,
        language: "typescript",
        score: 1,
        startLine: 1,
        endLine: 4,
        ownerSymbolInstanceId: owner.symbolInstanceId,
        ...overrides,
    };
}

function evidence(overrides: Partial<CurrentSourceEvidence> = {}): CurrentSourceEvidence {
    return {
        canonicalRoot: "/repo",
        relativeFile: owner.file,
        sourceBytes: Buffer.from(source),
        source,
        observedHash: fileHash,
        ...overrides,
    };
}

test("dirty overlay projection uses live bytes without publication hash or owner bounds", async () => {
    const current = `${source}\n// dirty overlay`;
    const sourceBytes = Buffer.from(current, "utf8");
    const dirtyOverlaySourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
    for (const relativePath of [owner.file, "src/dirty-new.ts"]) {
        const result = ownedResult({ relativePath, endLine: 5, dirtyOverlaySourceHash });
        const outcome = await projectPublicationBoundSearchRerankDocument({
            candidateId: searchRerankCandidateId(result),
            codebaseRoot: "/repo",
            semanticQuery: "owner",
            result,
            registry: registry(),
            readSourceEvidence: async (_root, relativeFile) => {
                assert.equal(relativeFile, relativePath);
                return evidence({ relativeFile, source: current, sourceBytes, observedHash: dirtyOverlaySourceHash });
            },
        });
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        if (outcome.ok) assert.match(outcome.document, /dirty overlay/);
    }
});

test("dirty overlay projection rejects source changed after the overlay read", async () => {
    const dirtyOverlaySourceHash = crypto.createHash("sha256").update(`${source}\n// dirty overlay`).digest("hex");
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "owner",
        result: ownedResult({ dirtyOverlaySourceHash }),
        registry: registry(),
        readSourceEvidence: async () => evidence(),
    }), { ok: false, candidateId, reason: "source_hash_mismatch" });
});

test("canonical projection admits ownerless candidates bound by the publication manifest", async () => {
    for (const result of [
        ownedResult({ ownerSymbolInstanceId: undefined }),
        ownedResult({ ownerSymbolInstanceId: "symbol-missing" }),
    ]) {
        const outcome = await projectPublicationBoundSearchRerankDocument({
            candidateId,
            codebaseRoot: "/repo",
            semanticQuery: "owner",
            result,
            registry: registry(),
            readSourceEvidence: async () => evidence(),
        });
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
    }
});

test("canonical projection reports owner_not_found without a registry owner or manifest file", async () => {
    const readSourceEvidence = async () => {
        throw new Error("must not read source without publication binding");
    };
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "owner",
        result: ownedResult({ relativePath: "src/other.ts" }),
        registry: registry(),
        readSourceEvidence,
    }), { ok: false, candidateId, reason: "owner_not_found" });
});

test("canonical projection reports candidate_span_invalid for a span outside its owner", async () => {
    const readSourceEvidence = async () => {
        throw new Error("must not read an invalid span");
    };
    for (const span of [
        { startLine: 1, endLine: 5 },
        { startLine: 0, endLine: 4 },
        { startLine: 3, endLine: 2 },
    ]) {
        assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
            candidateId,
            codebaseRoot: "/repo",
            semanticQuery: "owner",
            result: ownedResult(span),
            registry: registry(),
            readSourceEvidence,
        }), { ok: false, candidateId, reason: "candidate_span_invalid" });
    }
});

test("canonical projection reports source_unavailable when the evidence read fails", async () => {
    const base = {
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "owner",
        result: ownedResult(),
        registry: registry(),
    };
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        ...base,
        readSourceEvidence: async () => undefined,
    }), { ok: false, candidateId, reason: "source_unavailable" });
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        ...base,
        readSourceEvidence: async () => {
            throw new Error("read failed");
        },
    }), { ok: false, candidateId, reason: "source_unavailable" });
});

test("canonical projection reports source_hash_mismatch for stale or foreign evidence", async () => {
    const base = {
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "owner",
        result: ownedResult(),
        registry: registry(),
    };
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        ...base,
        readSourceEvidence: async () => evidence({ observedHash: "0".repeat(64) }),
    }), { ok: false, candidateId, reason: "source_hash_mismatch" });
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        ...base,
        readSourceEvidence: async () => evidence({ relativeFile: "src/other.ts" }),
    }), { ok: false, candidateId, reason: "source_hash_mismatch" });
});

test("canonical projection enforces the configured source limit on small-file evidence", async () => {
    assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "owner",
        result: ownedResult(),
        registry: registry(),
        maxSourceBytes: Buffer.byteLength(source, "utf8") - 1,
        readSourceEvidence: async () => evidence(),
    }), {
        ok: false,
        candidateId,
        reason: "source_exceeds_projection_limit",
    });
});

test("canonical projection reports projection_contract_failed when the contract throws", async () => {
    const outcome = await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "owner",
        result: ownedResult(),
        registry: registry(),
        readSourceEvidence: async () => evidence({ source: "short" }),
    });
    assert.deepEqual(outcome, {
        ok: false,
        candidateId,
        reason: "projection_contract_failed",
    });
});

test("canonical projection success carries bounded provenance fields", async () => {
    const outcome = await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "execute prepared request",
        result: ownedResult({ startLine: 2, endLine: 3 }),
        registry: registry(),
        readSourceEvidence: async () => evidence(),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.document, /execute/);
    assert.equal(outcome.utf8Bytes, Buffer.byteLength(outcome.document, "utf8"));
    assert.equal(
        outcome.sha256,
        crypto.createHash("sha256").update(outcome.document, "utf8").digest("hex"),
    );
    assert.equal(outcome.candidateRole, "implementation");
    assert.equal(outcome.projectionIdentity, SEARCH_RERANK_DOCUMENT_POLICY.id);
    assert.match(outcome.document, /\nrole: implementation \| /);
});

test("canonical projection keeps publication-bound source evidence when structural context is unavailable", async () => {
    const outcome = await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "execute prepared request",
        result: ownedResult({ startLine: 2, endLine: 3 }),
        registry: registry(),
        structuralContextStatus: "unavailable",
        readSourceEvidence: async () => evidence(),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.structuralContextStatus, "unavailable");
    assert.ok(!outcome.document.includes("\ncallers: "));
    assert.ok(!outcome.document.includes("\ncallees: "));
    assert.ok(!outcome.document.includes("\ntests: "));
});

test("canonical projection defaults missing structural preparation to unavailable", async () => {
    const outcome = await projectPublicationBoundSearchRerankDocument({
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "execute prepared request",
        result: ownedResult({ startLine: 2, endLine: 3 }),
        registry: registry(),
        readSourceEvidence: async () => evidence(),
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.structuralContextStatus, "unavailable");
});

test("canonical projection distinguishes explicit empty relationships from incompatible authority", async () => {
    const common = {
        candidateId,
        codebaseRoot: "/repo",
        semanticQuery: "execute prepared request",
        result: ownedResult({ startLine: 2, endLine: 3 }),
        registry: registry(),
        readSourceEvidence: async () => evidence(),
    };
    const available = await projectPublicationBoundSearchRerankDocument({
        ...common,
        relationships: [],
    });
    assert.equal(available.ok, true);
    if (available.ok) assert.equal(available.structuralContextStatus, "available");

    const incompatible = await projectPublicationBoundSearchRerankDocument({
        ...common,
        structuralContextStatus: "incompatible",
    });
    assert.equal(incompatible.ok, true);
    if (incompatible.ok) assert.equal(incompatible.structuralContextStatus, "incompatible");
});

function createLargeProjectionFixture(lineEnding: "\n" | "\r") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-large-rerank-projection-"));
    const relativeFile = "src/large-owner.ts";
    const absoluteFile = path.join(root, relativeFile);
    const prefixLines = Array.from({ length: 3_000 }, (_, index) => (
        `// padding ${String(index).padStart(4, "0")} ${"x".repeat(90)}`
    ));
    const ownerLines = [
        "export function largeOwner() {",
        "  return executeLargeOwner();",
        "}",
    ];
    const largeSource = [...prefixLines, ...ownerLines].join(lineEnding);
    const largeHash = crypto.createHash("sha256").update(largeSource, "utf8").digest("hex");
    const largeOwner: SymbolRecord = {
        symbolKey: `${relativeFile}:largeOwner`,
        symbolInstanceId: "large-owner-instance",
        language: "typescript",
        kind: "function",
        name: "largeOwner",
        qualifiedName: "largeOwner",
        label: "largeOwner",
        file: relativeFile,
        span: { startLine: 3_001, endLine: 3_003 },
        parentQualifiedNamePath: [],
        fileHash: largeHash,
        extractorVersion: "test",
    };

    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, largeSource, "utf8");
    assert.ok(fs.statSync(absoluteFile).size > 256 * 1024);
    const largeRegistry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root,
            rootFingerprint: "fingerprint",
            indexPolicyHash: "policy",
            languageRouterVersion: "test",
            extractorVersion: "test",
            relationshipVersion: "test",
            builtAt: "2026-08-10T00:00:00.000Z",
            files: [{
                path: relativeFile,
                hash: largeHash,
                language: "typescript",
                symbolCount: 1,
                definitionStatus: "definitions_present",
            }],
        },
        symbols: [largeOwner],
    });
    const largeResult: SearchResultLike = {
        content: ownerLines.join("\n"),
        relativePath: relativeFile,
        language: "typescript",
        score: 1,
        startLine: 3_001,
        endLine: 3_003,
        symbolKind: "function",
        symbolLabel: "largeOwner",
        ownerSymbolInstanceId: largeOwner.symbolInstanceId,
    };
    return {
        root,
        absoluteFile,
        common: {
            candidateId: searchRerankCandidateId(largeResult),
            codebaseRoot: root,
            semanticQuery: "execute large owner",
            result: largeResult,
            registry: largeRegistry,
        },
    };
}

test("canonical publication-bound projection retains large LF source through a bounded window", async () => {
    const { root, common } = createLargeProjectionFixture("\n");
    try {
        const outcome = await projectPublicationBoundSearchRerankDocument(common);
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        if (outcome.ok) assert.match(outcome.document, /executeLargeOwner/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("canonical publication-bound projection uses universal newlines and enforces streamed fallback limits", async () => {
    const { root, absoluteFile, common } = createLargeProjectionFixture("\r");
    try {
        const outcome = await projectPublicationBoundSearchRerankDocument(common);
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        if (outcome.ok) assert.match(outcome.document, /executeLargeOwner/);

        assert.deepEqual(await projectPublicationBoundSearchRerankDocument({
            ...common,
            maxSourceBytes: 256 * 1024,
        }), {
            ok: false,
            candidateId: common.candidateId,
            reason: "source_exceeds_projection_limit",
        });

        fs.appendFileSync(absoluteFile, "\r// changed after publication", "utf8");
        assert.deepEqual(await projectPublicationBoundSearchRerankDocument(common), {
            ok: false,
            candidateId: common.candidateId,
            reason: "source_hash_mismatch",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("rerank projection request cache coalesces duplicate reads and VerifiedRerankSourceCache stays bit-identical and invalidates on edits", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-rerank-cache-"));
    try {
        const relativeFile = "src/multi.ts";
        const absoluteFile = path.join(root, relativeFile);
        const content = [
            "export function alpha() {",
            "  return beta();",
            "}",
            "",
            "export function beta() {",
            "  return 42;",
            "}",
        ].join("\n");
        fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
        fs.writeFileSync(absoluteFile, content, "utf8");
        // Backdate mtime by 5 seconds so the racily-clean guard allows stat-witness hits.
        const past = new Date(Date.now() - 5_000);
        fs.utimesSync(absoluteFile, past, past);
        // Advance virtual clock beyond ctime + racily-clean window since utimes updates ctime.
        let nowMs = Date.now() + 5_000;
        const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

        const symAlpha: SymbolRecord = {
            symbolKey: `typescript:${relativeFile}:alpha`,
            symbolInstanceId: "sym-alpha",
            language: "typescript",
            kind: "function",
            name: "alpha",
            qualifiedName: "alpha",
            label: "function alpha",
            file: relativeFile,
            span: { startLine: 1, endLine: 3 },
            parentQualifiedNamePath: [],
            fileHash: hash,
            extractorVersion: "test",
        };
        const symBeta: SymbolRecord = {
            symbolKey: `typescript:${relativeFile}:beta`,
            symbolInstanceId: "sym-beta",
            language: "typescript",
            kind: "function",
            name: "beta",
            qualifiedName: "beta",
            label: "function beta",
            file: relativeFile,
            span: { startLine: 5, endLine: 7 },
            parentQualifiedNamePath: [],
            fileHash: hash,
            extractorVersion: "test",
        };
        const reg = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: root,
                rootFingerprint: "fp",
                indexPolicyHash: "policy",
                languageRouterVersion: "test",
                extractorVersion: "test",
                relationshipVersion: "test",
                builtAt: "2026-08-10T00:00:00.000Z",
                files: [{
                    path: relativeFile,
                    hash,
                    language: "typescript",
                    symbolCount: 2,
                    definitionStatus: "definitions_present",
                }],
            },
            symbols: [symAlpha, symBeta],
        });
        const resAlpha: SearchResultLike = {
            content,
            relativePath: relativeFile,
            language: "typescript",
            score: 1,
            startLine: 1,
            endLine: 3,
            symbolKind: "function",
            symbolLabel: "function alpha",
            ownerSymbolInstanceId: symAlpha.symbolInstanceId,
        };
        const resBeta: SearchResultLike = {
            content,
            relativePath: relativeFile,
            language: "typescript",
            score: 1,
            startLine: 5,
            endLine: 7,
            symbolKind: "function",
            symbolLabel: "function beta",
            ownerSymbolInstanceId: symBeta.symbolInstanceId,
        };

        // 1. Differential equivalence: uncached vs request-coalesced + cross-request cached.
        const uncachedAlpha = await projectPublicationBoundSearchRerankDocument({
            candidateId: searchRerankCandidateId(resAlpha),
            codebaseRoot: root,
            semanticQuery: "how does alpha call beta",
            result: resAlpha,
            registry: reg,
        });
        const uncachedBeta = await projectPublicationBoundSearchRerankDocument({
            candidateId: searchRerankCandidateId(resBeta),
            codebaseRoot: root,
            semanticQuery: "how does alpha call beta",
            result: resBeta,
            registry: reg,
        });

        const crossCache = new VerifiedRerankSourceCache(1024 * 1024, () => nowMs);
        const reqCache1 = createSearchRerankProjectionRequestCache(crossCache);
        const [cachedAlpha1, cachedBeta1] = await Promise.all([
            projectPublicationBoundSearchRerankDocument({
                candidateId: searchRerankCandidateId(resAlpha),
                codebaseRoot: root,
                semanticQuery: "how does alpha call beta",
                result: resAlpha,
                registry: reg,
                requestCache: reqCache1,
            }),
            projectPublicationBoundSearchRerankDocument({
                candidateId: searchRerankCandidateId(resBeta),
                codebaseRoot: root,
                semanticQuery: "how does alpha call beta",
                result: resBeta,
                registry: reg,
                requestCache: reqCache1,
            }),
        ]);
        assert.deepEqual(cachedAlpha1, uncachedAlpha);
        assert.deepEqual(cachedBeta1, uncachedBeta);
        assert.equal(crossCache.size, 1);

        // 2. Second request must hit VerifiedRerankSourceCache via stat witness without calling fallback reader.
        const canonicalRoot = fs.realpathSync(root);
        let fallbackCalls = 0;
        const secondRead = await crossCache.readVerifiedSource(
            canonicalRoot,
            root,
            relativeFile,
            async () => {
                fallbackCalls += 1;
                return undefined;
            },
        );
        assert.ok(secondRead);
        assert.equal(fallbackCalls, 0, "unchanged file past racily-clean window must skip full read and SHA-256");
        assert.equal(secondRead.evidence.observedHash, hash);

        // 3. Edit the file on disk (even keeping same byte length) -> witness must detect change and fail hash check.
        const edited = content.replace("42", "99");
        assert.equal(Buffer.byteLength(edited), Buffer.byteLength(content));
        fs.writeFileSync(absoluteFile, edited, "utf8");
        nowMs = Date.now() + 10_000;
        const reqCache2 = createSearchRerankProjectionRequestCache(crossCache);
        const afterEdit = await projectPublicationBoundSearchRerankDocument({
            candidateId: searchRerankCandidateId(resBeta),
            codebaseRoot: root,
            semanticQuery: "how does alpha call beta",
            result: resBeta,
            registry: reg,
            requestCache: reqCache2,
        });
        assert.deepEqual(afterEdit, {
            ok: false,
            candidateId: searchRerankCandidateId(resBeta),
            reason: "source_hash_mismatch",
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("canonical projection binds verified registry owner identity and recovers owner declaration for mid-function chunks", async () => {
    const multiLines = [
        "export async function undoAiBatch(batchId: string) {",
        "  const header = loadBatch(batchId);",
        "  const pre = (header.pre_state ?? {}) as CollectionPreState;",
        "  if (hasRevisionConflict(pre)) throw new ConflictError();",
        "  return rollbackBatch(batchId, pre);",
        "}",
    ];
    const multiSource = multiLines.join("\n");
    const multiHash = crypto.createHash("sha256").update(multiSource, "utf8").digest("hex");
    const ownerRecord: SymbolRecord = {
        symbolKey: "typescript:src/undo.ts:undoAiBatch",
        symbolInstanceId: "sym-undo-ai-batch",
        language: "typescript",
        kind: "function",
        name: "undoAiBatch",
        qualifiedName: "undoAiBatch",
        label: "function undoAiBatch",
        file: "src/undo.ts",
        span: { startLine: 1, endLine: 6 },
        parentQualifiedNamePath: [],
        fileHash: multiHash,
        extractorVersion: "test",
    };
    const reg = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: "/repo",
            rootFingerprint: "fp",
            indexPolicyHash: "policy",
            languageRouterVersion: "test",
            extractorVersion: "test",
            relationshipVersion: "test",
            builtAt: "2026-11-28T00:00:00.000Z",
            files: [{
                path: ownerRecord.file,
                hash: multiHash,
                language: "typescript",
                symbolCount: 1,
                definitionStatus: "definitions_present",
            }],
        },
        symbols: [ownerRecord],
    });
    // Chunk starts inside the body (line 3) and carries a mismatched stale chunk label/kind
    // (mirroring ts13/ts4/ts8). Projection must emit the verified owner identity + real declaration.
    const chunkResult: SearchResultLike = {
        content: multiLines.slice(2, 5).join("\n"),
        relativePath: ownerRecord.file,
        language: "typescript",
        score: 1,
        startLine: 3,
        endLine: 5,
        symbolKind: "method",
        symbolLabel: "function staleOuterFactory",
        ownerSymbolInstanceId: ownerRecord.symbolInstanceId,
    };
    const readEvidence = async () => evidence({
        relativeFile: ownerRecord.file,
        source: multiSource,
        sourceBytes: Buffer.from(multiSource, "utf8"),
        observedHash: multiHash,
    });

    const outcome = await projectPublicationBoundSearchRerankDocument({
        candidateId: searchRerankCandidateId(chunkResult),
        codebaseRoot: "/repo",
        semanticQuery: "check revision conflicts before rolling back AI mutation batch",
        result: chunkResult,
        registry: reg,
        readSourceEvidence: readEvidence,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.projectionIdentity, SEARCH_RERANK_DOCUMENT_POLICY.id);
    assert.match(outcome.document, /^path: src\/undo\.ts\nrole: implementation \| kind: function \| symbol: function undoAiBatch\ndeclaration: export async function undoAiBatch\(batchId: string\) \{\nsource:\n/);
});
