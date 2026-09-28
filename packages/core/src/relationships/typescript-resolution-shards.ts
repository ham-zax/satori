import type { ResolutionClaim, ResolutionProjectEvidence } from './resolution';

// Shared by the TypeScript analyzer (in its workers) and the main thread, which
// merges shard results; this module must not load the TypeScript compiler.

/** Orders resource-limit failures the way one unsharded analysis meets them. */
export type TypeScriptResourceFailureRank = readonly [phase: number, projectIndex: number];

export interface TypeScriptShardEvidence {
    readonly evidence: ResolutionProjectEvidence;
    readonly resourceFailure?: TypeScriptResourceFailureRank;
}

/** Combines shard evidence into what one unsharded analysis returns. */
export function mergeTypeScriptShardEvidence(shards: readonly TypeScriptShardEvidence[]): ResolutionProjectEvidence {
    const failures = shards
        .filter((shard) => shard.resourceFailure)
        .sort((left, right) => (
            left.resourceFailure![0] - right.resourceFailure![0]
            || left.resourceFailure![1] - right.resourceFailure![1]
        ));
    if (failures.length > 0) return failures[0].evidence;
    const [first] = shards;
    const claimsByFile = new Map<string, readonly ResolutionClaim[]>();
    const affectedSourceFiles = new Set<string>();
    let sourceFileCount = 0;
    let analyzedSourceFileCount = 0;
    for (const { evidence } of shards) {
        for (const [file, claims] of evidence.claimsByFile) claimsByFile.set(file, claims);
        for (const file of evidence.affectedSourceFiles ?? []) affectedSourceFiles.add(file);
        sourceFileCount += evidence.coverage?.sourceFileCount ?? 0;
        analyzedSourceFileCount += evidence.coverage?.analyzedSourceFileCount ?? 0;
    }
    return {
        ...first.evidence,
        claimsByFile,
        affectedSourceFiles,
        ...(first.evidence.coverage ? {
            coverage: {
                ...first.evidence.coverage,
                status: analyzedSourceFileCount === sourceFileCount
                    ? 'complete'
                    : analyzedSourceFileCount === 0 ? 'unavailable' : 'degraded',
                sourceFileCount,
                analyzedSourceFileCount,
            },
        } : {}),
    };
}
