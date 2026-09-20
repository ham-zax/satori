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
} from "@zokizuan/satori-core";
import type { CurrentSourceEvidence } from "./current-source-symbols.js";
import { SEARCH_RERANK_DOCUMENT_POLICY } from "./search-rerank-document.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import {
    projectPublicationBoundSearchRerankDocument,
    searchRerankCandidateId,
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
    assert.equal(
        (JSON.parse(outcome.document) as Record<string, unknown>).candidate_role,
        "implementation",
    );
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
    assert.deepEqual(
        (JSON.parse(outcome.document) as { structural_context: unknown }).structural_context,
        { direct_callers: [], direct_callees: [], supporting_tests: [] },
    );
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
