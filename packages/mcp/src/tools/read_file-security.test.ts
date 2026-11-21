import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_IGNORE_PATTERNS } from "@satori-code/core";
import { createSessionWorkspacePolicy } from "../core/session-workspace-policy.js";
import { readFileTool } from "./read_file.js";
import type { ToolContext } from "./types.js";

function initGitRepo(root: string): void {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "satori@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Satori Test"], { cwd: root });
}

function makeToolContext(
    root: string,
    publishedFiles: string[],
    options: {
        getActiveIgnorePatterns?: (codebasePath?: string) => string[];
        omitIgnorePatterns?: boolean;
    } = {},
): ToolContext {
    const publication = { publication: { canonicalRoot: root } };
    return {
        readFileMaxLines: 200,
        workspacePolicy: createSessionWorkspacePolicy({
            roots: [root],
            homeDirectory: os.homedir(),
            stateRoot: path.join(os.tmpdir(), "satori-read-file-sec-state"),
        }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => (codebaseRoot === root ? publication : undefined),
            getPublicationSourceCheckpoint: () => ({
                fileHashes: publishedFiles.map((file) => [file, "hash"]),
            }),
            ...(options.omitIgnorePatterns
                ? {}
                : {
                    getActiveIgnorePatterns: options.getActiveIgnorePatterns
                        ?? (() => [...DEFAULT_IGNORE_PATTERNS]),
                }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
    } as unknown as ToolContext;
}

test("read_file gives identical FILE_NOT_PUBLISHED denial for missing, directory, and unpublished regular files (P1-2)", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-oracle-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "published.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET_KEY=topsecret\n");
    fs.mkdirSync(path.join(root, "secret-dir"), { recursive: true });
    const ctx = makeToolContext(root, ["published.ts"]);

    const missingRes = await readFileTool.execute({ path: path.join(root, "does-not-exist.ts") }, ctx);
    const dirRes = await readFileTool.execute({ path: path.join(root, "secret-dir") }, ctx);
    const envRes = await readFileTool.execute({ path: path.join(root, ".env") }, ctx);

    for (const [label, res] of [
        ["missing", missingRes],
        ["directory", dirRes],
        ["unpublished .env", envRes],
    ] as const) {
        assert.equal(res.isError, true, `${label} must error`);
        const payload = JSON.parse(res.content[0].text) as { code?: string; reason?: string };
        assert.equal(payload.code, "FILE_NOT_PUBLISHED", `${label} must return FILE_NOT_PUBLISHED without existence/type oracle`);
        assert.equal(payload.reason, "file_not_published", `${label} must return file_not_published`);
    }
});

test("read_file rejects in-root symlinks without echoing the resolved target path (P1-2)", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-symlink-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "published.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(root, "hidden-secret.env"), "TOKEN=xyz\n");
    fs.mkdirSync(path.join(root, "internal-secret-dir"), { recursive: true });

    const linkToPublished = path.join(root, "alias-pub.ts");
    const linkToEnv = path.join(root, "alias-env.ts");
    const linkToDir = path.join(root, "alias-dir.ts");
    fs.symlinkSync(path.join(root, "published.ts"), linkToPublished);
    fs.symlinkSync(path.join(root, "hidden-secret.env"), linkToEnv);
    fs.symlinkSync(path.join(root, "internal-secret-dir"), linkToDir);

    const ctx = makeToolContext(root, ["published.ts"]);

    for (const [linkPath, forbiddenTargetName] of [
        [linkToPublished, "published.ts"],
        [linkToEnv, "hidden-secret.env"],
        [linkToDir, "internal-secret-dir"],
    ] as const) {
        const res = await readFileTool.execute({ path: linkPath }, ctx);
        assert.equal(res.isError, true);
        const text = res.content[0].text;
        const payload = JSON.parse(text) as { code?: string; path?: string };
        assert.equal(payload.code, "FINAL_SYMLINK_REJECTED");
        assert.equal(payload.path, linkPath, "denial path must echo the requested link path, not its resolved target");
        assert.equal(
            text.includes(forbiddenTargetName),
            false,
            `denial must not disclose symlink target '${forbiddenTargetName}': ${text}`,
        );
    }
});

test("read_file live-path admission fails closed when ignore patterns are missing or empty (P1-3)", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-ignore-failclosed-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initGitRepo(root);
    fs.writeFileSync(path.join(root, "published.ts"), "export const ok = 1;\n");
    execFileSync("git", ["add", "published.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

    const newFile = path.join(root, "untracked.ts");
    fs.writeFileSync(newFile, "export const secret = 123;\n");

    const missingCtx = makeToolContext(root, ["published.ts"], { omitIgnorePatterns: true });
    const emptyCtx = makeToolContext(root, ["published.ts"], { getActiveIgnorePatterns: () => [] });

    for (const [label, ctx] of [["missing", missingCtx], ["empty", emptyCtx]] as const) {
        const res = await readFileTool.execute({ path: newFile }, ctx);
        assert.equal(res.isError, true, `${label} ignore patterns must fail closed`);
        const payload = JSON.parse(res.content[0].text) as { code?: string };
        assert.equal(payload.code, "FILE_NOT_PUBLISHED");
    }
});

test("read_file live-path admission respects newly added .satoriignore rules immediately (P1-3)", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-satoriignore-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    initGitRepo(root);
    fs.writeFileSync(path.join(root, "published.ts"), "export const ok = 1;\n");
    execFileSync("git", ["add", "published.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

    const allowedNew = path.join(root, "allowed-new.ts");
    const ignoredNew = path.join(root, "private-new.ts");
    fs.writeFileSync(allowedNew, "export const visible = 1;\n");
    fs.writeFileSync(ignoredNew, "export const hidden = 2;\n");

    // In-memory active ignore patterns are stale (only DEFAULT_IGNORE_PATTERNS),
    // while .satoriignore on disk was just updated to exclude private-new.ts.
    fs.writeFileSync(path.join(root, ".satoriignore"), "private-new.ts\n");

    const ctx = makeToolContext(root, ["published.ts"]);

    const allowedRes = await readFileTool.execute({ path: allowedNew }, ctx);
    assert.notEqual(allowedRes.isError, true);
    assert.match(allowedRes.content[0].text, /export const visible = 1;/);

    const ignoredRes = await readFileTool.execute({ path: ignoredNew }, ctx);
    assert.equal(ignoredRes.isError, true);
    const payload = JSON.parse(ignoredRes.content[0].text) as { code?: string };
    assert.equal(payload.code, "FILE_NOT_PUBLISHED");
});
