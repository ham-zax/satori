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

test("read_file skips unrelated publications before authorizing candidates", async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-candidate-")));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, "workspace");
    const outside = path.join(base, "external");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const file = path.join(root, "published.ts");
    fs.writeFileSync(file, "export const ok = 1;\n");
    const ctx = makeToolContext(root, ["published.ts"]);
    const original = ctx.workspacePolicy;
    const authorized: string[] = [];
    ctx.workspacePolicy = { ...original, authorizeRoot: (candidate) => {
        authorized.push(candidate);
        return original.authorizeRoot(candidate);
    } };
    ctx.context.listCurrentPublications = () => [
        { publication: { canonicalRoot: outside } },
        { publication: { canonicalRoot: root } },
    ] as ReturnType<typeof ctx.context.listCurrentPublications>;
    const result = await readFileTool.execute({ path: file }, ctx);
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(result.content[0].text, /export const ok = 1/);
    assert.ok(authorized.includes(root));
    assert.ok(!authorized.includes(outside));

    const externalFile = path.join(outside, "external.ts");
    fs.writeFileSync(externalFile, "export const external = 2;\n");
    const externalContext = makeToolContext(outside, ["external.ts"]);
    const externalResult = await readFileTool.execute({ path: externalFile }, externalContext);
    assert.equal(externalResult.isError, undefined, externalResult.content[0].text);
    assert.match(externalResult.content[0].text, /export const external = 2/);
});

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

test("exact-symbol reads deny a tracked final symlink before composing source", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-symbol-alias-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "published.ts");
    const copy = path.join(root, "private-copy.ts");
    fs.writeFileSync(copy, "export function target() { return 1; }\n");
    fs.symlinkSync(copy, file);
    const ctx = makeToolContext(root, ["published.ts"]);
    const result = await readFileTool.execute({
        path: file, codebaseRoot: root,
        open_symbol: { contractVersion: 2, symbolId: "published-id", context: { preset: "implementation" } },
    }, ctx);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, "FINAL_SYMLINK_REJECTED");
    assert.ok(!result.content[0].text.includes(copy));
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

test("read_file rejects in-root final symlink pointing outside boundRoot with FINAL_SYMLINK_REJECTED instead of ROOT_BINDING_INVALID", async (t) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "satori-rf-bound-symlink-")));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, "repo");
    const symlinkedRoot = path.join(base, "repo-link");
    const outsideDir = path.join(base, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(root, symlinkedRoot);

    fs.writeFileSync(path.join(root, "published.ts"), "export const ok = 1;\n");
    const outsideSecret = path.join(outsideDir, "secret-token.env");
    fs.writeFileSync(outsideSecret, "TOP_SECRET=1\n");
    const escapeLink = path.join(root, "escape.ts");
    fs.symlinkSync(outsideSecret, escapeLink);

    const ctx = makeToolContext(root, ["published.ts"]);

    // Even when codebaseRoot is passed via a symlinked workspace directory, an in-root final
    // symlink pointing outside boundRoot must fail uniformly as FINAL_SYMLINK_REJECTED without
    // disclosing its target path or triggering ROOT_BINDING_INVALID.
    const symlinkRes = await readFileTool.execute({
        path: path.join(symlinkedRoot, "escape.ts"),
        codebaseRoot: symlinkedRoot,
        start_line: 1,
        end_line: 5,
    }, ctx);
    assert.equal(symlinkRes.isError, true);
    const symlinkText = symlinkRes.content[0].text;
    const symlinkPayload = JSON.parse(symlinkText) as {
        code?: string;
        reason?: string;
        path?: string;
        kind?: string;
    };
    assert.equal(symlinkPayload.code, "FINAL_SYMLINK_REJECTED");
    assert.equal(symlinkPayload.reason, "symlink_rejected");
    assert.equal(symlinkPayload.path, path.join(symlinkedRoot, "escape.ts"));
    assert.equal(symlinkPayload.kind, undefined);
    assert.equal(symlinkText.includes("secret-token.env"), false);
    assert.equal(symlinkText.includes("TOP_SECRET"), false);

    // Regular/non-symlink paths outside boundRoot still return plain ROOT_BINDING_INVALID.
    const outsideRegularRes = await readFileTool.execute({
        path: outsideSecret,
        codebaseRoot: symlinkedRoot,
        start_line: 1,
        end_line: 5,
    }, ctx);
    assert.equal(outsideRegularRes.isError, true);
    const outsidePayload = JSON.parse(outsideRegularRes.content[0].text) as {
        code?: string;
        reason?: string;
        kind?: string;
        formatVersion?: number;
    };
    assert.equal(outsidePayload.code, "ROOT_BINDING_INVALID");
    assert.equal(outsidePayload.reason, "root_binding_invalid");
    assert.equal(outsidePayload.kind, undefined);
    assert.equal(outsidePayload.formatVersion, undefined);

    // Missing file under a symlinked boundRoot must return FILE_NOT_PUBLISHED (not outside_indexed_root).
    const missingUnderSymlinkedRoot = await readFileTool.execute({
        path: path.join(symlinkedRoot, "does-not-exist.ts"),
        codebaseRoot: symlinkedRoot,
        start_line: 1,
        end_line: 5,
    }, ctx);
    assert.equal(missingUnderSymlinkedRoot.isError, true);
    const missingPayload = JSON.parse(missingUnderSymlinkedRoot.content[0].text) as {
        code?: string;
        reason?: string;
    };
    assert.equal(missingPayload.code, "FILE_NOT_PUBLISHED");
    assert.equal(missingPayload.reason, "file_not_published");
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
