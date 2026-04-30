import type { VectorDatabase } from './types';

export interface VerifiedCollectionDeleteOptions {
    maxAttempts?: number;
    initialBackoffMs?: number;
    backoffMultiplier?: number;
    sleep?: (ms: number) => Promise<void>;
}

export interface VerifiedCollectionDeleteResult {
    collectionName: string;
    attempts: number;
    verifiedAbsent: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 100;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class RemoteCollectionDeletePendingError extends Error {
    public readonly collectionName: string;
    public readonly attempts: number;
    public readonly lastError?: unknown;

    constructor(collectionName: string, attempts: number, lastError?: unknown) {
        const detail = lastError ? ` Last error: ${formatError(lastError)}` : '';
        super(`Remote collection deletion did not complete for '${collectionName}' after ${attempts} attempt(s).${detail}`);
        this.name = 'RemoteCollectionDeletePendingError';
        this.collectionName = collectionName;
        this.attempts = attempts;
        this.lastError = lastError;
    }
}

export async function deleteCollectionWithVerification(
    vectorDatabase: Pick<VectorDatabase, 'dropCollection' | 'hasCollection'>,
    collectionName: string,
    options: VerifiedCollectionDeleteOptions = {}
): Promise<VerifiedCollectionDeleteResult> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    const initialBackoffMs = Math.max(0, options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS);
    const backoffMultiplier = Math.max(1, options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER);
    const sleep = options.sleep ?? defaultSleep;

    if (!await vectorDatabase.hasCollection(collectionName)) {
        return { collectionName, attempts: 0, verifiedAbsent: true };
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        lastError = undefined;
        try {
            await vectorDatabase.dropCollection(collectionName);
        } catch (error) {
            lastError = error;
        }

        try {
            const stillExists = await vectorDatabase.hasCollection(collectionName);
            if (!stillExists) {
                return { collectionName, attempts: attempt, verifiedAbsent: true };
            }
            if (!lastError) {
                lastError = new Error(`dropCollection returned successfully but '${collectionName}' still exists.`);
            }
        } catch (error) {
            lastError = error;
        }

        if (attempt < maxAttempts && initialBackoffMs > 0) {
            await sleep(initialBackoffMs * Math.pow(backoffMultiplier, attempt - 1));
        }
    }

    throw new RemoteCollectionDeletePendingError(collectionName, maxAttempts, lastError);
}
