import { createReadStream } from 'node:fs';
import { loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildSearchProjections, type SearchProjectionInput } from '../../packages/core/src/core/search-projections';
import { buildProjectionBatch, flatten, loadAddon, MAX_BYTES, MAX_INPUTS, rawBytes, type Counts } from './wrapper';
import { assertProjectionEqual, projectionBytes } from './compare';

/** The line cap bounds decoding and JSON.parse, even for stdin without a newline. */
export async function* readJsonl(input: AsyncIterable<Buffer>, maxLineBytes: number): AsyncGenerator<SearchProjectionInput> {
    let parts: Buffer[] = [];
    let size = 0;
    let lineNumber = 0;
    const append = (part: Buffer): void => {
        size += part.length;
        if (size > maxLineBytes) throw new Error(`JSONL line exceeds ${maxLineBytes} bytes`);
        parts.push(part);
    };
    const parse = (): SearchProjectionInput | undefined => {
        lineNumber++;
        const text = Buffer.concat(parts, size).toString('utf8');
        parts = [];
        size = 0;
        if (!text.trim()) return;
        const value = JSON.parse(text) as SearchProjectionInput;
        if (!value || typeof value.relativePath !== 'string' || typeof value.chunk?.content !== 'string' || !value.chunk.metadata) {
            throw new Error(`Invalid SearchProjectionInput on line ${lineNumber}`);
        }
        const metadata = value.chunk.metadata;
        for (const field of ['language', 'symbolKind', 'symbolLabel'] as const) {
            if (metadata[field] !== undefined && typeof metadata[field] !== 'string') throw new Error(`Invalid ${field} on line ${lineNumber}`);
        }
        if (metadata.breadcrumbs !== undefined && (!Array.isArray(metadata.breadcrumbs) || !metadata.breadcrumbs.every(v => typeof v === 'string'))) {
            throw new Error(`Invalid breadcrumbs on line ${lineNumber}`);
        }
        return value;
    };
    for await (const buffer of input) {
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] !== 10) continue;
            append(buffer.subarray(start, i));
            const value = parse();
            if (value) yield value;
            start = i + 1;
        }
        if (start < buffer.length) append(buffer.subarray(start));
    }
    if (size) { const value = parse(); if (value) yield value; }
}
export async function* batches(inputs: AsyncIterable<SearchProjectionInput>): AsyncGenerator<SearchProjectionInput[]> {
    let batch: SearchProjectionInput[] = [];
    let size = 0;
    for await (const input of inputs) {
        const bytes = rawBytes(flatten(input));
        if (batch.length && (batch.length >= MAX_INPUTS || size + bytes > MAX_BYTES)) {
            yield batch;
            batch = [];
            size = 0;
        }
        batch.push(input);
        size += bytes;
    }
    if (batch.length) yield batch;
}
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export async function main(args: string[]): Promise<void> {
    const mode = args[0];
    if (mode !== 'compare' && mode !== 'benchmark') throw new Error('Usage: tools.ts compare|benchmark --input FILE|- [--repetitions N] [--max-line-bytes N]');
    const options = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
        if (!['--input', '--repetitions', '--max-line-bytes'].includes(args[i]) || args[i + 1] === undefined) throw new Error(`Invalid option ${args[i]}`);
        options.set(args[i], args[i + 1]);
    }
    const inputPath = options.get('--input') ?? '-';
    const repetitions = Number(options.get('--repetitions') ?? (mode === 'benchmark' ? 3 : 1));
    const maxLineBytes = Number(options.get('--max-line-bytes') ?? 16 * 1024 * 1024);
    if (!Number.isSafeInteger(repetitions) || repetitions < (mode === 'benchmark' ? 3 : 1) || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('Invalid repetition count or line cap');
    if (inputPath === '-' && repetitions !== 1) throw new Error('Repeated benchmark needs a seekable --input FILE. Stdin supports single-pass compare.');
    const startLoad = loadavg();
    if (!loadAddon()) throw new Error('Native addon unavailable. Build the experiment before comparison.');
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
        const counts: Counts = { total: 0, native: 0, fallback: 0, calls: 0 };
        let referenceMs = 0;
        let nativeMs = 0;
        const source = inputPath === '-' ? process.stdin : createReadStream(inputPath, { highWaterMark: 64 * 1024 });
        try {
            for await (const batch of batches(readJsonl(source, maxLineBytes))) {
                let start = performance.now();
                const expected = batch.map(buildSearchProjections);
                const expectedBytes = expected.map(projectionBytes);
                referenceMs += performance.now() - start;
                start = performance.now();
                const actual = await buildProjectionBatch(batch, { counts });
                const actualBytes = actual.map(projectionBytes);
                nativeMs += performance.now() - start;
                for (let i = 0; i < batch.length; i++) {
                    // Both string materializations are inside the measured sections.
                    if (actualBytes[i] !== expectedBytes[i]) assertProjectionEqual(actual[i], expected[i], `input ${counts.total - batch.length + i}`);
                    if (Object.keys(actual[i]).length !== 4) throw new Error('Native projection has extra fields');
                }
            }
        } finally { if (source !== process.stdin) source.destroy(); }
        runs.push({ referenceMs, nativeMs, counts, rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 });
    }
    console.log(JSON.stringify({ mode, input: inputPath, command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], repetitions,
        startLoad, runs, medianReferenceMs: median(runs.map(r => r.referenceMs)), medianNativeMs: median(runs.map(r => r.nativeMs)),
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
        note: 'Synthetic or fixture parity does not establish corpus acceptance. Peak RSS is the process high-water mark across repetitions.' }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
