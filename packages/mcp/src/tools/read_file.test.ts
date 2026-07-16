import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool } from './read_file.js';
import { ToolContext } from './types.js';
import { withSourceMeasurementOperation } from '@zokizuan/satori-core';

type SnapshotManagerLike = ToolContext['snapshotManager'];
type SyncManagerLike = ToolContext['syncManager'];
type ToolHandlersLike = ToolContext['toolHandlers'];

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-file-test-'));
    const run = async () => await fn(dir);
    return run().finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

function indexedSnapshot(
    repoPath: string,
    status: 'indexed' | 'sync_completed' | 'indexing' | 'requires_reindex' = 'indexed',
    extra: Record<string, unknown> = {}
): SnapshotManagerLike {
    return {
        getAllCodebases: () => [{
            path: repoPath,
            info: { status, ...extra }
        }]
    } as unknown as SnapshotManagerLike;
}

function buildContext(readFileMaxLines: number, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        readFileMaxLines,
        snapshotManager: {
            getAllCodebases: () => []
        },
        syncManager: {} as unknown as SyncManagerLike,
        toolHandlers: {
            handleFileOutline: async () => ({
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        status: "requires_reindex",
                        path: "/repo",
                        file: "src/file.ts",
                        outline: null,
                        hasMore: false
                    })
                }]
            })
        },
        ...overrides
    } as unknown as ToolContext;
}

async function runReadFile(args: unknown, readFileMaxLines = 1000, overrides: Partial<ToolContext> = {}) {
    return readFileTool.execute(args, buildContext(readFileMaxLines, overrides));
}

function assertOutsideIndexedRoot(response: { isError?: boolean; content: Array<{ text: string }> }, secret?: string) {
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.status, 'outside_indexed_root');
    assert.equal(payload.reason, 'outside_indexed_root');
    assert.deepEqual(payload.hints?.nextSteps, [{ tool: 'list_codebases', args: {} }]);
    if (secret !== undefined) {
        assert.equal(response.content[0].text.includes(secret), false);
        assert.equal(payload.content, undefined);
    }
}

test('read_file schema rejects invalid line parameters', async () => {
    const fractional = await runReadFile({
        path: '/tmp/test.txt',
        start_line: 1.5
    });

    assert.equal(fractional.isError, true);
    assert.match(fractional.content[0].text, /Invalid arguments for 'read_file'/);
    assert.match(fractional.content[0].text, /start_line/);

    const zero = await runReadFile({
        path: '/tmp/test.txt',
        end_line: 0
    });

    assert.equal(zero.isError, true);
    assert.match(zero.content[0].text, /end_line/);
});

test('read_file returns full content for small files when range is omitted', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'small.ts');
        fs.writeFileSync(filePath, 'a\nb\nc\n', 'utf8');

        const response = await runReadFile({ path: filePath }, 1000, {
            snapshotManager: indexedSnapshot(dir)
        });
        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'a\nb\nc');
    });
});

test('read_file source instrumentation preserves output and records one acquisition boundary', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'small.ts');
        const ledgerFile = path.join(dir, 'source-ledger.jsonl');
        fs.writeFileSync(filePath, 'a\nb\nc\n', 'utf8');
        const overrides = { snapshotManager: indexedSnapshot(dir) };

        const unmeasured = await runReadFile({ path: filePath }, 1000, overrides);
        const measured = await withSourceMeasurementOperation({
            operation: 'read_file',
            ledgerFile,
            rootDir: dir,
        }, () => runReadFile({ path: filePath }, 1000, overrides));

        assert.deepEqual(measured, unmeasured);
        const records = fs.readFileSync(ledgerFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        assert.deepEqual(records.map((record) => record.kind), [
            'source_observation',
            'source_io',
            'source_observation_outcome',
            'source_processing',
        ]);
        assert.equal(records[0].relativeFile, 'small.ts');
        assert.equal(records[1].bytesObtained, 6);
        assert.equal(records[1].basis, 'path_read');
        assert.equal(records[2].status, 'completed');
        assert.equal(records[3].owner, 'selector');
        assert.equal(records[3].outcome, 'success');
    });
});

