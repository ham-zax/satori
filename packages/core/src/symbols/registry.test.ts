import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    buildSymbolRecordsForFile,
    computeSymbolRegistryManifestHash,
    createSymbolInstanceId,
    createSymbolKey,
    createSynthesizedFileSymbol,
    resolveOwnerSymbolForChunk,
} from './registry';
import type { SymbolRecord, SymbolRegistryManifest } from './contracts';

function manifest(files: SymbolRegistryManifest['files']): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fingerprint',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files,
    };
}

test('symbol identity separates stable key from exact instance id', () => {
    const symbolKey = createSymbolKey({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        kind: 'method',
        qualifiedName: 'AuthService.login',
        parentQualifiedNamePath: ['class AuthService'],
    });

    const sameAfterLineOnlyEdit = createSymbolKey({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        kind: 'method',
        qualifiedName: 'AuthService.login',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const renamed = createSymbolKey({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        kind: 'method',
        qualifiedName: 'AuthService.authenticate',
        parentQualifiedNamePath: ['class AuthService'],
    });

    assert.equal(symbolKey, sameAfterLineOnlyEdit);
    assert.notEqual(symbolKey, renamed);

    const beforeEdit = createSymbolInstanceId({
        symbolKey,
        fileHash: 'file-hash-a',
        span: { startLine: 10, endLine: 20, startByte: 100, endByte: 250 },
        extractorVersion: 'extractor-v1',
    });
    const afterLineInsertion = createSymbolInstanceId({
        symbolKey,
        fileHash: 'file-hash-b',
        span: { startLine: 12, endLine: 22, startByte: 120, endByte: 270 },
        extractorVersion: 'extractor-v1',
    });

    assert.notEqual(beforeEdit, afterLineInsertion);
});

test('synthesized file symbol has deterministic fallback-owner shape', () => {
    const symbol = createSynthesizedFileSymbol({
        relativePath: 'src/routes/auth.ts',
        language: 'typescript',
        content: 'export function login() {\n  return true;\n}\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    });

    assert.equal(symbol.kind, 'file');
    assert.equal(symbol.name, 'auth.ts');
    assert.equal(symbol.qualifiedName, 'src/routes/auth.ts');
    assert.deepEqual(symbol.parentQualifiedNamePath, []);
    assert.deepEqual(symbol.span, {
        startLine: 1,
        endLine: 3,
        startByte: 0,
        endByte: Buffer.byteLength('export function login() {\n  return true;\n}\n', 'utf8'),
    });
});

test('symbol registry treats logical-key multiplicity as candidates, not corruption', () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: 'export class AuthService {}\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    });
    const method: SymbolRecord = {
        symbolKey: createSymbolKey({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            kind: 'method',
            qualifiedName: 'AuthService.login',
            parentQualifiedNamePath: ['class AuthService'],
        }),
        symbolInstanceId: 'method-instance',
        language: 'typescript',
        kind: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        label: 'method login()',
        file: 'src/auth.ts',
        span: { startLine: 4, endLine: 8 },
        parentQualifiedNamePath: ['class AuthService'],
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    };

    const registry = buildSymbolRegistry({
        manifest: manifest([{ path: 'src/auth.ts', hash: 'file-hash', language: 'typescript', symbolCount: 2 }]),
        symbols: [method, fileOwner, { ...method, symbolInstanceId: 'method-overload-instance' }],
    });

    assert.equal(registry.symbolsByInstanceId.get(fileOwner.symbolInstanceId), fileOwner);
    assert.deepEqual(registry.symbolsByFile.get('src/auth.ts')?.map((symbol) => symbol.kind), ['file', 'method', 'method']);
    assert.deepEqual(registry.symbolsByLabel.get('method login()')?.map((symbol) => symbol.symbolInstanceId), [
        'method-instance',
        'method-overload-instance',
    ]);
    assert.equal(registry.symbolsByKey.get(method.symbolKey)?.length, 2);
    assert.deepEqual(registry.warnings, []);
});

test('extracted namespace occurrences retain one stable key and distinct exact instances', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/namespaces.ts',
        language: 'typescript',
        content: [
            'namespace Billing { export class Invoice {} }',
            'namespace Billing { export function run() {} }',
        ].join('\n'),
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v2',
        chunks: [],
        extractedSymbols: [
            {
                kind: 'namespace',
                name: 'Billing',
                label: 'namespace Billing',
                qualifiedName: 'Billing',
                parentQualifiedNamePath: [],
                span: { startLine: 1, endLine: 1, startByte: 0, endByte: 47 },
            },
            {
                kind: 'class',
                name: 'Invoice',
                label: 'class Invoice',
                qualifiedName: 'Billing.Invoice',
                parentQualifiedNamePath: ['Billing'],
                span: { startLine: 1, endLine: 1, startByte: 27, endByte: 43 },
            },
            {
                kind: 'namespace',
                name: 'Billing',
                label: 'namespace Billing',
                qualifiedName: 'Billing',
                parentQualifiedNamePath: [],
                span: { startLine: 2, endLine: 2, startByte: 48, endByte: 96 },
            },
        ],
    });

    const namespaces = records.filter((record) => record.kind === 'namespace');
    assert.equal(namespaces.length, 2);
    assert.equal(new Set(namespaces.map((record) => record.symbolKey)).size, 1);
    assert.equal(new Set(namespaces.map((record) => record.symbolInstanceId)).size, 2);

    const invoice = records.find((record) => record.name === 'Invoice');
    assert.equal(invoice?.qualifiedName, 'Billing.Invoice');
    assert.deepEqual(invoice?.parentQualifiedNamePath, ['Billing']);
});

