import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool } from './read_file.js';
import { ToolContext } from './types.js';
import { ToolHandlers } from '../core/handlers.js';
import { CapabilityResolver } from '../core/capabilities.js';
import { IndexFingerprint } from '../config.js';
import type { FileOutlineInput } from '../core/search-types.js';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    writeSymbolRegistrySidecar,
} from '@zokizuan/satori-core';
import type { SymbolRegistryManifest } from '@zokizuan/satori-core';

type SnapshotManagerLike = ToolContext['snapshotManager'];
type SyncManagerLike = ToolContext['syncManager'];
type ToolHandlersLike = ToolContext['toolHandlers'];
type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const CAPABILITIES = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

function buildMarker(repoPath: string, fingerprint: IndexFingerprint = RUNTIME_FINGERPRINT) {
    return {
        kind: 'satori_index_completion_v1',
        codebasePath: repoPath,
        fingerprint,
        indexedFiles: 4,
        totalChunks: 8,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_test'
    };
}

function sha256Content(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-file-test-'));
    const run = async () => await fn(dir);
    return run().finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

async function withTempStateRoot<T>(fn: () => Promise<T>): Promise<T> {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-file-state-'));
    process.env.SATORI_STATE_ROOT = stateRoot;
    try {
        return await fn();
    } finally {
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

function buildContext(readFileMaxLines: number, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        readFileMaxLines,
        snapshotManager: {
            getAllCodebases: () => []
        },
        syncManager: {},
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

        const response = await runReadFile({ path: filePath }, 1000);
        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'a\nb\nc');
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

test('read_file does not touch watcher state when no indexed codebase root resolves', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'orphan.ts');
        fs.writeFileSync(filePath, 'a\n', 'utf8');

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

        assert.equal(response.isError, undefined);
        assert.deepEqual(touched, []);
    });
});

test('read_file auto-truncates large files and returns dynamic continuation hint', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'large.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');

        const response = await runReadFile({ path: filePath }, 3);
        assert.equal(response.isError, undefined);
        assert.equal(
            response.content[0].text,
            `L1\nL2\nL3\n\n(File truncated at line 3. To read more, call read_file with path="${filePath}" and start_line=4.)`
        );
    });
});

test('read_file start_line-only requests use a capped window and continuation hint', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'window.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');

        const response = await runReadFile({ path: filePath, start_line: 2 }, 3);
        assert.equal(response.isError, undefined);
        assert.equal(
            response.content[0].text,
            `L2\nL3\nL4\n\n(File truncated at line 4. To read more, call read_file with path="${filePath}" and start_line=5.)`
        );
    });
});

test('read_file start_line + end_line returns exact inclusive range', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'range.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\n', 'utf8');

        const response = await runReadFile({ path: filePath, start_line: 2, end_line: 3 }, 3);
        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'L2\nL3');
    });
});

test('read_file clamps out-of-range inputs safely', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'clamp.ts');
        fs.writeFileSync(filePath, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');

        const highClamp = await runReadFile({ path: filePath, start_line: 999, end_line: 1000 }, 3);
        assert.equal(highClamp.isError, undefined);
        assert.equal(highClamp.content[0].text, 'L5');

        const endOnly = await runReadFile({ path: filePath, end_line: 2 }, 3);
        assert.equal(endOnly.isError, undefined);
        assert.equal(endOnly.content[0].text, 'L1\nL2');
    });
});

test('read_file preserves missing-file and non-file errors', async () => {
    await withTempDir(async (dir) => {
        const missingPath = path.join(dir, 'missing.ts');
        const missing = await runReadFile({ path: missingPath }, 1000);
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /not found/);

        const nonFile = await runReadFile({ path: dir }, 1000);
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
            snapshotManager: {
                getAllCodebases: () => []
            } as unknown as SnapshotManagerLike
        });

        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.mode, 'annotated');
        assert.match(payload.content, /const value = 1;/);
        assert.equal(payload.outlineStatus, 'requires_reindex');
        assert.equal(payload.outline, null);
        assert.deepEqual(payload.hints?.nextSteps, [
            { tool: 'list_codebases', args: {} }
        ]);
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
            snapshotManager: {
                getAllCodebases: () => []
            } as unknown as SnapshotManagerLike
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
                snapshotManager: {
                    getAllCodebases: () => []
                } as unknown as SnapshotManagerLike
            });

            const payload = JSON.parse(response.content[0].text);
            assert.equal(payload.mode, 'annotated');
            assert.equal(payload.outlineStatus, 'requires_reindex');
            assert.equal(payload.outline, null);
        }
    });
});