test('read_file touches the resolved indexed codebase root on successful reads', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'small.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'a\nb\nc\n', 'utf8');

        const touched: string[] = [];
        const response = await runReadFile(
            { path: filePath },
            1000,
            {
                snapshotManager: {
                    getAllCodebases: () => [{
                        path: repoPath,
                        info: { status: 'indexed' }
                    }]
                } as unknown as SnapshotManagerLike,
                syncManager: {
                    touchWatchedCodebase: async (codebasePath: string) => {
                        touched.push(codebasePath);
                    }
                } as unknown as SyncManagerLike
            }
        );

        assert.equal(response.isError, undefined);
        assert.deepEqual(touched, [repoPath]);
    });
});

test('read_file refreshes snapshot state before resolving indexed roots', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'small.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'a\nb\nc\n', 'utf8');

        let refreshCalls = 0;
        const response = await runReadFile(
            { path: filePath },
            1000,
            {
                snapshotManager: {
                    refreshFromDiskIfChanged: () => {
                        refreshCalls += 1;
                        return false;
                    },
                    getAllCodebases: () => [{
                        path: repoPath,
                        info: { status: 'indexed' }
                    }]
                } as unknown as SnapshotManagerLike,
            }
        );

        assert.equal(response.isError, undefined);
        assert.ok(refreshCalls >= 1);
    });
});

test('read_file does not touch watcher and denies path when no searchable codebase root resolves', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'orphan.ts');
        fs.writeFileSync(filePath, 'SECRET_ORPHAN\n', 'utf8');

        const touched: string[] = [];
        const response = await runReadFile(
            { path: filePath },
            1000,
            {
                syncManager: {
                    touchWatchedCodebase: async (codebasePath: string) => {
                        touched.push(codebasePath);
                    }
                } as unknown as SyncManagerLike
            }
        );

        assertOutsideIndexedRoot(response, 'SECRET_ORPHAN');
        assert.deepEqual(touched, []);
    });
});

test('read_file denies path outside all indexed roots', async () => {
    await withTempDir(async (dir) => {
        const outside = path.join(dir, 'outside.txt');
        fs.writeFileSync(outside, 'OUTSIDE_SECRET\n', 'utf8');
        const response = await runReadFile({ path: outside }, 1000, {
            snapshotManager: { getAllCodebases: () => [] } as unknown as SnapshotManagerLike
        });
        assertOutsideIndexedRoot(response, 'OUTSIDE_SECRET');
    });
});

test('read_file ignores relative snapshot codebase roots without CWD resolving them', async () => {
    await withTempDir(async (parent) => {
        const indexedRoot = path.join(parent, 'indexed-root');
        fs.mkdirSync(path.join(indexedRoot, 'src'), { recursive: true });
        const filePath = path.join(indexedRoot, 'src', 'app.ts');
        fs.writeFileSync(filePath, 'RELATIVE_SNAPSHOT_SECRET\n', 'utf8');

        const previousCwd = process.cwd();
        process.chdir(parent);
        try {
            const response = await runReadFile({ path: filePath }, 1000, {
                snapshotManager: {
                    // Legacy/corrupt relative root must not become valid via process CWD.
                    getAllCodebases: () => [{
                        path: 'indexed-root',
                        info: { status: 'indexed' },
                    }],
                } as unknown as SnapshotManagerLike,
            });
            assertOutsideIndexedRoot(response, 'RELATIVE_SNAPSHOT_SECRET');
        } finally {
            process.chdir(previousCwd);
        }
    });
});

test('read_file denies sibling repo path while another root is indexed', async () => {
    await withTempDir(async (dir) => {
        const indexedRoot = path.join(dir, 'indexed');
        const siblingRoot = path.join(dir, 'sibling');
        fs.mkdirSync(indexedRoot, { recursive: true });
        fs.mkdirSync(siblingRoot, { recursive: true });
        const siblingFile = path.join(siblingRoot, 'app.ts');
        fs.writeFileSync(siblingFile, 'SIBLING_SECRET\n', 'utf8');

        const response = await runReadFile({ path: siblingFile }, 1000, {
            snapshotManager: indexedSnapshot(indexedRoot)
        });
        assertOutsideIndexedRoot(response, 'SIBLING_SECRET');
    });
});

