import {
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    type VectorControlRecord,
    type VectorDocument,
    type VectorDocumentMetadata,
    type VectorRecord,
} from './types';

const MILVUS_CONTROL_KIND_METADATA_KEY = '__satoriControlKind';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseMetadata(value: unknown): VectorDocumentMetadata {
    if (isRecord(value)) return { ...value };
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? { ...parsed } : {};
    } catch {
        return {};
    }
}

function requireLegacyVectorDimension(recordId: string, vectorDimension: number): number {
    if (!Number.isSafeInteger(vectorDimension) || vectorDimension <= 0) {
        throw new Error(`Milvus control record '${recordId}' has no valid adapter-owned vector dimension for its legacy placeholder row.`);
    }
    return vectorDimension;
}

/** Translate the neutral control contract at the legacy Milvus schema boundary. */
export function toLegacyMilvusControlDocument(
    record: VectorControlRecord,
    vectorDimension: number,
): VectorDocument {
    return {
        id: record.id,
        vector: new Array<number>(requireLegacyVectorDimension(record.id, vectorDimension)).fill(0),
        content: `satori control record: ${record.kind}`,
        relativePath: `.__satori__/control/${encodeURIComponent(record.id)}.json`,
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: {
            ...record.metadata,
            [MILVUS_CONTROL_KIND_METADATA_KEY]: record.kind,
        },
    };
}

export function fromLegacyMilvusControlRow(
    row: VectorRecord,
    expectedId: string,
): VectorControlRecord | null {
    if (row.id !== expectedId) return null;
    const metadata = parseMetadata(row.metadata);
    const encodedKind = metadata[MILVUS_CONTROL_KIND_METADATA_KEY];
    const kind = typeof encodedKind === 'string'
        ? encodedKind
        : typeof metadata.kind === 'string'
            ? metadata.kind
            : '';
    const logicalMetadata = Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== MILVUS_CONTROL_KIND_METADATA_KEY),
    );
    return {
        id: expectedId,
        kind,
        metadata: logicalMetadata,
    };
}

/** Keep legacy Milvus placeholder rows out of every retrieval operation. */
export function withMilvusControlExclusion(filterExpr?: string): string {
    const controlExclusion = `fileExtension != "${INDEX_COMPLETION_MARKER_FILE_EXTENSION}"`;
    if (!filterExpr || filterExpr.trim().length === 0) return controlExclusion;
    return `(${filterExpr}) and (${controlExclusion})`;
}
