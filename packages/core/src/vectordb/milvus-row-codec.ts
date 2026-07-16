import {
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    type VectorCandidate,
    type VectorDocument,
    type VectorDocumentMetadata,
    type VectorRecord,
} from './types';

export type MilvusPhysicalRow = VectorRecord & {
    id?: unknown;
    content?: unknown;
    relativePath?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    fileExtension?: unknown;
    metadata?: unknown;
    score?: unknown;
    distance?: unknown;
};

export function encodeMilvusDocument(document: VectorDocument): VectorRecord {
    return {
        id: document.id,
        vector: document.vector,
        content: document.content,
        relativePath: document.relativePath,
        startLine: document.startLine,
        endLine: document.endLine,
        fileExtension: document.fileExtension,
        metadata: JSON.stringify(document.metadata),
    };
}

export function encodeMilvusSearchableDocument(document: VectorDocument): VectorRecord {
    if (document.id === INDEX_COMPLETION_MARKER_DOC_ID) {
        throw new Error(`Searchable document ID '${document.id}' is reserved for a control record.`);
    }
    if (document.fileExtension === INDEX_COMPLETION_MARKER_FILE_EXTENSION) {
        throw new Error(
            `Searchable document '${document.id}' uses reserved control extension '${document.fileExtension}'.`,
        );
    }
    return encodeMilvusDocument(document);
}

export function assertMilvusSearchableDocumentIds(ids: readonly string[]): void {
    if (ids.some((id) => id === INDEX_COMPLETION_MARKER_DOC_ID)) {
        throw new Error(`Document deletion cannot target reserved control ID '${INDEX_COMPLETION_MARKER_DOC_ID}'.`);
    }
}

function isRecord(value: unknown): value is VectorRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeMilvusMetadata(value: unknown): VectorDocumentMetadata {
    if (isRecord(value)) return { ...value };
    if (typeof value !== 'string' || value.length === 0) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) ? { ...parsed } : {};
    } catch {
        return {};
    }
}

function stringValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

function numberValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

export function decodeMilvusCandidate(
    row: MilvusPhysicalRow,
    options: {
        readonly vector?: readonly number[];
        /** Selected Milvus response field must use a higher-is-better metric. */
        readonly scoreSource: 'score' | 'score-then-distance' | 'distance-then-score';
    },
): VectorCandidate {
    const score = options.scoreSource === 'score'
        ? numberValue(row.score) ?? 0
        : options.scoreSource === 'distance-then-score'
            ? numberValue(row.distance) ?? numberValue(row.score) ?? 0
            : numberValue(row.score) ?? numberValue(row.distance) ?? 0;
    return {
        document: {
            id: stringValue(row.id),
            vector: [...(options.vector ?? [])],
            content: stringValue(row.content),
            relativePath: stringValue(row.relativePath),
            startLine: numberValue(row.startLine) ?? 0,
            endLine: numberValue(row.endLine) ?? 0,
            fileExtension: stringValue(row.fileExtension),
            metadata: decodeMilvusMetadata(row.metadata),
        },
        score,
    };
}
