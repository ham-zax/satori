import { serializeCanonicalJson } from "./canonical-json.js";
import type {
    CallGraphEvidenceKind,
    CallGraphEvidencePageResult,
    CallGraphEvidenceSummaryResult,
    CallGraphResponseEnvelope,
} from "./search-types.js";

const CALL_GRAPH_EVIDENCE_CURSOR_FORMAT_VERSION = 1 as const;
const MAX_CALL_GRAPH_EVIDENCE_CURSOR_BYTES = 1_024;

export interface CallGraphEvidenceRequest {
    kind: CallGraphEvidenceKind;
    limit: number;
    cursor?: string;
}

type CallGraphEvidenceCursor = {
    formatVersion: typeof CALL_GRAPH_EVIDENCE_CURSOR_FORMAT_VERSION;
    publicationId: string;
    symbolId: string;
    kind: CallGraphEvidenceKind;
    direction: "callers" | "callees" | "both";
    depth: number;
    graphLimit: number;
    offset: number;
};

export class InvalidCallGraphEvidenceContinuationError extends Error {
    constructor() {
        super("The call_graph evidence continuation is invalid for the current Publication.");
        this.name = "InvalidCallGraphEvidenceContinuationError";
    }
}

function isEvidenceKind(value: unknown): value is CallGraphEvidenceKind {
    return value === "exact_references"
        || value === "source_references"
        || value === "test_references"
        || value === "construct_gaps"
        || value === "edge_arguments";
}

function serializeCursor(cursor: CallGraphEvidenceCursor): string {
    const serialized = serializeCanonicalJson(cursor);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CALL_GRAPH_EVIDENCE_CURSOR_BYTES) {
        throw new InvalidCallGraphEvidenceContinuationError();
    }
    return serialized;
}

function parseCursor(
    serialized: string,
    expected: {
        publicationId: string;
        symbolId: string;
        kind: CallGraphEvidenceKind;
        direction: "callers" | "callees" | "both";
        depth: number;
        graphLimit: number;
    },
): CallGraphEvidenceCursor {
    if (
        !serialized
        || Buffer.byteLength(serialized, "utf8") > MAX_CALL_GRAPH_EVIDENCE_CURSOR_BYTES
    ) {
        throw new InvalidCallGraphEvidenceContinuationError();
    }

    try {
        const parsed = JSON.parse(serialized) as Partial<CallGraphEvidenceCursor>;
        if (
            parsed === null
            || typeof parsed !== "object"
            || Array.isArray(parsed)
            || Object.keys(parsed).length !== 8
            || parsed.formatVersion !== CALL_GRAPH_EVIDENCE_CURSOR_FORMAT_VERSION
            || parsed.publicationId !== expected.publicationId
            || parsed.symbolId !== expected.symbolId
            || parsed.kind !== expected.kind
            || parsed.direction !== expected.direction
            || parsed.depth !== expected.depth
            || parsed.graphLimit !== expected.graphLimit
            || !isEvidenceKind(parsed.kind)
            || (parsed.direction !== "callers" && parsed.direction !== "callees" && parsed.direction !== "both")
            || !Number.isSafeInteger(parsed.depth)
            || Number(parsed.depth) < 1
            || !Number.isSafeInteger(parsed.graphLimit)
            || Number(parsed.graphLimit) < 1
            || !Number.isSafeInteger(parsed.offset)
            || Number(parsed.offset) < 1
        ) {
            throw new InvalidCallGraphEvidenceContinuationError();
        }
        const cursor: CallGraphEvidenceCursor = {
            formatVersion: CALL_GRAPH_EVIDENCE_CURSOR_FORMAT_VERSION,
            publicationId: parsed.publicationId,
            symbolId: parsed.symbolId,
            kind: parsed.kind,
            direction: parsed.direction,
            depth: Number(parsed.depth),
            graphLimit: Number(parsed.graphLimit),
            offset: Number(parsed.offset),
        };
        if (serializeCursor(cursor) !== serialized) {
            throw new InvalidCallGraphEvidenceContinuationError();
        }
        return cursor;
    } catch (error) {
        if (error instanceof InvalidCallGraphEvidenceContinuationError) throw error;
        throw new InvalidCallGraphEvidenceContinuationError();
    }
}

