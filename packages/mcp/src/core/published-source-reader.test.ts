import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    withSourceMeasurementOperation,
} from '@satori-code/core';
import {
    AuthorizedSourceReadError,
    READ_FILE_MAX_BYTES_DEFAULT,
    readAuthorizedPublishedSource,
} from './published-source-reader.js';
import { PublishedFileAuthorizationError } from './published-file-authorization.js';
import {
    createSessionWorkspacePolicy,
    WorkspaceAuthorizationError,
    type SessionWorkspacePolicy,
} from './session-workspace-policy.js';

function buildWorkspacePolicy(root: string): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots: [root],
        homeDirectory: os.homedir(),
        stateRoot: path.join(os.tmpdir(), 'published-source-reader-test-state'),
    });
}

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-reader-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

const PUBLISHED = new Set(['src/runtime.ts']);

function readSource(input: {
    repoPath: string;
    maxBytes?: number;
    onAuthorized?: () => Promise<void> | void;
}) {
    return readAuthorizedPublishedSource({
        workspacePolicy: buildWorkspacePolicy(input.repoPath),
        codebaseRoot: input.repoPath,
        requestedPath: path.join(input.repoPath, 'src', 'runtime.ts'),
        publishedRelativePaths: PUBLISHED,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        ...(input.onAuthorized ? { onAuthorized: input.onAuthorized } : {}),
    });
}

test('readAuthorizedPublishedSource returns bytes plus stable identity evidence', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, 'export function run() { return true; }\n', 'utf8');

        const result = await readSource({ repoPath });

        assert.equal(result.bytes.toString('utf8'), 'export function run() { return true; }\n');
        assert.equal(result.codebaseRoot, repoPath);
        assert.equal(result.absolutePath, filePath);
        assert.equal(result.relativePath, 'src/runtime.ts');
        assert.equal(result.observedStat.size, 39);
        assert.equal(typeof result.identity.stableIdentity, 'string');
        assert.equal(result.identity.canonicalRelativePath, 'src/runtime.ts');
        assert.equal(result.sourceMeasurementObservation, undefined);
    });
});

test('readAuthorizedPublishedSource rejects an oversized file before any read', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, 'small\n', 'utf8');
        // Enlarge as a sparse file far beyond the configured ceiling: the
        // denial must precede any allocation or content read.
        fs.truncateSync(filePath, 64 * 1024 * 1024);
        let hookRan = false;

        await assert.rejects(
            () => readSource({
                repoPath,
                maxBytes: 1024,
                onAuthorized: () => {
                    hookRan = true;
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, 'FILE_TOO_LARGE');
                assert.equal(error.maxBytes, 1024);
                assert.equal(error.observedSize, 64 * 1024 * 1024);
                assert.match(error.message, /READ_FILE_MAX_BYTES/);
                return true;
            },
        );
        // The post-authorization hook never runs: the ceiling is enforced
        // before the read and before any caller-visible side effect.
        assert.equal(hookRan, false);
    });
});

test('readAuthorizedPublishedSource defaults to the 8 MiB ceiling', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, 'small\n', 'utf8');
        fs.truncateSync(filePath, READ_FILE_MAX_BYTES_DEFAULT + 1);

        await assert.rejects(
            () => readSource({ repoPath }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, 'FILE_TOO_LARGE');
                assert.equal(error.maxBytes, READ_FILE_MAX_BYTES_DEFAULT);
                return true;
            },
        );
    });
});

test('readAuthorizedPublishedSource detects replacement after authorization via rename', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        const original = 'export const ORIGINAL = "CONTENT";\n';
        fs.writeFileSync(filePath, original, 'utf8');
        const swapPath = path.join(repoPath, 'src', 'swap.tmp');

        await assert.rejects(
            () => readSource({
                repoPath,
                onAuthorized: async () => {
                    // Rename a new file over the authorized path: the open
                    // descriptor still names the original inode, so the
                    // pathname rebinding after the read must fail closed.
                    fs.writeFileSync(swapPath, 'export const REPLACED = "SECRET";\n', 'utf8');
                    fs.renameSync(swapPath, filePath);
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, 'FILE_REPLACED');
                assert.match(error.message, /replaced|changed/i);
                return true;
            },
        );
    });
});

test('readAuthorizedPublishedSource detects same-size replacement after authorization', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        const original = 'export const ORIGINAL = "AAAA";\n';
        const sameSize = 'export const REPLACED = "BBBB";\n';
        assert.equal(Buffer.byteLength(original), Buffer.byteLength(sameSize));
        fs.writeFileSync(filePath, original, 'utf8');

        await assert.rejects(
            () => readSource({
                repoPath,
                onAuthorized: async () => {
                    // Rewrite the same inode with same-size content: only the
                    // descriptor metadata (mtime/ctime) can reveal the change,
                    // which the post-read stability verification checks.
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    fs.writeFileSync(filePath, sameSize, 'utf8');
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, 'FILE_REPLACED');
                return true;
            },
        );
    });
});

test('readAuthorizedPublishedSource detects deletion and recreation after authorization', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, 'export const ORIGINAL = "CONTENT";\n', 'utf8');

        await assert.rejects(
            () => readSource({
                repoPath,
                onAuthorized: async () => {
                    // Delete the authorized target and recreate it: the open
                    // descriptor pins the old inode, so the recreated path
                    // must fail the identity rebinding.
                    fs.rmSync(filePath);
                    fs.writeFileSync(filePath, 'export const RECREATED = "CONTENT";\n', 'utf8');
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, 'FILE_REPLACED');
                return true;
            },
        );
    });
});

