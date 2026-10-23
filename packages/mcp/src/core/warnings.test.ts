import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFreshnessWarningCodes, WARNING_CODES, WARNING_CODE_SET, isWarningCode } from './warnings.js';
import type { FreshnessDecision } from './sync.js';

test('warning registry exports a unique deterministic warning code set', () => {
    const values = Object.values(WARNING_CODES);
    assert.equal(values.length > 0, true);
    assert.equal(new Set(values).size, values.length);
    assert.deepEqual([...WARNING_CODE_SET].sort(), [...values].sort());
});

test('isWarningCode accepts only registered warning identifiers', () => {
    for (const code of Object.values(WARNING_CODES)) {
        assert.equal(isWarningCode(code), true);
    }
    assert.equal(isWarningCode('UNKNOWN_WARNING_CODE'), false);
    assert.equal(isWarningCode(''), false);
    assert.equal(isWarningCode(null), false);
});

test('invalid grouped target warning is part of the authoritative registry', () => {
    assert.equal(
        WARNING_CODES.SEARCH_INVALID_GROUP_TARGET_OMITTED,
        'SEARCH_INVALID_GROUP_TARGET_OMITTED',
    );
});

test('temporary unverified suppression preserves freshness and actionable warnings', () => {
    const decision: FreshnessDecision = {
        mode: 'read_only',
        checkedAt: new Date(0).toISOString(),
        thresholdMs: 0,
        sourceFreshness: { state: 'unverified', reason: 'root_watcher_not_active' },
    };
    assert.deepEqual(buildFreshnessWarningCodes(decision), []);
    assert.deepEqual(decision.sourceFreshness, {
        state: 'unverified', reason: 'root_watcher_not_active',
    });
    assert.deepEqual(buildFreshnessWarningCodes({
        ...decision, mode: 'skipped_source_checkpoint_unavailable',
    }), [WARNING_CODES.SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE]);
    assert.deepEqual(buildFreshnessWarningCodes({
        ...decision, mode: 'served_previous_generation',
    }), [WARNING_CODES.SOURCE_CHANGES_PENDING]);
    assert.deepEqual(buildFreshnessWarningCodes({
        ...decision, sourceFreshness: { state: 'changed', reason: 'exact_source_comparison' },
    }), [WARNING_CODES.SOURCE_CHANGES_PENDING]);
    assert.deepEqual(buildFreshnessWarningCodes({
        ...decision, sourceFreshness: { state: 'index_snapshot', reason: 'watcher_manager_not_started' },
    }), [WARNING_CODES.SOURCE_SERVED_FROM_INDEX_SNAPSHOT]);
});
