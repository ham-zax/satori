import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildMilvusIdInFilter,
    serializeLanceDbFilter,
    serializeMilvusFilter,
    validateVectorFilter,
} from './filters';
import { withMilvusControlExclusion } from './milvus-control-record';
import type { VectorFilter } from './types';

test('buildMilvusIdInFilter escapes Milvus string literals', () => {
    assert.equal(
        buildMilvusIdInFilter(['plain', 'quote"break', 'slash\\break']),
        'id in ["plain", "quote\\"break", "slash\\\\break"]'
    );
});

test('Milvus filter strings escape every permitted line and control character', () => {
    assert.equal(
        serializeMilvusFilter({
            kind: 'comparison',
            field: 'relativePath',
            operator: 'eq',
            value: 'src/line\nbreak\r\ttab\u007f.ts',
        }),
        'relativePath == "src/line\\nbreak\\r\\ttab\\u007f.ts"',
    );
});

test('LanceDB filter serialization escapes SQL literals and keeps the field allowlist', () => {
    assert.equal(
        serializeLanceDbFilter({
            kind: 'and',
            operands: [
                {
                    kind: 'comparison',
                    field: 'relativePath',
                    operator: 'eq',
                    value: "src/O'Brien.ts' OR 1=1 --",
                },
                {
                    kind: 'in',
                    field: 'fileExtension',
                    values: ['.ts', '.tsx'],
                },
            ],
        }),
        "(relativePath = 'src/O''Brien.ts'' OR 1=1 --') AND (fileExtension IN ('.ts', '.tsx'))",
    );
});

test('vector filter validation rejects unsupported runtime shapes', () => {
    const invalidFilters: unknown[] = [
        { kind: 'comparison', field: 'language', operator: 'eq', value: 'typescript' },
        { kind: 'comparison', field: 'relativePath', operator: 'contains', value: 'src' },
        { kind: 'comparison', field: 'relativePath', operator: 'eq', value: 1 },
        { kind: 'in', field: 'id', values: [] },
        { kind: 'and', operands: [] },
        { kind: 'or', operands: [] },
    ];
    for (const filter of invalidFilters) {
        assert.throws(() => validateVectorFilter(filter), /Vector|Unsupported/);
    }
    assert.throws(() => buildMilvusIdInFilter([]), /at least one/);
});

test('vector filter validation bounds recursive input', () => {
    let filter: unknown = {
        kind: 'comparison',
        field: 'id',
        operator: 'eq',
        value: 'chunk-1',
    };
    for (let depth = 0; depth < 16; depth++) {
        filter = { kind: 'and', operands: [filter] };
    }
    assert.throws(() => validateVectorFilter(filter), /maximum depth/);
});

test('Milvus control exclusion preserves the public filter depth and node limits', () => {
    let maximumDepthFilter: VectorFilter = {
        kind: 'comparison',
        field: 'id',
        operator: 'eq',
        value: 'chunk-1',
    };
    for (let depth = 1; depth < 16; depth++) {
        maximumDepthFilter = { kind: 'and', operands: [maximumDepthFilter] };
    }

    const maximumNodeFilter: VectorFilter = {
        kind: 'and',
        operands: Array.from({ length: 255 }, (_, index) => ({
            kind: 'comparison' as const,
            field: 'id' as const,
            operator: 'ne' as const,
            value: `chunk-${index}`,
        })),
    };

    assert.match(withMilvusControlExclusion(maximumDepthFilter), /fileExtension !=/);
    assert.match(withMilvusControlExclusion(maximumNodeFilter), /fileExtension !=/);
});

test('vector filter validation returns an immutable canonical copy', () => {
    const source = {
        kind: 'in' as const,
        field: 'id' as const,
        values: ['chunk-1'],
    };
    const validated = validateVectorFilter(source);

    source.values.push('chunk-2');
    assert.deepEqual(validated, {
        kind: 'in',
        field: 'id',
        values: ['chunk-1'],
    });
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(validated.kind === 'in' && Object.isFrozen(validated.values), true);
});