test('readAuthorizedPublishedSource composes the unchanged publication gates', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, 'export function run() { return true; }\n', 'utf8');

        // Unpublished file: the manifest gate denies before any content read.
        await assert.rejects(
            () => readAuthorizedPublishedSource({
                workspacePolicy: buildWorkspacePolicy(repoPath),
                codebaseRoot: repoPath,
                requestedPath: filePath,
                publishedRelativePaths: new Set(['src/other.ts']),
            }),
            (error: unknown) => {
                assert.ok(error instanceof PublishedFileAuthorizationError);
                assert.equal(error.code, 'FILE_NOT_PUBLISHED');
                return true;
            },
        );

        // Out-of-workspace path: the session policy denies before publication.
        const outside = path.join(os.tmpdir(), `satori-outside-${process.pid}-${Date.now()}.ts`);
        fs.writeFileSync(outside, 'secret\n', 'utf8');
        try {
            await assert.rejects(
                () => readAuthorizedPublishedSource({
                    workspacePolicy: buildWorkspacePolicy(repoPath),
                    codebaseRoot: repoPath,
                    requestedPath: outside,
                    publishedRelativePaths: PUBLISHED,
                }),
                (error: unknown) => {
                    assert.ok(error instanceof WorkspaceAuthorizationError);
                    assert.equal(error.code, 'ROOT_NOT_AUTHORIZED');
                    return true;
                },
            );
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });
});

test('readAuthorizedPublishedSource records the source measurement ledger when requested', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, 'export function run() { return true; }\n', 'utf8');
        const ledgerFile = path.join(repoPath, 'ledger.jsonl');

        await withSourceMeasurementOperation({
            operation: 'read_file',
            ledgerFile,
            rootDir: repoPath,
        }, async () => {
            const result = await readAuthorizedPublishedSource({
                workspacePolicy: buildWorkspacePolicy(repoPath),
                codebaseRoot: repoPath,
                requestedPath: filePath,
                publishedRelativePaths: PUBLISHED,
                sourceMeasurement: {
                    owner: 'validation',
                    filePath,
                    scanKind: 'complete',
                },
            });
            assert.ok(result.sourceMeasurementObservation !== undefined);
        });

        const records = fs.readFileSync(ledgerFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const observation = records.find((record) => record.kind === 'source_observation');
        assert.ok(observation, 'expected a source_observation record');
        assert.equal(observation.logicalBytesRequested, 39);
        const ioRecord = records.find((record) => record.kind === 'source_io');
        assert.ok(ioRecord, 'expected a source_io record');
        assert.equal(ioRecord.basis, 'stream_chunk');
        assert.equal(ioRecord.bytesObtained, 39);
        const outcome = records.find((record) => record.kind === 'source_observation_outcome');
        assert.ok(outcome, 'expected a source_observation_outcome record');
        assert.equal(outcome.status, 'completed');
    });
});

test("readAuthorizedPublishedSource detects truncation inside onAuthorized during read", async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, "src", "runtime.ts");
        fs.writeFileSync(filePath, "export function run() { return true; }\n", "utf8");

        await assert.rejects(
            () => readSource({
                repoPath,
                onAuthorized: async () => {
                    // Truncate the file inside onAuthorized during the read process
                    fs.truncateSync(filePath, 5);
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, "FILE_REPLACED");
                assert.match(error.message, /does not match the observed size|changed/i);
                return true;
            },
        );
    });
});

test("readAuthorizedPublishedSource maps RootBoundFileError to FILE_REPLACED and records non-completed measurement outcome when truncated inside onAuthorized", async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, "src", "runtime.ts");
        fs.writeFileSync(filePath, "export function run() { return true; }\n", "utf8");
        const ledgerFile = path.join(repoPath, "ledger.jsonl");

        await withSourceMeasurementOperation({
            operation: "read_file",
            ledgerFile,
            rootDir: repoPath,
        }, async () => {
            await assert.rejects(
                () => readAuthorizedPublishedSource({
                    workspacePolicy: buildWorkspacePolicy(repoPath),
                    codebaseRoot: repoPath,
                    requestedPath: filePath,
                    publishedRelativePaths: PUBLISHED,
                    onAuthorized: async () => {
                        fs.truncateSync(filePath, 0);
                    },
                    sourceMeasurement: {
                        owner: "validation",
                        filePath,
                        scanKind: "complete",
                    },
                }),
                (error: unknown) => {
                    assert.ok(error instanceof AuthorizedSourceReadError);
                    assert.equal(error.code, "FILE_REPLACED");
                    return true;
                },
            );
        });

        const records = fs.readFileSync(ledgerFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const outcome = records.find((record) => record.kind === "source_observation_outcome");
        assert.ok(outcome, "expected a source_observation_outcome record");
        assert.notEqual(outcome.status, "completed");
    });
});

test("readAuthorizedPublishedSource detects growth inside onAuthorized during read", async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, "src", "runtime.ts");
        fs.writeFileSync(filePath, "export function run() { return true; }\n", "utf8");

        await assert.rejects(
            () => readSource({
                repoPath,
                onAuthorized: async () => {
                    fs.appendFileSync(filePath, "unexpected growth beyond observed size\n");
                },
            }),
            (error: unknown) => {
                assert.ok(error instanceof AuthorizedSourceReadError);
                assert.equal(error.code, "FILE_REPLACED");
                assert.match(error.message, /grew beyond the observed size|changed/i);
                return true;
            },
        );
    });
});

