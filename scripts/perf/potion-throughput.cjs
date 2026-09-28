#!/usr/bin/env node
// Potion embedding throughput on real chunk-sized texts (~1.45 KB each, the
// indexer's average) taken from a repository's .ts/.go/.md/.py files.
//
//   node scripts/perf/potion-throughput.cjs helper <repo> [--helper <path>] [--batch 64] [--mode serial|pipelined] [--mb 5]
//       Drives the native helper directly: MB/s and CPU cores it used.
//   node scripts/perf/potion-throughput.cjs client <repo> [--batch 64] [--mb 5]
//       Goes through PotionEmbedding (packages/core/dist): what the indexer sees.
//   node scripts/perf/potion-throughput.cjs parity <repo> <helperA> <helperB> [--mb 5]
//       Hashes every vector and retained-token count from two helpers; they must match.
//   node scripts/perf/potion-throughput.cjs texts <repo> <out.json> [--mb 5]
//       Writes the texts for experiments/potion-l0-l1/examples/components.rs.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const POTION = path.join(ROOT, 'packages/mcp/assets/potion/linux-x64');

function parseArgs(argv) {
    const options = { mode: argv[0], positional: [], helper: path.join(POTION, 'satori-potion'), batch: 64, send: 'pipelined', mb: 5 };
    for (let i = 1; i < argv.length; i++) {
        switch (argv[i]) {
            case '--helper': options.helper = path.resolve(argv[++i]); break;
            case '--batch': options.batch = Number(argv[++i]); break;
            case '--mode': options.send = argv[++i]; break;
            case '--mb': options.mb = Number(argv[++i]); break;
            default: options.positional.push(argv[i]);
        }
    }
    return options;
}

function loadTexts(repo, megabytes) {
    const limit = megabytes * 1e6;
    const texts = [];
    let bytes = 0;
    const files = execFileSync('git', ['-C', repo, 'ls-files', '*.ts', '*.go', '*.md', '*.py'], { encoding: 'utf8' })
        .split('\n').filter(Boolean).sort();
    for (const file of files) {
        const source = fs.readFileSync(path.join(repo, file), 'utf8');
        for (let offset = 0; offset < source.length && bytes < limit; offset += 1450) {
            const text = source.slice(offset, offset + 1450);
            if (!text.trim()) continue;
            texts.push(text);
            bytes += Buffer.byteLength(text);
        }
        if (bytes >= limit) break;
    }
    return { texts, bytes };
}

/** Starts a helper worker and yields each parsed JSON frame (compact or pretty output). */
function startHelper(helperPath, onFrame) {
    const child = spawn(helperPath, ['worker', path.join(POTION, 'model'), '--block-network']);
    child.stdin.on('error', () => {});
    let buffer = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = 0;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
        const base = buffer.length;
        buffer += chunk;
        for (let i = base; i < buffer.length; i++) {
            const ch = buffer[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{' || ch === '[') { if (depth === 0) start = i; depth++; }
            else if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 0) {
                    onFrame(JSON.parse(buffer.slice(start, i + 1)));
                    buffer = buffer.slice(i + 1);
                    i = -1;
                }
            }
        }
    });
    return child;
}

function helperCpuMs(pid) {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return (Number(fields[11]) + Number(fields[12])) * 10;
}

function runHelper(options) {
    const [repo] = options.positional;
    const { texts, bytes } = loadTexts(repo, options.mb);
    const frames = [];
    for (let i = 0; i < texts.length; i += options.batch) {
        frames.push(`${JSON.stringify({ op: 'encode_batch', id: `r${i}`, texts: texts.slice(i, i + options.batch) })}\n`);
    }
    return new Promise((resolve) => {
        let received = -1;
        let startedAt;
        const child = startHelper(options.helper, () => {
            received++;
            if (received === 0) {
                startedAt = performance.now();
                if (options.send === 'serial') child.stdin.write(frames[0]);
                else for (const frame of frames) child.stdin.write(frame);
                return;
            }
            if (options.send === 'serial' && received < frames.length) child.stdin.write(frames[received]);
            if (received === frames.length) {
                const ms = performance.now() - startedAt;
                const cpu = helperCpuMs(child.pid);
                console.log(`helper ${options.send} batch=${options.batch} texts=${texts.length} ${(bytes / 1e6).toFixed(1)}MB `
                    + `${Math.round(ms)}ms ${(bytes / 1e6 / (ms / 1000)).toFixed(2)} MB/s cpu=${cpu}ms (${(cpu / ms).toFixed(1)} cores)`);
                child.stdin.end();
                child.kill();
                resolve();
            }
        });
    });
}

async function runClient(options) {
    const [repo] = options.positional;
    const { PotionEmbedding } = require(path.join(ROOT, 'packages/core/dist/embedding/potion-embedding.js'));
    const { texts, bytes } = loadTexts(repo, options.mb);
    const embedding = await PotionEmbedding.create({
        helperPath: path.join(POTION, 'satori-potion'),
        modelPath: path.join(POTION, 'model'),
        maxBatchItems: Math.min(options.batch, 64),
    });
    await embedding.embedDocuments(texts.slice(0, 16));
    const startedAt = performance.now();
    for (let i = 0; i < texts.length; i += options.batch) await embedding.embedDocuments(texts.slice(i, i + options.batch));
    const ms = performance.now() - startedAt;
    console.log(`client batch=${options.batch} texts=${texts.length} ${(bytes / 1e6).toFixed(1)}MB ${Math.round(ms)}ms ${(bytes / 1e6 / (ms / 1000)).toFixed(2)} MB/s`);
    await embedding.close();
}

function hashHelper(helperPath, texts) {
    return new Promise((resolve, reject) => {
        const expected = Math.ceil(texts.length / 32);
        const frames = [];
        const child = startHelper(helperPath, (frame) => {
            frames.push(frame);
            if (frames.length !== expected + 1) return;
            const hash = crypto.createHash('sha256');
            for (const response of frames.slice(1)) {
                if (!response.ok) return reject(new Error(JSON.stringify(response).slice(0, 200)));
                for (const item of response.items) hash.update(JSON.stringify([item.retainedTokenCount, item.vector]));
            }
            child.stdin.end();
            child.kill();
            resolve(hash.digest('hex'));
        });
        for (let i = 0; i < texts.length; i += 32) {
            child.stdin.write(`${JSON.stringify({ op: 'encode_batch', id: `r${i}`, texts: texts.slice(i, i + 32) })}\n`);
        }
    });
}

async function runParity(options) {
    const [repo, helperA, helperB] = options.positional;
    const { texts } = loadTexts(repo, options.mb);
    const [a, b] = [await hashHelper(path.resolve(helperA), texts), await hashHelper(path.resolve(helperB), texts)];
    console.log(`items=${texts.length} A=${a.slice(0, 16)} B=${b.slice(0, 16)} ${a === b ? 'IDENTICAL' : 'DIFFERENT'}`);
    if (a !== b) process.exitCode = 1;
}

function runTexts(options) {
    const [repo, out] = options.positional;
    const { texts, bytes } = loadTexts(repo, options.mb);
    fs.writeFileSync(path.resolve(out), JSON.stringify(texts));
    console.log(`wrote ${texts.length} texts (${(bytes / 1e6).toFixed(1)}MB) to ${out}`);
}

const options = parseArgs(process.argv.slice(2));
const run = { helper: runHelper, client: runClient, parity: runParity, texts: runTexts }[options.mode];
if (!run || options.positional.length === 0) {
    console.error('usage: potion-throughput.cjs <helper|client|parity> <repo> [...] (see header)');
    process.exit(2);
}
Promise.resolve(run(options)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
