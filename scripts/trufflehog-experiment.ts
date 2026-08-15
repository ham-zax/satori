import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { Context } from '../packages/core/src/core/context';
import {
    readSymbolRegistrySidecar,
    readRelationshipSidecar,
} from '../packages/core/src/symbols/sidecar-reads';
import { WasmSemanticProjectAnalyzer } from '../packages/core/src/semantic/wasm/wasm-analyzer';
import { Embedding, type EmbeddingIdentity, type EmbeddingVector } from '../packages/core/src/embedding/base-embedding';
import { LanceDbVectorDatabase } from '../packages/core/src/vectordb/lancedb-vectordb';

const TRUFFLEHOG_PATH = '/home/hamza/repo/trufflehog';

/**
 * Deterministic semantic embedding based on term hashing & normalization.
 * Enables zero-dependency local vector indexing and hybrid keyword/semantic search.
 */
class DeterministicSemanticEmbedding extends Embedding {
    private readonly dimension = 64;
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return this.dimension;
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return 'DeterministicSemanticEmbedding';
    }

    getIdentity(): Readonly<EmbeddingIdentity> {
        return this.buildIdentity('deterministic-semantic-v1');
    }

    private computeVector(text: string): number[] {
        const vec = new Float64Array(this.dimension);
        const tokens = text.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
        for (const token of tokens) {
            const hash = crypto.createHash('md5').update(token).digest();
            const idx = hash.readUInt16BE(0) % this.dimension;
            const sign = (hash.readUInt8(2) % 2 === 0) ? 1 : -1;
            vec[idx] += sign * (1 + Math.log(1 + token.length));
        }

        // L2 normalize
        let norm = 0;
        for (let i = 0; i < this.dimension; i++) {
            norm += vec[i] * vec[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < this.dimension; i++) {
                vec[i] /= norm;
            }
        }
        return Array.from(vec);
    }

    async embedQuery(text: string): Promise<EmbeddingVector> {
        return {
            vector: this.computeVector(text),
            dimension: this.dimension,
        };
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map((t) => ({
            vector: this.computeVector(t),
            dimension: this.dimension,
        }));
    }
}

