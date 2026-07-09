import test from 'node:test';
import assert from 'node:assert/strict';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { computeMerkleRoot } from './merkle';

test('compareContractStrings uses stable code-unit order for adversarial keys', () => {
    const keys = [
        'å.ts',
        'z.ts',
        'A.ts',
        'a.ts',
        'file-2.ts',
        'file-10.ts',
        'src/a.ts',
        'src/a/index.ts',
        'src/b.ts',
        'café.ts',
        'cafe.ts',
        '10.ts',
        '2.ts',
    ];

    const sorted = [...keys].sort(compareContractStrings);
    // Expected order is pure UTF-16 code-unit order (same as Array.prototype.sort with < / >).
    const expected = [...keys].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    assert.deepEqual(sorted, expected);

    // Spot-check known code-unit relationships (not locale/natural sort).
    assert.equal(compareContractStrings('A.ts', 'a.ts') < 0, true); // 'A' < 'a'
    assert.equal(compareContractStrings('file-10.ts', 'file-2.ts') < 0, true); // '1' < '2'
    assert.equal(compareContractStrings('2.ts', '10.ts') > 0, true);
    assert.equal(compareContractStrings('src/a.ts', 'src/a/index.ts') < 0, true); // '.' < '/'
    assert.equal(compareContractStrings('cafe.ts', 'café.ts') < 0, true);
});

test('computeMerkleRoot is independent of String.prototype.localeCompare', () => {
    const fileHashes = new Map<string, string>([
        ['z.ts', 'hash-z'],
        ['å.ts', 'hash-a-ring'],
        ['A.ts', 'hash-A'],
        ['a.ts', 'hash-a'],
        ['file-10.ts', 'hash-10'],
        ['file-2.ts', 'hash-2'],
        ['src/a.ts', 'hash-src-a'],
        ['src/a/index.ts', 'hash-src-a-index'],
        ['café.ts', 'hash-cafe-acute'],
        ['cafe.ts', 'hash-cafe'],
    ]);

    const baseline = computeMerkleRoot(fileHashes);

    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = function patchedLocaleCompare(
        that: string,
        ..._args: unknown[]
    ): number {
        // Reverse lexicographic order to poison any remaining localeCompare-based sort.
        if (String(this) === that) {
            return 0;
        }
        return String(this) < that ? 1 : -1;
    };

    try {
        const poisoned = computeMerkleRoot(fileHashes);
        assert.equal(
            poisoned,
            baseline,
            'computeMerkleRoot must not depend on String.prototype.localeCompare',
        );
    } finally {
        String.prototype.localeCompare = original;
    }
});

test('computeMerkleRoot is independent of Map insertion order', () => {
    const entries: Array<[string, string]> = [
        ['z.ts', 'hash-z'],
        ['a.ts', 'hash-a'],
        ['src/b.ts', 'hash-b'],
        ['src/a.ts', 'hash-a2'],
        ['file-2.ts', 'hash-2'],
        ['file-10.ts', 'hash-10'],
        ['å.ts', 'hash-ar'],
    ];

    const mapA = new Map(entries);
    const mapB = new Map([...entries].reverse());
    const mapC = new Map([...entries].sort(() => Math.random() - 0.5));

    const rootA = computeMerkleRoot(mapA);
    const rootB = computeMerkleRoot(mapB);
    const rootC = computeMerkleRoot(mapC);

    assert.equal(rootA, rootB);
    assert.equal(rootA, rootC);
    assert.match(rootA, /^[a-f0-9]{64}$/);
});
