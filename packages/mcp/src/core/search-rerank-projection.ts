import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistry,
} from "@zokizuan/satori-core";
import {
    readStableRootBoundFileWindow,
    RootBoundFileWindowLimitError,
} from "@zokizuan/satori-core";
import { readCurrentSourceEvidence } from "./current-source-symbols.js";
import { READ_FILE_MAX_BYTES_DEFAULT } from "./published-source-reader.js";
import { resolveSearchCandidateRole } from "./search-candidate-role.js";
import type { SearchCandidateRole } from "./search-rerank-context.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import {
    buildSearchRerankDocument,
    SEARCH_RERANK_DOCUMENT_POLICY,
} from "./search-rerank-document.js";
import {
    buildSearchRerankStructuralContext,
    type PreparedSearchRerankStructuralRelationships,
} from "./search-rerank-structural-context.js";
import type {
    SearchRerankProjectionFailureReason,
    SearchRerankProjectionResult,
    SearchRerankStructuralContextStatus,
} from "./search-rerank-projection-result.js";

type CurrentSourceEvidenceReader = typeof readCurrentSourceEvidence;

const RERANK_PROJECTION_WINDOW_MAX_BYTES = 256 * 1024;

interface PublicationBoundSourceEvidence {
    readonly relativeFile: string;
    readonly source: string;
    readonly observedHash: string;
    readonly sourceStartLine: number;
}

export function searchRerankCandidateId(result: SearchResultLike): string {
    return [
        result.relativePath,
        result.startLine ?? 0,
        result.endLine ?? 0,
    ].join(":");
}

export function resolveCanonicalOwner(
    result: SearchResultLike,
    registry: SymbolRegistry,
): SymbolRecord | undefined {
    const instanceId = typeof result.ownerSymbolInstanceId === "string"
        ? result.ownerSymbolInstanceId.trim()
        : "";
    if (instanceId) return registry.symbolsByInstanceId.get(instanceId);

    const symbolKey = typeof result.ownerSymbolKey === "string"
        ? result.ownerSymbolKey.trim()
        : "";
    if (!symbolKey) return undefined;
    const matches = (registry.symbolsByKey.get(symbolKey) ?? []).filter(
        (symbol) => symbol.file === result.relativePath,
    );
    return matches.length === 1 ? matches[0] : undefined;
}

function failure(
    candidateId: string,
    reason: SearchRerankProjectionFailureReason,
): SearchRerankProjectionResult {
    return { ok: false, candidateId, reason };
}

/**
 * Project frozen canonical reranker bytes from publication-bound current source.
 * Registry-owned candidates must remain inside their canonical owner. Candidates
 * without a resolvable owner may still use their unique manifest file identity
 * and exact result span; this does not invent symbol ownership.
 */
async function resolvePublicationBoundEvidence(input: {
    codebaseRoot: string;
    result: SearchResultLike;
    registry: SymbolRegistry;
    maxSourceBytes?: number;
    readSourceEvidence?: CurrentSourceEvidenceReader;
}): Promise<
    | { ok: true; evidence: PublicationBoundSourceEvidence }
    | { ok: false; reason: SearchRerankProjectionFailureReason }
