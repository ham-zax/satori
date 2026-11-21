import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
    RelationshipRecord,
    RootBoundFileIdentity,
    SymbolRecord,
    SymbolRegistry,
} from "@satori-code/core";
import {
    canPublishRootBoundFileIdentity,
    openRegularFileWithIdentityInsideRoot,
    readStableRootBoundFileWindow,
    RootBoundFileWindowLimitError,
    sameRootBoundFileIdentity,
} from "@satori-code/core";
import {
    readCurrentSourceEvidence,
    type CurrentSourceEvidence,
} from "./current-source-symbols.js";
import type { InspectableSourceObservedStat } from "./inspectable-source.js";
import { buildSearchRerankSourceReferences } from "./search-rerank-source-references.js";
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
export const VERIFIED_RERANK_SOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// Racily-clean window: never trust a stat witness for a file modified within the
// last second, so rapid same-second edits always re-read and re-hash from disk.
export const VERIFIED_RERANK_SOURCE_RACILY_CLEAN_MS = 1_000;

type ManifestFileEntry = SymbolRegistry["manifest"]["files"][number];
const manifestFileIndexByRegistry = new WeakMap<SymbolRegistry, ReadonlyMap<string, ManifestFileEntry>>();

function lookupManifestFile(
    registry: SymbolRegistry,
    relativePath: string,
): ManifestFileEntry | undefined {
    let index = manifestFileIndexByRegistry.get(registry);
    if (!index) {
        const built = new Map<string, ManifestFileEntry>();
        for (const file of registry.manifest.files) {
            if (!built.has(file.path)) built.set(file.path, file);
        }
        index = built;
        manifestFileIndexByRegistry.set(registry, index);
    }
    return index.get(relativePath);
}

type CachedVerifiedSourceEntry = Readonly<{
    evidence: CurrentSourceEvidence;
    identity: RootBoundFileIdentity;
    observedStat: InspectableSourceObservedStat;
    sourceLines: readonly string[];
    retainedBytes: number;
}>;

/**
 * Byte-bounded cross-request cache of publication-verified current source files.
 * Every cache hit still opens the path root-bound via
 * `openRegularFileWithIdentityInsideRoot` and verifies `(dev, ino, size, mtimeMs,
 * ctimeMs)` plus a racily-clean guard before skipping byte reads and SHA-256
 * hashing. Any stat drift, symlink change, or recent edit falls back to a full
 * read + hash.
 */
export class VerifiedRerankSourceCache {
    private readonly entries = new Map<string, CachedVerifiedSourceEntry>();
    private readonly limitBytes: number;
    private readonly nowMs: () => number;
    private retainedBytes = 0;

