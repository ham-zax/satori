import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadedWasmSemanticProjectAnalyzer } from './wasm-threaded-analyzer';

test('ThreadedWasmSemanticProjectAnalyzer executes analysis without blocking main event loop', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    assert.equal(analyzer.supportsLanguage('go'), true);
    assert.equal(analyzer.supportsLanguage('python'), false);

    // Build a multi-file Go project with callers and targets
    const sourceFiles = [];
    for (let i = 0; i < 30; i++) {
        sourceFiles.push({
            path: `pkg/file${i}.go`,
            source: `package pkg\n\nfunc Helper${i}() {}\nfunc CallHelper${i}() {\n    Helper${i}()\n}\n`,
            sourceHash: `hash-${i}`,
        });
    }

    let eventLoopTicks = 0;
    const timer = setInterval(() => { eventLoopTicks += 1; }, 2);

    const result = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [
            {
                role: 'go.mod',
                path: 'go.mod',
                source: 'module example.com/test\n\ngo 1.21\n',
                sourceHash: 'aux-hash',
            },
        ],
        sourceFiles,
    });

    clearInterval(timer);
    assert.ok(eventLoopTicks > 0, `Main event loop must tick during off-thread WASM analysis (observed ${eventLoopTicks} ticks)`);
    assert.equal(result.language, 'go');
    assert.equal(result.occurrencesByFile.size, 30);
    const firstOccurrences = result.occurrencesByFile.get('pkg/file0.go');
    assert.ok(firstOccurrences && firstOccurrences.length > 0);
    assert.equal(firstOccurrences[0].targetProvenance?.name, 'Helper0');

    await analyzer.dispose();
});

test('ThreadedWasmSemanticProjectAnalyzer handles unsupported languages and disposal cleanly', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    const result = await analyzer.analyze({
        language: 'unsupported_lang',
        auxiliaryFiles: [],
        sourceFiles: [],
    });
    assert.equal(result.occurrencesByFile.size, 0);
    await analyzer.dispose();
});

test('Context wires dispose() to semanticAnalyzer', async () => {
    let disposed = false;
    const mockAnalyzer = {
        supportsLanguage: () => true,
        analyze: async () => ({ language: 'go', occurrencesByFile: new Map() }),
        dispose: async () => {
            disposed = true;
        },
    };
    const { Context } = await import('../../core/context.js');
    const context = new Context({
        semanticAnalyzer: mockAnalyzer,
        embedding: {
            getProvider: () => 'mock',
            getDimension: () => 10,
            getIdentity: () => ({
                provider: 'mock',
                model: 'mock-model',
                dimension: 10,
                artifactDigest: null,
                normalizationPolicy: 'provider_output_v1',
            }),
            embed: async () => [],
            close: async () => {},
        } as any,
        vectorDatabase: {
            search: async () => [],
        } as any,
    });
    await context.dispose();
    assert.equal(disposed, true);
});

test('ThreadedWasmSemanticProjectAnalyzer rejects in-flight pending requests when disposed', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    const sourceFiles = [];
    for (let i = 0; i < 50; i++) {
        sourceFiles.push({
            path: `pkg/file${i}.go`,
            source: `package pkg\n\nfunc HeavyFunc${i}() {}\nfunc Call${i}() { HeavyFunc${i}() }\n`,
            sourceHash: `hash-${i}`,
        });
    }

    const pendingPromise = analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [
            {
                role: 'go.mod',
                path: 'go.mod',
                source: 'module example.com/test\n\ngo 1.21\n',
                sourceHash: 'aux-hash',
            },
        ],
        sourceFiles,
    });

    // Dispose immediately while analysis request is in-flight
    const disposePromise = analyzer.dispose();

    await assert.rejects(
        pendingPromise,
        /Semantic analyzer disposed while request was pending|CBM Semantic Worker stopped unexpectedly/,
    );
    await disposePromise;
});

test('ThreadedWasmSemanticProjectAnalyzer rejects analyze calls made after disposal', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    await analyzer.dispose();

    await assert.rejects(
        () => analyzer.analyze({
            language: 'go',
            auxiliaryFiles: [],
            sourceFiles: [],
        }),
        /Semantic analyzer has been disposed/,
    );
});

test('ThreadedWasmSemanticProjectAnalyzer handles multiple dispose calls idempotently without error', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    await Promise.all([
        analyzer.dispose(),
        analyzer.dispose(),
        analyzer.dispose(),
    ]);
});

test('Context memoizes dispose and calls underlying analyzer dispose exactly once across concurrent callers', async () => {
    let disposeCount = 0;
    const mockAnalyzer = {
        supportsLanguage: () => true,
        analyze: async () => ({ language: 'go', occurrencesByFile: new Map() }),
        dispose: async () => {
            disposeCount += 1;
        },
    };
    const { Context } = await import('../../core/context.js');
    const context = new Context({
        semanticAnalyzer: mockAnalyzer,
        embedding: {
            getProvider: () => 'mock',
            getDimension: () => 10,
            getIdentity: () => ({
                provider: 'mock',
                model: 'mock-model',
                dimension: 10,
                artifactDigest: null,
                normalizationPolicy: 'provider_output_v1',
            }),
            embed: async () => [],
            close: async () => {},
        } as any,
        vectorDatabase: {
            search: async () => [],
        } as any,
    });

    await Promise.all([
        context.dispose(),
        context.dispose(),
        context.dispose(),
    ]);

    assert.equal(disposeCount, 1);
});
