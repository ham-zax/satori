// resolveSearchFlags is the single owner of the flag shape contract. Before C2 it
// accepted a token array and a record while the tool schema accepted only a
// record, so a caller could not tell from the type whether its input was
// understood. These tests pin the rejection: the resolver must name the
// offending type instead of coercing, so a malformed flag set fails at the
// boundary that owns the shape rather than silently changing retrieval.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSearchFlags } from './search-flags.js';

test('the token array form is rejected and named as an array', () => {
    // This is the form A8's F7 widened the schema to accept. Reverted in C2.
    assert.throws(
        () => resolveSearchFlags(['baseline'] as unknown as Record<string, boolean>),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /search flags must be a record of flag names to booleans/);
            assert.match(err.message, /received array/);
            return true;
        },
    );
});

test('a comma-separated string is rejected and named as a string', () => {
    assert.throws(
        () => resolveSearchFlags('no-path_demotion' as unknown as Record<string, boolean>),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /received string/);
            return true;
        },
    );
});

test('a number is rejected and named as a number', () => {
    assert.throws(
        () => resolveSearchFlags(1 as unknown as Record<string, boolean>),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /received number/);
            return true;
        },
    );
});

test('a boolean is rejected and named as a boolean', () => {
    assert.throws(
        () => resolveSearchFlags(true as unknown as Record<string, boolean>),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /received boolean/);
            return true;
        },
    );
});

test('a record whose value is not a boolean names the flag and the offending type', () => {
    // The failure must be attributable: which flag, and what it actually was.
    assert.throws(
        () => resolveSearchFlags({ path_demotion: 'no' } as unknown as Record<string, boolean>),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /search flag "path_demotion" must be a boolean/);
            assert.match(err.message, /received string/);
            return true;
        },
    );
    assert.throws(
        () => resolveSearchFlags({ path_demotion: ['no'] } as unknown as Record<string, boolean>),
        /search flag "path_demotion" must be a boolean; received array/,
    );
});

test('absent and null both mean "no explicit flags" and do not throw', () => {
    // run.mjs and every production caller pass either undefined or a record;
    // treating null as absent keeps that path total.
    assert.deepEqual(resolveSearchFlags(), resolveSearchFlags(null));
    assert.deepEqual(resolveSearchFlags(null), resolveSearchFlags({}));
});

test('an unknown flag name in a well-formed record is ignored, not an error', () => {
    // A2 removed the synonyms flag. A caller still naming it must not throw --
    // the flag simply does not exist.
    const flags = resolveSearchFlags({ synonyms: true } as unknown as Record<string, boolean>);
    assert.equal('synonyms' in flags, false);
    assert.equal(flags.compound_join, true, 'ignoring one unknown name must not disturb the defaults');
});

test('SATORI_SEARCH_FLAGS is still the one string-encoded path', () => {
    // run.mjs sets the env var rather than building a token array, so removing
    // the array form must not remove the harness's ability to pass flags.
    const previous = process.env.SATORI_SEARCH_FLAGS;
    try {
        process.env.SATORI_SEARCH_FLAGS = 'no-path_demotion,rerank_blend';
        const flags = resolveSearchFlags();
        assert.equal(flags.path_demotion, false);
        assert.equal(flags.rerank_blend, true);
        assert.equal(flags.compound_join, true);
    } finally {
        if (previous === undefined) delete process.env.SATORI_SEARCH_FLAGS;
        else process.env.SATORI_SEARCH_FLAGS = previous;
    }
});