async function runExperiment() {
    console.log('='.repeat(80));
    console.log('🚀 SATORI CBM WASM SEMANTIC ENGINE BENCHMARK ON TRUFFLEHOG');
    console.log(`Target Repository: ${TRUFFLEHOG_PATH}`);
    console.log('='.repeat(80));

    if (!fs.existsSync(TRUFFLEHOG_PATH)) {
        console.error(`Error: Repository path ${TRUFFLEHOG_PATH} does not exist.`);
        process.exit(1);
    }

    // SECTION 1: Direct WASM Semantic Engine Analysis
    console.log('\n' + '-'.repeat(80));
    console.log('⚡ SECTION 1: Pure CBM WASM Engine Execution & Package Graph');
    console.log('-'.repeat(80));

    const goModPath = path.join(TRUFFLEHOG_PATH, 'go.mod');
    const goModContent = fs.readFileSync(goModPath, 'utf8');
    const goModHash = crypto.createHash('sha256').update(goModContent).digest('hex');

    // Collect representative core TruffleHog packages
    const targetDirs = [
        'pkg/engine',
        'pkg/analyzer',
        'pkg/detectors/aws',
        'pkg/detectors/github',
        'pkg/detectors/slack',
        'pkg/detectors/stripe',
        'pkg/sources/git',
        'pkg/sources/filesystem',
    ];

    const sourceFiles: { path: string; source: string; sourceHash: string }[] = [];
    if (fs.existsSync(path.join(TRUFFLEHOG_PATH, 'main.go'))) {
        const src = fs.readFileSync(path.join(TRUFFLEHOG_PATH, 'main.go'), 'utf8');
        sourceFiles.push({
            path: 'main.go',
            source: src,
            sourceHash: crypto.createHash('sha256').update(src).digest('hex'),
        });
    }

    for (const dir of targetDirs) {
        const fullDir = path.join(TRUFFLEHOG_PATH, dir);
        if (!fs.existsSync(fullDir)) continue;
        const entries = fs.readdirSync(fullDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
                const rel = path.join(dir, entry.name).replace(/\\/g, '/');
                const src = fs.readFileSync(path.join(fullDir, entry.name), 'utf8');
                sourceFiles.push({
                    path: rel,
                    source: src,
                    sourceHash: crypto.createHash('sha256').update(src).digest('hex'),
                });
            }
        }
    }

    console.log(`Loaded ${sourceFiles.length} core Go source files across ${targetDirs.length} subsystem packages.`);
    console.log(`Observed auxiliary: go.mod (${goModContent.split('\n')[0]})`);

    const wasmAnalyzer = new WasmSemanticProjectAnalyzer();
    const wasmStart = Date.now();
    const wasmResult = await wasmAnalyzer.analyze({
        language: 'go',
        sourceFiles,
        auxiliaryFiles: [
            {
                path: 'go.mod',
                role: 'manifest',
                source: goModContent,
                sourceHash: goModHash,
            },
        ],
    });
    const wasmDuration = Date.now() - wasmStart;

    let totalOccurrences = 0;
    let resolvedOccurrences = 0;
    const targetFiles = new Set<string>();

    for (const [_, occurrences] of wasmResult.occurrencesByFile) {
        totalOccurrences += occurrences.length;
        for (const occ of occurrences) {
            if (occ.decision === 'resolved' && occ.targetProvenance) {
                resolvedOccurrences++;
                targetFiles.add(occ.targetProvenance.file);
            }
        }
    }

    console.log(`\n✔ WASM Analysis completed in ${wasmDuration}ms!`);
    console.log(`   Files Analyzed:          ${sourceFiles.length}`);
    console.log(`   Total Call Sites Found:  ${totalOccurrences}`);
    console.log(`   Resolved Call Targets:   ${resolvedOccurrences} (${((resolvedOccurrences / (totalOccurrences || 1)) * 100).toFixed(1)}%)`);
    console.log(`   Unique Target Files:     ${targetFiles.size}`);

    // Sample some resolved call occurrences
    console.log('\n📌 Sample CBM WASM Resolved Calls:');
    let printed = 0;
    for (const [file, occurrences] of wasmResult.occurrencesByFile) {
        for (const occ of occurrences) {
            if (occ.decision === 'resolved' && occ.targetProvenance && printed < 6) {
                console.log(`   ${file}:${occ.callSpan.startLine} -> ${occ.targetProvenance.name}() in ${occ.targetProvenance.file}:${occ.targetProvenance.span.startLine} [strategy: ${occ.proof.strategy}, conf: ${occ.confidence}]`);
                printed++;
            }
        }
    }

    // SECTION 2: Full Satori Context Indexing & Navigation Sidecars
    console.log('\n' + '-'.repeat(80));
    console.log('📁 SECTION 2: Full Satori Pipeline & Navigation Sidecar Generation');
    console.log('-'.repeat(80));

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-trufflehog-exp-'));
    process.env.SATORI_STATE_DIR = stateDir;

    const lanceDir = path.join(stateDir, 'lancedb');
    fs.mkdirSync(lanceDir, { recursive: true });
    const vectorDatabase = new LanceDbVectorDatabase({ databasePath: lanceDir });
    const embedding = new DeterministicSemanticEmbedding();
    const context = new Context({ embedding, vectorDatabase });

    console.log(`Indexing TruffleHog codebase into Satori...`);
    const indexStart = Date.now();
    const indexResult = await context.indexCodebase(
        TRUFFLEHOG_PATH,
        (progress) => {
            if (progress.percentage % 25 === 0) {
                console.log(`   [Progress] ${progress.phase}: ${progress.percentage}% (${progress.current}/${progress.total})`);
            }
        }
    );
    const indexDuration = ((Date.now() - indexStart) / 1000).toFixed(2);
    console.log(`\n✔ Satori indexing completed in ${indexDuration}s!`);
    console.log(`   Indexed Searchable Files: ${indexResult.indexedFiles}`);
    console.log(`   Vector Chunks Created:    ${indexResult.totalChunks}`);

    // Check symbol registry and relationships from sidecars
    const symRegistryResult = await readSymbolRegistrySidecar({
        stateRoot: path.join(stateDir, 'navigation'),
        normalizedRootPath: TRUFFLEHOG_PATH,
    });

    if (symRegistryResult.status === 'ok') {
        console.log(`   Total Extracted Symbols:  ${symRegistryResult.registry.symbols.length}`);
        console.log(`   Manifest Indexed Files:   ${symRegistryResult.registry.manifest.files.length}`);
    }

    const relSidecarResult = await readRelationshipSidecar({
        stateRoot: path.join(stateDir, 'navigation'),
        normalizedRootPath: TRUFFLEHOG_PATH,
        expectedSymbolRegistryManifestHash: symRegistryResult.status === 'ok' ? symRegistryResult.manifestHash : '',
    });

    if (relSidecarResult.status === 'ok') {
        console.log(`   Total Relationship Edges: ${relSidecarResult.records.length}`);
    }

    // SECTION 3: Deep Call Graph Traversal
    console.log('\n' + '-'.repeat(80));
    console.log('🌐 SECTION 3: Graph Navigation & Call Hierarchy Inspection');
    console.log('-'.repeat(80));

    if (relSidecarResult.status === 'ok') {
        const testFiles = [
            'pkg/engine/engine.go',
            'pkg/detectors/aws/aws.go',
            'pkg/sources/git/git.go',
        ];

        for (const tf of testFiles) {
            const fileCalls = relSidecarResult.records.filter((r) => r.file === tf && r.type === 'CALLS');
            console.log(`\n🔍 Calls in: ${tf} (Total: ${fileCalls.length})`);
            for (const c of fileCalls.slice(0, 5)) {
                console.log(`     -> ${c.sourceKey} => ${c.targetKey} [auth: ${c.resolutionAuthority}, conf: ${c.confidence}]`);
            }
        }
    }

    // SECTION 4: Semantic Search Evaluation
    console.log('\n' + '-'.repeat(80));
    console.log('🔎 SECTION 4: Semantic Code Search Queries on TruffleHog');
    console.log('-'.repeat(80));

    const queries = [
        'detect AWS credentials secret access key and session token',
        'git branch walk commit history and chunking',
        'custom regex verification pattern matching and high entropy detection',
        'filesystem archive decompress zip tar scanner',
    ];

    for (const q of queries) {
        console.log(`\n🔎 Query: "${q}"`);
        const searchStart = Date.now();
        const results = await context.semanticSearch(TRUFFLEHOG_PATH, q, 3);
        const searchDuration = Date.now() - searchStart;
        console.log(`   Latency: ${searchDuration}ms | Matches: ${results.length}`);

        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            console.log(`   #${i + 1} [${res.relativePath}] (score: ${res.score.toFixed(4)})`);
            const snippetText = res.content || '';
            if (snippetText) {
                const firstLines = snippetText.split('\n').slice(0, 2).map((l: string) => '       ' + l.trim()).join('\n');
                console.log(firstLines);
            }
        }
    }

    console.log('\n' + '='.repeat(80));
    console.log('🎯 EXPERIMENT FINISHED SUCCESSFULLY');
    console.log('='.repeat(80));
}

runExperiment().catch((err) => {
    console.error('Experiment failed:', err);
    process.exit(1);
});
