import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { batches, readJsonl } from '../tools';

const fixture = { relativePath: 'src/test.ts', chunk: { content: 'parseHTTPResponse foo_bar', metadata: { startLine: 1, endLine: 1 } } };
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values; }
test('JSONL parses split buffers, CRLF, blank lines and final line without LF', async () => {
    const text = JSON.stringify(fixture) + '\r\n\n' + JSON.stringify(fixture);
    const values = await collect(readJsonl(Readable.from([Buffer.from(text.slice(0, 17)), Buffer.from(text.slice(17))]), 4096));
    assert.deepEqual(values, [fixture, fixture]);
});
test('JSONL bounds a line before parsing and rejects malformed shape', async () => {
    await assert.rejects(collect(readJsonl(Readable.from([Buffer.alloc(65, 32)]), 64)), /line exceeds/);
    await assert.rejects(collect(readJsonl(Readable.from([Buffer.from('{}\n')]), 64)), /Invalid SearchProjectionInput/);
});
test('streaming batches stay count-bounded', async () => {
    const text = Array(129).fill(JSON.stringify(fixture)).join('\n');
    const values = await collect(batches(readJsonl(Readable.from([Buffer.from(text)]), 4096)));
    assert.deepEqual(values.map(v => v.length), [64, 64, 1]);
});
test('single-pass CLI accepts stdin and reports actual native counts', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../tools.ts', import.meta.url)), 'compare', '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const done = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    child.stdin.end(JSON.stringify(fixture) + '\n');
    assert.equal(await done, 0, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.runs[0].counts.native, 1);
    assert.equal(report.runs[0].counts.fallback, 0);
    assert.equal(report.repetitions, 1);
    assert.equal(report.startLoad.length, 3);
});