test('read_file denies symlink inside root pointing outside root', async () => {
    await withTempDir(async (dir) => {
        const indexedRoot = path.join(dir, 'indexed');
        const outsideDir = path.join(dir, 'outside');
        fs.mkdirSync(path.join(indexedRoot, 'src'), { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'SYMLINK_SECRET\n', 'utf8');
        const symlinkPath = path.join(indexedRoot, 'src', 'leak');
        fs.symlinkSync(outsideFile, symlinkPath);

        const response = await runReadFile({ path: symlinkPath }, 1000, {
            snapshotManager: indexedSnapshot(indexedRoot)
        });
        assertOutsideIndexedRoot(response, 'SYMLINK_SECRET');
    });
});

test('read_file denies absolute path with .. escaping root', async () => {
    await withTempDir(async (dir) => {
        const indexedRoot = path.join(dir, 'indexed');
        const outsideDir = path.join(dir, 'outside');
        fs.mkdirSync(indexedRoot, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'DOTDOT_SECRET\n', 'utf8');

        const escapePath = path.join(indexedRoot, '..', 'outside', 'secret.txt');
        const response = await runReadFile({ path: escapePath }, 1000, {
            snapshotManager: indexedSnapshot(indexedRoot)
        });
        assertOutsideIndexedRoot(response, 'DOTDOT_SECRET');
    });
});

test('read_file allows a normal file inside an indexed root', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'ok.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export const ok = 1;\n', 'utf8');

        const response = await runReadFile({ path: filePath }, 1000, {
            snapshotManager: indexedSnapshot(repoPath, 'indexed')
        });
        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'export const ok = 1;');
    });
});

test('read_file allows a normal file inside a sync_completed root', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'ok.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export const synced = 1;\n', 'utf8');

        const response = await runReadFile({ path: filePath }, 1000, {
            snapshotManager: indexedSnapshot(repoPath, 'sync_completed')
        });
        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'export const synced = 1;');
    });
});

test('read_file annotated mode must not return file content when denied outside root', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'secret.ts');
        fs.writeFileSync(filePath, 'ANNOTATED_SECRET_BODY\n', 'utf8');

        const response = await runReadFile({ path: filePath, mode: 'annotated' }, 1000, {
            snapshotManager: { getAllCodebases: () => [] } as unknown as SnapshotManagerLike
        });
        assertOutsideIndexedRoot(response, 'ANNOTATED_SECRET_BODY');
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.mode, undefined);
        assert.equal(payload.content, undefined);
    });
});

test('read_file rejects relative paths without reading', async () => {
    const response = await runReadFile({ path: 'relative/path.ts' }, 1000);
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.status, 'outside_indexed_root');
    assert.equal(payload.reason, 'relative_path_not_allowed');
});

test('read_file auto-truncates large files and returns dynamic continuation hint', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'large.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');

        const response = await runReadFile({ path: filePath }, 3, {
            snapshotManager: indexedSnapshot(dir)
        });
        assert.equal(response.isError, undefined);
        assert.equal(
            response.content[0].text,
            `L1\nL2\nL3\n\n(File truncated at line 3. To read more, call read_file with path="${path.resolve(filePath)}" and start_line=4.)`
        );
    });
});

test('read_file start_line-only requests use a capped window and continuation hint', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'window.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');

        const response = await runReadFile({ path: filePath, start_line: 2 }, 3, {
            snapshotManager: indexedSnapshot(dir)
        });
        assert.equal(response.isError, undefined);
        assert.equal(
            response.content[0].text,
            `L2\nL3\nL4\n\n(File truncated at line 4. To read more, call read_file with path="${path.resolve(filePath)}" and start_line=5.)`
        );
    });
});

test('read_file start_line + end_line returns exact inclusive range', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'range.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\n', 'utf8');

        const response = await runReadFile({ path: filePath, start_line: 2, end_line: 3 }, 3, {
            snapshotManager: indexedSnapshot(dir)
        });
        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'L2\nL3');
    });
});

test('read_file clamps out-of-range inputs safely', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'clamp.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');
        const snapshot = { snapshotManager: indexedSnapshot(dir) };

        const highClamp = await runReadFile({ path: filePath, start_line: 999, end_line: 1000 }, 3, snapshot);
        assert.equal(highClamp.isError, undefined);
        assert.equal(highClamp.content[0].text, 'L5');

        const endOnly = await runReadFile({ path: filePath, end_line: 2 }, 3, snapshot);
        assert.equal(endOnly.isError, undefined);
        assert.equal(endOnly.content[0].text, 'L1\nL2');
    });
});

