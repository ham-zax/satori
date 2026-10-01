import assert from "node:assert/strict";
import test from "node:test";
import { SearchQuerySupport } from "./search-query-support.js";
import { parseSearchOperators } from "./search-query-planning.js";
import { buildSearchRetrievalScope } from "./search-retrieval-scope.js";

const files = [
    { path: "src/effects.ts", language: "typescript" },
    { path: "src/nested/effects.py", language: "python" },
    { path: "src/effects.test.ts", language: "typescript" },
    { path: "docs/effects.md", language: "markdown" },
    { path: "generated/effects.ts", language: "typescript" },
    { path: "src-other/effects.ts", language: "typescript" },
];
const support = new SearchQuerySupport({} as never);
const build = (scope: "runtime" | "docs" | "mixed", query = "effects", prefix?: string) => buildSearchRetrievalScope({
    files,
    scope,
    parsedOperators: parseSearchOperators(query),
    requestedSubdirectory: prefix ? { relativePrefix: prefix } : null,
    matchesPath: (relativePath, patterns) => support.pathMatchesAnyPattern(relativePath, patterns),
});

test("retrieval scope shares runtime and docs categories, retaining tests in runtime", () => {
    assert.deepEqual(build("runtime"), { kind: "in", field: "relativePath", values: [
        "src-other/effects.ts", "src/effects.test.ts", "src/effects.ts", "src/nested/effects.py",
    ] });
    assert.deepEqual(build("docs"), { kind: "in", field: "relativePath", values: ["docs/effects.md"] });
    assert.equal(build("mixed"), undefined);
});

test("retrieval scope composes language, include/exclude path and requested subtree before topK", () => {
    assert.deepEqual(build("runtime", "effects lang:typescript path:src/* -path:*.test.ts", "src"), {
        kind: "in", field: "relativePath", values: ["src/effects.ts"],
    });
    assert.deepEqual(build("runtime", "effects lang:python", "src"), {
        kind: "in", field: "relativePath", values: ["src/nested/effects.py"],
    });
});

test("empty scope cannot fall back to unfiltered retrieval", () => {
    assert.deepEqual(build("docs", "effects lang:typescript"), {
        kind: "comparison", field: "relativePath", operator: "eq", value: "",
    });
});
