import { createLanguageAnalysisService } from './service';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-runner';
import type { LanguageAnalysisServiceOptions } from './types';

const service = createLanguageAnalysisService(JSON.parse(process.argv[2]) as LanguageAnalysisServiceOptions);
// Parent loss ends this ownership scope, including compiler/grammar capacity.
process.once('disconnect', () => process.exit(0));
process.on('message', async (message: AnalysisWorkerRequest) => {
    try {
        const result = await service.analyze(message.input);
        process.send?.({ id: message.id, ok: true, result } satisfies AnalysisWorkerResponse);
    } catch (error) {
        process.send?.({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies AnalysisWorkerResponse);
    }
});
