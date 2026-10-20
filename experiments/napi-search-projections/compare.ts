import assert from 'node:assert/strict';
import type { SearchProjections } from '../../packages/core/src/vectordb/types';

/** Fixed field order compares complete strings and versions, including all bytes. */
export function projectionBytes(value: SearchProjections): string {
    return JSON.stringify([value.embeddingText, value.lexicalText, value.embeddingVersion, value.lexicalVersion]);
}
export function assertProjectionEqual(actual: SearchProjections, expected: SearchProjections, label = 'projection'): void {
    assert.equal(projectionBytes(actual), projectionBytes(expected), `${label}: projection mismatch`);
    assert.deepEqual(Object.keys(actual).sort(), ['embeddingText', 'embeddingVersion', 'lexicalText', 'lexicalVersion']);
}
