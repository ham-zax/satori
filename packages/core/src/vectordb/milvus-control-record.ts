import {
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    type VectorControlRecord,
    type VectorDocument,
    type VectorFilter,
    type VectorRecord,
} from './types';
import { serializeMilvusFilter } from './filters';
import { decodeMilvusMetadata } from './milvus-row-codec';

const MILVUS_CONTROL_KIND_METADATA_KEY = '__satoriControlKind';

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
    if (Object.prototype.hasOwnProperty.call(record.metadata, MILVUS_CONTROL_KIND_METADATA_KEY)) {
        throw new Error(
            `Milvus control metadata cannot contain reserved key '${MILVUS_CONTROL_KIND_METADATA_KEY}'.`,
        );
    }
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
    const metadata = decodeMilvusMetadata(row.metadata);
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
export function withMilvusControlExclusion(filter?: VectorFilter): string {
    const controlExclusion = serializeMilvusFilter({
        kind: 'comparison',
        field: 'fileExtension',
        operator: 'ne',
        value: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    });
    const callerFilter = serializeMilvusFilter(filter);
    return callerFilter.length > 0
        ? `(${callerFilter}) and (${controlExclusion})`
        : controlExclusion;
}