    constructor(
        maxBytes = VERIFIED_RERANK_SOURCE_CACHE_MAX_BYTES,
        nowMs: () => number = () => Date.now(),
    ) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new Error("Verified rerank source cache limit must be a positive integer.");
        }
        this.limitBytes = maxBytes;
        this.nowMs = nowMs;
    }

    get size(): number {
        return this.entries.size;
    }

    get bytes(): number {
        return this.retainedBytes;
    }

    private keyFor(canonicalRoot: string, relativeFile: string): string {
        return `${canonicalRoot}\0${relativeFile.replace(/\\/g, "/")}`;
    }

    private touch(key: string, entry: CachedVerifiedSourceEntry): void {
        this.entries.delete(key);
        this.entries.set(key, entry);
    }

    private evict(key: string): void {
        const existing = this.entries.get(key);
        if (!existing) return;
        this.entries.delete(key);
        this.retainedBytes -= existing.retainedBytes;
    }

    private store(key: string, evidence: CurrentSourceEvidence, sourceLines: readonly string[]): void {
        if (!evidence.identity || !evidence.observedStat) return;
        this.evict(key);
        // UTF-16 string + raw Uint8Array + overhead estimate.
        const retainedBytes = evidence.sourceBytes.byteLength * 3 + 512;
        if (retainedBytes > this.limitBytes) return;
        this.entries.set(key, {
            evidence,
            identity: evidence.identity,
            observedStat: evidence.observedStat,
            sourceLines,
            retainedBytes,
        });
        this.retainedBytes += retainedBytes;
        while (this.retainedBytes > this.limitBytes) {
            const oldest = this.entries.entries().next();
            if (oldest.done) break;
            this.entries.delete(oldest.value[0]);
            this.retainedBytes -= oldest.value[1].retainedBytes;
        }
    }

    async readVerifiedSource(
        canonicalRoot: string,
        codebaseRoot: string,
        relativeFile: string,
        readFallback: CurrentSourceEvidenceReader = readCurrentSourceEvidence,
    ): Promise<Readonly<{ evidence: CurrentSourceEvidence; sourceLines: readonly string[] }> | undefined> {
        const normalizedRelative = relativeFile.replace(/\\/g, "/");
        const key = this.keyFor(canonicalRoot, normalizedRelative);
        const cached = this.entries.get(key);
        if (cached) {
            const logicalFile = path.resolve(canonicalRoot, normalizedRelative);
            const relCheck = path.relative(canonicalRoot, logicalFile);
            const insideRoot = !path.isAbsolute(normalizedRelative)
                && relCheck.length > 0
                && relCheck !== ".."
                && !relCheck.startsWith(`..${path.sep}`)
                && !path.isAbsolute(relCheck);
            if (insideRoot) {
                let opened: Awaited<ReturnType<typeof openRegularFileWithIdentityInsideRoot>> | undefined;
                try {
                    opened = await openRegularFileWithIdentityInsideRoot(logicalFile, canonicalRoot);
                    const stat = opened.observedStat;
                    const now = this.nowMs();
                    const racilyClean = (now - stat.mtimeMs) < VERIFIED_RERANK_SOURCE_RACILY_CLEAN_MS
                        || (now - stat.ctimeMs) < VERIFIED_RERANK_SOURCE_RACILY_CLEAN_MS;
                    if (
                        !racilyClean
                        && canPublishRootBoundFileIdentity(opened.identity)
                        && sameRootBoundFileIdentity(cached.identity, opened.identity)
                        && stat.size === cached.observedStat.size
                        && stat.mtimeMs === cached.observedStat.mtimeMs
                        && stat.ctimeMs === cached.observedStat.ctimeMs
                    ) {
                        this.touch(key, cached);
                        return { evidence: cached.evidence, sourceLines: cached.sourceLines };
                    }
                } catch {
                    // Fall through to authoritative reader which classifies failures identically.
                } finally {
                    await opened?.handle.close().catch(() => undefined);
                }
            }
            this.evict(key);
        }

        const fresh = await readFallback(codebaseRoot, relativeFile);
        if (!fresh) return undefined;
        const sourceLines = fresh.source.split(/\r?\n/);
        this.store(key, fresh, sourceLines);
        return { evidence: fresh, sourceLines };
    }
}

/**
 * Per-search-request cache that coalesces duplicate concurrent file reads,
 * `realpath(codebaseRoot)` calls, and line-splitting across candidates sharing
 * the same file (typically ~60-68% of the 128 candidates in a rerank batch).
 */
export interface SearchRerankProjectionRequestCache {
    getCanonicalRoot(codebaseRoot: string): Promise<string>;
    readSource(
        codebaseRoot: string,
        relativeFile: string,
        readFallback?: CurrentSourceEvidenceReader,
    ): Promise<Readonly<{ evidence: CurrentSourceEvidence; sourceLines: readonly string[] }> | undefined>;
}

