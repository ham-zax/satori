import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    getSymbolExtractorForLanguage,
} from './index';
import {
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    resolveOwnerSymbolForChunk,
} from '../../symbols';
import { buildRelationshipsForRegistry } from '../../relationships';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
} from '../../symbols';
import type { SymbolRegistryManifest } from '../../symbols';

function hash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

test('Go symbol extractor returns top-level declarations without call graph claims', () => {
    const extractor = getSymbolExtractorForLanguage('go');
    assert.ok(extractor);

    const source = [
        'package svc',
        '',
        'type User struct {',
        '  Name string',
        '}',
        '',
        'type Runner interface {',
        '  Run() error',
        '}',
        '',
        'func add(a, b int) int {',
        '  return a + b',
        '}',
        '',
        'func (s *Service) Start() error {',
        '  return nil',
        '}',
        '',
    ].join('\n');

    const symbols = extractor.extract({ content: source, relativePath: 'svc.go' });

    assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.label, symbol.qualifiedName]), [
        ['type', 'type User', 'User'],
        ['interface', 'interface Runner', 'Runner'],
        ['function', 'function add', 'add'],
        ['method', 'method Start', 'Service.Start'],
    ]);
});

test('Rust symbol extractor returns type, trait, module, function, and impl method symbols', () => {
    const extractor = getSymbolExtractorForLanguage('rs');
    assert.ok(extractor);

    const source = [
        'pub struct Stack<T> { items: Vec<T> }',
        '',
        'impl<T> Stack<T> {',
        '    pub fn new() -> Self { Stack { items: Vec::new() } }',
        '    fn push(&mut self, item: T) { self.items.push(item); }',
        '}',
        '',
        'pub trait Store { fn save(&self); }',
        'mod inner { pub fn nested() {} }',
        'fn demo() {}',
        '',
    ].join('\n');

    const symbols = extractor.extract({ content: source, relativePath: 'stack.rs' });

    assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.label, symbol.qualifiedName]), [
        ['type', 'type Stack', 'Stack'],
        ['method', 'method new', 'Stack.new'],
        ['method', 'method push', 'Stack.push'],
        ['trait', 'trait Store', 'Store'],
        ['method', 'method save', 'Store.save'],
        ['module', 'module inner', 'inner'],
        ['function', 'function nested', 'inner.nested'],
        ['function', 'function demo', 'demo'],
    ]);
});

test('Go and Rust extractors degrade malformed source to file-owner fallback eligibility', () => {
    const goExtractor = getSymbolExtractorForLanguage('go');
    const rustExtractor = getSymbolExtractorForLanguage('rust');
    assert.ok(goExtractor);
    assert.ok(rustExtractor);

    assert.deepEqual(goExtractor.extract({ content: 'package svc\nfunc broken( {\n', relativePath: 'broken.go' }), []);
    assert.deepEqual(rustExtractor.extract({ content: 'fn broken( {\n', relativePath: 'broken.rs' }), []);
});

test('extracted Go symbols become registry records and owner metadata without stale source labels', () => {
    const extractor = getSymbolExtractorForLanguage('go');
    assert.ok(extractor);
    const source = [
        'package svc',
        '',
        'func add(a, b int) int {',
        '  return a + b',
        '}',
        '',
    ].join('\n');
    const fileHash = hash(source);
    const extractedSymbols = extractor.extract({ content: source, relativePath: 'svc.go' });
    const records = buildSymbolRecordsForFile({
        relativePath: 'svc.go',
        language: 'go',
        content: source,
        fileHash,
        extractorVersion: extractor.extractorVersion,
        extractedSymbols,
        chunks: [{
            content: source,
            metadata: {
                startLine: 1,
                endLine: 6,
                language: 'go',
                filePath: 'svc.go',
            },
        }],
    });

    const add = records.find((record) => record.kind === 'function' && record.name === 'add');
    assert.ok(add);
    assert.equal(add.label, 'function add');
    assert.equal(add.qualifiedName, 'add');

    const owner = resolveOwnerSymbolForChunk({
        chunk: {
            content: 'return a + b',
            metadata: {
                startLine: 4,
                endLine: 4,
                language: 'go',
                filePath: 'svc.go',
            },
        },
        symbols: records,
    });
    assert.equal(owner.symbolInstanceId, add.symbolInstanceId);
});

test('malformed Go source publishes only synthesized file owner and no CALLS relationships', () => {
    const extractor = getSymbolExtractorForLanguage('go');
    assert.ok(extractor);
    const source = 'package svc\nfunc broken( {\n';
    const fileHash = hash(source);
    const records = buildSymbolRecordsForFile({
        relativePath: 'broken.go',
        language: 'go',
        content: source,
        fileHash,
        extractorVersion: extractor.extractorVersion,
        extractedSymbols: extractor.extract({ content: source, relativePath: 'broken.go' }),
        chunks: [{
            content: source,
            metadata: {
                startLine: 1,
                endLine: 2,
                language: 'go',
                filePath: 'broken.go',
                symbolLabel: 'function staleFromMalformedSource',
            },
        }],
    });
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root',
        indexPolicyHash: 'policy',
        languageRouterVersion: 'router',
        extractorVersion: extractor.extractorVersion,
        relationshipVersion: 'relationships',
        builtAt: '2026-06-18T00:00:00.000Z',
        files: [{
            path: 'broken.go',
            hash: fileHash,
            language: 'go',
            symbolCount: records.length,
        }],
    };
    const registry = buildSymbolRegistry({ manifest, symbols: records });

    assert.deepEqual(records.map((record) => record.kind), ['file']);
    assert.deepEqual(buildRelationshipsForRegistry({
        registry,
        contentByFile: new Map([['broken.go', source]]),
    }), []);
});

test('Go symbol-only registries do not produce CALLS relationships from generic relationship building', () => {
    const extractor = getSymbolExtractorForLanguage('go');
    assert.ok(extractor);
    const source = [
        'package svc',
        '',
        'func add(a, b int) int {',
        '  return a + b',
        '}',
        '',
        'func run() int {',
        '  return add(1, 2)',
        '}',
        '',
    ].join('\n');
    const fileHash = hash(source);
    const records = buildSymbolRecordsForFile({
        relativePath: 'svc.go',
        language: 'go',
        content: source,
        fileHash,
        extractorVersion: extractor.extractorVersion,
        extractedSymbols: extractor.extract({ content: source, relativePath: 'svc.go' }),
        chunks: [{
            content: source,
            metadata: {
                startLine: 1,
                endLine: 10,
                language: 'go',
                filePath: 'svc.go',
            },
        }],
    });
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root',
        indexPolicyHash: 'policy',
        languageRouterVersion: 'router',
        extractorVersion: extractor.extractorVersion,
        relationshipVersion: 'relationships',
        builtAt: '2026-06-18T00:00:00.000Z',
        files: [{
            path: 'svc.go',
            hash: fileHash,
            language: 'go',
            symbolCount: records.length,
        }],
    };
    const registry = buildSymbolRegistry({ manifest, symbols: records });

    assert.equal(records.some((record) => record.kind === 'function' && record.name === 'run'), true);
    assert.deepEqual(buildRelationshipsForRegistry({
        registry,
        contentByFile: new Map([['svc.go', source]]),
    }), []);
});
