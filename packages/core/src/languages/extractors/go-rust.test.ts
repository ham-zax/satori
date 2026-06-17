import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    getSymbolExtractorForLanguage,
} from './index';
import { getLanguageCapabilityDeclaration } from '../capabilities';
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
import type { ExtractedSymbol } from '../types';

interface ExpectedFixtureSymbol {
    readonly kind: string;
    readonly name: string;
    readonly label: string;
    readonly qualifiedName: string;
    readonly parentQualifiedNamePath?: readonly string[];
    readonly span: {
        readonly startLine: number;
        readonly endLine: number;
    };
}

interface ExpectedFixtureEdges {
    readonly calls: readonly unknown[];
}

interface ExpectedFixtureToolOutputs {
    readonly language: string;
    readonly tier: string;
    readonly searchCodebase: {
        readonly nextActionsCallGraph: boolean;
    };
    readonly callGraph: {
        readonly supported: boolean;
        readonly reason: string;
    };
}

function hash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function fixturePath(fixtureName: string, fileName: string): string {
    const relativePath = path.join('fixtures', 'navigation', fixtureName, fileName);
    const candidates = [
        path.resolve(process.cwd(), relativePath),
        path.resolve(process.cwd(), '../..', relativePath),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

function readFixtureFile(fixtureName: string, fileName: string): string {
    return fs.readFileSync(fixturePath(fixtureName, fileName), 'utf8');
}

function readFixtureJson<T>(fixtureName: string, fileName: string): T {
    return JSON.parse(readFixtureFile(fixtureName, fileName)) as T;
}

function summarizeExtractedSymbol(symbol: ExtractedSymbol): ExpectedFixtureSymbol {
    const summary: ExpectedFixtureSymbol = {
        kind: symbol.kind,
        name: symbol.name,
        label: symbol.label,
        qualifiedName: symbol.qualifiedName || '',
        span: {
            startLine: symbol.span.startLine,
            endLine: symbol.span.endLine,
        },
    };
    return symbol.parentQualifiedNamePath && symbol.parentQualifiedNamePath.length > 0
        ? { ...summary, parentQualifiedNamePath: symbol.parentQualifiedNamePath }
        : summary;
}

function buildFixtureRegistry(input: {
    fixtureName: string;
    relativePath: string;
    language: string;
    extractorVersion: string;
    source: string;
    extractedSymbols: readonly ExtractedSymbol[];
}) {
    const fileHash = hash(input.source);
    const records = buildSymbolRecordsForFile({
        relativePath: input.relativePath,
        language: input.language,
        content: input.source,
        fileHash,
        extractorVersion: input.extractorVersion,
        extractedSymbols: input.extractedSymbols,
        chunks: [{
            content: input.source,
            metadata: {
                startLine: 1,
                endLine: input.source.split('\n').length,
                language: input.language,
                filePath: input.relativePath,
            },
        }],
    });
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: `/fixtures/navigation/${input.fixtureName}`,
        rootFingerprint: 'fixture-root',
        indexPolicyHash: 'fixture-policy',
        languageRouterVersion: 'fixture-router',
        extractorVersion: input.extractorVersion,
        relationshipVersion: 'relationships',
        builtAt: '2026-06-18T00:00:00.000Z',
        files: [{
            path: input.relativePath,
            hash: fileHash,
            language: input.language,
            symbolCount: records.length,
        }],
    };
    return buildSymbolRegistry({ manifest, symbols: records });
}

test('Go navigation fixture matches extractor and no-graph golden expectations', () => {
    const fixtureName = 'go-basic-symbols';
    const relativePath = 'svc.go';
    const source = readFixtureFile(fixtureName, relativePath);
    const expectedSymbols = readFixtureJson<ExpectedFixtureSymbol[]>(fixtureName, 'expected_symbols.json');
    const expectedEdges = readFixtureJson<ExpectedFixtureEdges>(fixtureName, 'expected_edges.json');
    const expectedToolOutputs = readFixtureJson<ExpectedFixtureToolOutputs>(fixtureName, 'expected_tool_outputs.json');
    const declaration = getLanguageCapabilityDeclaration(expectedToolOutputs.language);
    const extractor = getSymbolExtractorForLanguage(expectedToolOutputs.language);
    assert.ok(extractor);

    const symbols = extractor.extract({ content: source, relativePath });
    const registry = buildFixtureRegistry({
        fixtureName,
        relativePath,
        language: expectedToolOutputs.language,
        extractorVersion: extractor.extractorVersion,
        source,
        extractedSymbols: symbols,
    });

    assert.equal(declaration?.publicClaim, expectedToolOutputs.tier);
    assert.equal(expectedToolOutputs.searchCodebase.nextActionsCallGraph, false);
    assert.deepEqual(summarizeExtractedSymbol(symbols[0]), expectedSymbols[0]);
    assert.deepEqual(symbols.map(summarizeExtractedSymbol), expectedSymbols);
    assert.deepEqual(buildRelationshipsForRegistry({
        registry,
        contentByFile: new Map([[relativePath, source]]),
    }), expectedEdges.calls);
    assert.equal(expectedToolOutputs.callGraph.supported, false);
    assert.equal(expectedToolOutputs.callGraph.reason, 'unsupported_language');
});

test('Rust navigation fixture matches extractor and no-graph golden expectations', () => {
    const fixtureName = 'rust-basic-symbols';
    const relativePath = 'stack.rs';
    const source = readFixtureFile(fixtureName, relativePath);
    const expectedSymbols = readFixtureJson<ExpectedFixtureSymbol[]>(fixtureName, 'expected_symbols.json');
    const expectedEdges = readFixtureJson<ExpectedFixtureEdges>(fixtureName, 'expected_edges.json');
    const expectedToolOutputs = readFixtureJson<ExpectedFixtureToolOutputs>(fixtureName, 'expected_tool_outputs.json');
    const declaration = getLanguageCapabilityDeclaration(expectedToolOutputs.language);
    const extractor = getSymbolExtractorForLanguage(expectedToolOutputs.language);
    assert.ok(extractor);

    const symbols = extractor.extract({ content: source, relativePath });
    const registry = buildFixtureRegistry({
        fixtureName,
        relativePath,
        language: expectedToolOutputs.language,
        extractorVersion: extractor.extractorVersion,
        source,
        extractedSymbols: symbols,
    });

    assert.equal(declaration?.publicClaim, expectedToolOutputs.tier);
    assert.equal(expectedToolOutputs.searchCodebase.nextActionsCallGraph, false);
    assert.deepEqual(symbols.map(summarizeExtractedSymbol), expectedSymbols);
    assert.deepEqual(buildRelationshipsForRegistry({
        registry,
        contentByFile: new Map([[relativePath, source]]),
    }), expectedEdges.calls);
    assert.equal(expectedToolOutputs.callGraph.supported, false);
    assert.equal(expectedToolOutputs.callGraph.reason, 'unsupported_language');
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
