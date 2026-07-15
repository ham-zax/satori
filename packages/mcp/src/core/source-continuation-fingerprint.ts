import * as crypto from "node:crypto";
import * as path from "node:path";
import { serializeCanonicalJson } from "./canonical-json.js";

export const SOURCE_CONTINUATION_FINGERPRINT_FORMAT_VERSION = 1 as const;

export interface SourceContinuationSpan {
    startLine: number;
    endLine: number;
    startByte?: number;
    endByte?: number;
    startColumn?: number;
    endColumn?: number;
}

export type CurrentSpanIdentity = {
    kind: "resolved_symbol_instance";
    symbolInstanceId: string;
} | {
    kind: "canonical_structural_identity";
    language: string;
    qualifiedName: string;
    kindName: string;
    parentPath: string[];
};

type SourceContinuationIdentityBase = {
    canonicalRoot: string;
    selectionPolicyVersion: string;
};

export type IndexSnapshotMatchedContinuationIdentity = SourceContinuationIdentityBase & {
    spanResolution: "index_snapshot_matched";
    registryManifestIdentity: string;
    indexedSourceIdentity: string;
    symbolInstanceId: string;
    indexedSpan: SourceContinuationSpan;
};

export type CurrentSymbolValidatedContinuationIdentity = SourceContinuationIdentityBase & {
    spanResolution: "current_symbol_validated";
    currentSourceHash: string;
    currentSpanIdentity: CurrentSpanIdentity;
    resolvedSpan: SourceContinuationSpan;
    spanResolutionPolicyVersion: string;
    extractorLanguageImplementationVersion: string;
    resolutionDerivation: "exact_registry_rebuild_match" | "language_structural_reresolution";
};

export type SourceContinuationIdentity =
    | IndexSnapshotMatchedContinuationIdentity
    | CurrentSymbolValidatedContinuationIdentity;

export interface SourceContinuationFingerprint {
    formatVersion: typeof SOURCE_CONTINUATION_FINGERPRINT_FORMAT_VERSION;
    kind: "source_range";
    domains: ["symbol", "source"];
    fingerprint: string;
}

function requireNonEmpty(value: string, name: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new TypeError(`${name} must be a non-empty string.`);
    }
    return normalized;
}

function requireSha256(value: string, name: string): string {
    if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new TypeError(`${name} must be a lowercase SHA-256 hex digest.`);
    }
    return value;
}

function canonicalSpan(span: SourceContinuationSpan, name: string): Record<string, number> {
    if (
        !Number.isSafeInteger(span.startLine)
        || !Number.isSafeInteger(span.endLine)
        || span.startLine < 1
        || span.endLine < span.startLine
    ) {
        throw new RangeError(`${name} must have a valid one-based inclusive line range.`);
    }
    const optionalCoordinates = [
        ["startByte", span.startByte],
        ["endByte", span.endByte],
        ["startColumn", span.startColumn],
        ["endColumn", span.endColumn],
    ] as const;
    for (const [coordinate, value] of optionalCoordinates) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
            throw new RangeError(`${name}.${coordinate} must be a non-negative safe integer when present.`);
        }
    }
    if (
        span.startByte !== undefined
        && span.endByte !== undefined
        && span.endByte < span.startByte
    ) {
        throw new RangeError(`${name}.endByte cannot precede startByte.`);
    }
    return {
        startLine: span.startLine,
        endLine: span.endLine,
        ...(span.startByte !== undefined ? { startByte: span.startByte } : {}),
        ...(span.endByte !== undefined ? { endByte: span.endByte } : {}),
        ...(span.startColumn !== undefined ? { startColumn: span.startColumn } : {}),
        ...(span.endColumn !== undefined ? { endColumn: span.endColumn } : {}),
    };
}

function currentSpanIdentity(input: CurrentSymbolValidatedContinuationIdentity): Record<string, unknown> {
    const identity = input.currentSpanIdentity;
    if (input.resolutionDerivation === "exact_registry_rebuild_match") {
        if (identity.kind !== "resolved_symbol_instance") {
            throw new TypeError("exact_registry_rebuild_match requires resolved_symbol_instance identity.");
        }
        return {
            kind: identity.kind,
            symbolInstanceId: requireNonEmpty(identity.symbolInstanceId, "symbolInstanceId"),
        };
    }
    if (identity.kind !== "canonical_structural_identity") {
        throw new TypeError("language_structural_reresolution requires canonical_structural_identity.");
    }
    return {
        kind: identity.kind,
        language: requireNonEmpty(identity.language, "language"),
        qualifiedName: requireNonEmpty(identity.qualifiedName, "qualifiedName"),
        kindName: requireNonEmpty(identity.kindName, "kindName"),
        parentPath: identity.parentPath.map((entry, index) => requireNonEmpty(entry, `parentPath[${index}]`)),
    };
}

function canonicalIdentityPayload(input: SourceContinuationIdentity): Record<string, unknown> {
    if (!path.isAbsolute(input.canonicalRoot)) {
        throw new TypeError("canonicalRoot must be absolute.");
    }
    const shared = {
        formatVersion: SOURCE_CONTINUATION_FINGERPRINT_FORMAT_VERSION,
        kind: "source_range",
        domains: ["symbol", "source"],
        canonicalRoot: path.normalize(input.canonicalRoot),
        selectionPolicyVersion: requireNonEmpty(input.selectionPolicyVersion, "selectionPolicyVersion"),
        spanResolution: input.spanResolution,
    };
    if (input.spanResolution === "index_snapshot_matched") {
        return {
            ...shared,
            projection: {
                registryManifestIdentity: requireNonEmpty(
                    input.registryManifestIdentity,
                    "registryManifestIdentity",
                ),
                indexedSourceIdentity: requireSha256(input.indexedSourceIdentity, "indexedSourceIdentity"),
                symbolInstanceId: requireNonEmpty(input.symbolInstanceId, "symbolInstanceId"),
                indexedSpan: canonicalSpan(input.indexedSpan, "indexedSpan"),
            },
        };
    }
    return {
        ...shared,
        projection: {
            currentSourceHash: requireSha256(input.currentSourceHash, "currentSourceHash"),
            currentSpanIdentity: currentSpanIdentity(input),
            resolvedSpan: canonicalSpan(input.resolvedSpan, "resolvedSpan"),
            spanResolutionPolicyVersion: requireNonEmpty(
                input.spanResolutionPolicyVersion,
                "spanResolutionPolicyVersion",
            ),
            extractorLanguageImplementationVersion: requireNonEmpty(
                input.extractorLanguageImplementationVersion,
                "extractorLanguageImplementationVersion",
            ),
            resolutionDerivation: input.resolutionDerivation,
        },
    };
}

export function buildSourceContinuationFingerprint(
    input: SourceContinuationIdentity,
): SourceContinuationFingerprint {
    const serialized = serializeCanonicalJson(canonicalIdentityPayload(input));
    const digest = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
    return {
        formatVersion: SOURCE_CONTINUATION_FINGERPRINT_FORMAT_VERSION,
        kind: "source_range",
        domains: ["symbol", "source"],
        fingerprint: `sha256_source_${digest}`,
    };
}