test('read_file preserves missing-file and non-file errors', async () => {
    await withTempDir(async (dir) => {
        const missingPath = path.join(dir, 'missing.ts');
        const snapshot = { snapshotManager: indexedSnapshot(dir) };

        const missing = await runReadFile({ path: missingPath }, 1000, snapshot);
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /not found/);

        const annotatedMissing = await runReadFile({ path: missingPath, mode: 'annotated' }, 1000, snapshot);
        assert.equal(annotatedMissing.isError, true);
        assert.equal(JSON.parse(annotatedMissing.content[0].text).status, 'not_found');

        const nonFile = await runReadFile({ path: dir }, 1000, snapshot);
        assert.equal(nonFile.isError, true);
        assert.match(nonFile.content[0].text, /is not a file/);
    });
});

test('read_file returns not_ready envelope when parent codebase is indexing', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'export const value = true;\n', 'utf8');

        const response = await runReadFile({
            path: filePath
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{
                    path: repoPath,
                    info: {
                        status: 'indexing',
                        indexingPercentage: 42,
                        lastUpdated: '2026-02-27T23:57:03.000Z'
                    }
                }]
            } as unknown as SnapshotManagerLike
        });

        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'indexing');
        assert.equal(payload.codebaseRoot, repoPath);
        assert.equal(payload.indexing.progressPct, 42);
        assert.equal(payload.indexing.lastUpdated, '2026-02-27T23:57:03.000Z');
        assert.equal(payload.indexing.phase, null);
        assert.equal(payload.hints.status.tool, 'manage_index');
        assert.equal(payload.hints.status.args.action, 'status');
        assert.equal(payload.hints.status.args.path, repoPath);
    });
});

test('read_file annotated mode returns content and outline metadata when outline is available', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'export function run() {\n  return true;\n}\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'annotated'
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as unknown as SnapshotManagerLike,
            toolHandlers: {
                handleFileOutline: async () => ({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'ok',
                            path: repoPath,
                            file: 'src/runtime.ts',
                            outline: {
                                symbols: [{
                                    symbolId: 'sym_runtime_run',
                                    symbolLabel: 'function run()',
                                    span: { startLine: 1, endLine: 3 },
                                    callGraphHint: {
                                        supported: true,
                                        symbolRef: {
                                            file: 'src/runtime.ts',
                                            symbolId: 'sym_runtime_run'
                                        }
                                    }
                                }]
                            },
                            hasMore: false
                        })
                    }]
                })
            } as unknown as ToolHandlersLike
        });

        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.mode, 'annotated');
        assert.match(payload.content, /export function run\(\)/);
        assert.equal(payload.outlineStatus, 'ok');
        assert.equal(payload.outline.symbols.length, 1);
        assert.equal(payload.outline.symbols[0].symbolId, 'sym_runtime_run');
    });
});

test('read_file annotated mode degrades gracefully when outline is unavailable', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'runtime.ts');
        fs.writeFileSync(filePath, 'const value = 1;\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'annotated'
        }, 1000, {
            snapshotManager: indexedSnapshot(dir)
        });

        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.mode, 'annotated');
        assert.match(payload.content, /const value = 1;/);
        assert.equal(payload.outlineStatus, 'requires_reindex');
        assert.equal(payload.outline, null);
    });
});

test('read_file annotated mode treats JavaScript files as outline-capable', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'runtime.js');
        fs.writeFileSync(filePath, 'const value = 1;\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'annotated'
        }, 1000, {
            snapshotManager: indexedSnapshot(dir)
        });

        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.mode, 'annotated');
        assert.equal(payload.outlineStatus, 'requires_reindex');
        assert.equal(payload.outline, null);
    });
});

test('read_file annotated mode treats Go and Rust files as outline-capable', async () => {
    await withTempDir(async (dir) => {
        const goPath = path.join(dir, 'service.go');
        const rustPath = path.join(dir, 'stack.rs');
        fs.writeFileSync(goPath, 'package svc\nfunc add() {}\n', 'utf8');
        fs.writeFileSync(rustPath, 'fn demo() {}\n', 'utf8');

        for (const filePath of [goPath, rustPath]) {
            const response = await runReadFile({
                path: filePath,
                mode: 'annotated'
            }, 1000, {
                snapshotManager: indexedSnapshot(dir)
            });

            const payload = JSON.parse(response.content[0].text);
            assert.equal(payload.mode, 'annotated');
            assert.equal(payload.outlineStatus, 'requires_reindex');
            assert.equal(payload.outline, null);
        }
    });
});

