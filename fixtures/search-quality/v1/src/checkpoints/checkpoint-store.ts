import { writeFileSync } from 'node:fs';

export const SOURCE_CHECKPOINT_MISSING = 'SOURCE_CHECKPOINT_MISSING';

export function writeSourceCheckpoint(path: string, payload: string): void {
    if (payload.length === 0) {
        throw new Error(SOURCE_CHECKPOINT_MISSING);
    }
    writeFileSync(path, payload, 'utf8');
}
