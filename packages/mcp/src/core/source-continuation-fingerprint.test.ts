import test from "node:test";
import assert from "node:assert/strict";
import {
    buildSourceContinuationFingerprint,
    type CurrentSymbolValidatedContinuationIdentity,
    type IndexSnapshotMatchedContinuationIdentity,
} from "./source-continuation-fingerprint.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function snapshotIdentity(): IndexSnapshotMatchedContinuationIdentity {
    return {
        canonicalRoot: "/repo",
        selectionPolicyVersion: "bounded_source_selection_v1",
        spanResolution: "index_snapshot_matched",
        registryManifestIdentity: "symmanifest_v1",
        indexedSourceIdentity: hashA,
        symbolInstanceId: "syminst_run",
        indexedSpan: { startLine: 10, endLine: 20, startByte: 100, endByte: 300 },
    };
}

function currentIdentity(): CurrentSymbolValidatedContinuationIdentity {
    return {
        canonicalRoot: "/repo",
        selectionPolicyVersion: "bounded_source_selection_v1",
        spanResolution: "current_symbol_validated",
        currentSourceHash: hashA,
        currentSpanIdentity: {
            kind: "resolved_symbol_instance",
            symbolInstanceId: "syminst_run",
        },
        resolvedSpan: { startLine: 11, endLine: 22, startByte: 120, endByte: 340 },
        spanResolutionPolicyVersion: "span_resolution_v1",
        extractorLanguageImplementationVersion: "typescript_analyzer_v3",
        resolutionDerivation: "exact_registry_rebuild_match",
    };
}

test("snapshot-matched source continuation is deterministic and domain scoped", () => {
    const first = buildSourceContinuationFingerprint(snapshotIdentity());
    const second = buildSourceContinuationFingerprint(snapshotIdentity());
    assert.deepEqual(first, second);
    assert.deepEqual(first.domains, ["symbol", "source"]);
    assert.match(first.fingerprint, /^sha256_source_[a-f0-9]{64}$/);
});

test("snapshot continuation changes with manifest, source, span, or selection policy", () => {
    const baseline = buildSourceContinuationFingerprint(snapshotIdentity()).fingerprint;
    const variants: IndexSnapshotMatchedContinuationIdentity[] = [{
        ...snapshotIdentity(),
        registryManifestIdentity: "symmanifest_v2",
    }, {
        ...snapshotIdentity(),
        indexedSourceIdentity: hashB,
    }, {
        ...snapshotIdentity(),
        indexedSpan: { ...snapshotIdentity().indexedSpan, endLine: 21 },
    }, {
        ...snapshotIdentity(),
        selectionPolicyVersion: "bounded_source_selection_v2",
    }];
    for (const variant of variants) {
        assert.notEqual(buildSourceContinuationFingerprint(variant).fingerprint, baseline);
    }
});

test("current continuation binds observed bytes and every structural derivation input", () => {
    const baseline = buildSourceContinuationFingerprint(currentIdentity()).fingerprint;
    const variants: CurrentSymbolValidatedContinuationIdentity[] = [{
        ...currentIdentity(),
        currentSourceHash: hashB,
    }, {
        ...currentIdentity(),
        resolvedSpan: { ...currentIdentity().resolvedSpan, endByte: 341 },
    }, {
        ...currentIdentity(),
        spanResolutionPolicyVersion: "span_resolution_v2",
    }, {
        ...currentIdentity(),
        extractorLanguageImplementationVersion: "typescript_analyzer_v4",
    }];
    for (const variant of variants) {
        assert.notEqual(buildSourceContinuationFingerprint(variant).fingerprint, baseline);
    }

    const structural = buildSourceContinuationFingerprint({
        ...currentIdentity(),
        resolutionDerivation: "language_structural_reresolution",
        currentSpanIdentity: {
            kind: "canonical_structural_identity",
            language: "typescript",
            qualifiedName: "Service.run",
            kindName: "method",
            parentPath: ["class Service"],
        },
    });
    assert.notEqual(structural.fingerprint, baseline);
});

test("current continuation rejects a derivation with the wrong tagged identity", () => {
    assert.throws(() => buildSourceContinuationFingerprint({
        ...currentIdentity(),
        currentSpanIdentity: {
            kind: "canonical_structural_identity",
            language: "typescript",
            qualifiedName: "Service.run",
            kindName: "method",
            parentPath: ["class Service"],
        },
    }), /requires resolved_symbol_instance/);
    assert.throws(() => buildSourceContinuationFingerprint({
        ...currentIdentity(),
        resolutionDerivation: "language_structural_reresolution",
    }), /requires canonical_structural_identity/);
});

test("source continuation rejects malformed roots, hashes, and coordinates", () => {
    assert.throws(() => buildSourceContinuationFingerprint({
        ...snapshotIdentity(),
        canonicalRoot: "relative/repo",
    }), /canonicalRoot/);
    assert.throws(() => buildSourceContinuationFingerprint({
        ...snapshotIdentity(),
        indexedSourceIdentity: "not-a-hash",
    }), /indexedSourceIdentity/);
    assert.throws(() => buildSourceContinuationFingerprint({
        ...snapshotIdentity(),
        indexedSpan: { startLine: 20, endLine: 10 },
    }), /indexedSpan/);
});
