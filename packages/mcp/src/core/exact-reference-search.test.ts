import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@satori-code/core";
import { findExactPublishedSourceReferences } from "./exact-reference-search.js";

test("exact reference cancellation drains started reads before rejecting", async () => {
    const nav = registry();
    const target = nav.symbolsByInstanceId.get("target")!;
    const controller = new AbortController();
    const reason = new Error("deterministic read cancellation");
    const pending: Array<() => void> = [];
    let active = 0;
    let started = 0;
    let readsStarted!: () => void;
    const startedGate = new Promise<void>((resolve) => { readsStarted = resolve; });
    const input = {
        registry: nav,
        target,
        signal: controller.signal,
        readPublishedSource: async (file: string) => {
            active += 1;
            started += 1;
            if (started === 3) readsStarted();
            await new Promise<void>((resolve) => { pending.push(resolve); });
            active -= 1;
            return { status: "ok" as const, text: sources.get(file)! };
        },
    };
    const result = findExactPublishedSourceReferences(input);
    let settled = false;
    const assertion = assert.rejects(result, (error: unknown) => {
        assert.equal(active, 0, "all started reads must finish before the lease can release");
        return error === reason;
    }).finally(() => { settled = true; });
    await startedGate;
    controller.abort(reason);
    pending[0]!();
    // Flush continuations while two reads remain blocked by explicit gates.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(active, 2);
    for (const resolve of pending.slice(1)) resolve();
    await assertion;
});

function symbol(input: Partial<SymbolRecord> & Pick<SymbolRecord, "symbolInstanceId" | "name" | "file">): SymbolRecord {
    const { symbolInstanceId, name, file, ...overrides } = input;
    return {
        symbolKey: symbolInstanceId,
        language: "typescript",
        kind: "function",
        qualifiedName: overrides.qualifiedName ?? name,
        label: overrides.label ?? `function ${name}()`,
        span: overrides.span ?? { startLine: 1, endLine: 3 },
        parentQualifiedNamePath: [],
        fileHash: "fixture",
        extractorVersion: "fixture",
        ...overrides,
        symbolInstanceId,
        name,
        file,
    } as SymbolRecord;
}

function registry(): SymbolRegistry {
    const target = symbol({
        symbolInstanceId: "target",
        name: "request",
        file: "src/target.ts",
        span: { startLine: 1, endLine: 1 },
    });
    const caller = symbol({
        symbolInstanceId: "caller",
        name: "run",
        file: "src/caller.ts",
        span: { startLine: 1, endLine: 3 },
    });
    const ignored = symbol({
        symbolInstanceId: "ignored",
        name: "ignoredRun",
        file: "src/ignored/caller.ts",
        span: { startLine: 1, endLine: 3 },
    });
    return {
        manifest: {
            files: [
                { path: "src/caller.ts" },
                { path: "src/ignored/caller.ts" },
                { path: "src/target.ts" },
            ],
        },
        symbolsByFile: new Map([
            ["src/target.ts", [target]],
            ["src/caller.ts", [caller]],
            ["src/ignored/caller.ts", [ignored]],
        ]),
        symbolsByInstanceId: new Map([
            [target.symbolInstanceId, target],
            [caller.symbolInstanceId, caller],
            [ignored.symbolInstanceId, ignored],
        ]),
    } as unknown as SymbolRegistry;
}

const sources = new Map([
    ["src/target.ts", "export function request() {}\n"],
    ["src/caller.ts", "export function run(client: any) {\n  return client.request();\n}\n"],
    ["src/ignored/caller.ts", "export function ignoredRun(client: any) {\n  return client.request();\n}\n"],
]);

test("exact reference search materializes only the bounded prefix but counts every match", async (t) => {
    const nav = registry();
    const target = nav.symbolsByInstanceId.get("target")!;
    const getSymbols = nav.symbolsByFile.get.bind(nav.symbolsByFile);
    let materialized = 0;
    t.mock.method(nav.symbolsByFile, "get", (file: string) => {
        materialized += 1;
        if (materialized > 2) throw new Error("materialized occurrence beyond result limit");
        return getSymbols(file);
    });
    const result = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        limit: 2,
        readPublishedSource: async (file) => ({
            status: "ok",
            text: file === "src/caller.ts" ? "client.request();\n".repeat(5000) : sources.get(file)!,
        }),
    });
    assert.equal(materialized, 2);
    assert.equal(result.coverage.matchedOccurrenceCount, 5002);
    assert.equal(result.coverage.inspectedFileCount, 3);
    assert.equal(result.coverage.returnedOccurrenceCount, 2);
    assert.deepEqual(result.references.map((reference) => [reference.file, reference.span.startLine]), [
        ["src/caller.ts", 1], ["src/caller.ts", 2],
    ]);
    assert.deepEqual(result.coverage.reasons, [{
        code: "result_limit",
        detail: "Matched 5002 occurrences; returned first 2 in deterministic source order.",
    }]);
});

test("bounded exact references equal the unlimited source-order prefix", async () => {
    const nav = registry();
    const input = {
        registry: nav,
        target: nav.symbolsByInstanceId.get("target")!,
        readPublishedSource: async (file: string) => ({ status: "ok" as const, text: sources.get(file)! }),
    };
    const unlimited = await findExactPublishedSourceReferences({ ...input, limit: 100 });
    for (const limit of [1, 2, 3, 4]) {
        const result = await findExactPublishedSourceReferences({ ...input, limit });
        assert.deepEqual(result.references, unlimited.references.slice(0, limit));
        assert.equal(result.coverage.matchedOccurrenceCount, unlimited.coverage.matchedOccurrenceCount);
        if (limit >= unlimited.references.length) assert.deepEqual(result, unlimited);
    }
});

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function withPublishedHashes(nav: SymbolRegistry): SymbolRegistry {
    return {
        ...nav,
        manifest: {
            ...nav.manifest,
            files: nav.manifest.files.map((entry) => ({
                ...entry,
                hash: sha256(sources.get(entry.path)!),
            })),
        },
    } as SymbolRegistry;
}

