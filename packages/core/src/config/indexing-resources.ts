import { envManager } from '../utils/env-manager';

export interface IndexingResourceOverrides {
    readonly budgetBytes?: number;
    readonly analysisWorkers?: number;
    readonly diagnostics: readonly string[];
}

/** Operator input is validated once where it enters, through the existing env owner. */
export function readIndexingResourceOverrides(env: Pick<typeof envManager, 'get'> = envManager): IndexingResourceOverrides {
    const diagnostics: string[] = [];
    const rawBudget = env.get('SATORI_INDEX_MEMORY_BUDGET_MB');
    let budgetBytes: number | undefined;
    if (rawBudget !== undefined) {
        const value = rawBudget.trim();
        const megabytes = Number(value);
        if (/^\d+$/.test(value) && Number.isSafeInteger(megabytes) && megabytes > 0
            && Number.isSafeInteger(megabytes * 1024 * 1024)) budgetBytes = megabytes * 1024 * 1024;
        else diagnostics.push('SATORI_INDEX_MEMORY_BUDGET_MB must be a positive integer; using the derived memory budget.');
    }
    const rawWorkers = env.get('SATORI_ANALYSIS_WORKERS');
    const workers = rawWorkers === undefined ? NaN : Number.parseInt(rawWorkers, 10);
    // Preserve the existing parser override, including zero (in-process analysis).
    const analysisWorkers = Number.isSafeInteger(workers) && workers >= 0 ? workers : undefined;
    return Object.freeze({ budgetBytes, analysisWorkers, diagnostics: Object.freeze(diagnostics) });
}
