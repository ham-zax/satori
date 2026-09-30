import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

export interface RelationshipResolutionProgress {
    file: string;
    completedCalls: number;
    totalCalls: number;
}

export interface RelationshipResolutionWorkOptions {
    assertCurrent?: () => void;
    onProgress?: (progress: RelationshipResolutionProgress) => void;
}

export type RelationshipResolutionWork<T> = Generator<RelationshipResolutionProgress, T, void>;

export function drainResolutionWork<T>(work: RelationshipResolutionWork<T>): T {
    let step = work.next();
    while (!step.done) step = work.next();
    return step.value;
}

/** Only completed calls are reported; cancellation cannot expose an unfinished result. */
export async function drainResolutionWorkAsync<T>(
    work: RelationshipResolutionWork<T>,
    options: RelationshipResolutionWorkOptions = {},
): Promise<T> {
    let sinceYield = 0;
    let lastYield = performance.now();
    try {
        while (true) {
            options.assertCurrent?.();
            const step = work.next();
            if (step.done) return step.value;
            sinceYield++;
            if (sinceYield === 1 && step.value.completedCalls === 1
                || sinceYield >= 64 || performance.now() - lastYield >= 25
                || step.value.completedCalls === step.value.totalCalls) {
                options.onProgress?.(step.value);
                await yieldToEventLoop();
                options.assertCurrent?.();
                sinceYield = 0;
                lastYield = performance.now();
            }
        }
    } finally {
        // The iterator owns only local result state, but close it on every
        // callback/cancellation failure so no suspended work escapes the drain.
        work.return(undefined as T);
    }
}


/** Leave room for completed relationship work below the worker's 98% cap. */
export function relationshipIndexingProgress(progress: RelationshipResolutionProgress): {
    phase: string; current: number; total: number; percentage: number;
} {
    return {
        phase: `Resolving Python calls (${progress.completedCalls}/${progress.totalCalls})...`,
        current: progress.completedCalls,
        total: progress.totalCalls,
        percentage: 90 + 8 * progress.completedCalls / progress.totalCalls,
    };
}
