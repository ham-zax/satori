import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    computeNavigationGenerationSealHash,
    resolveNavigationSidecarRoot,
} from '@zokizuan/satori-core';
import { listCodebasesTool } from './list_codebases.js';
import { ToolContext } from './types.js';

type SectionMap = Map<string, string[]>;
type MarkerMap = Record<string, unknown>;
type ProviderRuntimeOverride = {
    providerRuntime: {
        requireToolContext(operation: string): Promise<ToolContext>;
    };
};

const RUNTIME_FINGERPRINT = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    embeddingArtifactDigest: null,
    embeddingNormalizationPolicy: 'provider_output_v1',
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
    parserVersion: 'parser-v1',
    extractorVersion: 'extractor-v1',
    relationshipVersion: 'relationship-v1',
    embeddingProjectionVersion: 'embedding-projection-v1',
    lexicalProjectionVersion: 'lexical-projection-v1',
} as const;

const POLICY_HASH = 'a'.repeat(64);

function buildContext(
    entries: Array<{ path: string; info: Record<string, unknown> }>,
    markers: MarkerMap = {},
    options?: { throwOnProbe?: boolean }
): ToolContext {
    return {
        context: {
            getIndexCompletionMarker: async (codebasePath: string) => {
                if (options?.throwOnProbe) {
                    throw new Error('probe_failed');
                }
                return Object.prototype.hasOwnProperty.call(markers, codebasePath)
                    ? markers[codebasePath]
                    : null;
            }
        },
        snapshotManager: {
            getAllCodebases: () => entries
        },
        runtimeFingerprint: RUNTIME_FINGERPRINT
    } as unknown as ToolContext;
}

function createMarker(path: string, overrides?: Record<string, unknown>) {
    return {
        kind: 'satori_index_completion_v3',
        codebasePath: path,
        fingerprint: { ...RUNTIME_FINGERPRINT },
        indexedFiles: 10,
        totalChunks: 25,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_123',
        indexPolicyHash: POLICY_HASH,
        indexStatus: 'completed',
        navigation: { status: 'not_bound' },
        ...overrides
    };
}

async function runListCodebases(
    entries: Array<{ path: string; info: Record<string, unknown> }>,
    markers: MarkerMap = {},
    options?: {
        throwOnProbe?: boolean;
        runtimeOwnerGate?: ToolContext["runtimeOwnerGate"];
    }
) {
    const ctx = buildContext(entries, markers, options);
    if (options?.runtimeOwnerGate !== undefined) {
        (ctx as ToolContext).runtimeOwnerGate = options.runtimeOwnerGate;
    }
    return listCodebasesTool.execute({}, ctx);
}

function parseHeadings(text: string): string[] {
    return text
        .split('\n')
        .filter((line) => line.startsWith('### '))
        .map((line) => line.slice(4).trim());
}

function parseSectionLines(text: string): SectionMap {
    const sections: SectionMap = new Map();
    let currentSection: string | null = null;

    for (const line of text.split('\n')) {
        if (line.startsWith('### ')) {
            currentSection = line.slice(4).trim();
            sections.set(currentSection, []);
            continue;
        }
        if (!currentSection) {
            continue;
        }
        if (!line.startsWith('- `')) {
            continue;
        }
        sections.get(currentSection)?.push(line);
    }

    return sections;
}

