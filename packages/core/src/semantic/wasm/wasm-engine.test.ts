import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmSemanticEngine } from './wasm-engine';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';

test('WasmSemanticEngine manages sessions, isolates data between sessions, and cleans up on destroy', async () => {
    const engine = await WasmSemanticEngine.create();

    const sessionA = await engine.createSession('go');
    const sessionB = await engine.createSession('go');

    assert.notEqual(sessionA.handleId, sessionB.handleId, 'Handles must be distinct');

    const goSrcA = `package main

func foo() {}
func main() {
    foo()
}
`;
    sessionA.addSource('a/main.go', goSrcA);

    const goSrcB = `package main

func bar() {}
func main() {
    bar()
}
`;
    sessionB.addSource('b/main.go', goSrcB);

    const resultsA = await sessionA.resolve();
    const resultsB = await sessionB.resolve();

    assert.equal(resultsA.length, 1);
    assert.equal(resultsA[0].sourceFile, 'a/main.go');
    assert.equal(resultsA[0].targetName, 'foo');

    assert.equal(resultsB.length, 1);
    assert.equal(resultsB[0].sourceFile, 'b/main.go');
    assert.equal(resultsB[0].targetName, 'bar');

    sessionA.destroy();
    sessionB.destroy();

    assert.throws(() => sessionA.addSource('a/other.go', ''), /destroyed/i);
    assert.throws(() => sessionB.addSource('b/other.go', ''), /destroyed/i);
});

test('WasmSemanticProjectAnalyzer supports Go, rejects Python, and produces structured project evidence', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();

    assert.equal(analyzer.supportsLanguage('go'), true);
    assert.equal(analyzer.supportsLanguage('python'), false);
    assert.equal(analyzer.supportsLanguage('typescript'), false);

    const evidence = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [],
        sourceFiles: [
            {
                path: 'main.go',
                source: `package main

type Service struct{}

func (s *Service) Process() {}

func main() {
    svc := &Service{}
    svc.Process()
}
`,
                sourceHash: 'sha-main',
            },
        ],
    });

    assert.equal(evidence.language, 'go');
    const occurrences = evidence.occurrencesByFile.get('main.go');
    assert.ok(occurrences);
    assert.equal(occurrences.length, 1);

    const occ = occurrences[0];
    assert.equal(occ.sourceFile, 'main.go');
    assert.ok(occ.targetProvenance);
    assert.equal(occ.targetProvenance.name, 'Process');
    assert.equal(occ.targetProvenance.kind, 'method');
    assert.equal(occ.targetProvenance.ownerName, 'Service');
    assert.equal(occ.proof.strategy, 'type_dispatch');
    assert.equal(occ.proof.receiverBinding?.receiverType, 'Service');
    assert.equal(occ.decision, 'resolved');
});