test('extracted Rust macro retains its persisted macro kind and module ownership', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/lib.rs',
        language: 'rust',
        content: 'mod storage { macro_rules! build { () => {} } }',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v15',
        chunks: [],
        extractedSymbols: [{
            kind: 'macro',
            name: 'build',
            label: 'macro build',
            qualifiedName: 'storage.build',
            parentQualifiedNamePath: ['storage'],
            span: { startLine: 1, endLine: 1, startByte: 14, endByte: 47 },
        }],
    });

    const macro = records.find((record) => record.kind === 'macro');
    assert.equal(macro?.qualifiedName, 'storage.build');
    assert.deepEqual(macro?.parentQualifiedNamePath, ['storage']);
});

test('symbol registry manifest hash is stable across file order and ignores display path timing churn', () => {
    const first = manifest([
        { path: 'src/b.ts', hash: 'hash-b', language: 'typescript', symbolCount: 1 },
        { path: 'src/a.ts', hash: 'hash-a', language: 'typescript', symbolCount: 1 },
    ]);
    const second = {
        ...first,
        normalizedRootPath: '/different/checkout/path',
        builtAt: '2026-06-18T00:00:00.000Z',
        files: [...first.files].reverse(),
    };

    assert.equal(computeSymbolRegistryManifestHash(first), computeSymbolRegistryManifestHash(second));
    assert.notEqual(
        computeSymbolRegistryManifestHash(first),
        computeSymbolRegistryManifestHash({ ...first, indexPolicyHash: 'different-policy' })
    );
    assert.notEqual(
        computeSymbolRegistryManifestHash(first),
        computeSymbolRegistryManifestHash({ ...first, extractorVersion: 'extractor-v2' })
    );
});

