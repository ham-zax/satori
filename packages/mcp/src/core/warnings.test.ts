import test from 'node:test';
import assert from 'node:assert/strict';
import { WARNING_CODES, WARNING_CODE_SET, isWarningCode } from './warnings.js';

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