test('read_file open_symbol treats symbolId as canonical symbolInstanceId on exact opens', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as unknown as SnapshotManagerLike,
            toolHandlers: {
                handleFileOutline: async (args: FileOutlineInput) => {
                    assert.equal(args.resolveMode, 'exact');
                    assert.equal(args.symbolIdExact, 'sym_runtime_instance');
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'ok',
                                path: repoPath,
                                file: 'src/runtime.ts',
                                outline: {
                                    symbols: [{
                                        symbolId: 'sym_runtime_instance',
                                        symbolLabel: 'function run()',
                                        span: { startLine: 2, endLine: 3 },
                                        callGraphHint: {
                                            supported: true,
                                            symbolRef: { file: 'src/runtime.ts', symbolId: 'sym_runtime_instance' }
                                        }
                                    }]
                                },
                                hasMore: false
                            })
                        }]
                    };
                }
            } as unknown as ToolHandlersLike
        });

        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'line2\nline3');
    });
});

test('read_file open_symbol opens source-repaired Python multiline function spans', async () => {
    await withTempStateRoot(async () => withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const relativePath = 'src/phases.py';
        const filePath = path.join(repoPath, relativePath);
        const source = [
            'def previous_phase():',
            '    return _rename_outputs(signal)',
            '',
            'def _attach_entry_telemetry(',
            '    *,',
            '    signal=None,',
            '    entry_decision=None,',
            '    pending=None,',
            ') -> None:',
            '    telemetry = build_entry_telemetry(',
            '        signal=signal,',
            '        entry_decision=entry_decision,',
            '        pending=pending,',
            '    )',
            '    return telemetry',
            '',
            'def build_entry_telemetry(*, signal=None, entry_decision=None, pending=None):',
            '    return (signal, entry_decision, pending)',
            '',
        ].join('\n');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, source, 'utf8');

        const fileHash = sha256Content(source);
        const staleHeaderContent = source.split('\n').slice(1, 9).join('\n');
        const symbols = buildSymbolRecordsForFile({
            relativePath,
            language: 'python',
            content: source,
            fileHash,
            extractorVersion: 'test-extractor-v1',
            chunks: [{
                content: staleHeaderContent,
                metadata: {
                    startLine: 2,
                    endLine: 9,
                    language: 'python',
                    filePath: relativePath,
                    symbolLabel: 'function _attach_entry_telemetry(',
                },
            }],
        });
        const attach = symbols.find((symbol) => symbol.name === '_attach_entry_telemetry');
        assert.ok(attach);
        assert.equal(attach.span.endLine, 9);
        const manifest: SymbolRegistryManifest = {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: repoPath,
            rootFingerprint: 'test-root-fingerprint',
            indexPolicyHash: 'test-policy',
            languageRouterVersion: 'test-router-v1',
            extractorVersion: 'test-extractor-v1',
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: [{
                path: relativePath,
                hash: fileHash,
                language: 'python',
                symbolCount: symbols.length,
            }],
        };
        await writeSymbolRegistrySidecar({
            registry: buildSymbolRegistry({ manifest, symbols }),
        });

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified',
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: (codebasePath: string) => codebasePath === repoPath ? codebaseInfo : undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined,
        } as unknown as SnapshotManagerLike;
        const handlers = new ToolHandlers(
            {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            } as unknown as HandlerContext,
            snapshotManager,
            {} as unknown as SyncManagerLike,
            RUNTIME_FINGERPRINT,
            CAPABILITIES
        );

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: attach.symbolInstanceId,
            },
        }, 1000, {
            snapshotManager,
            syncManager: {},
            toolHandlers: handlers,
        });

        assert.equal(response.isError, undefined);
        assert.match(response.content[0].text, /telemetry = build_entry_telemetry\(/);
        assert.match(response.content[0].text, /return telemetry/);
        assert.doesNotMatch(response.content[0].text, /def previous_phase/);
        assert.doesNotMatch(response.content[0].text, /return _rename_outputs\(signal\)/);
        assert.doesNotMatch(response.content[0].text, /def build_entry_telemetry/);
    }));
});

