import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSemanticEngine } from './wasm-loader.js';
import { WasmSemanticEngine } from './wasm-engine.js';

test('WASM C ABI rejects unsupported languages at creation time', async () => {
    const engine = await loadSemanticEngine();
    const handlePtr = engine._malloc(4);
    try {
        const pyBytes = Buffer.from('python', 'utf8');
        const pyPtr = engine._malloc(pyBytes.length);
        engine.HEAPU8.set(pyBytes, pyPtr);
        const rc = engine._satori_semantic_create(pyPtr, pyBytes.length, handlePtr);
        assert.equal(rc, -1, 'Expected INVALID_ARGUMENT (-1) for python');
        engine._free(pyPtr);

        const goBytes = Buffer.from('go', 'utf8');
        const goPtr = engine._malloc(goBytes.length);
        engine.HEAPU8.set(goBytes, goPtr);
        const goRc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
        assert.equal(goRc, 0, 'Expected OK (0) for go');
        engine._free(goPtr);

        const handle = engine.getValue(handlePtr, 'i32');
        assert.ok(handle > 0);
        engine._satori_semantic_destroy(handle);
    } finally {
        engine._free(handlePtr);
    }
});

test('WASM C ABI enforces handle limit (64 max)', async () => {
    const engine = await loadSemanticEngine();
    const handlePtr = engine._malloc(4);
    const handles: number[] = [];

    const goBytes = Buffer.from('go', 'utf8');
    const goPtr = engine._malloc(goBytes.length);
    engine.HEAPU8.set(goBytes, goPtr);

    try {
        for (let i = 0; i < 64; i++) {
            const rc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
            assert.equal(rc, 0, `Session ${i} creation must succeed`);
            handles.push(engine.getValue(handlePtr, 'i32'));
        }

        // 65th session must fail with RESOURCE_LIMIT_EXCEEDED (-6)
        const overflowRc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
        assert.equal(overflowRc, -6, '65th session must fail with RESOURCE_LIMIT_EXCEEDED (-6)');

        // Destroy one session and create another
        engine._satori_semantic_destroy(handles.pop()!);
        const newRc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
        assert.equal(newRc, 0, 'Creation after destroy must succeed');
        handles.push(engine.getValue(handlePtr, 'i32'));
    } finally {
        engine._free(goPtr);
        for (const h of handles) {
            engine._satori_semantic_destroy(h);
        }
        engine._free(handlePtr);
    }
});

test('WASM C ABI enforces aggregate source byte limit (100MB)', async () => {
    const engine = await loadSemanticEngine();
    const handlePtr = engine._malloc(4);

    const goBytes = Buffer.from('go', 'utf8');
    const goPtr = engine._malloc(goBytes.length);
    engine.HEAPU8.set(goBytes, goPtr);

    try {
        const rc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
        assert.equal(rc, 0);
        const handle = engine.getValue(handlePtr, 'i32');

        // Allocate a 10MB chunk and add it 11 times (>100MB)
        const chunkSize = 10 * 1024 * 1024;
        const chunkPtr = engine._malloc(chunkSize);
        engine.HEAPU8.fill(32, chunkPtr, chunkPtr + chunkSize);
        const header = Buffer.from('package main\n\n');
        for (let b = 0; b < header.length; b++) {
            engine.HEAPU8[chunkPtr + b] = header[b];
        }

        const pathBytes = Buffer.from('large.go', 'utf8');
        const pathPtr = engine._malloc(pathBytes.length);
        engine.HEAPU8.set(pathBytes, pathPtr);

        let lastRc = 0;
        for (let i = 0; i < 11; i++) {
            lastRc = engine._satori_semantic_add_source(handle, pathPtr, pathBytes.length, chunkPtr, chunkSize);
            if (lastRc !== 0) break;
        }

        assert.equal(lastRc, -6, 'Adding >100MB must return RESOURCE_LIMIT_EXCEEDED (-6)');

        engine._free(pathPtr);
        engine._free(chunkPtr);
        engine._satori_semantic_destroy(handle);
    } finally {
        engine._free(goPtr);
        engine._free(handlePtr);
    }
});