test("exact reference search scans the scoped Publication source universe without ranking", async () => {
    const nav = registry();
    const target = nav.symbolsByInstanceId.get("target")!;
    const inspected: string[] = [];
    const result = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        scope: { subtree: "src", excludePaths: ["src/ignored"] },
        limit: 10,
        readPublishedSource: async (file) => {
            inspected.push(file);
            return { status: "ok", text: sources.get(file)! };
        },
    });

    assert.equal(result.coverage.status, "complete");
    assert.deepEqual(inspected, ["src/caller.ts", "src/target.ts"]);
    assert.equal(result.coverage.eligibleFileCount, 2);
    assert.equal(result.coverage.inspectedFileCount, 2);
    assert.equal(result.references.length, 2);
    const caller = result.references.find((reference) => reference.file === "src/caller.ts");
    assert.ok(caller);
    assert.equal(caller!.occurrenceKind, "member");
    assert.equal(caller!.owningSymbol?.symbolId, "caller");
    assert.equal(caller!.span.startLine, 2);
    assert.equal(caller!.matchedText, "request");
    assert.equal(caller!.evidenceClass, "published_source_text");
});

test("exact reference completeness becomes partial for output limits or skipped source", async () => {
    const nav = registry();
    const target = nav.symbolsByInstanceId.get("target")!;
    const limited = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        scope: { includePaths: ["src/caller.ts", "src/target.ts"] },
        limit: 1,
        readPublishedSource: async (file) => ({ status: "ok", text: sources.get(file)! }),
    });
    assert.equal(limited.coverage.status, "partial");
    assert.equal(limited.coverage.inspectedFileCount, 2);
    assert.equal(limited.coverage.matchedOccurrenceCount, 2);
    assert.equal(limited.coverage.returnedOccurrenceCount, 1);
    assert.ok(limited.coverage.reasons.some((reason) => reason.code === "result_limit"));

    const skipped = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        scope: { includePaths: ["src/caller.ts", "src/target.ts"] },
        readPublishedSource: async (file) => (
            file === "src/caller.ts"
                ? { status: "skipped", code: "source_too_large", detail: "fixture ceiling" }
                : { status: "ok", text: sources.get(file)! }
        ),
    });
    assert.equal(skipped.coverage.status, "partial");
    assert.equal(skipped.coverage.inspectedFileCount, 1);
    assert.equal(skipped.coverage.skippedFileCount, 1);
    assert.ok(skipped.coverage.reasons.some((reason) => (
        reason.code === "source_too_large" && reason.file === "src/caller.ts"
    )));
});

test("Publication hash without bound source bytes is source_unverified and never complete", async () => {
    const nav = withPublishedHashes(registry());
    const target = nav.symbolsByInstanceId.get("target")!;
    const result = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        scope: { includePaths: ["src/caller.ts"] },
        readPublishedSource: async (file) => ({ status: "ok", text: sources.get(file)! }),
    });

    assert.equal(result.coverage.status, "partial");
    assert.equal(result.coverage.inspectedFileCount, 0);
    assert.equal(result.coverage.skippedFileCount, 1);
    assert.deepEqual(result.references, []);
    assert.ok(result.coverage.reasons.some((reason) => (
        reason.code === "source_unverified" && reason.file === "src/caller.ts"
    )));
});

test("Unicode identifier continuations do not create false exact references", async () => {
    const target = symbol({
        symbolInstanceId: "foo-target",
        name: "foo",
        file: "src/foo.ts",
        span: { startLine: 1, endLine: 1 },
    });
    const nav = {
        manifest: { files: [{ path: "src/foo.ts" }] },
        symbolsByFile: new Map([["src/foo.ts", [target]]]),
        symbolsByInstanceId: new Map([[target.symbolInstanceId, target]]),
    } as unknown as SymbolRegistry;
    const text = [
        "foo();",
        "fooβ();",
        "βfoo();",
        "foo\u0301();",
        "foo$bar();",
        "foo_bar();",
    ].join("\n");

    const result = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        readPublishedSource: async () => ({ status: "ok", text }),
    });

    assert.equal(result.coverage.status, "complete");
    assert.deepEqual(result.references.map((reference) => reference.span.startLine), [1]);
    assert.equal(result.references[0]?.matchedText, "foo");
});

test("exact reference reads overlap but results keep path order", async () => {
    const nav = registry();
    const target = nav.symbolsByInstanceId.get("target")!;
    let inFlight = 0;
    let maxInFlight = 0;
    const order = ["src/caller.ts", "src/ignored/caller.ts", "src/target.ts"];
    const result = await findExactPublishedSourceReferences({
        registry: nav,
        target,
        limit: 10,
        readPublishedSource: async (file) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // Earlier paths finish last.
            await new Promise((resolve) => setTimeout(resolve, (order.length - order.indexOf(file)) * 5));
            inFlight -= 1;
            return { status: "ok", text: sources.get(file)! };
        },
    });

    assert.equal(maxInFlight, 3);
    assert.deepEqual(result.references.map((reference) => [reference.file, reference.occurrenceKind]), [
        ["src/caller.ts", "member"],
        ["src/ignored/caller.ts", "member"],
        ["src/target.ts", "declaration"],
    ]);
});
