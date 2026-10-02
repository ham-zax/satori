import assert from "node:assert/strict";
import test from "node:test";
import { isNonProductionDistractor } from "./search-non-production-path.js";

const NOT_DISTRACTORS = [
    // Regression cases for the old whole-path regex: these were all matched by
    // `\btest` / `docs?` / `\.(?:md|markdown|txt)$` somewhere in the string and
    // must not be demoted, because they are production code.
    "src/test-utils/helpers.ts",
    "packages/docs-site/app.ts",
    "src/spec-utils/x.ts",
    "packages/react-test-renderer/index.js",
    // The old `.md|.markdown|.txt` extension rule demoted these unconditionally.
    "CMakeLists.txt",
    "requirements.txt",
    "README.md",
    "CONTRIBUTING.md",
    "docs.go", // a Go source file named "docs", not the docs/ directory
    "tests", // a bare segment with no filename component
    "src/contest.ts",
    "src/latest.ts",
    "crates/polars-core/src/frame/mod.rs",
    "packages/react-reconciler/src/ReactFiberCommitWork.new.js",
];

const DISTRACTORS = [
    "tests/monster_test.fbs", // tests/ segment
    "src/__tests__/a.js", // __tests__/ segment
    "src/__mocks__/a.js",
    "src/foo.test.ts", // *.test.*
    "src/foo.spec.tsx", // *.spec.*
    "docs/a.md", // docs/ segment despite the .md extension being allowed
    "src/test/helpers.ts",
    "src/fixtures/data.json",
    "src/examples/demo.ts",
    "src/benchmarks/bench_x.py",
    "src/spec/x.rs",
    "src/specs/x.rs",
    "CHANGELOG.md",
    "CHANGELOG",
    "packages/react/CHANGELOG-v2.txt",
    "crates/monster_test.fbs", // *_test.*
    "crates/monster_spec.fbs", // *_spec.*
    "packages/react-reconciler/src/__tests__/ReactEffect-test.js",
    "docs/design.md",
    "packages/react/fixtures/test.js",
];

test("production-looking paths are not classified as non-production", () => {
    for (const path of NOT_DISTRACTORS) {
        assert.equal(isNonProductionDistractor(path), false, path);
    }
});

test("test, doc, fixture and example paths are classified as non-production", () => {
    for (const path of DISTRACTORS) {
        assert.equal(isNonProductionDistractor(path), true, path);
    }
});

test("segment rules match whole segments, never substrings", () => {
    // Every one of these contains a distractor word as a substring of a
    // different segment.
    assert.equal(isNonProductionDistractor("src/testbed/x.ts"), false);
    assert.equal(isNonProductionDistractor("src/docsite/x.ts"), false);
    assert.equal(isNonProductionDistractor("src/spectacle/x.ts"), false);
    assert.equal(isNonProductionDistractor("src/example_app/x.ts"), false);
    assert.equal(isNonProductionDistractor("src/benchmarking/x.ts"), false);
    // ...and these are the real thing.
    assert.equal(isNonProductionDistractor("src/testbed/tests/x.ts"), true);
    assert.equal(isNonProductionDistractor("nested/docs/nested/index.html"), true);
});

test("windows separators and missing paths are handled", () => {
    assert.equal(isNonProductionDistractor("src\\__tests__\\a.js"), true);
    assert.equal(isNonProductionDistractor("src\\a.ts"), false);
    assert.equal(isNonProductionDistractor(undefined), false);
    assert.equal(isNonProductionDistractor(null), false);
    assert.equal(isNonProductionDistractor(""), false);
    assert.equal(isNonProductionDistractor("/"), false);
});
