import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
    createSessionWorkspacePolicy,
    WorkspaceAuthorizationError,
    type SessionWorkspacePolicy,
} from "./session-workspace-policy.js";
import {
    openAuthorizedPublishedFile,
    PublishedFileAuthorizationError,
} from "./published-file-authorization.js";
import { RootBoundFileError, verifyStableFileObservation } from "@satori-code/core";

const IS_LINUX = process.platform === "linux";

function setupWorkspace(t: TestContext): { workspace: string; policy: SessionWorkspacePolicy } {
    if (!IS_LINUX) {
        t.skip("descriptor-bound opening requires Linux O_NOFOLLOW and /proc/self/fd");
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "satori-pfa-"));
    t.after(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const policy = createSessionWorkspacePolicy({
        roots: [workspace],
        homeDirectory: os.homedir(),
        stateRoot: process.env.SATORI_STATE_ROOT ?? path.join(os.tmpdir(), "satori-pfa-state"),
    });
    return { workspace, policy };
}

function writeFile(workspace: string, relative: string, content = "print('ok')\n"): string {
    const absolute = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return absolute;
}

async function expectCode(
    promise: Promise<unknown>,
    errorType: new (...args: never[]) => Error,
    code?: string,
): Promise<void> {
    await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof errorType, `expected ${errorType.name}, got ${String(error)}`);
        if (code !== undefined) {
            const candidate = error as { code?: string };
            assert.equal(candidate.code, code);
        }
        return true;
    });
}

test("opens a published regular file", async (t) => {
    const { workspace, policy } = setupWorkspace(t);
    const filePath = writeFile(workspace, "src/a.ts", "export const a = 1;\n");
    const result = await openAuthorizedPublishedFile({
        workspacePolicy: policy,
        codebaseRoot: workspace,
        requestedPath: filePath,
        publishedRelativePaths: new Set(["src/a.ts"]),
    });
    try {
        assert.equal(result.relativePath, "src/a.ts");
        assert.equal(result.absolutePath, filePath);
        assert.equal(result.codebaseRoot, workspace);
        assert.ok(result.observedStat.isFile());
        assert.equal(result.observedStat.size, "export const a = 1;\n".length);
        assert.ok(result.identity.stableIdentity.length > 0);
    } finally {
        await result.handle.close();
    }
});

test("rejects an ignored or unpublished file", async (t) => {
    const { workspace, policy } = setupWorkspace(t);
    const filePath = writeFile(workspace, "src/secret.env", "TOKEN=abc\n");
    await expectCode(
        openAuthorizedPublishedFile({
            workspacePolicy: policy,
            codebaseRoot: workspace,
            requestedPath: filePath,
            publishedRelativePaths: new Set<string>(),
        }),
        PublishedFileAuthorizationError,
        "FILE_NOT_PUBLISHED",
    );
});

test("rejects a symlink to an outside file", async (t) => {
    const { workspace, policy } = setupWorkspace(t);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-pfa-outside-"));
    t.after(() => {
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });
    const outsideTarget = path.join(outsideDir, "id_ed25519");
    fs.writeFileSync(outsideTarget, "SECRET\n");
    const linkPath = path.join(workspace, "escaped.ts");
    fs.symlinkSync(outsideTarget, linkPath);
    await assert.rejects(
        openAuthorizedPublishedFile({
            workspacePolicy: policy,
            codebaseRoot: workspace,
            requestedPath: linkPath,
            publishedRelativePaths: new Set(["escaped.ts"]),
        }),
        WorkspaceAuthorizationError,
    );
});

test("rejects a symlink to an inside file", async (t) => {
    const { workspace, policy } = setupWorkspace(t);
    const targetPath = writeFile(workspace, "src/target.ts", "export const target = 1;\n");
    const linkPath = path.join(workspace, "alias.ts");
    fs.symlinkSync(targetPath, linkPath);
    // The symlink's canonical identity is its resolved target, so the published
    // set must contain the target's relative path for the publication gate to
    // pass and the final-symlink rejection to be the gate under test.
    await expectCode(
        openAuthorizedPublishedFile({
            workspacePolicy: policy,
            codebaseRoot: workspace,
            requestedPath: linkPath,
            publishedRelativePaths: new Set(["src/target.ts"]),
        }),
        PublishedFileAuthorizationError,
        "FINAL_SYMLINK_REJECTED",
    );
});

test("rejects a FIFO or directory", async (t) => {
    const { workspace, policy } = setupWorkspace(t);
    const directoryPath = path.join(workspace, "dir");
    fs.mkdirSync(directoryPath, { recursive: true });
    await expectCode(
        openAuthorizedPublishedFile({
            workspacePolicy: policy,
            codebaseRoot: workspace,
            requestedPath: directoryPath,
            publishedRelativePaths: new Set(["dir"]),
        }),
        PublishedFileAuthorizationError,
        "NOT_A_REGULAR_FILE",
    );

    let fifoPath: string | undefined;
    try {
        fifoPath = path.join(workspace, "pipe");
        execFileSync("mkfifo", [fifoPath]);
    } catch {
        t.skip("mkfifo is unavailable on this platform");
        return;
    }
    await expectCode(
        openAuthorizedPublishedFile({
            workspacePolicy: policy,
            codebaseRoot: workspace,
            requestedPath: fifoPath,
            publishedRelativePaths: new Set(["pipe"]),
        }),
        PublishedFileAuthorizationError,
        "NOT_A_REGULAR_FILE",
    );
});

test("detects path replacement between authorization and verification", async (t) => {
    const { workspace, policy } = setupWorkspace(t);
    const filePath = writeFile(workspace, "src/r.ts", "original content\n");
    const replacementPath = writeFile(workspace, "src/replacement.ts", "replaced content\n");
    const result = await openAuthorizedPublishedFile({
        workspacePolicy: policy,
        codebaseRoot: workspace,
        requestedPath: filePath,
        publishedRelativePaths: new Set(["src/r.ts"]),
    });
    try {
        fs.renameSync(replacementPath, filePath);
        await assert.rejects(
            verifyStableFileObservation(
                result.handle,
                result.absolutePath,
                result.codebaseRoot,
                result.observedStat,
            ),
            RootBoundFileError,
        );
    } finally {
        await result.handle.close();
    }
});
