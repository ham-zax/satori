import test from 'node:test';
import assert from 'node:assert/strict';
import { listCodebasesTool } from './list_codebases.js';
import { ToolContext } from './types.js';

type SectionMap = Map<string, string[]>;
type MarkerMap = Record<string, unknown>;

const RUNTIME_FINGERPRINT = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
} as const;

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
        kind: 'satori_index_completion_v1',
        codebasePath: path,
        fingerprint: { ...RUNTIME_FINGERPRINT },
        indexedFiles: 10,
        totalChunks: 25,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_123',
        ...overrides
    };
}

async function runListCodebases(
    entries: Array<{ path: string; info: Record<string, unknown> }>,
    markers: MarkerMap = {},
    options?: { throwOnProbe?: boolean }
) {
    return listCodebasesTool.execute({}, buildContext(entries, markers, options));
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

test('list_codebases keeps ready membership stable when marker probe fails', async () => {
    const entries = [
        { path: '/repo/a', info: { status: 'indexed' } }
    ];
    const response = await runListCodebases(entries, {}, { throwOnProbe: true });
    const text = response.content[0]?.text || '';
    const sections = parseSectionLines(text);

    assert.deepEqual(extractPaths(sections.get('Ready') || []), ['/repo/a']);
    assert.match(text, /completion proof probe failed/);
});
