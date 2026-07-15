import * as crypto from "node:crypto";
import * as path from "node:path";
import type { CallGraphEdge } from "./call-graph.js";
import { serializeCanonicalJson } from "./canonical-json.js";
import {
    RELATIONSHIP_CONFIDENCE_POLICY_VERSION,
    RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION,
    type RelationshipEvidenceKind,
} from "./relationship-evidence.js";

export const RELATIONSHIP_EDGE_ORDERING_POLICY_VERSION = "relationship_edge_ordering_v1" as const;
export const RELATIONSHIP_CURSOR_FORMAT_VERSION = 1 as const;
export const MAX_RELATIONSHIP_CURSOR_BYTES = 1_024;

export interface RelationshipTraversalIdentity {
    canonicalRoot: string;
    targetSymbolInstanceId: string;
    registryManifestIdentity: string;
    relationshipManifestIdentity: string;
    relationship: RelationshipEvidenceKind;
    depth: number;
}

export interface RelationshipTraversalFingerprint {
    kind: "caller_page" | "callee_page";
    domains: ["symbol", "relationships"];
    fingerprint: string;
}

export interface RelationshipCursor {
    formatVersion: typeof RELATIONSHIP_CURSOR_FORMAT_VERSION;
    traversalFingerprint: string;
    lastEdgeKey: string;
}

export interface RelationshipPage {
    edges: CallGraphEdge[];
    availableCount: number;
    duplicateCount: number;
    terminal: boolean;
    nextCursor?: string;
}

export class InvalidRelationshipContinuationError extends Error {
    public readonly code = "INVALID_RELATIONSHIP_CONTINUATION" as const;

    constructor() {
        super("The relationship continuation is invalid for the prepared traversal.");
        this.name = "InvalidRelationshipContinuationError";
    }
}

function requireNonEmpty(value: string, name: string): string {
    const normalized = value.trim();
    if (!normalized) throw new TypeError(`${name} must be a non-empty string.`);
    return normalized;
}

function traversalPayload(input: RelationshipTraversalIdentity): Record<string, unknown> {
    if (!path.isAbsolute(input.canonicalRoot)) {
        throw new TypeError("canonicalRoot must be absolute.");
    }
    if (!Number.isSafeInteger(input.depth) || input.depth < 1) {
        throw new RangeError("depth must be a positive safe integer.");
    }
    return {
        canonicalRoot: path.normalize(input.canonicalRoot),
        targetSymbolInstanceId: requireNonEmpty(
            input.targetSymbolInstanceId,
            "targetSymbolInstanceId",
        ),
        registryManifestIdentity: requireNonEmpty(
            input.registryManifestIdentity,
            "registryManifestIdentity",
        ),
        relationshipManifestIdentity: requireNonEmpty(
            input.relationshipManifestIdentity,
            "relationshipManifestIdentity",
        ),
        relationshipKind: "call_graph",
        relationship: input.relationship,
        direction: input.relationship === "caller" ? "callers" : "callees",
        depth: input.depth,
        projectionPolicyVersion: RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION,
        confidencePolicyVersion: RELATIONSHIP_CONFIDENCE_POLICY_VERSION,
        orderingPolicyVersion: RELATIONSHIP_EDGE_ORDERING_POLICY_VERSION,
    };
}

export function buildRelationshipTraversalFingerprint(
    input: RelationshipTraversalIdentity,
): RelationshipTraversalFingerprint {
    const digest = crypto
        .createHash("sha256")
        .update(serializeCanonicalJson(traversalPayload(input)), "utf8")
        .digest("hex");
    const plural = input.relationship === "caller" ? "callers" : "callees";
    return {
        kind: input.relationship === "caller" ? "caller_page" : "callee_page",
        domains: ["symbol", "relationships"],
        fingerprint: `sha256_${plural}_${digest}`,
    };
}

export function buildRelationshipEdgeKey(edge: CallGraphEdge): string {
    if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
        throw new RangeError("Relationship edge confidence must be finite and between 0 and 1.");
    }
    if (!Number.isSafeInteger(edge.site.startLine) || edge.site.startLine < 1) {
        throw new RangeError("Relationship edge startLine must be a positive safe integer.");
    }
    if (
        edge.site.endLine !== undefined
        && (!Number.isSafeInteger(edge.site.endLine) || edge.site.endLine < edge.site.startLine)
    ) {
        throw new RangeError("Relationship edge endLine must not precede startLine.");
    }
    return serializeCanonicalJson({
        srcSymbolId: requireNonEmpty(edge.srcSymbolId, "srcSymbolId"),
        dstSymbolId: requireNonEmpty(edge.dstSymbolId, "dstSymbolId"),
        kind: edge.kind,
        site: {
            file: requireNonEmpty(edge.site.file, "site.file"),
            startLine: edge.site.startLine,
            ...(edge.site.endLine !== undefined ? { endLine: edge.site.endLine } : {}),
        },
        confidence: edge.confidence,
    });
}

