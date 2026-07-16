import type { VectorFilter, VectorFilterField, VectorFilterValue } from './types';

const VECTOR_FILTER_FIELDS = new Set<VectorFilterField>([
    'id',
    'relativePath',
    'fileExtension',
]);
const MAX_VECTOR_FILTER_DEPTH = 16;
const MAX_VECTOR_FILTER_NODES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validateVectorFilterNode(
    value: unknown,
    depth: number,
    state: { nodes: number },
): VectorFilter {
    if (depth > MAX_VECTOR_FILTER_DEPTH) {
        throw new Error(`Vector filter exceeds the maximum depth of ${MAX_VECTOR_FILTER_DEPTH}.`);
    }
    state.nodes++;
    if (state.nodes > MAX_VECTOR_FILTER_NODES) {
        throw new Error(`Vector filter exceeds the maximum node count of ${MAX_VECTOR_FILTER_NODES}.`);
    }
    if (!isRecord(value) || typeof value.kind !== 'string') {
        throw new Error('Vector filter must be an object with a supported kind.');
    }
    if (value.kind === 'comparison') {
        if (
            !hasExactKeys(value, ['kind', 'field', 'operator', 'value'])
            || !VECTOR_FILTER_FIELDS.has(value.field as VectorFilterField)
            || (value.operator !== 'eq' && value.operator !== 'ne')
            || typeof value.value !== 'string'
        ) {
            throw new Error('Vector comparison filter is malformed.');
        }
        return Object.freeze({
            kind: 'comparison',
            field: value.field as VectorFilterField,
            operator: value.operator,
            value: value.value,
        });
    }
    if (value.kind === 'in') {
        if (
            !hasExactKeys(value, ['kind', 'field', 'values'])
            || !VECTOR_FILTER_FIELDS.has(value.field as VectorFilterField)
            || !Array.isArray(value.values)
            || value.values.length === 0
            || !value.values.every((entry) => typeof entry === 'string')
        ) {
            throw new Error('Vector in filter is malformed or empty.');
        }
        return Object.freeze({
            kind: 'in',
            field: value.field as VectorFilterField,
            values: Object.freeze([...value.values]),
        });
    }
    if (value.kind === 'and') {
        if (
            !hasExactKeys(value, ['kind', 'operands'])
            || !Array.isArray(value.operands)
            || value.operands.length === 0
        ) {
            throw new Error('Vector and filter is malformed or empty.');
        }
        return Object.freeze({
            kind: 'and',
            operands: Object.freeze(value.operands.map((operand) => (
                validateVectorFilterNode(operand, depth + 1, state)
            ))),
        });
    }
    throw new Error(`Unsupported vector filter kind: ${JSON.stringify(value.kind)}.`);
}

export function validateVectorFilter(value: unknown): VectorFilter {
    return validateVectorFilterNode(value, 1, { nodes: 0 });
}

export function escapeMilvusStringLiteral(value: string): string {
    return JSON.stringify(value)
        .slice(1, -1)
        .replace(/[\u007f-\u009f]/g, (character) => (
            `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
        ))
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function buildMilvusIdInFilter(ids: readonly string[]): string {
    if (ids.length === 0 || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
        throw new Error('Milvus ID filter requires at least one non-empty string ID.');
    }
    return `id in [${ids.map((id) => `"${escapeMilvusStringLiteral(id)}"`).join(', ')}]`;
}

function serializeMilvusFilterValue(value: VectorFilterValue): string {
    return `"${escapeMilvusStringLiteral(value)}"`;
}

function serializeValidatedMilvusFilter(filter: VectorFilter): string {
    switch (filter.kind) {
        case 'comparison':
            return `${filter.field} ${filter.operator === 'eq' ? '==' : '!='} ${serializeMilvusFilterValue(filter.value)}`;
        case 'in':
            return `${filter.field} in [${filter.values.map(serializeMilvusFilterValue).join(', ')}]`;
        case 'and': {
            const operands = filter.operands.map(serializeValidatedMilvusFilter);
            return operands.length === 1
                ? operands[0]
                : operands.map((operand) => `(${operand})`).join(' and ');
        }
    }
}

export function serializeMilvusFilter(filter?: VectorFilter): string {
    return filter ? serializeValidatedMilvusFilter(validateVectorFilter(filter)) : '';
}