test('buildSymbolRecordsForFile converts splitter metadata into synthesized and extracted symbols', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: [
            'export class AuthService {',
            '  async login(input: string) {',
            '    return input;',
            '  }',
            '}',
        ].join('\n'),
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [
            {
                content: 'export class AuthService {}',
                metadata: {
                    startLine: 1,
                    endLine: 5,
                    language: 'typescript',
                    filePath: 'src/auth.ts',
                    symbolLabel: 'class AuthService',
                    breadcrumbs: ['class AuthService'],
                },
            },
            {
                content: 'async login(input: string) { return input; }',
                metadata: {
                    startLine: 2,
                    endLine: 4,
                    language: 'typescript',
                    filePath: 'src/auth.ts',
                    symbolLabel: 'async method login(input: string)',
                    breadcrumbs: ['class AuthService', 'async method login(input: string)'],
                },
            },
        ],
    });

    assert.equal(records.length, 3);
    assert.equal(records[0].kind, 'file');

    const service = records.find((record) => record.label === 'class AuthService');
    const login = records.find((record) => record.label === 'async method login(input: string)');

    assert.ok(service);
    assert.equal(service.kind, 'class');
    assert.equal(service.name, 'AuthService');
    assert.equal(service.qualifiedName, 'AuthService');
    assert.deepEqual(service.parentQualifiedNamePath, []);

    assert.ok(login);
    assert.equal(login.kind, 'method');
    assert.equal(login.name, 'login');
    assert.equal(login.qualifiedName, 'AuthService.login');
    assert.deepEqual(login.parentQualifiedNamePath, ['class AuthService']);
    assert.notEqual(login.symbolKey, service.symbolKey);
    assert.notEqual(login.symbolInstanceId, login.symbolKey);
});

test('buildSymbolRecordsForFile skips chunks without labels and deduplicates repeated splitter metadata', () => {
    const chunks = [
        {
            content: 'def health_check(request):\n    return True',
            metadata: {
                startLine: 1,
                endLine: 2,
                language: 'python',
                filePath: 'src/routes.py',
                symbolLabel: 'function health_check(request)',
                breadcrumbs: ['function health_check(request)'],
            },
        },
        {
            content: 'def health_check(request):\n    return True',
            metadata: {
                startLine: 1,
                endLine: 2,
                language: 'python',
                filePath: 'src/routes.py',
                symbolLabel: 'function health_check(request)',
                breadcrumbs: ['function health_check(request)'],
            },
        },
        {
            content: 'print("module body")',
            metadata: {
                startLine: 4,
                endLine: 4,
                language: 'python',
                filePath: 'src/routes.py',
            },
        },
    ];

    const records = buildSymbolRecordsForFile({
        relativePath: 'src/routes.py',
        language: 'python',
        content: 'def health_check(request):\n    return True\n\nprint("module body")\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks,
    });

    assert.equal(records.length, 2);
    assert.equal(records[0].kind, 'file');
    assert.equal(records[1].kind, 'function');
    assert.equal(records[1].name, 'health_check');
    assert.equal(records[1].qualifiedName, 'health_check');
});

test('buildSymbolRecordsForFile collapses overlapping chunk-derived symbols by stable identity', () => {
    const label = 'async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput)';
    const chunks = [
        {
            content: 'export async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput) {',
            metadata: {
                startLine: 501,
                endLine: 584,
                language: 'typescript',
                filePath: 'packages/core/src/symbols/sidecar.ts',
                symbolLabel: label,
                breadcrumbs: [label],
            },
        },
        {
            content: 'async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput) {',
            metadata: {
                startLine: 511,
                endLine: 584,
                language: 'typescript',
                filePath: 'packages/core/src/symbols/sidecar.ts',
                symbolLabel: label,
                breadcrumbs: [label],
            },
        },
        {
            content: 'return registry;',
            metadata: {
                startLine: 577,
                endLine: 622,
                language: 'typescript',
                filePath: 'packages/core/src/symbols/sidecar.ts',
                symbolLabel: label,
                breadcrumbs: [label],
            },
        },
    ];

    const records = buildSymbolRecordsForFile({
        relativePath: 'packages/core/src/symbols/sidecar.ts',
        language: 'typescript',
        content: 'export async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput) {}\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks,
    });

    const symbols = records.filter((record) => record.kind !== 'file');
    const matches = records.filter((record) => record.label === label);
    const symbolInstanceIds = new Set(records.map((record) => record.symbolInstanceId));

    assert.equal(symbols.length, 1);
    assert.equal(matches.length, 1);
    assert.equal(symbolInstanceIds.size, records.length);
    assert.deepEqual(matches[0]?.span, {
        startLine: 501,
        endLine: 622,
    });
    assert.notEqual(matches[0]?.symbolInstanceId, matches[0]?.symbolKey);
});