test('read_file exact-symbol schema rejects legacy, mixed, and unknown request shapes', async () => {
    const base = {
        path: '/repo/src/runtime.ts',
        mode: 'plain' as const,
    };
    for (const open_symbol of [
        { symbolId: 'sym_runtime', context: { preset: 'implementation' } },
        {
            contractVersion: 2,
            symbolId: 'sym_runtime',
            symbolLabel: 'runtime',
            context: { preset: 'implementation' },
        },
        {
            contractVersion: 2,
            symbolId: 'sym_runtime',
            context: { preset: 'implementation' },
            continuation: {
                kind: 'source_range',
                fingerprint: 'sha256_source_fixture',
                startLine: 1,
                endLine: 2,
            },
        },
        {
            contractVersion: 2,
            symbolId: 'sym_runtime',
            context: { preset: 'implementation' },
            fullSymbol: true,
        },
    ]) {
        const response = await runReadFile({ ...base, open_symbol });
        assert.equal(response.isError, true);
        assert.match(response.content[0].text, /Invalid arguments for 'read_file'/);
    }

    const missingMode = await runReadFile({
        path: base.path,
        open_symbol: {
            contractVersion: 2,
            symbolId: 'sym_runtime',
            context: { preset: 'implementation' },
        },
    });
    assert.equal(missingMode.isError, true);
    assert.match(missingMode.content[0].text, /mode is required/);
});

function composedContextFixture() {
    return {
        status: 'ok' as const,
        symbol: {
            symbolId: 'sym_runtime',
            symbolKey: 'key:runtime',
            name: 'runtime',
            qualifiedName: 'runtime',
            label: 'function runtime()',
            kind: 'function',
            language: 'typescript',
            file: 'src/runtime.ts',
            span: { startLine: 1, endLine: 3 },
            parentQualifiedNamePath: [],
            parentResolution: 'not_applicable',
        },
        outline: {
            siblings: {
                items: [],
                returnedCount: 0,
                availableCount: 0,
                truncated: false,
            },
        },
        source: {
            selectionPolicyVersion: 'bounded_source_selection_v1',
            mode: 'complete',
            status: 'available',
            span: { startLine: 1, endLine: 3, startByte: 0, endByte: 42 },
            completeSymbolReturned: true,
            totalLines: 3,
            totalBytes: 42,
            returnedLines: 3,
            returnedBytes: 42,
            excerptCount: 1,
            excerpts: [{
                reason: 'complete_symbol',
                selectionBases: ['complete_symbol'],
                startLine: 1,
                endLine: 3,
                startByte: 0,
                endByte: 42,
                content: 'export function runtime() {\n  return true;\n}',
            }],
            omittedRanges: [],
            truncated: false,
            selectionCapabilities: {
                localLexical: 'available',
                lineWindows: 'available',
                syntaxBoundaries: 'available',
                controlFlowAnchors: 'available',
            },
            limitations: [],
        },
        relationships: {
            callers: { status: 'not_requested', relationship: 'caller' },
            callees: { status: 'not_requested', relationship: 'callee' },
        },
        authority: {
            vector: 'not_required',
            navigation: 'remote_generation_proven',
            source: {
                freshness: 'current_at_final_observation',
                spanResolution: 'index_snapshot_matched',
            },
            relationships: 'not_requested',
        },
        continuations: [],
        limitations: [],
    };
}

