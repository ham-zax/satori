import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSemanticEngine } from './wasm-loader';
import { SATORI_SEMANTIC_ABI_VERSION } from './wasm-types';

test('WASM semantic engine instantiates, reports ABI version, engine version, and passes smoke execution', async () => {
    const engine = await loadSemanticEngine();
    assert.ok(engine, 'Semantic engine instance should be loaded');

    const abiVersion = engine._satori_semantic_abi_version();
    assert.equal(abiVersion, SATORI_SEMANTIC_ABI_VERSION);

    const engineVersionPtr = engine._satori_semantic_engine_version();
    const engineVersion = engine.UTF8ToString(engineVersionPtr);
    assert.equal(engineVersion, 'cbm-d150ebe4+satori-go-semantic-v1');

    const smokeRc = await engine._satori_semantic_go_smoke();
    assert.equal(smokeRc, 0, 'Smoke execution should return 0 (OK)');
});

test('WASM semantic engine creates session, resolves Go call relationships, and returns 64-byte POD results', async () => {
    const engine = await loadSemanticEngine();

    const outHandlePtr = engine._malloc(4);
    assert.ok(outHandlePtr > 0);

    const lang = 'go';
    const langBytes = Buffer.from(lang, 'utf8');
    const langPtr = engine._malloc(langBytes.length + 1);
    engine.HEAPU8.set(langBytes, langPtr);
    engine.HEAPU8[langPtr + langBytes.length] = 0;

    const createRc = engine._satori_semantic_create(langPtr, lang.length, outHandlePtr);
    assert.equal(createRc, 0);

    const handle = engine.getValue(outHandlePtr, 'i32');
    assert.ok(handle > 0);

    engine._free(langPtr);
    engine._free(outHandlePtr);

    const goSrc = `package main

func add(a int, b int) int {
    return a + b
}

func main() {
    res := add(1, 2)
    _ = res
}
`;
    const srcBytes = Buffer.from(goSrc, 'utf8');
    const srcPtr = engine._malloc(srcBytes.length + 1);
    engine.HEAPU8.set(srcBytes, srcPtr);
    engine.HEAPU8[srcPtr + srcBytes.length] = 0;

    const pathStr = 'main.go';
    const pathBytes = Buffer.from(pathStr, 'utf8');
    const pathPtr = engine._malloc(pathBytes.length + 1);
    engine.HEAPU8.set(pathBytes, pathPtr);
    engine.HEAPU8[pathPtr + pathBytes.length] = 0;

    const addRc = engine._satori_semantic_add_source(handle, pathPtr, pathStr.length, srcPtr, srcBytes.length);
    assert.equal(addRc, 0);

    engine._free(srcPtr);
    engine._free(pathPtr);

    const resolveRc = await engine._satori_semantic_resolve(handle);
    assert.equal(resolveRc, 0);

    // Verify multi-stream ABI contracts
    const relCount = engine._satori_semantic_relationship_count(handle);
    assert.ok(relCount >= 1, `Expected at least 1 resolved call relationship, saw ${relCount}`);

    const defCount = engine._satori_semantic_definition_count(handle);
    assert.equal(defCount, 0, 'Definition stream returns 0 in milestone 1');

    const diagCount = engine._satori_semantic_diagnostic_count(handle);
    assert.equal(diagCount, 0, 'Diagnostic stream returns 0 in milestone 1');

    const resultsPtr = engine._satori_semantic_relationships(handle);
    assert.ok(resultsPtr > 0);

    const strTablePtr = engine._satori_semantic_string_table(handle, 0);
    assert.ok(strTablePtr > 0);

    // Read first result struct (64 bytes)
    const srcFileOff = engine.getValue(resultsPtr + 0, 'i32');
    const srcFileLen = engine.getValue(resultsPtr + 4, 'i32');
    const callStart = engine.getValue(resultsPtr + 8, 'i32');
    const callEnd = engine.getValue(resultsPtr + 12, 'i32');

    const tgtNameOff = engine.getValue(resultsPtr + 24, 'i32');
    const tgtNameLen = engine.getValue(resultsPtr + 28, 'i32');

    const decision = engine.getValue(resultsPtr + 58, 'i8');
    const strategy = engine.getValue(resultsPtr + 59, 'i8');
    const confidence = engine.getValue(resultsPtr + 60, 'float');

    assert.ok(srcFileLen > 0);
    assert.ok(tgtNameLen > 0);

    const srcFile = engine.UTF8ToString(strTablePtr + srcFileOff);
    const tgtName = engine.UTF8ToString(strTablePtr + tgtNameOff);

    assert.equal(srcFile, 'main.go');
    assert.equal(tgtName, 'add');
    assert.ok(callStart > 0);
    assert.ok(callEnd > callStart);
    assert.equal(decision, 1); // RESOLVED
    assert.equal(strategy, 1); // DIRECT_CALL
    assert.ok(confidence >= 0.9);

    engine._satori_semantic_free(handle);
});