export function orderUniqueRelationshipEdges(edges: readonly CallGraphEdge[]): {
    edges: CallGraphEdge[];
    duplicateCount: number;
} {
    const byKey = new Map<string, CallGraphEdge>();
    for (const edge of edges) {
        const key = buildRelationshipEdgeKey(edge);
        if (!byKey.has(key)) {
            byKey.set(key, {
                ...edge,
                site: { ...edge.site },
            });
        }
    }
    const orderedKeys = [...byKey.keys()].sort();
    return {
        edges: orderedKeys.map((key) => byKey.get(key) as CallGraphEdge),
        duplicateCount: edges.length - orderedKeys.length,
    };
}

export function serializeRelationshipCursor(cursor: RelationshipCursor): string {
    const serialized = serializeCanonicalJson(cursor);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RELATIONSHIP_CURSOR_BYTES) {
        throw new InvalidRelationshipContinuationError();
    }
    return serialized;
}

export function parseRelationshipCursor(
    serialized: string,
    expectedTraversalFingerprint: string,
): RelationshipCursor {
    if (
        Buffer.byteLength(serialized, "utf8") > MAX_RELATIONSHIP_CURSOR_BYTES
        || !serialized
    ) {
        throw new InvalidRelationshipContinuationError();
    }
    try {
        const parsed = JSON.parse(serialized) as Partial<RelationshipCursor>;
        if (
            parsed === null
            || typeof parsed !== "object"
            || Array.isArray(parsed)
            || Object.keys(parsed).length !== 3
            || parsed.formatVersion !== RELATIONSHIP_CURSOR_FORMAT_VERSION
            || parsed.traversalFingerprint !== expectedTraversalFingerprint
            || typeof parsed.lastEdgeKey !== "string"
            || parsed.lastEdgeKey.length === 0
        ) {
            throw new InvalidRelationshipContinuationError();
        }
        const cursor: RelationshipCursor = {
            formatVersion: RELATIONSHIP_CURSOR_FORMAT_VERSION,
            traversalFingerprint: parsed.traversalFingerprint,
            lastEdgeKey: parsed.lastEdgeKey,
        };
        if (serializeRelationshipCursor(cursor) !== serialized) {
            throw new InvalidRelationshipContinuationError();
        }
        return cursor;
    } catch (error) {
        if (error instanceof InvalidRelationshipContinuationError) throw error;
        throw new InvalidRelationshipContinuationError();
    }
}

export function paginateRelationshipEdges(input: {
    edges: readonly CallGraphEdge[];
    traversalFingerprint: string;
    pageSize: number;
    cursor?: string;
}): RelationshipPage {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1) {
        throw new RangeError("pageSize must be a positive safe integer.");
    }
    const ordered = orderUniqueRelationshipEdges(input.edges);
    let startIndex = 0;
    if (input.cursor !== undefined) {
        const cursor = parseRelationshipCursor(input.cursor, input.traversalFingerprint);
        const cursorIndex = ordered.edges.findIndex(
            (edge) => buildRelationshipEdgeKey(edge) === cursor.lastEdgeKey,
        );
        if (cursorIndex < 0 || cursorIndex >= ordered.edges.length - 1) {
            throw new InvalidRelationshipContinuationError();
        }
        startIndex = cursorIndex + 1;
    }

    const edges = ordered.edges.slice(startIndex, startIndex + input.pageSize);
    const terminal = startIndex + edges.length >= ordered.edges.length;
    const finalEdge = edges.at(-1);
    return {
        edges,
        availableCount: ordered.edges.length,
        duplicateCount: ordered.duplicateCount,
        terminal,
        ...(!terminal && finalEdge
            ? {
                nextCursor: serializeRelationshipCursor({
                    formatVersion: RELATIONSHIP_CURSOR_FORMAT_VERSION,
                    traversalFingerprint: input.traversalFingerprint,
                    lastEdgeKey: buildRelationshipEdgeKey(finalEdge),
                }),
            }
            : {}),
    };
}