test('read_file exact symbols use vector-backed authority and return one bounded transport in both modes', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'DO_NOT_READ_THROUGH_LEGACY_BRANCH\n', 'utf8');

        for (const mode of ['plain', 'annotated'] as const) {
            let received: unknown;
            const requestedOperations: string[] = [];
            const providerContext = buildContext(1000, {
                snapshotManager: indexedSnapshot(repoPath),
                toolHandlers: {
                    composeSymbolContext: async (input: unknown) => {
                        received = input;
                        return { status: 'ok', context: composedContextFixture() };
                    },
                } as unknown as ToolHandlersLike,
            });
            const response = await runReadFile({
                path: filePath,
                mode,
                open_symbol: {
                    contractVersion: 2,
                    symbolId: 'sym_runtime',
                    context: {
                        preset: 'implementation',
                        budgets: {
                            sourceBytes: 999_999,
                            totalResponseBytes: 999_999,
                        },
                    },
                },
            }, 1000, {
                snapshotManager: indexedSnapshot(repoPath),
                providerRuntime: {
                    requireToolContext: async (operation) => {
                        requestedOperations.push(operation);
                        return providerContext;
                    },
                },
                toolHandlers: {
                    composeSymbolContext: async () => {
                        throw new Error('exact symbol context used the local-only handler');
                    },
                } as unknown as ToolHandlersLike,
            });

            assert.equal(response.isError, undefined);
            assert.deepEqual(requestedOperations, ['vector_only']);
            const payload = JSON.parse(response.content[0].text);
            assert.equal(payload.formatVersion, 2);
            assert.equal(payload.kind, 'symbol_context');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.effectiveRequest.requestedMode, mode);
            assert.equal(payload.effectiveRequest.budgets.sourceBytes, 16_384);
            assert.equal(payload.effectiveRequest.budgets.totalResponseBytes, 32_768);
            assert.equal(payload.source.excerpts[0].content.includes('DO_NOT_READ'), false);
            assert.equal((received as { symbolId?: string }).symbolId, 'sym_runtime');
        }
    });
});

test('read_file exact-symbol continuations forward only their scoped evidence request', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export function runtime() {}\n', 'utf8');

        let received: {
            include?: Record<string, boolean>;
            continuation?: Record<string, unknown>;
        } | undefined;
        const response = await runReadFile({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: 'sym_runtime',
                continuation: {
                    kind: 'source_range',
                    fingerprint: 'sha256_source_fixture',
                    startLine: 10,
                    endLine: 20,
                },
            },
        }, 1000, {
            snapshotManager: indexedSnapshot(repoPath),
            toolHandlers: {
                composeSymbolContext: async (input: typeof received) => {
                    received = input;
                    return { status: 'ok', context: composedContextFixture() };
                },
            } as unknown as ToolHandlersLike,
        });

        assert.equal(response.isError, undefined);
        assert.deepEqual(received?.include, {
            source: true,
            siblings: false,
            callers: false,
            callees: false,
        });
        assert.deepEqual(received?.continuation, {
            kind: 'source_range',
            fingerprint: 'sha256_source_fixture',
            startLine: 10,
            endLine: 20,
        });
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.effectiveRequest.continuation.kind, 'source_range');
        assert.equal(JSON.stringify(payload).includes('sha256_source_fixture'), false);
    });
});

test('read_file exact-symbol errors use bounded common envelopes without caller-controlled values', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'SECRET_SOURCE\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolLabel: 'CALLER_CONTROLLED_SECRET_LABEL',
                context: { preset: 'definition' },
            },
        }, 1000, {
            snapshotManager: indexedSnapshot(repoPath),
            toolHandlers: {
                composeSymbolContext: async () => ({
                    status: 'symbol_not_found',
                    reason: 'arbitrary internal detail',
                }),
            } as unknown as ToolHandlersLike,
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.deepEqual({
            formatVersion: payload.formatVersion,
            kind: payload.kind,
            status: payload.status,
            code: payload.code,
        }, {
            formatVersion: 2,
            kind: 'symbol_context',
            status: 'error',
            code: 'SYMBOL_NOT_FOUND',
        });
        assert.equal(response.content[0].text.includes('CALLER_CONTROLLED'), false);
        assert.equal(response.content[0].text.includes(filePath), false);
        assert.equal(response.content[0].text.includes('SECRET_SOURCE'), false);
        assert.ok(Buffer.byteLength(response.content[0].text) <= 4_096);
    });
});