test('WASM C ABI enforces auxiliary file count limit (1000 files max)', async () => {
    const engine = await loadSemanticEngine();
    const handlePtr = engine._malloc(4);
    const goBytes = Buffer.from('go', 'utf8');
    const goPtr = engine._malloc(goBytes.length);
    engine.HEAPU8.set(goBytes, goPtr);

    try {
        const rc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
        assert.equal(rc, 0);
        const handle = engine.getValue(handlePtr, 'i32');

        const roleBytes = Buffer.from('manifest', 'utf8');
        const rolePtr = engine._malloc(roleBytes.length);
        engine.HEAPU8.set(roleBytes, rolePtr);

        const pathBytes = Buffer.from('aux.json', 'utf8');
        const pathPtr = engine._malloc(pathBytes.length);
        engine.HEAPU8.set(pathBytes, pathPtr);

        const srcBytes = Buffer.from('{}', 'utf8');
        const srcPtr = engine._malloc(srcBytes.length);
        engine.HEAPU8.set(srcBytes, srcPtr);

        for (let i = 0; i < 1000; i++) {
            const auxRc = engine._satori_semantic_add_auxiliary(handle, rolePtr, roleBytes.length, pathPtr, pathBytes.length, srcPtr, srcBytes.length);
            assert.equal(auxRc, 0, `Auxiliary ${i} must succeed`);
        }

        // 1001st file must fail with RESOURCE_LIMIT_EXCEEDED (-6)
        const overflowRc = engine._satori_semantic_add_auxiliary(handle, rolePtr, roleBytes.length, pathPtr, pathBytes.length, srcPtr, srcBytes.length);
        assert.equal(overflowRc, -6, '1001st auxiliary file must fail with RESOURCE_LIMIT_EXCEEDED (-6)');

        engine._free(rolePtr);
        engine._free(pathPtr);
        engine._free(srcPtr);
        engine._satori_semantic_destroy(handle);
    } finally {
        engine._free(goPtr);
        engine._free(handlePtr);
    }
});

test('WASM C ABI enforces auxiliary aggregate byte limit (10MB max)', async () => {
    const engine = await loadSemanticEngine();
    const handlePtr = engine._malloc(4);
    const goBytes = Buffer.from('go', 'utf8');
    const goPtr = engine._malloc(goBytes.length);
    engine.HEAPU8.set(goBytes, goPtr);

    try {
        const rc = engine._satori_semantic_create(goPtr, goBytes.length, handlePtr);
        assert.equal(rc, 0);
        const handle = engine.getValue(handlePtr, 'i32');

        const roleBytes = Buffer.from('manifest', 'utf8');
        const rolePtr = engine._malloc(roleBytes.length);
        engine.HEAPU8.set(roleBytes, rolePtr);

        const pathBytes = Buffer.from('large-aux.json', 'utf8');
        const pathPtr = engine._malloc(pathBytes.length);
        engine.HEAPU8.set(pathBytes, pathPtr);

        // 2MB chunk added 6 times (>10MB)
        const chunkSize = 2 * 1024 * 1024;
        const chunkPtr = engine._malloc(chunkSize);
        engine.HEAPU8.fill(32, chunkPtr, chunkPtr + chunkSize);

        let lastRc = 0;
        for (let i = 0; i < 6; i++) {
            lastRc = engine._satori_semantic_add_auxiliary(handle, rolePtr, roleBytes.length, pathPtr, pathBytes.length, chunkPtr, chunkSize);
            if (lastRc !== 0) break;
        }

        assert.equal(lastRc, -6, 'Adding >10MB auxiliary must return RESOURCE_LIMIT_EXCEEDED (-6)');

        engine._free(chunkPtr);
        engine._free(rolePtr);
        engine._free(pathPtr);
        engine._satori_semantic_destroy(handle);
    } finally {
        engine._free(goPtr);
        engine._free(handlePtr);
    }
});

test('WASM semantic engine maintains lifecycle stability across 100 sessions', async () => {
    const engine = await WasmSemanticEngine.create();

    const sampleGo = `package main

type Service struct{}
func (s *Service) Run() string { return "ok" }

func main() {
    svc := &Service{}
    _ = svc.Run()
}
`;

    for (let cycle = 0; cycle < 100; cycle++) {
        const session = await engine.createSession('go');
        session.addSource('main.go', sampleGo);
        const results = await session.resolve();
        assert.ok(results.length >= 1, `Cycle ${cycle} must produce results`);
        assert.equal(results[0].targetName, 'Run');
        session.destroy();
    }
});
