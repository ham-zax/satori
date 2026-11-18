import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { PublicationLease, SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { ToolHandlers } from "../core/handlers.js";
import { NavigationHandlers } from "../core/navigation-handlers.js";
import { createSessionWorkspacePolicy } from "../core/session-workspace-policy.js";
import {
    findReferencesInputSchema,
    findReferencesTool,
} from "./find_references.js";
import type { ToolContext } from "./types.js";

test("find_references cancellation stops source scanning and releases the publication lease", async (t) => {
    const root = fs.mkdtempSync(path.resolve("satori-find-references-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, "0")}.ts`);
    for (const file of files) fs.writeFileSync(path.join(root, file), "request();\n");
    const target = {
        symbolInstanceId: "target", name: "request", file: files[0]!, language: "typescript",
        kind: "function", label: "request", qualifiedName: "request", parentQualifiedNamePath: [],
        span: { startLine: 1, endLine: 1 },
        symbolKey: "target", fileHash: "fixture", extractorVersion: "fixture",
    } as SymbolRecord;
    const registry = {
        manifest: { files: files.map((file) => ({ path: file })) },
        symbolsByFile: new Map([[target.file, [target]]]),
    } as unknown as SymbolRegistry;
    let released = false;
    let published = false;
    let sourceReads = 0;
    const controller = new AbortController();
    const abortReason = new Error("deterministic scan cancellation");
    const lease = {
        id: "publication-1", publication: { id: "publication-1", canonicalRoot: root },
        release: () => { released = true; },
    } as PublicationLease;
    const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: path.dirname(root), stateRoot: path.join(root, "state") });
    const navigationHandlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: "ready", root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: () => true,
        getPublicationNavigationStatus: async () => "valid",
        loadPreparedNavigationManifest: async () => ({ status: "ok", registry }),
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => { published = true; },
        stringifyToolJson: JSON.stringify,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);
    const toolHandlers = {
        navigationHandlers,
        handleFindReferences: ToolHandlers.prototype.handleFindReferences,
    } as unknown as ToolHandlers;
    const ctx = {
        toolHandlers,
        requestSignal: controller.signal,
        workspacePolicy: {
            ...policy,
            authorizePath(file: string) {
                sourceReads += 1;
                controller.abort(abortReason);
                return policy.authorizePath(file);
            },
        },
    } as unknown as ToolContext;
    await assert.rejects(findReferencesTool.execute({
        path: root, symbolRef: { file: target.file, symbolId: "target" },
    }, ctx), (error: unknown) => error === abortReason);
    assert.equal(released, true);
    assert.equal(published, false);
    assert.equal(sourceReads, 1);
});

test("find_references schema requires canonical symbol target and safe repo-relative scope", () => {
    assert.equal(findReferencesInputSchema.safeParse({
        path: path.resolve("/tmp/repo"),
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "src",
        includePaths: ["src/app"],
        excludePaths: ["src/generated"],
    }).success, true);

    assert.equal(findReferencesInputSchema.safeParse({
        path: path.resolve("/tmp/repo"),
        symbolRef: { file: "/etc/passwd", symbolId: "target" },
    }).success, false);

    assert.equal(findReferencesInputSchema.safeParse({
        path: path.resolve("/tmp/repo"),
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "../escape",
    }).success, false);
});

test("find_references documents Publication-hash-bound completeness", () => {
    const description = findReferencesTool.description({} as ToolContext);
    assert.match(description, /Publication content hash/i);
    assert.match(description, /changed\/unverified source/i);
    assert.match(description, /coverage=partial/i);
});

