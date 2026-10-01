import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { filterWorkerExecArgv } from '../utils/worker-threads';
import { cbmExtractorHost } from './cbm-extractor-host';

function parentRequest(assetRoot: string, method: 'extract' | 'extractInProcess' = 'extract'): Promise<{ code: number | null; output: string }> {
    const hostPath = path.join(__dirname, `cbm-extractor-host${path.extname(__filename)}`);
    const script = `const { cbmExtractorHost } = require(${JSON.stringify(hostPath)});
        cbmExtractorHost(${JSON.stringify(assetRoot)}).${method}('swift', 'a.swift', 'func foo() {}')
            .then(records => process.stdout.write(JSON.stringify({ records })))
            .catch(error => process.stdout.write(JSON.stringify({ error: error.message, name: error.constructor.name })));`;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...filterWorkerExecArgv(), '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
    });
}

function assets(glue: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-extractor-isolation-'));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, glue: { file: 'extractor.cjs' },
        modules: [{ cbmLanguage: 'SWIFT', satoriLanguageId: 'swift', file: 'swift.wasm', pack: 'core' }] }));
    fs.writeFileSync(path.join(root, 'swift.wasm'), 'fixture');
    fs.writeFileSync(path.join(root, 'extractor.cjs'), glue);
    return root;
}

test('Swift uses baseline-only isolation and waits for child cleanup before returning records', async () => {
    const root = assets(`module.exports = async () => {
        if (!process.execArgv.includes('--liftoff-only')) throw new Error('missing baseline-only isolation');
        const fs = require('node:fs');
        process.once('exit', () => fs.writeFileSync(require('node:path').join(__dirname, 'closed'), 'yes'));
        const memory = new Uint8Array(1024);
        const result = Buffer.from('Function\\tfoo\\tfoo\\t\\t1\\t1\\t0\\t13\\n');
        memory.set(result, 512);
        let next = 0;
        return { HEAPU8: memory, _malloc: length => { const pointer = next; next += length; return pointer; },
            _free() {}, _satori_extract: () => 1, _satori_result_ptr: () => 512, _satori_result_len: () => result.length };
    };`);
    try {
        const unisolated = await parentRequest(root, 'extractInProcess');
        assert.equal(JSON.parse(unisolated.output).error, 'missing baseline-only isolation');
        const response = await parentRequest(root);
        assert.equal(response.code, 0, response.output);
        const parsed = JSON.parse(response.output);
        assert.equal(parsed.records?.[0]?.name, 'foo', response.output);
        assert.ok(fs.existsSync(path.join(root, 'closed')), 'child exit cleanup must complete before extraction settles');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Swift child exit fails extraction without terminating the parent', async () => {
    const root = assets('module.exports = async () => { process.exit(17); };');
    try {
        const response = await parentRequest(root);
        assert.equal(response.code, 0, response.output);
        assert.match(JSON.parse(response.output).error, /17/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Swift isolation preserves missing module diagnostics', async () => {
    const root = assets('module.exports = async () => { throw new Error("must not load missing module"); };');
    fs.unlinkSync(path.join(root, 'swift.wasm'));
    try {
        const response = await parentRequest(root);
        assert.equal(response.code, 0, response.output);
        assert.equal(JSON.parse(response.output).name, 'CbmExtractorUnavailableError');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Swift isolation preserves unsupported language diagnostics', async () => {
    const root = assets('module.exports = async () => { throw new Error("must not load unsupported module"); };');
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, glue: { file: 'extractor.cjs' }, modules: [] }));
    try {
        const response = await parentRequest(root);
        assert.equal(response.code, 0, response.output);
        const parsed = JSON.parse(response.output);
        assert.equal(parsed.name, 'CbmExtractorUnavailableError');
        assert.match(parsed.error, /No CBM extractor module for swift/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Swift isolation completes failure cleanup before returning extractor errors', async () => {
    const root = assets(`module.exports = async () => {
        process.once('exit', () => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'closed'), 'yes'));
        throw new Error('injected extractor failure');
    };`);
    try {
        const response = await parentRequest(root);
        assert.equal(response.code, 0, response.output);
        assert.equal(JSON.parse(response.output).error, 'injected extractor failure');
        assert.ok(fs.existsSync(path.join(root, 'closed')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Swift isolated and baseline in-process extractors produce identical records and UTF-8 spans', async () => {
    // This test process uses the repository's baseline-only test flags. The
    // production path still launches its own child independently of those flags.
    const host = cbmExtractorHost();
    const fixtures = [
        'func foo() {}\nclass A {}\n',
        '// café\nstruct Registry {\n func add() {}\n}\nfunc total() -> Int { return 1 }\n',
        'protocol Store { func add() }\nclass Registry { class Inner { func run() {} } }\n',
    ];
    for (const source of fixtures) {
        const expected = await host.extractInProcess('swift', 'src/Registry.swift', source);
        assert.ok(expected.some((record) => record.label !== 'Module'));
        assert.deepEqual(await host.extract('swift', 'src/Registry.swift', source), expected);
    }
});
