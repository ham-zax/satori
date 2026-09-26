export const INDEX_CANDIDATE_RECEIPT_VERSION = 1 as const;

export type IndexCandidateReceiptPhase = 'reserved' | 'collection_created';

export interface IndexCandidateReceipt {
    readonly version: typeof INDEX_CANDIDATE_RECEIPT_VERSION;
    readonly canonicalRoot: string;
    readonly operationId: string;
    readonly action: 'create' | 'reindex';
    readonly generation: number;
    readonly collectionName: string;
    readonly ownerId: string;
    readonly pid: number;
    readonly processStartTime?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly phase: IndexCandidateReceiptPhase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
    return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

export function parseIndexCandidateReceipt(
    value: unknown,
    sourcePath: string,
): IndexCandidateReceipt {
    if (
        !isRecord(value)
        || value.version !== INDEX_CANDIDATE_RECEIPT_VERSION
        || !isNonEmptyString(value.canonicalRoot)
        || !isNonEmptyString(value.operationId)
        || (value.action !== 'create' && value.action !== 'reindex')
        || !Number.isSafeInteger(value.generation)
        || Number(value.generation) < 1
        || !isNonEmptyString(value.collectionName)
        || !isNonEmptyString(value.ownerId)
        || !Number.isSafeInteger(value.pid)
        || Number(value.pid) <= 0
        || (value.processStartTime !== undefined && !isNonEmptyString(value.processStartTime))
        || !isIsoTimestamp(value.createdAt)
        || !isIsoTimestamp(value.updatedAt)
        || (value.phase !== 'reserved' && value.phase !== 'collection_created')
    ) {
        throw new Error(`Invalid index candidate receipt at '${sourcePath}'.`);
    }

    return Object.freeze({
        version: INDEX_CANDIDATE_RECEIPT_VERSION,
        canonicalRoot: value.canonicalRoot,
        operationId: value.operationId,
        action: value.action,
        generation: Number(value.generation),
        collectionName: value.collectionName,
        ownerId: value.ownerId,
        pid: Number(value.pid),
        ...(value.processStartTime === undefined
            ? {}
            : { processStartTime: value.processStartTime }),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        phase: value.phase,
    });
}