function evidenceSummary(payload: CallGraphResponseEnvelope): CallGraphEvidenceSummaryResult {
    const exactReferenceCount = payload.exactReferences?.length ?? 0;
    const sourceReferenceCount = payload.sourceReferences?.length ?? 0;
    const testReferenceCount = payload.testReferences?.length ?? 0;
    const constructGapCount = (payload.constructCoverage ?? [])
        .reduce((total, coverage) => total + coverage.gapCount, 0);
    const edgeArgumentEdgeCount = payload.edges.filter((edge) => (edge.args?.length ?? 0) > 0).length;
    const availableKinds: CallGraphEvidenceKind[] = [];
    if (exactReferenceCount > 0) availableKinds.push("exact_references");
    if (sourceReferenceCount > 0) availableKinds.push("source_references");
    if (testReferenceCount > 0) availableKinds.push("test_references");
    if ((payload.constructCoverage ?? []).some((coverage) => coverage.gapSpans.length > 0)) {
        availableKinds.push("construct_gaps");
    }
    if (edgeArgumentEdgeCount > 0) availableKinds.push("edge_arguments");

    return {
        exactReferenceCount,
        sourceReferenceCount,
        testReferenceCount,
        constructGapCount,
        edgeArgumentEdgeCount,
        availableKinds,
    };
}

function materializedItems(
    payload: CallGraphResponseEnvelope,
    kind: CallGraphEvidenceKind,
): CallGraphEvidencePageResult["items"] {
    switch (kind) {
        case "exact_references":
            return payload.exactReferences ?? [];
        case "source_references":
            return payload.sourceReferences ?? [];
        case "test_references":
            return payload.testReferences ?? [];
        case "construct_gaps":
            return (payload.constructCoverage ?? []).flatMap((coverage) => (
                coverage.gapSpans.map((gap) => ({
                    construct: coverage.construct,
                    gap,
                }))
            ));
        case "edge_arguments":
            return payload.edges.flatMap((edge) => (
                edge.args && edge.args.length > 0
                    ? [{
                        srcSymbolId: edge.srcSymbolId,
                        dstSymbolId: edge.dstSymbolId,
                        site: { ...edge.site },
                        args: [...edge.args],
                    }]
                    : []
            ));
    }
}

function summarizePayload(
    payload: CallGraphResponseEnvelope,
    summary: CallGraphEvidenceSummaryResult,
): CallGraphResponseEnvelope {
    const {
        exactReferences: _exactReferences,
        sourceReferences: _sourceReferences,
        testReferences: _testReferences,
        evidencePage: _evidencePage,
        ...rest
    } = payload;
    return {
        ...rest,
        edges: payload.edges.map(({ args: _args, ...edge }) => edge),
        ...(payload.constructCoverage
            ? {
                constructCoverage: payload.constructCoverage.map((coverage) => ({
                    ...coverage,
                    gapSpans: [],
                    gapsTruncated: coverage.gapsTruncated || coverage.gapCount > 0,
                })),
            }
            : {}),
        evidenceSummary: summary,
    };
}

export function projectCallGraphEvidence(
    payload: CallGraphResponseEnvelope,
    request?: CallGraphEvidenceRequest,
): CallGraphResponseEnvelope {
    if (payload.status !== "ok") return payload;

    const summary = evidenceSummary(payload);
    const projected = summarizePayload(payload, summary);
    if (!request) return projected;

    const pageSize = Math.max(1, Math.min(50, Math.floor(request.limit)));
    const publicationId = payload.navigationAuthority?.publicationId;
    if (request.cursor && !publicationId) {
        throw new InvalidCallGraphEvidenceContinuationError();
    }
    const traversalIdentity = {
        publicationId: publicationId!,
        symbolId: payload.symbolRef.symbolId,
        kind: request.kind,
        direction: payload.direction ?? "both",
        depth: payload.depth ?? 1,
        graphLimit: payload.limit ?? 20,
    } as const;
    const offset = request.cursor
        ? parseCursor(request.cursor, traversalIdentity).offset
        : 0;
    const items = materializedItems(payload, request.kind);
    const pageItems = items.slice(offset, offset + pageSize) as CallGraphEvidencePageResult["items"];
    const nextOffset = offset + pageItems.length;
    const nextCursor = nextOffset < items.length && publicationId
        ? serializeCursor({
            formatVersion: CALL_GRAPH_EVIDENCE_CURSOR_FORMAT_VERSION,
            ...traversalIdentity,
            offset: nextOffset,
        })
        : undefined;

    return {
        ...projected,
        evidencePage: {
            kind: request.kind,
            availableCount: items.length,
            returnedCount: pageItems.length,
            ...(nextCursor ? { nextCursor } : {}),
            items: pageItems,
        } as CallGraphEvidencePageResult,
    };
}
