import { writeSourceCheckpoint } from './checkpoint-store.js';

export function refreshCheckpoint(path: string, payload: string): void {
    writeSourceCheckpoint(path, payload);
}