export function createSearchRerankProjectionRequestCache(
    crossRequestCache?: VerifiedRerankSourceCache,
): SearchRerankProjectionRequestCache {
    const canonicalRoots = new Map<string, Promise<string>>();
    const inFlight = new Map<
        string,
        Promise<Readonly<{ evidence: CurrentSourceEvidence; sourceLines: readonly string[] }> | undefined>
    >();

    const getCanonicalRoot = (codebaseRoot: string): Promise<string> => {
        let pending = canonicalRoots.get(codebaseRoot);
        if (!pending) {
            pending = fs.realpath(codebaseRoot);
            canonicalRoots.set(codebaseRoot, pending);
        }
        return pending;
    };

    return {
        getCanonicalRoot,
        readSource(codebaseRoot, relativeFile, readFallback) {
            const key = `${codebaseRoot}\0${relativeFile.replace(/\\/g, "/")}`;
            let pending = inFlight.get(key);
            if (!pending) {
                pending = (async () => {
                    if (crossRequestCache && !readFallback) {
                        let canonicalRoot: string;
                        try {
                            canonicalRoot = await getCanonicalRoot(codebaseRoot);
                        } catch {
                            return undefined;
                        }
                        return crossRequestCache.readVerifiedSource(
                            canonicalRoot,
                            codebaseRoot,
                            relativeFile,
                        );
                    }
                    const fresh = await (readFallback ?? readCurrentSourceEvidence)(
                        codebaseRoot,
                        relativeFile,
                    );
                    if (!fresh) return undefined;
                    return {
                        evidence: fresh,
                        sourceLines: fresh.source.split(/\r?\n/),
                    };
                })();
                inFlight.set(key, pending);
            }
            return pending;
        },
    };
}

interface PublicationBoundSourceEvidence {
    readonly relativeFile: string;
    readonly source: string;
    readonly sourceLines?: readonly string[];
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
    requestCache?: SearchRerankProjectionRequestCache;
}): Promise<
    | { ok: true; evidence: PublicationBoundSourceEvidence }
    | { ok: false; reason: SearchRerankProjectionFailureReason }
> {
    const dirtyOverlaySourceHash = input.result.dirtyOverlaySourceHash;
    const owner = dirtyOverlaySourceHash ? undefined : resolveCanonicalOwner(input.result, input.registry);
    const manifestFile = dirtyOverlaySourceHash
        ? undefined
        : lookupManifestFile(input.registry, input.result.relativePath);
    const expectedFile = dirtyOverlaySourceHash ? input.result.relativePath : owner?.file ?? manifestFile?.path;
    const expectedHash = dirtyOverlaySourceHash ?? owner?.fileHash ?? manifestFile?.hash;
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

    let currentSourceEvidence: CurrentSourceEvidence | undefined;
    let cachedSourceLines: readonly string[] | undefined;
    try {
        if (input.requestCache) {
            const loaded = await input.requestCache.readSource(
                input.codebaseRoot,
                expectedFile,
                input.readSourceEvidence,
            );
            currentSourceEvidence = loaded?.evidence;
            cachedSourceLines = loaded?.sourceLines;
        } else {
            currentSourceEvidence = await (input.readSourceEvidence ?? readCurrentSourceEvidence)(
                input.codebaseRoot,
                expectedFile,
            );
        }
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
            ...(cachedSourceLines ? { sourceLines: cachedSourceLines } : {}),
            observedHash: currentSourceEvidence.observedHash,
            sourceStartLine: 1,
        };
    } else if (input.readSourceEvidence) {
        return { ok: false, reason: "source_unavailable" };
    } else {
        try {
            const canonicalRoot = input.requestCache
                ? await input.requestCache.getCanonicalRoot(input.codebaseRoot)
                : await fs.realpath(input.codebaseRoot);
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
    requestCache?: SearchRerankProjectionRequestCache;
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
            sourceReferences: buildSearchRerankSourceReferences({
                owner: resolveCanonicalOwner(input.result, input.registry),
                registry: input.registry,
                source: resolved.evidence.source,
                ...(resolved.evidence.sourceLines
                    ? { sourceLines: resolved.evidence.sourceLines }
                    : {}),
                sourceStartLine: resolved.evidence.sourceStartLine,
                observedHash: resolved.evidence.observedHash,
                query: input.semanticQuery,
            }),
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
