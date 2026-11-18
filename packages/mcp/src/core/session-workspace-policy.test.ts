import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    createSessionWorkspacePolicy,
    WorkspaceAuthorizationError,
    type WorkspaceAuthorizationCode,
} from "./session-workspace-policy.js";

function createDirectorySymlinkOrSkip(t: TestContext, target: string, linkPath: string): boolean {
    try {
        fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
            t.skip(`Directory symlinks are unavailable on this platform: ${code}`);
            return false;
        }
        throw error;
    }
}

function createFileSymlinkOrSkip(t: TestContext, target: string, linkPath: string): boolean {
    try {
        fs.symlinkSync(target, linkPath);
        return true;
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
            t.skip(`File symlinks are unavailable on this platform: ${code}`);
            return false;
        }
        throw error;
    }
}

function expectCode(fn: () => unknown, code: WorkspaceAuthorizationCode): void {
    assert.throws(fn, (error: unknown) => {
        assert.ok(error instanceof WorkspaceAuthorizationError, `expected WorkspaceAuthorizationError, got ${String(error)}`);
        assert.equal((error as WorkspaceAuthorizationError).code, code);
        return true;
    });
}

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("rejects filesystem root by default", () => {
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        expectCode(
            () => createSessionWorkspacePolicy({ roots: ["/"], homeDirectory: home, stateRoot }),
            "BROAD_ROOT_NOT_ALLOWED",
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("rejects the user home as a broad root by default", () => {
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        expectCode(
            () => createSessionWorkspacePolicy({ roots: [home], homeDirectory: home, stateRoot }),
            "BROAD_ROOT_NOT_ALLOWED",
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("rejects the satori state root by default", () => {
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        expectCode(
            () => createSessionWorkspacePolicy({ roots: [stateRoot], homeDirectory: home, stateRoot }),
            "BROAD_ROOT_NOT_ALLOWED",
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("rejects authorizing the exact home directory even when a root contains it", () => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const home = path.join(base, "home");
    fs.mkdirSync(home, { recursive: true });
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [base], homeDirectory: home, stateRoot });
        expectCode(() => policy.authorizeRoot(home), "BROAD_ROOT_NOT_ALLOWED");
        expectCode(() => policy.authorizePath(home), "BROAD_ROOT_NOT_ALLOWED");
        // Descendants of the home directory are still inside the launcher-authorized root.
        const authorized = policy.authorizePath(path.join(home, "file.ts"));
        assert.equal(authorized.relativePath, "home/file.ts");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("rejects a relative root", () => {
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        expectCode(
            () => createSessionWorkspacePolicy({ roots: ["relative/workspace"], homeDirectory: home, stateRoot }),
            "INVALID_WORKSPACE_ROOT",
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("allowBroadRoots permits the filesystem root", () => {
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({
            roots: ["/"],
            homeDirectory: home,
            stateRoot,
            allowBroadRoots: true,
        });
        assert.deepEqual(policy.roots, [path.sep]);
        const candidate = path.join(home, "any", "file.ts");
        const authorized = policy.authorizePath(candidate);
        assert.equal(authorized.workspaceRoot, path.sep);
        assert.equal(
            authorized.relativePath,
            path.relative(path.sep, candidate).replace(/\\/g, "/"),
        );
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("reduces duplicate and nested roots to the narrowest authority set", () => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const nested = path.join(base, "a", "b");
    const sibling = makeTempDir("satori-workspace-policy-sibling-");
    fs.mkdirSync(nested, { recursive: true });
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({
            roots: [base, base, nested, sibling],
            homeDirectory: home,
            stateRoot,
        });
        // base covers nested; duplicates collapse; sibling stays.
        assert.deepEqual(policy.roots, [fs.realpathSync.native(base), fs.realpathSync.native(sibling)]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(sibling, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("canonicalizes symlink aliases", (t) => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const real = path.join(base, "real");
    fs.mkdirSync(real, { recursive: true });
    const alias = path.join(base, "alias");
    if (!createDirectorySymlinkOrSkip(t, real, alias)) return;
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [alias], homeDirectory: home, stateRoot });
        const canonicalAlias = fs.realpathSync.native(alias);
        assert.equal(policy.roots.length, 1);
        assert.equal(policy.roots[0], canonicalAlias);
        const authorized = policy.authorizePath(path.join(alias, "src", "a.ts"));
        assert.equal(authorized.workspaceRoot, canonicalAlias);
        assert.equal(authorized.canonicalPath, path.join(canonicalAlias, "src", "a.ts"));
        assert.equal(authorized.relativePath, "src/a.ts");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("does not confuse /repo with /repo-other", () => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const repo = path.join(base, "repo");
    const repoOther = path.join(base, "repo-other");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(repoOther, { recursive: true });
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [repo], homeDirectory: home, stateRoot });
        expectCode(
            () => policy.authorizePath(path.join(repoOther, "file.ts")),
            "ROOT_NOT_AUTHORIZED",
        );
        expectCode(
            () => policy.authorizeRoot(repoOther),
            "ROOT_NOT_AUTHORIZED",
        );
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("rejects a path whose real target escapes through a symlink", (t) => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const root = path.join(base, "root");
    fs.mkdirSync(root, { recursive: true });
    const outside = makeTempDir("satori-workspace-policy-outside-");
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret", "utf8");
    const link = path.join(root, "escape.txt");
    if (!createFileSymlinkOrSkip(t, secret, link)) return;
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: home, stateRoot });
        expectCode(() => policy.authorizePath(link), "ROOT_NOT_AUTHORIZED");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("returns a normalized relative path for an allowed descendant", () => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const workspace = path.join(base, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [workspace], homeDirectory: home, stateRoot });
        const authorized = policy.authorizePath(path.join(workspace, "src", "deep", "a.ts"));
        assert.equal(authorized.workspaceRoot, fs.realpathSync.native(workspace));
        assert.equal(authorized.relativePath, "src/deep/a.ts");
        assert.equal(authorized.canonicalPath, path.join(fs.realpathSync.native(workspace), "src", "deep", "a.ts"));
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("authorizes the workspace root itself and a repository below it", () => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const workspace = path.join(base, "workspace");
    const repo = path.join(workspace, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [workspace], homeDirectory: home, stateRoot });
        const rootAuth = policy.authorizeRoot(workspace);
        assert.equal(rootAuth.workspaceRoot, fs.realpathSync.native(workspace));
        assert.equal(rootAuth.relativePath, "");
        const repoAuth = policy.authorizeRoot(repo);
        assert.equal(repoAuth.workspaceRoot, fs.realpathSync.native(workspace));
        assert.equal(repoAuth.relativePath, "repo");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("denies an outside directory symlink as an authorized root", (t) => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const root = path.join(base, "root");
    fs.mkdirSync(root, { recursive: true });
    const outside = makeTempDir("satori-workspace-policy-outside-");
    const link = path.join(root, "outside-link");
    if (!createDirectorySymlinkOrSkip(t, outside, link)) return;
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: home, stateRoot });
        expectCode(() => policy.authorizeRoot(link), "ROOT_NOT_AUTHORIZED");
        expectCode(() => policy.authorizePath(path.join(link, "file.ts")), "ROOT_NOT_AUTHORIZED");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("cannot add authority after construction", () => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const workspace = path.join(base, "workspace");
    const other = path.join(base, "other");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [workspace], homeDirectory: home, stateRoot });
        // The exposed roots array is frozen; mutation attempts must fail.
        assert.throws(() => (policy.roots as string[]).push(other), TypeError);
        assert.throws(() => ((policy.roots as string[])[0] = other), TypeError);
        expectCode(() => policy.authorizePath(path.join(other, "file.ts")), "ROOT_NOT_AUTHORIZED");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("rejects a root that is a dangling symlink deterministically", (t) => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const missingTarget = path.join(base, "missing-target");
    const dangling = path.join(base, "dangling");
    if (!createDirectorySymlinkOrSkip(t, missingTarget, dangling)) return;
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        // A root whose real target does not exist must fail closed with a
        // deterministic authorization error, not an uncaught fs exception
        // and not a lexical authorization of the symlink path.
        expectCode(
            () => createSessionWorkspacePolicy({ roots: [dangling], homeDirectory: home, stateRoot }),
            "INVALID_WORKSPACE_ROOT",
        );
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("denies paths through a dangling symlink inside an authorized root", (t) => {
    const base = makeTempDir("satori-workspace-policy-base-");
    const root = path.join(base, "root");
    fs.mkdirSync(root, { recursive: true });
    const missingTarget = path.join(base, "missing-target");
    const dangling = path.join(root, "dangling");
    if (!createDirectorySymlinkOrSkip(t, missingTarget, dangling)) return;
    const home = makeTempDir("satori-workspace-policy-home-");
    const stateRoot = makeTempDir("satori-workspace-policy-state-");
    try {
        const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: home, stateRoot });
        // The dangling symlink itself is denied.
        expectCode(() => policy.authorizePath(dangling), "INVALID_WORKSPACE_ROOT");
        // A path that passes through the dangling symlink is denied even
        // though its lexical form is under the authorized root.
        expectCode(() => policy.authorizePath(path.join(dangling, "src", "a.ts")), "INVALID_WORKSPACE_ROOT");
        expectCode(() => policy.authorizeRoot(path.join(dangling, "src")), "INVALID_WORKSPACE_ROOT");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test("allowImplicitBroadContainerRoot permits descendant Git repos under HOME or / while blocking non-Git paths, HOME, /, and stateRoot", () => {
    const base = makeTempDir("satori-workspace-policy-container-");
    const home = path.join(base, "home");
    const stateRoot = path.join(home, ".satori");
    const repo = path.join(home, "repo", "satori");
    const nonRepoUnderHome = path.join(home, "Documents");
    const nonRepoSibling = path.join(base, "plain-outside");
    fs.mkdirSync(path.join(stateRoot, "models"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const x = 1;\n");
    fs.mkdirSync(nonRepoUnderHome, { recursive: true });
    fs.writeFileSync(path.join(nonRepoUnderHome, "notes.txt"), "private\n");
    fs.mkdirSync(nonRepoSibling, { recursive: true });
    fs.writeFileSync(path.join(nonRepoSibling, "secret.txt"), "secret\n");
    try {
        const homePolicy = createSessionWorkspacePolicy({
            roots: [home],
            homeDirectory: home,
            stateRoot,
            allowImplicitBroadContainerRoot: true,
        });
        const canonicalRepo = fs.realpathSync.native(repo);
        const repoAuth = homePolicy.authorizeRoot(repo);
        assert.equal(repoAuth.workspaceRoot, canonicalRepo);
        assert.equal(repoAuth.canonicalPath, canonicalRepo);
        assert.equal(repoAuth.relativePath, "");
        const fileAuth = homePolicy.authorizePath(path.join(repo, "src", "app.ts"));
        assert.equal(fileAuth.workspaceRoot, canonicalRepo);
        assert.equal(fileAuth.relativePath, "src/app.ts");

        // Non-Git directories under HOME are rejected.
        expectCode(() => homePolicy.authorizeRoot(nonRepoUnderHome), "ROOT_NOT_AUTHORIZED");
        expectCode(() => homePolicy.authorizePath(path.join(nonRepoUnderHome, "notes.txt")), "ROOT_NOT_AUTHORIZED");
        expectCode(() => homePolicy.authorizeRoot(home), "BROAD_ROOT_NOT_ALLOWED");
        expectCode(() => homePolicy.authorizePath(home), "BROAD_ROOT_NOT_ALLOWED");
        expectCode(() => homePolicy.authorizeRoot(stateRoot), "BROAD_ROOT_NOT_ALLOWED");
        expectCode(() => homePolicy.authorizePath(path.join(stateRoot, "models")), "BROAD_ROOT_NOT_ALLOWED");

        // Even if HOME itself has a dotfiles `.git`, it cannot turn arbitrary HOME files into an authorized project.
        fs.mkdirSync(path.join(home, ".git"), { recursive: true });
        expectCode(() => homePolicy.authorizePath(path.join(nonRepoUnderHome, "notes.txt")), "ROOT_NOT_AUTHORIZED");

        // Implicit "/" container must reject /etc, /etc/hosts, and unrelated non-Git paths.
        const slashPolicy = createSessionWorkspacePolicy({
            roots: ["/"],
            homeDirectory: home,
            stateRoot,
            allowImplicitBroadContainerRoot: true,
        });
        expectCode(() => slashPolicy.authorizeRoot("/etc"), "ROOT_NOT_AUTHORIZED");
        expectCode(() => slashPolicy.authorizePath("/etc/hosts"), "ROOT_NOT_AUTHORIZED");
        expectCode(() => slashPolicy.authorizeRoot(nonRepoSibling), "ROOT_NOT_AUTHORIZED");
        expectCode(() => slashPolicy.authorizePath(path.join(nonRepoSibling, "secret.txt")), "ROOT_NOT_AUTHORIZED");
        assert.equal(slashPolicy.authorizeRoot(repo).workspaceRoot, canonicalRepo);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