function extractPaths(lines: string[]): string[] {
    return lines
        .map((line) => {
            const match = line.match(/^- `([^`]+)`/);
            return match ? match[1] : null;
        })
        .filter((value): value is string => Boolean(value));
}

test('list_codebases output is deterministic with fixed bucket order and sorted paths', async () => {
    const entries = [
        { path: '/repo/gamma', info: { status: 'indexed' } },
        { path: '/repo/alpha', info: { status: 'sync_completed' } },
        { path: '/repo/indexing-z', info: { status: 'indexing', indexingPercentage: 42.456 } },
        { path: '/repo/indexing-a', info: { status: 'indexing', indexingPercentage: 5 } },
        { path: '/repo/reindex-z', info: { status: 'requires_reindex', reindexReason: 'fingerprint_mismatch' } },
        { path: '/repo/reindex-a', info: { status: 'requires_reindex', reindexReason: 'missing_fingerprint' } },
        { path: '/repo/failed-z', info: { status: 'indexfailed', errorMessage: 'timeout' } },
        { path: '/repo/failed-a', info: { status: 'indexfailed', errorMessage: 'disk-full' } }
    ];

    const response = await runListCodebases(entries, {
        '/repo/gamma': createMarker('/repo/gamma'),
        '/repo/alpha': createMarker('/repo/alpha')
    });
    const text = response.content[0]?.text || '';

    const headings = parseHeadings(text);
    assert.deepEqual(headings, ['Ready', 'Indexing', 'Requires Reindex', 'Failed']);

    const sections = parseSectionLines(text);
    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/alpha', '/repo/gamma']);
    assert.deepEqual(extractPaths(sections.get('Indexing') || []), ['/repo/indexing-a', '/repo/indexing-z']);
    assert.deepEqual(extractPaths(sections.get('Requires Reindex') || []), ['/repo/reindex-a', '/repo/reindex-z']);
    assert.deepEqual(extractPaths(sections.get('Failed') || []), ['/repo/failed-a', '/repo/failed-z']);

    const indexingLines = sections.get('Indexing') || [];
    assert.ok(indexingLines.some((line) => line.includes('/repo/indexing-a') && line.includes('(5.0%)')));
    assert.ok(indexingLines.some((line) => line.includes('/repo/indexing-z') && line.includes('(42.5%)')));

    const allSectionPaths = Array.from(sections.values()).flatMap(extractPaths);
    assert.equal(new Set(allSectionPaths).size, allSectionPaths.length);
});

test('list_codebases preserves empty-state message when no codebases are tracked', async () => {
    const response = await runListCodebases([]);
    assert.equal(
        response.content[0]?.text,
        "No codebases are currently tracked.\n\nUse manage_index with action='create' to index one."
    );
});

test('list_codebases remains stable across repeated calls and does not mutate membership', async () => {
    const entries = [
        { path: '/repo/a', info: { status: 'indexed' } },
        { path: '/repo/b', info: { status: 'sync_completed' } }
    ];
    const frozenEntries = Object.freeze(entries.map((entry) => Object.freeze({
        path: entry.path,
        info: Object.freeze({ ...entry.info })
    })));

    const markerMap = {
        '/repo/a': createMarker('/repo/a'),
        '/repo/b': createMarker('/repo/b')
    };
    const first = await runListCodebases(
        frozenEntries as unknown as Array<{ path: string; info: Record<string, unknown> }>,
        markerMap
    );
    const second = await runListCodebases(
        frozenEntries as unknown as Array<{ path: string; info: Record<string, unknown> }>,
        markerMap
    );

    assert.equal(first.content[0]?.text, second.content[0]?.text);
    assert.match(first.content[0]?.text || '', /`\/repo\/a`/);
    assert.match(first.content[0]?.text || '', /`\/repo\/b`/);
});

test('list_codebases moves stale-local indexed entries to Failed bucket', async () => {
    const entries = [
        { path: '/repo/stale', info: { status: 'indexed' } },
        { path: '/repo/ok', info: { status: 'indexed' } }
    ];
    const response = await runListCodebases(entries, {
        '/repo/stale': null,
        '/repo/ok': createMarker('/repo/ok')
    });
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/ok']);
    assert.deepEqual(extractPaths(sections.get('Failed') || []), ['/repo/stale']);
    assert.match(text, /stale_local:missing_marker_doc/);
});

test('list_codebases maps completion-proof fingerprint mismatch to Requires Reindex', async () => {
    const entries = [
        { path: '/repo/mismatch', info: { status: 'indexed' } }
    ];
    const response = await runListCodebases(entries, {
        '/repo/mismatch': createMarker('/repo/mismatch', {
            fingerprint: {
                ...RUNTIME_FINGERPRINT,
                embeddingModel: 'voyage-3'
            }
        })
    });
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Requires Reindex') || []), ['/repo/mismatch']);
    assert.match(text, /completion_proof_fingerprint_mismatch/);
});

test('list_codebases maps retired and unsupported authority proofs to Requires Reindex', async () => {
    const response = await runListCodebases(
        [
            { path: '/repo/retired', info: { status: 'indexed' } },
            { path: '/repo/future', info: { status: 'indexed' } },
        ],
        {
            '/repo/retired': { status: 'requires_reindex' },
            '/repo/future': { status: 'unsupported_authority' },
        },
    );
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(
        extractPaths(sections.get('Requires Reindex') || []),
        ['/repo/future', '/repo/retired'],
    );
    assert.deepEqual(extractPaths(sections.get('Failed') || []), []);
});

test('list_codebases keeps ready membership stable when marker probe fails', async () => {
    const entries = [
        { path: '/repo/a', info: { status: 'indexed' } }
    ];
    const response = await runListCodebases(entries, {}, { throwOnProbe: true });
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/a']);
    assert.deepEqual(extractPaths(sections.get('Failed') || []), []);
});

test('list_codebases renders compact symbolQuality marker on ready roots', async () => {
    const entries = [
        { path: '/repo/ready-a', info: { status: 'indexed' } },
        { path: '/repo/ready-b', info: { status: 'sync_completed' } },
    ];
    const response = await runListCodebases(entries, {
        '/repo/ready-a': createMarker('/repo/ready-a'),
        '/repo/ready-b': createMarker('/repo/ready-b'),
    });
    const text = response.content[0]?.text || '';
    assert.match(text, /`\/repo\/ready-a` symbolQuality=unknown/);
    assert.match(text, /`\/repo\/ready-b` symbolQuality=unknown/);
    // Ready bucket still sorted by path
    const readySection = (text.split('### Ready')[1] || '').split('###')[0] || '';
    const aIdx = readySection.indexOf('/repo/ready-a');
    const bIdx = readySection.indexOf('/repo/ready-b');
    assert.ok(aIdx >= 0 && bIdx > aIdx);
});

test('list_codebases ignores an orphan navigation seal when the completion marker is not bound', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-list-quality-seal-'));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const codebasePath = '/repo/sealed-quality';
    try {
        process.env.SATORI_STATE_ROOT = stateRoot;
        const navigationRoot = resolveNavigationSidecarRoot(undefined, codebasePath);
        const generationId = 'sealed-generation';
        const generationRoot = path.join(navigationRoot, 'generations', generationId);
        const seal = {
            schemaVersion: 'navigation_generation_seal_v1' as const,
            generationId,
            symbolRegistryManifestHash: `symmanifest_${'a'.repeat(32)}`,
            relationshipManifestHash: 'b'.repeat(64),
            artifactSetHash: 'c'.repeat(64),
            symbolQuality: {
                indexedFileCount: 2,
                languages: [{
                    language: 'typescript',
                    indexedFiles: 2,
                    filesWithNonFileSymbols: 2,
                    nonFileSymbolCount: 4,
                }],
            },
        };
        fs.mkdirSync(generationRoot, { recursive: true });
        fs.writeFileSync(path.join(generationRoot, 'seal.json'), JSON.stringify(seal), 'utf8');
        fs.writeFileSync(path.join(navigationRoot, 'current.json'), JSON.stringify({
            schemaVersion: 'navigation_current_v3',
            generationId,
            symbolRegistryManifestHash: seal.symbolRegistryManifestHash,
            relationshipManifestHash: seal.relationshipManifestHash,
            navigationSealHash: computeNavigationGenerationSealHash(seal),
        }), 'utf8');

        const response = await runListCodebases(
            [{ path: codebasePath, info: { status: 'indexed' } }],
            { [codebasePath]: createMarker(codebasePath) },
        );

        assert.match(response.content[0]?.text || '', /`\/repo\/sealed-quality` symbolQuality=unknown/);
        assert.equal(fs.existsSync(path.join(generationRoot, 'manifest.json')), false);
        assert.equal(fs.existsSync(path.join(generationRoot, 'symbols')), false);
    } finally {
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test('list_codebases derives symbol quality from the seal bound by a valid generation receipt', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-list-quality-bound-seal-'));
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const codebasePath = '/repo/sealed-quality';
    try {
        process.env.SATORI_STATE_ROOT = stateRoot;
        const navigationRoot = resolveNavigationSidecarRoot(undefined, codebasePath);
        const generationId = 'sealed-generation';
        const generationRoot = path.join(navigationRoot, 'generations', generationId);
        const seal = {
            schemaVersion: 'navigation_generation_seal_v1' as const,
            generationId,
            symbolRegistryManifestHash: `symmanifest_${'a'.repeat(32)}`,
            relationshipManifestHash: 'b'.repeat(64),
            artifactSetHash: 'c'.repeat(64),
            symbolQuality: {
                indexedFileCount: 2,
                languages: [{
                    language: 'typescript',
                    indexedFiles: 2,
                    filesWithNonFileSymbols: 2,
                    nonFileSymbolCount: 4,
                }],
            },
        };
        const navigationSealHash = computeNavigationGenerationSealHash(seal);
        fs.mkdirSync(generationRoot, { recursive: true });
        fs.writeFileSync(path.join(generationRoot, 'seal.json'), JSON.stringify(seal), 'utf8');
        fs.writeFileSync(path.join(navigationRoot, 'current.json'), JSON.stringify({
            schemaVersion: 'navigation_current_v3',
            generationId,
            symbolRegistryManifestHash: seal.symbolRegistryManifestHash,
            relationshipManifestHash: seal.relationshipManifestHash,
            navigationSealHash,
        }), 'utf8');

        const marker = createMarker(codebasePath, {
            navigation: {
                status: 'sealed',
                generationId,
                symbolRegistryManifestHash: seal.symbolRegistryManifestHash,
                relationshipManifestHash: seal.relationshipManifestHash,
                sealHash: navigationSealHash,
            },
        });
        const response = await runListCodebases(
            [{ path: codebasePath, info: { status: 'indexed' } }],
            {
                [codebasePath]: {
                    status: 'valid_v3',
                    marker,
                    collectionName: 'collection-a',
                    navigationProof: { status: 'valid' },
                    generationReceipt: {
                        collectionName: 'collection-a',
                        marker,
                        policy: {
                            canonicalRoot: codebasePath,
                            profile: 'default',
                            customExtensions: [],
                            customIgnorePatterns: [],
                            fileBasedIgnorePatterns: [],
                            supportedExtensions: ['.ts'],
                            effectiveIgnorePatterns: [],
                            policyHash: POLICY_HASH,
                        },
                        policyDocumentDigest: 'd'.repeat(64),
                        exactPayloadCount: 25,
                        navigation: {
                            generationId,
                            generationRoot,
                            symbolRegistryManifestHash: seal.symbolRegistryManifestHash,
                            relationshipManifestHash: seal.relationshipManifestHash,
                            navigationSealHash,
                        },
                        observations: {
                            profileFileToken: null,
                            policyFileToken: 'policy-token',
                            navigationToken: 'navigation-token',
                        },
                    },
                },
            },
        );

        assert.match(response.content[0]?.text || '', /`\/repo\/sealed-quality` symbolQuality=symbol_rich/);
        assert.equal(fs.existsSync(path.join(generationRoot, 'manifest.json')), false);
        assert.equal(fs.existsSync(path.join(generationRoot, 'symbols')), false);
    } finally {
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test('list_codebases annotates ready entries when completion proof probe fails', async () => {
    const entries = [
        { path: '/repo/a', info: { status: 'indexed' } }
    ];
    const response = await runListCodebases(entries, {}, { throwOnProbe: true });
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/a']);
    assert.match(sections.get('Ready')?.[0] || '', /completion proof probe failed/i);
    assert.match(sections.get('Ready')?.[0] || '', /manage_index action='status'/i);
});

test('list_codebases uses provider vector context for completion proof when available', async () => {
    let requestedOperation: string | null = null;
    const ctx = buildContext([
        { path: '/repo/a', info: { status: 'indexed' } }
    ], {}, { throwOnProbe: true });
    (ctx as unknown as ProviderRuntimeOverride).providerRuntime = {
        requireToolContext: async (operation: string) => {
            requestedOperation = operation;
            return buildContext([
                { path: '/repo/a', info: { status: 'indexed' } }
            ], {
                '/repo/a': createMarker('/repo/a')
            });
        }
    };

    const response = await listCodebasesTool.execute({}, ctx);
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.equal(requestedOperation, 'vector_only');
    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/a']);
    assert.doesNotMatch(sections.get('Ready')?.[0] || '', /completion proof probe failed/i);
});

test('list_codebases preserves getIndexCompletionMarker receiver binding', async () => {
    const markerContext = {
        marker: createMarker('/repo/a'),
        async getIndexCompletionMarker(codebasePath: string) {
            assert.equal(this, markerContext);
            assert.equal(codebasePath, '/repo/a');
            return this.marker;
        }
    };
    const ctx = buildContext([
        { path: '/repo/a', info: { status: 'indexed' } }
    ]);
    (ctx as unknown as { context: typeof markerContext }).context = markerContext;

    const response = await listCodebasesTool.execute({}, ctx);
    const sections = parseSectionLines(response.content[0]?.text || '');

    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/a']);
    assert.deepEqual(extractPaths(sections.get('Failed') || []), []);
});

test('list_codebases prefers provider_incomplete over missing_marker when provider config is incomplete', async () => {
    const ctx = buildContext([
        { path: '/repo/a', info: { status: 'indexed' } },
        { path: '/repo/b', info: { status: 'sync_completed' } },
    ], {
        // Markers deliberately missing — without provider priority this becomes stale_local:missing_marker_doc.
        '/repo/a': null,
        '/repo/b': null,
    });
    (ctx as unknown as ProviderRuntimeOverride).providerRuntime = {
        requireToolContext: async () => ({
            ok: false,
            code: 'MISSING_PROVIDER_CONFIG',
            missingEnv: ['MILVUS_ADDRESS', 'VOYAGEAI_API_KEY'],
            message: 'Satori provider setup is incomplete. Missing required environment variable(s): MILVUS_ADDRESS, VOYAGEAI_API_KEY.',
            hints: {
                setup: {
                    code: 'MISSING_PROVIDER_CONFIG',
                    missingEnv: ['MILVUS_ADDRESS', 'VOYAGEAI_API_KEY'],
                    nextSteps: [
                        'Set MILVUS_ADDRESS, restart the MCP server, then retry the tool call.',
                        'Set VOYAGEAI_API_KEY, restart the MCP server, then retry the tool call.',
                    ],
                },
            },
        }) as unknown as ToolContext,
    };

    const response = await listCodebasesTool.execute({}, ctx);
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Ready') || []), []);
    assert.deepEqual(extractPaths(sections.get('Failed') || []), ['/repo/a', '/repo/b']);
    assert.match(text, /provider_incomplete/);
    assert.doesNotMatch(text, /stale_local:missing_marker_doc/);
    // Existing buckets only — no new section.
    assert.deepEqual(parseHeadings(text), ['Failed']);
});

test('list_codebases prefers provider_incomplete over snapshot requires_reindex when provider is incomplete', async () => {
    // HI-2: same recovery class as manage_index status for ready/requires_reindex roots.
    // indexfailed maps to status:"error" on manage_index and must keep the real failure reason.
    const ctx = buildContext([
        { path: '/repo/reindex', info: { status: 'requires_reindex', reindexReason: 'fingerprint_mismatch' } },
        { path: '/repo/ready-looking', info: { status: 'indexed' } },
        { path: '/repo/failed', info: { status: 'indexfailed', errorMessage: 'prior_error' } },
    ], {
        '/repo/ready-looking': null,
    });
    (ctx as unknown as ProviderRuntimeOverride).providerRuntime = {
        requireToolContext: async () => ({
            ok: false,
            code: 'MISSING_PROVIDER_CONFIG',
            missingEnv: ['MILVUS_ADDRESS'],
            message: 'missing',
            hints: {
                setup: {
                    code: 'MISSING_PROVIDER_CONFIG',
                    missingEnv: ['MILVUS_ADDRESS'],
                    nextSteps: ['Set MILVUS_ADDRESS, restart the MCP server, then retry the tool call.'],
                },
            },
        }) as unknown as ToolContext,
    };

    const response = await listCodebasesTool.execute({}, ctx);
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Requires Reindex') || []), []);
    assert.deepEqual(extractPaths(sections.get('Failed') || []), [
        '/repo/failed',
        '/repo/ready-looking',
        '/repo/reindex',
    ]);
    assert.match(sections.get('Failed')?.find((line) => line.includes('/repo/failed')) || '', /prior_error/);
    assert.match(sections.get('Failed')?.find((line) => line.includes('/repo/reindex')) || '', /provider_incomplete:MILVUS_ADDRESS/);
    assert.match(sections.get('Failed')?.find((line) => line.includes('/repo/ready-looking')) || '', /provider_incomplete:MILVUS_ADDRESS/);
    assert.doesNotMatch(text, /fingerprint_mismatch/);
    assert.doesNotMatch(text, /stale_local:missing_marker_doc/);
    assert.deepEqual(parseHeadings(text), ['Failed']);
});

test('list_codebases still maps true missing marker to stale_local when provider is available', async () => {
    const response = await runListCodebases(
        [{ path: '/repo/stale', info: { status: 'indexed' } }],
        { '/repo/stale': null },
    );
    const text = response.content[0]?.text || '';
    assert.match(text, /stale_local:missing_marker_doc/);
    assert.doesNotMatch(text, /provider_incomplete/);
});

test('list_codebases appends Runtime owners line from runtimeOwnerGate summary', async () => {
    const response = await runListCodebases(
        [{ path: '/repo/a', info: { status: 'indexed' } }],
        { '/repo/a': createMarker('/repo/a') },
        {
            runtimeOwnerGate: {
                checkMutation: async () => ({ blocked: false }),
                getLiveOwnersSummary: () => ({
                    liveCount: 2,
                    versions: ['4.11.13', '4.11.15'],
                    multiVersion: true,
                    registryPath: '/tmp/owners.json',
                    owners: [
                        { pid: 1, satoriVersion: '4.11.13', lastSeenAt: 't', configSource: 'env' },
                        { pid: 2, satoriVersion: '4.11.15', lastSeenAt: 't', configSource: 'env' },
                    ],
                }),
            },
        },
    );
    const text = response.content[0]?.text || '';
    assert.match(text, /Runtime owners: 2 live, multi-version/);
    assert.match(text, /runtime_owner_conflict/);
});

test('list_codebases omits Runtime owners line when summary is unavailable (null)', async () => {
    const response = await runListCodebases(
        [{ path: '/repo/a', info: { status: 'indexed' } }],
        { '/repo/a': createMarker('/repo/a') },
        {
            runtimeOwnerGate: {
                checkMutation: async () => ({ blocked: false }),
                getLiveOwnersSummary: () => null,
            },
        },
    );
    const text = response.content[0]?.text || '';
    assert.doesNotMatch(text, /Runtime owners:/);
    assert.doesNotMatch(text, /none live/);
});
