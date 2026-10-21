import assert from "node:assert/strict";
import test from "node:test";
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
