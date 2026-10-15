import type { ExtractedSymbol } from '../languages';
import { createAnalysisChunkPlan, type AnalysisChunkPlan, type AnalysisChunkPlanKind, type ChunkOptions } from './chunks';
import type {
    LanguageAnalysisInput,
    LanguageAnalysisPort,
    LanguageAnalysisResult,
} from './types';

type WithoutChunks<T> = T extends unknown ? Omit<T, 'chunks'> : never;

export interface SerializableIndexingChunkPlan {
    readonly kind: AnalysisChunkPlanKind;
    readonly options: ChunkOptions;
}

/** Internal result used only by built-in indexing analysis and its worker transports. */
export type IndexingAnalysisResult = WithoutChunks<LanguageAnalysisResult> & {
    readonly chunkPlan: SerializableIndexingChunkPlan;
};

export interface IndexingAnalysisCapability {
    analyzeForIndexing(input: LanguageAnalysisInput): Promise<IndexingAnalysisResult>;
}

export type AnalysisWorkerPayload = LanguageAnalysisResult | IndexingAnalysisResult;

export function hasIndexingAnalysisCapability(
    analyzer: LanguageAnalysisPort,
): analyzer is LanguageAnalysisPort & IndexingAnalysisCapability {
    return typeof (analyzer as LanguageAnalysisPort & Partial<IndexingAnalysisCapability>)
        .analyzeForIndexing === 'function';
}

export function createIndexingChunkPlan(input: {
    readonly content: string;
    readonly relativePath: string;
    readonly language: string;
    readonly symbols: readonly ExtractedSymbol[];
    readonly result: IndexingAnalysisResult;
}): AnalysisChunkPlan {
    return createAnalysisChunkPlan(
        input.content,
        input.relativePath,
        input.language,
        input.symbols,
        input.result.chunkPlan.options,
        input.result.chunkPlan.kind,
    );
}
