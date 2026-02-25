import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileTool } from './read_file.js';
import { ToolContext } from './types.js';

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-file-test-'));
    const run = async () => await fn(dir);
    return run().finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

function buildContext(readFileMaxLines: number, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        readFileMaxLines,
        snapshotManager: {
            getAllCodebases: () => []
        },
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
            } as any,
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
            } as any
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
            } as any
        });

        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.mode, 'annotated');
        assert.match(payload.content, /const value = 1;/);
        assert.equal(payload.outlineStatus, 'requires_reindex');
        assert.equal(payload.outline, null);
    });
});
