import { refreshCheckpoint } from '../checkpoints/checkpoint-service.js';

export const GENERATED_CHECKPOINT_ERROR = 'SOURCE_CHECKPOINT_MISSING';

export function generatedWriteCheckpoint(path: string, payload: string): void {
    refreshCheckpoint(path, payload);
}