> {
    const owner = resolveCanonicalOwner(input.result, input.registry);
    const manifestFile = input.registry.manifest.files.find(
        (file) => file.path === input.result.relativePath,
    );
    const expectedFile = owner?.file ?? manifestFile?.path;
    const expectedHash = owner?.fileHash ?? manifestFile?.hash;
    const startLine = input.result.startLine;
    const endLine = input.result.endLine;
    if (
        !expectedFile
        || expectedFile !== input.result.relativePath
        || !expectedHash
        || !/^[a-f0-9]{64}$/.test(expectedHash)
    ) {
        return { ok: false, reason: "owner_not_found" };
    }
    if (
        !Number.isSafeInteger(startLine)
        || !Number.isSafeInteger(endLine)
        || (startLine as number) < 1
        || (endLine as number) < (startLine as number)
        || (
            owner !== undefined
            && (
                (startLine as number) < owner.span.startLine
                || (endLine as number) > owner.span.endLine
            )
        )
    ) {
        return { ok: false, reason: "candidate_span_invalid" };
    }

    let currentSourceEvidence;
    try {
        currentSourceEvidence = await (input.readSourceEvidence ?? readCurrentSourceEvidence)(
            input.codebaseRoot,
            expectedFile,
        );
    } catch {
        return { ok: false, reason: "source_unavailable" };
    }
    let evidence: PublicationBoundSourceEvidence;
    if (currentSourceEvidence) {
        const maxSourceBytes = input.maxSourceBytes ?? READ_FILE_MAX_BYTES_DEFAULT;
        if (currentSourceEvidence.sourceBytes.byteLength > maxSourceBytes) {
            return { ok: false, reason: "source_exceeds_projection_limit" };
        }
        evidence = {
            relativeFile: currentSourceEvidence.relativeFile,
            source: currentSourceEvidence.source,
            observedHash: currentSourceEvidence.observedHash,
            sourceStartLine: 1,
        };
    } else if (input.readSourceEvidence) {
        return { ok: false, reason: "source_unavailable" };
    } else {
        try {
            const canonicalRoot = await fs.realpath(input.codebaseRoot);
            const window = await readStableRootBoundFileWindow({
                canonicalRoot,
                relativePath: expectedFile,
                requestedLineRange: {
                    startLine: startLine as number,
                    endLine: endLine as number,
                },
                maxFileBytes: input.maxSourceBytes ?? READ_FILE_MAX_BYTES_DEFAULT,
                maxWindowBytes: RERANK_PROJECTION_WINDOW_MAX_BYTES,
            });
            const originalLineRange = window.originalLineRange;
            if (
                originalLineRange === null
                || originalLineRange.startLine !== startLine
                || originalLineRange.endLine !== endLine
            ) {
                return { ok: false, reason: "source_unavailable" };
            }
            evidence = {
                relativeFile: window.normalizedRelativePath,
                source: window.utf8Window,
                observedHash: window.rawByteSha256,
                sourceStartLine: originalLineRange.startLine,
            };
        } catch (error) {
            return {
                ok: false,
                reason: error instanceof RootBoundFileWindowLimitError
                    ? "source_exceeds_projection_limit"
                    : "source_unavailable",
            };
        }
    }
    if (
        evidence.relativeFile !== expectedFile
        || evidence.observedHash !== expectedHash
    ) {
        return { ok: false, reason: "source_hash_mismatch" };
    }
    return { ok: true, evidence };
}

function localCandidateSpan(input: {
    result: SearchResultLike;
    evidence: PublicationBoundSourceEvidence;
}): { startLine: number; endLine: number } {
    return {
        startLine: (input.result.startLine as number) - input.evidence.sourceStartLine + 1,
        endLine: (input.result.endLine as number) - input.evidence.sourceStartLine + 1,
    };
}

function success(
    document: string,
    candidateRole: SearchCandidateRole,
    projectionIdentity: string,
    structuralContextStatus?: SearchRerankStructuralContextStatus,
): SearchRerankProjectionResult {
    return {
        ok: true,
        document,
        utf8Bytes: Buffer.byteLength(document, "utf8"),
        sha256: crypto.createHash("sha256").update(document, "utf8").digest("hex"),
        candidateRole,
        projectionIdentity,
        ...(structuralContextStatus === undefined ? {} : { structuralContextStatus }),
    };
}

export async function projectPublicationBoundSearchRerankDocument(input: {
    candidateId: string;
    codebaseRoot: string;
    semanticQuery: string;
    result: SearchResultLike;
    registry: SymbolRegistry;
    relationships?: readonly RelationshipRecord[];
    preparedStructuralRelationships?: PreparedSearchRerankStructuralRelationships;
    structuralContextStatus?: SearchRerankStructuralContextStatus;
    maxSourceBytes?: number;
    readSourceEvidence?: CurrentSourceEvidenceReader;
}): Promise<SearchRerankProjectionResult> {
    const { candidateId } = input;
    const resolved = await resolvePublicationBoundEvidence(input);
    if (!resolved.ok) return failure(candidateId, resolved.reason);

    const candidateRole = resolveSearchCandidateRole({
        relativePath: input.result.relativePath,
        ...(typeof input.result.language === "string"
            ? { language: input.result.language }
            : {}),
        ...(typeof input.result.symbolKind === "string"
            ? { symbolKind: input.result.symbolKind }
            : {}),
    });
    const structuralContext = buildSearchRerankStructuralContext({
        candidate: input.result,
        registry: input.registry,
        ...(input.preparedStructuralRelationships
            ? { preparedRelationships: input.preparedStructuralRelationships }
            : { relationships: input.relationships ?? [] }),
    });
    let document: string;
    try {
        document = buildSearchRerankDocument({
            relativePath: input.result.relativePath,
            language: input.result.language,
            candidateRole,
            symbolKind: input.result.symbolKind ?? "file",
            canonicalSymbolLabel:
                input.result.symbolLabel ?? path.posix.basename(input.result.relativePath),
            content: resolved.evidence.source,
            symbolSpan: localCandidateSpan({ result: input.result, evidence: resolved.evidence }),
            query: input.semanticQuery,
            structuralContext,
        }).text;
    } catch {
        return failure(candidateId, "projection_contract_failed");
    }
    return success(
        document,
        candidateRole,
        SEARCH_RERANK_DOCUMENT_POLICY.id,
        input.structuralContextStatus
            ?? (input.preparedStructuralRelationships !== undefined || input.relationships !== undefined
                ? "available"
                : "unavailable"),
    );
}