test('read_file open_symbol opens a Go symbol by symbolInstanceId through exact outline resolution', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'service.go');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'package svc\n\nfunc add() {\n  println("ok")\n}\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'go_add_instance'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as unknown as SnapshotManagerLike,
            toolHandlers: {
                handleFileOutline: async (args: FileOutlineInput) => {
                    assert.equal(args.resolveMode, 'exact');
                    assert.equal(args.symbolIdExact, 'go_add_instance');
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'ok',
                                path: repoPath,
                                file: 'service.go',
                                outline: {
                                    symbols: [{
                                        symbolId: 'go_add_instance',
                                        symbolLabel: 'function add',
                                        span: { startLine: 3, endLine: 5 },
                                        callGraphHint: {
                                            supported: false,
                                            reason: 'unsupported_language'
                                        }
                                    }]
                                },
                                hasMore: false
                            })
                        }]
                    };
                }
            } as unknown as ToolHandlersLike
        });

        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'func add() {\n  println("ok")\n}');
    });
});

test('read_file open_symbol opens a Rust symbol by symbolInstanceId through exact outline resolution', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const filePath = path.join(repoPath, 'stack.rs');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, [
            'pub struct Stack { value: i32 }',
            '',
            'impl Stack {',
            '  pub fn push(&mut self, value: i32) {',
            '    self.value = value;',
            '  }',
            '}',
            '',
        ].join('\n'), 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'rust_push_instance'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as any,
            toolHandlers: {
                handleFileOutline: async (args: any) => {
                    assert.equal(args.resolveMode, 'exact');
                    assert.equal(args.symbolIdExact, 'rust_push_instance');
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'ok',
                                path: repoPath,
                                file: 'stack.rs',
                                outline: {
                                    symbols: [{
                                        symbolId: 'rust_push_instance',
                                        symbolLabel: 'method push',
                                        span: { startLine: 4, endLine: 6 },
                                        callGraphHint: {
                                            supported: false,
                                            reason: 'unsupported_language'
                                        }
                                    }]
                                },
                                hasMore: false
                            })
                        }]
                    };
                }
            } as any
        });

        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, '  pub fn push(&mut self, value: i32) {\n    self.value = value;\n  }');
    });
});

test('read_file open_symbol returns not_found for a stale symbolInstanceId without span fallback', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance_stale'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as any,
            toolHandlers: {
                handleFileOutline: async (args: any) => {
                    assert.equal(args.resolveMode, 'exact');
                    assert.equal(args.symbolIdExact, 'sym_runtime_instance_stale');
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'not_found',
                                path: repoPath,
                                file: 'src/runtime.ts',
                                message: 'Exact symbol not found for symbolInstanceId.',
                                hasMore: false
                            })
                        }]
                    };
                }
            } as any
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'not_found');
        assert.match(payload.message, /Exact symbol not found/);
    });
});

test('read_file open_symbol does not bypass exact resolution when stale symbolInstanceId also includes a span', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance_stale',
                start_line: 4,
                end_line: 4,
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as any,
            toolHandlers: {
                handleFileOutline: async (args: any) => {
                    assert.equal(args.resolveMode, 'exact');
                    assert.equal(args.symbolIdExact, 'sym_runtime_instance_stale');
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'not_found',
                                path: repoPath,
                                file: 'src/runtime.ts',
                                message: 'Exact symbol not found for symbolInstanceId.',
                                hasMore: false
                            })
                        }]
                    };
                }
            } as any
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'not_found');
        assert.match(payload.message, /Exact symbol not found/);
    });
});

test('read_file open_symbol returns requires_reindex for stale symbolInstanceId when exact navigation is incompatible', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance_stale'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as any,
            toolHandlers: {
                handleFileOutline: async (args: any) => {
                    assert.equal(args.resolveMode, 'exact');
                    assert.equal(args.symbolIdExact, 'sym_runtime_instance_stale');
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'requires_reindex',
                                path: repoPath,
                                file: 'src/runtime.ts',
                                message: 'Symbol registry is incompatible with the current file state.',
                                hints: {
                                    reindex: {
                                        tool: 'manage_index',
                                        args: { action: 'reindex', path: repoPath }
                                    }
                                },
                                hasMore: false
                            })
                        }]
                    };
                }
            } as any
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.hints.reindex.tool, 'manage_index');
        assert.deepEqual(payload.hints.reindex.args, { action: 'reindex', path: repoPath });
    });
});

test('read_file open_symbol returns not_indexed when delegated exact navigation finds missing vector collection readiness', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined,
            removeCodebaseCompletely: () => undefined,
            saveCodebaseSnapshot: () => undefined
        } as any;
        const syncManager = {
            unwatchCodebase: async () => undefined
        } as any;
        const handlerContext = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({
                hasCollection: async () => false
            }),
            resolveCollectionName: () => 'satori_repo_missing_collection',
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as any;
        const toolHandlers = new ToolHandlers(handlerContext, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance'
            }
        }, 1000, {
            snapshotManager,
            syncManager,
            toolHandlers
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.match(payload.message, /vector collection is missing from the configured vector backend/i);
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
    });
});

