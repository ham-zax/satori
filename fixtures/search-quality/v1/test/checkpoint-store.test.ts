import { strict as assert } from 'node:assert';
import {
    SOURCE_CHECKPOINT_MISSING,
    writeSourceCheckpoint,
} from '../src/checkpoints/checkpoint-store.js';

export function verifiesCheckpointWriter(): void {
    assert.equal(SOURCE_CHECKPOINT_MISSING, 'SOURCE_CHECKPOINT_MISSING');
    assert.equal(typeof writeSourceCheckpoint, 'function');
}
