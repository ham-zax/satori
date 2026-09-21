import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolRecord, SymbolRegistry } from "@zokizuan/satori-core";
import { findExactPublishedSourceReferences } from "./exact-reference-search.js";

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