test('read_file open_symbol preserves failed-index diagnostics from delegated exact navigation', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{
                    path: repoPath,
                    info: { status: 'indexed' }
                }]
            } as any,
            syncManager: {} as any,
            toolHandlers: {
                handleFileOutline: async () => ({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'not_indexed',
                            reason: 'index_failed',
                            path: repoPath,
                            codebaseRoot: repoPath,
                            file: 'src/runtime.ts',
                            outline: null,
                            hasMore: false,
                            message: 'Codebase has a failed indexing attempt.',
                            indexingFailure: {
                                errorMessage: 'Interrupted indexing detected without completion marker proof.',
                                lastAttemptedPercentage: 0,
                                lastUpdated: '2026-06-19T12:15:18.574Z'
                            },
                            hints: {
                                create: {
                                    tool: 'manage_index',
                                    args: { action: 'create', path: repoPath }
                                }
                            }
                        })
                    }]
                })
            } as any
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'index_failed');
        assert.equal(payload.indexingFailure?.errorMessage, 'Interrupted indexing detected without completion marker proof.');
        assert.equal(payload.indexingFailure?.lastAttemptedPercentage, 0);
        assert.equal(payload.indexingFailure?.lastUpdated, '2026-06-19T12:15:18.574Z');
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
    });
});

test('read_file open_symbol still supports direct span opens when no symbol identity is supplied', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                start_line: 3,
                end_line: 4,
            }
        });

        assert.equal(response.isError, undefined);
        assert.equal(response.content[0].text, 'line3\nline4');
    });
});

test('read_file open_symbol returns explicit error on ambiguous symbol resolution', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolLabel: 'function same()'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }]
            } as any,
            toolHandlers: {
                handleFileOutline: async () => ({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'ambiguous',
                            path: repoPath,
                            file: 'src/runtime.ts',
                            message: 'Multiple exact symbol matches found (2).',
                            outline: {
                                symbols: [
                                    { symbolId: 'sym_a', symbolLabel: 'function same()', span: { startLine: 1, endLine: 1 } },
                                    { symbolId: 'sym_b', symbolLabel: 'function same()', span: { startLine: 3, endLine: 3 } }
                                ]
                            },
                            hasMore: false
                        })
                    }]
                })
            } as any
        });

        assert.equal(response.isError, true);
        assert.match(response.content[0].text, /"status": "ambiguous"/);
    });
});

test('read_file open_symbol unresolved root returns structured runnable nextSteps without placeholders', async () => {
    await withTempDir(async (dir) => {
        const filePath = path.join(dir, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => []
            } as any
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'requires_reindex');
        assert.deepEqual(payload.hints?.nextSteps, [
            { tool: 'list_codebases', args: {} }
        ]);
    });
});

test('read_file annotated mode ignores non-searchable candidate roots in nextSteps', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'const value = 1;\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            mode: 'annotated'
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [
                    { path: repoPath, info: { status: 'requires_reindex' } }
                ]
            } as any
        });

        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.outlineStatus, 'requires_reindex');
        assert.deepEqual(payload.hints?.nextSteps, [
            { tool: 'list_codebases', args: {} }
        ]);
    });
});

test('read_file open_symbol request is blocked with not_ready when parent codebase is indexing', async () => {
    await withTempDir(async (dir) => {
        const repoPath = path.join(dir, 'repo');
        const srcPath = path.join(repoPath, 'src');
        fs.mkdirSync(srcPath, { recursive: true });
        const filePath = path.join(srcPath, 'runtime.ts');
        fs.writeFileSync(filePath, 'line1\nline2\n', 'utf8');

        const response = await runReadFile({
            path: filePath,
            open_symbol: {
                symbolId: 'sym_runtime_instance'
            }
        }, 1000, {
            snapshotManager: {
                getAllCodebases: () => [
                    { path: repoPath, info: { status: 'indexing' } }
                ]
            } as any
        });

        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'indexing');
        assert.equal(payload.hints?.status?.tool, 'manage_index');
        assert.equal(payload.hints?.status?.args?.action, 'status');
        assert.equal(payload.hints?.status?.args?.path, repoPath);
    });
});