test('buildSymbolRecordsForFile keeps same-line anonymous callbacks distinct with byte spans', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/sidecar.ts',
        language: 'typescript',
        content: 'entries.filter((candidate) => candidate.isFile()).sort((a, b) => compare(a.name, b.name));\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [
            {
                content: '(candidate) => candidate.isFile()',
                metadata: {
                    startLine: 1,
                    endLine: 1,
                    startByte: 15,
                    endByte: 47,
                    language: 'typescript',
                    filePath: 'src/sidecar.ts',
                    symbolLabel: 'function <anonymous>(candidate)',
                    breadcrumbs: ['function parent()', 'function <anonymous>(candidate)'],
                },
            },
            {
                content: '(a, b) => compare(a.name, b.name)',
                metadata: {
                    startLine: 1,
                    endLine: 1,
                    startByte: 54,
                    endByte: 87,
                    language: 'typescript',
                    filePath: 'src/sidecar.ts',
                    symbolLabel: 'function <anonymous>(a, b)',
                    breadcrumbs: ['function parent()', 'function <anonymous>(a, b)'],
                },
            },
        ],
    });

    const callbacks = records
        .filter((record) => record.name === '<anonymous>')
        .sort((a, b) => (a.span.startByte ?? 0) - (b.span.startByte ?? 0));

    assert.equal(callbacks.length, 2);
    assert.deepEqual(callbacks.map((record) => record.span.startByte), [15, 54]);
    assert.equal(new Set(callbacks.map((record) => record.symbolInstanceId)).size, 2);
    assert.doesNotThrow(() => buildSymbolRegistry({
        manifest: manifest([{ path: 'src/sidecar.ts', hash: 'file-hash', language: 'typescript', symbolCount: records.length }]),
        symbols: records,
    }));
});

test('buildSymbolRecordsForFile merges multiline symbol columns from selected boundary lines', () => {
    const label = 'function render()';
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/view.ts',
        language: 'typescript',
        content: 'export function render() {}\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [
            {
                content: 'middle',
                metadata: {
                    startLine: 10,
                    endLine: 20,
                    startByte: 100,
                    endByte: 300,
                    startColumn: 40,
                    endColumn: 5,
                    language: 'typescript',
                    filePath: 'src/view.ts',
                    symbolLabel: label,
                    breadcrumbs: [label],
                },
            },
            {
                content: 'start',
                metadata: {
                    startLine: 8,
                    endLine: 12,
                    startByte: 50,
                    endByte: 180,
                    startColumn: 2,
                    endColumn: 80,
                    language: 'typescript',
                    filePath: 'src/view.ts',
                    symbolLabel: label,
                    breadcrumbs: [label],
                },
            },
        ],
    });

    const match = records.find((record) => record.label === label);

    assert.deepEqual(match?.span, {
        startLine: 8,
        endLine: 20,
        startByte: 50,
        endByte: 300,
        startColumn: 2,
        endColumn: 5,
    });
});

test('resolveOwnerSymbolForChunk chooses tightest extracted line owner before synthesized file fallback', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: [
            'export class AuthService {',
            '  async login(input: string) {',
            '    return input.trim();',
            '  }',
            '',
            '  logout() {',
            '    return true;',
            '  }',
            '}',
        ].join('\n'),
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [
            {
                content: 'export class AuthService {}',
                metadata: {
                    startLine: 1,
                    endLine: 9,
                    symbolLabel: 'class AuthService',
                    breadcrumbs: ['class AuthService'],
                },
            },
            {
                content: 'async login(input: string) { return input.trim(); }',
                metadata: {
                    startLine: 2,
                    endLine: 4,
                    symbolLabel: 'async method login(input: string)',
                    breadcrumbs: ['class AuthService', 'async method login(input: string)'],
                },
            },
        ],
    });

    const owner = resolveOwnerSymbolForChunk({
        chunk: {
            content: 'return input.trim();',
            metadata: { startLine: 3, endLine: 3 },
        },
        symbols: records,
    });

    assert.equal(owner.kind, 'method');
    assert.equal(owner.qualifiedName, 'AuthService.login');
});

