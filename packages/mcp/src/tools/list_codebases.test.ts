import test from 'node:test';
import assert from 'node:assert/strict';
import { listCodebasesTool } from './list_codebases.js';
import { ToolContext } from './types.js';

type SectionMap = Map<string, string[]>;

function buildContext(entries: Array<{ path: string; info: Record<string, unknown> }>): ToolContext {
    return {
        snapshotManager: {
            getAllCodebases: () => entries
        }
    } as unknown as ToolContext;
}

async function runListCodebases(entries: Array<{ path: string; info: Record<string, unknown> }>) {
    return listCodebasesTool.execute({}, buildContext(entries));
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

    const response = await runListCodebases(entries);
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