test("find_references dispatches through the authorized root without provider retrieval", async () => {
    const root = path.resolve("/tmp/repo");
    let dispatched: unknown;
    const ctx = {
        workspacePolicy: {
            authorizeRoot(requested: string) {
                assert.equal(requested, root);
                return { canonicalPath: root };
            },
        },
        toolHandlers: {
            async handleFindReferences(args: unknown) {
                dispatched = args;
                return {
                    content: [{ type: "text", text: JSON.stringify({ status: "ok", rankingIndependent: true }) }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await findReferencesTool.execute({
        path: root,
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "src",
        excludePaths: ["src/generated"],
        limit: 25,
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.deepEqual(dispatched, {
        path: root,
        symbolRef: { file: "src/target.ts", symbolId: "target" },
        subtree: "src",
        excludePaths: ["src/generated"],
        limit: 25,
    });
});

test("find_references pages through every occurrence with a scope-bound cursor", async (t) => {
    const root = fs.mkdtempSync(path.resolve("satori-find-references-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = ["a.ts", "b.ts", "c.ts"];
    for (const file of files) fs.writeFileSync(path.join(root, file), "request();\nrequest();\n");
    const target = {
        symbolInstanceId: "target", name: "request", file: files[0]!, language: "typescript",
        kind: "function", label: "request", qualifiedName: "request", parentQualifiedNamePath: [],
        span: { startLine: 1, endLine: 1 },
        symbolKey: "target", fileHash: "fixture", extractorVersion: "fixture",
    } as SymbolRecord;
    const registry = {
        manifest: { files: files.map((file) => ({ path: file })) },
        symbolsByFile: new Map([[target.file, [target]]]),
    } as unknown as SymbolRegistry;
    const lease = {
        id: "publication-1", publication: { id: "publication-1", canonicalRoot: root },
        release: () => {},
    } as PublicationLease;
    const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: path.dirname(root), stateRoot: path.join(root, "state") });
    const navigationHandlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: "ready", root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: () => true,
        getPublicationNavigationStatus: async () => "valid",
        loadPreparedNavigationManifest: async () => ({ status: "ok", registry }),
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => {},
        stringifyToolJson: JSON.stringify,
        readFileMaxBytes: 1024 * 1024,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);
    const ctx = {
        toolHandlers: {
            navigationHandlers,
            handleFindReferences: ToolHandlers.prototype.handleFindReferences,
        } as unknown as ToolHandlers,
        workspacePolicy: policy,
    } as unknown as ToolContext;
    const call = async (args: Record<string, unknown>) => {
        const response = await findReferencesTool.execute({
            path: root, symbolRef: { file: target.file, symbolId: "target" }, ...args,
        }, ctx);
        return { isError: response.isError, payload: JSON.parse(response.content[0]!.text as string) };
    };

    const unpaged = await call({});
    assert.equal(unpaged.payload.references.length, 6);
    assert.equal(unpaged.payload.nextCursor, undefined);
    const occurrences = [];
    let args: Record<string, unknown> = { limit: 4 };
    for (;;) {
        const page = await call(args);
        assert.equal(page.payload.status, "ok");
        assert.equal(page.payload.nextOffset, undefined);
        occurrences.push(...page.payload.references);
        if (!page.payload.nextCursor) break;
        assert.equal(page.payload.hints.nextPage.args.cursor, page.payload.nextCursor);
        args = page.payload.hints.nextPage.args;
        delete args.path;
        delete args.symbolRef;
    }
    assert.deepEqual(occurrences, unpaged.payload.references);

    const first = await call({ limit: 4 });
    const crossScope = await call({ limit: 4, excludePaths: ["c.ts"], cursor: first.payload.nextCursor });
    assert.equal(crossScope.isError, true);
    assert.equal(crossScope.payload.status, "not_found");
    assert.equal(crossScope.payload.reason, "invalid_continuation");
});

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

/** The racy-timestamp margin sourceDigestFor applies to a stat witness. */
const SOURCE_DIGEST_RACY_MARGIN_MS = 2_000;

type SourceDigestProbe = {
    sourceDigestFor(
        codebaseRoot: string,
        relativeFilePath: string,
        sourceRead: { bytes: Buffer; observedStat: fs.Stats },
        nowMs?: number,
    ): string;
};

/** sourceDigestFor touches no host state, so an empty host is enough to probe it. */
function sourceDigestProbe(): SourceDigestProbe {
    return new NavigationHandlers(
        {} as unknown as ConstructorParameters<typeof NavigationHandlers>[0],
    ) as unknown as SourceDigestProbe;
}

/**
 * A stat witness with no file behind it. A real file cannot be aged: every
 * write and every utimesSync refreshes ctime, so only a synthetic witness can
 * exercise the aged branch deterministically.
 */
function statWitness(overrides: Partial<Record<"dev" | "ino" | "size" | "mtimeMs" | "ctimeMs", number>> = {}): fs.Stats {
    return {
        dev: 1, ino: 42, size: 11, mtimeMs: 1_000_000, ctimeMs: 1_000_000,
        ...overrides,
    } as unknown as fs.Stats;
}

/**
 * One published root whose only file is `a.ts`, plus the find_references entry
 * point that serves it. The Publication content hash is the hash of `content`,
 * so any later byte change is observable as source_changed.
 */
function digestFixture(t: TestContext, content: string) {
    const root = fs.mkdtempSync(path.resolve("satori-find-references-digest-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, content);
    const target = {
        symbolInstanceId: "target", name: "request", file: "a.ts", language: "typescript",
        kind: "function", label: "request", qualifiedName: "request", parentQualifiedNamePath: [],
        span: { startLine: 1, endLine: 1 },
        symbolKey: "target", fileHash: "fixture", extractorVersion: "fixture",
    } as SymbolRecord;
    const registry = {
        manifest: { files: [{ path: "a.ts", hash: sha256(content) }] },
        symbolsByFile: new Map([["a.ts", [target]]]),
    } as unknown as SymbolRegistry;
    const lease = {
        id: "publication-1", publication: { id: "publication-1", canonicalRoot: root },
        release: () => {},
    } as PublicationLease;
    const policy = createSessionWorkspacePolicy({
        roots: [root], homeDirectory: path.dirname(root), stateRoot: path.join(root, "state"),
    });
    const navigationHandlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: "ready", root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: () => true,
        getPublicationNavigationStatus: async () => "valid",
        loadPreparedNavigationManifest: async () => ({ status: "ok", registry }),
        normalizeRelativeFilePath: (value: string) => value,
        touchWatchedCodebase: async () => {},
        stringifyToolJson: JSON.stringify,
        readFileMaxBytes: 1024 * 1024,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);
    const ctx = {
        toolHandlers: {
            navigationHandlers,
            handleFindReferences: ToolHandlers.prototype.handleFindReferences,
        } as unknown as ToolHandlers,
        workspacePolicy: policy,
    } as unknown as ToolContext;
    const call = async () => {
        const response = await findReferencesTool.execute({
            path: root, symbolRef: { file: "a.ts", symbolId: "target" },
        }, ctx);
        return { isError: response.isError, payload: JSON.parse(response.content[0]!.text as string) };
    };
    return { root, file, navigationHandlers, call };
}

test("sourceDigestFor reuses an aged digest and re-hashes when the stat witness changes", () => {
    const probe = sourceDigestProbe();
    const root = path.resolve("satori-find-references-digest-root");
    const aged = statWitness();
    const nowMs = aged.mtimeMs + 60_000;
    const digest = (bytes: string, observedStat: fs.Stats, codebaseRoot = root) => (
        probe.sourceDigestFor(codebaseRoot, "a.ts", { bytes: Buffer.from(bytes), observedStat }, nowMs)
    );

    const first = digest("request();\n", aged);
    assert.equal(first, sha256("request();\n"));
    // The witness is unchanged, so the cached digest answers even for different
    // bytes. That reuse is exactly what find_references depends on.
    assert.equal(digest("request();\n", aged), first);
    assert.equal(digest("request(1)\n", aged), first);

    // A changed witness re-hashes instead of answering from the cache.
    const moved = statWitness({ mtimeMs: aged.mtimeMs - 1, ctimeMs: aged.ctimeMs - 1 });
    assert.equal(digest("request(1)\n", moved), sha256("request(1)\n"));

    // A digest cached under one root never answers for another root's file,
    // even when the stat witness is identical (unstable-inode filesystems).
    assert.equal(digest("request(2)\n", moved, path.join(root, "other-root")), sha256("request(2)\n"));
});

test("sourceDigestFor never caches a stat observed inside the racy margin", () => {
    const probe = sourceDigestProbe();
    const root = path.resolve("satori-find-references-digest-root");
    const nowMs = 1_000_000;
    // A same-size in-place write inside one filesystem timestamp tick leaves
    // this witness identical, so it must never be trusted.
    const racy = statWitness({ mtimeMs: nowMs - 500, ctimeMs: nowMs - 500 });
    const digest = (bytes: string, atMs: number) => (
        probe.sourceDigestFor(root, "a.ts", { bytes: Buffer.from(bytes), observedStat: racy }, atMs)
    );

    assert.equal(digest("request();\n", nowMs), sha256("request();\n"));
    assert.equal(digest("request(1)\n", nowMs), sha256("request(1)\n"));

    // The margin is exclusive: a stat exactly at the margin is still racy.
    assert.equal(
        digest("request(2)\n", nowMs - 500 + SOURCE_DIGEST_RACY_MARGIN_MS),
        sha256("request(2)\n"),
    );

    // The same witness becomes cacheable once it is older than the margin.
    const agedAtMs = nowMs + 60_000;
    assert.equal(digest("request();\n", agedAtMs), sha256("request();\n"));
    assert.equal(digest("request(1)\n", agedAtMs), sha256("request();\n"));
});

test("find_references re-hashes a same-size in-place write on a racy file", async (t) => {
    const original = "request();\n";
    const edited = "request(1)\n";
    assert.equal(Buffer.byteLength(original), Buffer.byteLength(edited));
    const fixture = digestFixture(t, original);

    const first = await fixture.call();
    assert.equal(first.payload.status, "ok");
    assert.equal(first.payload.coverage.status, "complete");
    assert.equal(first.payload.references[0].evidenceClass, "published_source_text");
    assert.equal(first.payload.coverage.reasons.length, 0);

    // Same byte length, written in place while the file is still inside the
    // racy margin: the digest must be recomputed, never served from cache.
    fs.writeFileSync(fixture.file, edited);
    const second = await fixture.call();
    assert.equal(second.payload.status, "ok");
    assert.equal(second.payload.coverage.status, "partial");
    assert.ok(second.payload.coverage.reasons.some((reason: { code: string; file?: string }) => (
        reason.code === "source_changed" && reason.file === "a.ts"
    )));
    assert.equal(second.payload.references[0].evidenceClass, "current_source_text");
});

test("find_references keeps an unchanged published file on published_source_text across calls", async (t) => {
    // A real file's ctime is always fresh after a write, so this exercises the
    // racy branch end to end: repeated calls must re-hash and still agree with
    // the Publication hash instead of reporting a false source_changed.
    const fixture = digestFixture(t, "request();\n");

    for (let call = 0; call < 2; call += 1) {
        const page = await fixture.call();
        assert.equal(page.payload.status, "ok");
        assert.equal(page.payload.coverage.status, "complete");
        assert.equal(page.payload.references[0].evidenceClass, "published_source_text");
        assert.equal(page.payload.coverage.reasons.length, 0);
    }
});
