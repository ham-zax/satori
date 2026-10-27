import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmSemanticEngine, type WasmSemanticSession } from './wasm-engine';
import type { NativeSemanticEngine } from './wasm-loader';

const createNative = require('../../../assets/semantic-engine/satori-semantic-engine.js') as () => Promise<NativeSemanticEngine>;

type Source = Readonly<{ path: string; source: string }>;
type Auxiliary = Readonly<{ role: string; path: string; source: string }>;
type Input = Readonly<{ sources: readonly Source[]; auxiliaries?: readonly Auxiliary[] }>;

function addInputs(session: WasmSemanticSession, input: Input): void {
    for (const source of input.sources) session.addSource(source.path, source.source);
    for (const aux of input.auxiliaries ?? []) session.addAuxiliary(aux.role, aux.path, aux.source);
}

async function resolve(engine: WasmSemanticEngine, language: string, input: Input) {
    const session = await engine.createSession(language);
    try {
        addInputs(session, input);
        const results = await session.resolve();
        return { results, diagnostics: session.diagnostics() };
    } finally { session.destroy(); }
}

async function comparePrepared(language: string, before: Input, after: Input) {
    const preparedEngine = new WasmSemanticEngine(await createNative());
    const preparation = await preparedEngine.createSession(language);
    try {
        addInputs(preparation, before);
        await preparation.prepare();
    } finally { preparation.destroy(); }
    const prepared = await resolve(preparedEngine, language, after);
    const fresh = await resolve(new WasmSemanticEngine(await createNative()), language, after);
    assert.deepEqual(prepared, fresh);
    return fresh;
}

const goSource = 'package main\nfunc foo() {}\nfunc main() { foo() }\n';
const goInput = (source: string): Input => ({ sources: [{ path: 'main.go', source }] });

test('equal-length syntax change does not reuse an old tree', async () => {
    const changed = goSource.replace('foo() }', 'foo   }');
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(goSource));
    assert.notEqual(changed, goSource);
    const initial = await resolve(new WasmSemanticEngine(await createNative()), 'go', goInput(goSource));
    assert.ok(initial.results.some(result => result.targetName === 'foo'));
    const result = await comparePrepared('go', goInput(goSource), goInput(changed));
    assert.equal(result.results.some(call => call.targetName === 'foo'), false);
});

test('prepared Go parses match fresh results for edited sources and auxiliaries', async () => {
    const cases: Array<readonly [string, Input, Input]> = [
        ['trailing comment', goInput(goSource.trimEnd()), goInput(`${goSource.trimEnd()} // comment`)],
        ['inserted lines and multibyte spans', goInput(goSource), goInput(`// 世界\n\n${goSource}`)],
        ['changed callee and receiver type', goInput('package main\ntype A struct{}\nfunc (A) Run() {}\nfunc main() { A{}.Run() }\n'),
            goInput('package main\ntype B struct{}\nfunc (B) Run() {}\nfunc main() { B{}.Run() }\n')],
        ['changed import and build directive', goInput('//go:build linux\n\npackage main\nimport "fmt"\nfunc main(){ fmt.Println("x") }\n'),
            goInput('//go:build windows\n\npackage main\nimport "strings"\nfunc main(){ strings.TrimSpace("x") }\n')],
        ['added and deleted sources and changed go.mod', {
            sources: [{ path: 'main.go', source: goSource }, { path: 'old.go', source: 'package main\nfunc old() {}\n' }],
            auxiliaries: [{ role: 'manifest', path: 'go.mod', source: 'module example.com/old\n\ngo 1.22\n' }],
        }, {
            sources: [{ path: 'main.go', source: goSource }, { path: 'new.go', source: 'package main\nfunc newer() { foo() }\n' }],
            auxiliaries: [{ role: 'manifest', path: 'go.mod', source: 'module example.com/new\n\ngo 1.22\n' }],
        }],
    ];
    for (const [name, before, after] of cases) {
        await comparePrepared('go', before, after).catch(error => { throw new Error(name, { cause: error }); });
    }
});

test('prepared parses match fresh modules for every native grammar', async () => {
    const fixtures: Array<readonly [string, string, string]> = [
        ['go', 'main.go', goSource],
        ['java', 'Main.java', 'class Main { static void foo() {} static void run() { foo(); } }'],
        ['csharp', 'Main.cs', 'class Main { static void Foo() {} static void Run() { Foo(); } }'],
        ['cpp', 'main.cpp', '#ifdef FEATURE\nint h(){return 1;}\n#endif'],
        ['rust', 'src/lib.rs', 'pub fn help() {}\npub fn run() { help(); }\n'],
        ['kotlin', 'Main.kt', 'fun foo() {}\nfun run() { foo() }\n'],
        ['php', 'main.php', '<?php function foo() {} function run() { foo(); }'],
    ];
    for (const [language, path, source] of fixtures) {
        const input = { sources: [{ path, source }] };
        const evidence = await comparePrepared(language, input, input);
        if (language === 'cpp') assert.ok(evidence.diagnostics.length > 0);
    }
});

test('same path and bytes across grammars match fresh modules', async () => {
    const input = { sources: [{ path: 'same.file', source: goSource }] };
    const engine = new WasmSemanticEngine(await createNative());
    for (const language of ['go', 'java', 'go']) {
        const session = await engine.createSession(language);
        try { addInputs(session, input); await session.prepare(); } finally { session.destroy(); }
        assert.deepEqual(await resolve(engine, language, input),
            await resolve(new WasmSemanticEngine(await createNative()), language, input));
    }
});

test('source above the cache byte budget matches a fresh module', { timeout: 120_000 }, async () => {
    const source = `/*${'x'.repeat(32 * 1024 * 1024)}*/\n${goSource}`;
    const input = goInput(source);
    const result = await comparePrepared('go', input, input);
    assert.ok(result.results.some(call => call.targetName === 'foo'));
});