test('read_file exact-symbol outcome matrix uses the canonical bounded error transport', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export function runtime() {}\n', 'utf8');

        const cases = [
            {
                result: { status: 'ambiguous_symbol', reason: 'ambiguous_symbol_label' },
                code: 'AMBIGUOUS_SYMBOL',
            },
            {
                result: { status: 'symbol_not_found', reason: 'symbol_identity_not_found' },
                code: 'SYMBOL_NOT_FOUND',
            },
            {
                result: { status: 'stale_continuation', reason: 'continuation_identity_changed' },
                code: 'STALE_CONTINUATION',
            },
            {
                result: {
                    status: 'invalid_relationship_continuation',
                    reason: 'cursor_invalid_for_prepared_traversal',
                },
                code: 'INVALID_RELATIONSHIP_CONTINUATION',
            },
            {
                result: {
                    status: 'safety_error',
                    reason: 'root_binding_invalid',
                    diagnosticCode: 'ROOT_BINDING_INVALID',
                },
                code: 'ROOT_BINDING_INVALID',
            },
            {
                result: {
                    status: 'resource_limit',
                    symbolId: 'sym_runtime',
                    minimumRequiredResponseBytes: 40_000,
                    hardResponseLimitBytes: 24_000,
                },
                code: 'MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT',
            },
            {
                result: { status: 'navigation_unavailable', reason: 'prepared_navigation_unavailable' },
                code: 'NAVIGATION_UNAVAILABLE',
            },
            {
                result: { status: 'stale', reason: 'prepared_authority_changed' },
                code: 'NAVIGATION_UNAVAILABLE',
            },
        ] as const;

        for (const fixture of cases) {
            const response = await runReadFile({
                path: filePath,
                mode: 'plain',
                open_symbol: {
                    contractVersion: 2,
                    symbolId: 'sym_runtime',
                    context: { preset: 'implementation' },
                },
            }, 1000, {
                snapshotManager: indexedSnapshot(repoPath),
                toolHandlers: {
                    composeSymbolContext: async () => fixture.result,
                } as unknown as ToolHandlersLike,
            });

            assert.equal(response.isError, true, fixture.code);
            const payload = JSON.parse(response.content[0].text);
            assert.deepEqual({
                formatVersion: payload.formatVersion,
                kind: payload.kind,
                status: payload.status,
                code: payload.code,
            }, {
                formatVersion: 2,
                kind: 'symbol_context',
                status: 'error',
                code: fixture.code,
            });
            const limit = fixture.code === 'ROOT_BINDING_INVALID'
                || fixture.code === 'MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT'
                ? 1_024
                : 4_096;
            assert.ok(Buffer.byteLength(response.content[0].text) <= limit, fixture.code);
            if (fixture.code === 'MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT') {
                assert.equal(payload.hardResponseLimitBytes, 32_768);
            }
        }

        const unsupported = await runReadFile({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: 'sym_runtime',
                continuation: { kind: 'future_continuation' },
            },
        }, 1000, {
            snapshotManager: indexedSnapshot(repoPath),
            toolHandlers: {
                composeSymbolContext: async () => {
                    throw new Error('unsupported continuations must not reach the composer');
                },
            } as unknown as ToolHandlersLike,
        });
        assert.equal(unsupported.isError, true);
        assert.equal(JSON.parse(unsupported.content[0].text).code, 'UNSUPPORTED_CONTINUATION_KIND');
    });
});

test('read_file exact-symbol root discovery failures use navigation-unavailable transport', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'runtime.ts');
        fs.writeFileSync(filePath, 'ROOT_DISCOVERY_SECRET\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: 'sym_runtime',
                context: { preset: 'definition' },
            },
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.code, 'NAVIGATION_UNAVAILABLE');
        assert.equal(response.content[0].text.includes(filePath), false);
        assert.equal(response.content[0].text.includes('ROOT_DISCOVERY_SECRET'), false);
    });
});

test('read_file open_symbol direct spans remain unversioned and bounded to the requested range', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                startLine: 2,
                endLine: 3,
            },
        }, 1000, {
            snapshotManager: indexedSnapshot(dir),
        });

        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'line2\nline3');
    });
});

test('read_file annotated mode denies content when only non-searchable requires_reindex roots match', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'REQUIRES_REINDEX_SECRET\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'annotated'
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [
                    { path: repoPath, info: { status: 'requires_reindex' } }
                ]
            } as unknown as SnapshotManagerLike
        });

        assertOutsideIndexedRoot(response, 'REQUIRES_REINDEX_SECRET');
    });
});

test('read_file exact-symbol request reports navigation unavailable while its root is indexing', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: 'sym_runtime_instance',
                context: { preset: 'implementation' },
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [
                    { path: repoPath, info: { status: 'indexing' } }
                ]
            } as unknown as SnapshotManagerLike
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.deepEqual({
            formatVersion: payload.formatVersion,
            kind: payload.kind,
            status: payload.status,
            code: payload.code,
        }, {
            formatVersion: 2,
            kind: 'symbol_context',
            status: 'error',
            code: 'NAVIGATION_UNAVAILABLE',
        });
        assert.equal(response.content[0].text.includes(repoPath), false);
    });
});