test('resolveOwnerSymbolForChunk prefers byte-contained extracted owner over line-contained owner', () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: '0123456789\n0123456789\n0123456789\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    });
    const broadLineOwner: SymbolRecord = {
        symbolKey: 'broad-key',
        symbolInstanceId: 'broad-instance',
        language: 'typescript',
        kind: 'class',
        name: 'AuthService',
        qualifiedName: 'AuthService',
        label: 'class AuthService',
        file: 'src/auth.ts',
        span: { startLine: 1, endLine: 3 },
        parentQualifiedNamePath: [],
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    };
    const byteOwner: SymbolRecord = {
        ...broadLineOwner,
        symbolKey: 'byte-key',
        symbolInstanceId: 'byte-instance',
        kind: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        label: 'method login()',
        span: { startLine: 1, endLine: 3, startByte: 12, endByte: 20 },
        parentQualifiedNamePath: ['class AuthService'],
    };

    const owner = resolveOwnerSymbolForChunk({
        chunk: {
            content: 'login',
            metadata: {
                startLine: 2,
                endLine: 2,
                startByte: 14,
                endByte: 18,
            },
        },
        symbols: [fileOwner, broadLineOwner, byteOwner],
    });

    assert.equal(owner.symbolInstanceId, 'byte-instance');
});

test('resolveOwnerSymbolForChunk falls back to synthesized file owner and tie-breaks deterministically', () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: 'export const auth = true;\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    });
    const first: SymbolRecord = {
        symbolKey: 'a-key',
        symbolInstanceId: 'a-instance',
        language: 'typescript',
        kind: 'function',
        name: 'a',
        qualifiedName: 'a',
        label: 'function a()',
        file: 'src/auth.ts',
        span: { startLine: 1, endLine: 1 },
        parentQualifiedNamePath: [],
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
    };
    const second: SymbolRecord = {
        ...first,
        symbolKey: 'b-key',
        symbolInstanceId: 'b-instance',
        name: 'b',
        qualifiedName: 'b',
        label: 'function b()',
    };

    const owner = resolveOwnerSymbolForChunk({
        chunk: { content: 'export const auth = true;', metadata: { startLine: 1, endLine: 1 } },
        symbols: [fileOwner, second, first],
    });
    const fallback = resolveOwnerSymbolForChunk({
        chunk: { content: 'missing', metadata: { startLine: 10, endLine: 10 } },
        symbols: [fileOwner, second, first],
    });

    assert.equal(owner.symbolInstanceId, 'a-instance');
    assert.equal(fallback.symbolInstanceId, fileOwner.symbolInstanceId);
});

test('buildSymbolRecordsForFile normalizes parent identity away from display signatures', () => {
    const first = buildSymbolRecordsForFile({
        relativePath: 'src/nested.ts',
        language: 'typescript',
        content: 'function parent(input: string) { function child() {} }\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [{
            content: 'function child() {}',
            metadata: {
                startLine: 1,
                endLine: 1,
                language: 'typescript',
                filePath: 'src/nested.ts',
                symbolLabel: 'function child()',
                breadcrumbs: ['function parent(input: string)', 'function child()'],
            },
        }],
    });
    const second = buildSymbolRecordsForFile({
        relativePath: 'src/nested.ts',
        language: 'typescript',
        content: 'function parent(renamed: string) { function child() {} }\n',
        fileHash: 'file-hash-2',
        extractorVersion: 'extractor-v1',
        chunks: [{
            content: 'function child() {}',
            metadata: {
                startLine: 1,
                endLine: 1,
                language: 'typescript',
                filePath: 'src/nested.ts',
                symbolLabel: 'function child()',
                breadcrumbs: ['function parent(renamed: string)', 'function child()'],
            },
        }],
    });

    const firstChild = first.find((record) => record.label === 'function child()');
    const secondChild = second.find((record) => record.label === 'function child()');

    assert.ok(firstChild);
    assert.ok(secondChild);
    assert.deepEqual(firstChild.parentQualifiedNamePath, ['function parent']);
    assert.deepEqual(secondChild.parentQualifiedNamePath, ['function parent']);
    assert.equal(firstChild.qualifiedName, 'parent.child');
    assert.equal(firstChild.symbolKey, secondChild.symbolKey);
    assert.notEqual(firstChild.symbolInstanceId, secondChild.symbolInstanceId);
});

