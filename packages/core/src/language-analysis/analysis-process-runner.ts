import { createLanguageAnalysisService } from './service';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-runner';
import type { LanguageAnalysisServiceOptions } from './types';
import type { IndexingAnalysisCapability } from './indexing-analysis';

const service = createLanguageAnalysisService(JSON.parse(process.argv[2]) as LanguageAnalysisServiceOptions);
const indexingService = service as typeof service & IndexingAnalysisCapability;
// Parent loss ends this ownership scope, including compiler/grammar capacity.
process.once('disconnect', () => process.exit(0));
process.on('message', async (message: AnalysisWorkerRequest) => {
    try {
        const result = message.mode === 'indexing'
            ? await indexingService.analyzeForIndexing(message.input)
            : await service.analyze(message.input);
        process.send?.({ id: message.id, ok: true, result } satisfies AnalysisWorkerResponse);
    } catch (error) {
        process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies AnalysisWorkerResponse);
    }
});