test('buildSymbolRecordsForFile drops normalized self breadcrumbs from long fallback labels', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/phases.py',
        language: 'python',
        content: 'def _attach_entry_telemetry(trade, signal, entry_decision, pending):\n    return None\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [{
            content: 'def _attach_entry_telemetry(trade, signal, entry_decision, pending):\n    return None',
            metadata: {
                startLine: 1,
                endLine: 2,
                language: 'python',
                filePath: 'src/phases.py',
                symbolLabel: 'function _attach_entry_telemetry( trade, signal, entry_decision, pending )',
                breadcrumbs: ['function _attach_entry_telemetry( trade, signal, entry_decision, pending...'],
            },
        }],
    });

    const attach = records.find((record) => record.name === '_attach_entry_telemetry');

    assert.ok(attach);
    assert.deepEqual(attach.parentQualifiedNamePath, []);
    assert.equal(attach.qualifiedName, '_attach_entry_telemetry');
});

test('buildSymbolRecordsForFile strips type-like suffixes from class and interface names', () => {
    const records = buildSymbolRecordsForFile({
        relativePath: 'src/models.py',
        language: 'python',
        content: 'class User(BaseModel):\n    pass\n',
        fileHash: 'file-hash',
        extractorVersion: 'extractor-v1',
        chunks: [{
            content: 'class User(BaseModel):\n    pass',
            metadata: {
                startLine: 1,
                endLine: 2,
                language: 'python',
                filePath: 'src/models.py',
                symbolLabel: 'class User(BaseModel)',
                breadcrumbs: ['class User(BaseModel)'],
            },
        }],
    });

    const user = records.find((record) => record.label === 'class User(BaseModel)');

    assert.ok(user);
    assert.equal(user.kind, 'class');
    assert.equal(user.name, 'User');
    assert.equal(user.qualifiedName, 'User');
});

test('buildSymbolRegistry uses deterministic byte-order sorting and rejects duplicate exact ids', () => {
    const upper = createSynthesizedFileSymbol({
        relativePath: 'src/Z.ts',
        language: 'typescript',
        content: 'export const Z = 1;\n',
        fileHash: 'hash-z',
        extractorVersion: 'extractor-v1',
    });
    const lower = createSynthesizedFileSymbol({
        relativePath: 'src/a.ts',
        language: 'typescript',
        content: 'export const a = 1;\n',
        fileHash: 'hash-a',
        extractorVersion: 'extractor-v1',
    });

    const registry = buildSymbolRegistry({
        manifest: manifest([
            { path: 'src/Z.ts', hash: 'hash-z', language: 'typescript', symbolCount: 1 },
            { path: 'src/a.ts', hash: 'hash-a', language: 'typescript', symbolCount: 1 },
        ]),
        symbols: [lower, upper],
    });

    assert.deepEqual(registry.symbols.map((symbol) => symbol.file), ['src/Z.ts', 'src/a.ts']);
    assert.throws(
        () => buildSymbolRegistry({
            manifest: manifest([{ path: 'src/a.ts', hash: 'hash-a', language: 'typescript', symbolCount: 2 }]),
            symbols: [lower, { ...lower }],
        }),
        /Duplicate symbolInstanceId/
    );
});
