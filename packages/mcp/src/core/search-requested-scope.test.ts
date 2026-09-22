import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
    candidateWithinRequestedSubdirectory,
    resolveRequestedSearchSubdirectory,
} from "./search-requested-scope.js";

test("resolveRequestedSearchSubdirectory returns null for the indexed root itself", () => {
    const root = path.join(path.sep, "repo");
    assert.equal(
        resolveRequestedSearchSubdirectory({ indexedRoot: root, requestedPath: root }),
        null,
    );
    assert.equal(
        resolveRequestedSearchSubdirectory({
            indexedRoot: root,
            requestedPath: path.join(root, "."),
        }),
        null,
    );
});

test("resolveRequestedSearchSubdirectory builds a canonical slash prefix without trailing slash", () => {
    const root = path.join(path.sep, "repo");
    const scope = resolveRequestedSearchSubdirectory({
        indexedRoot: root,
        requestedPath: path.join(root, "packages", "mcp", "src"),
    });
    assert.deepEqual(scope, { relativePrefix: "packages/mcp/src" });
});

test("resolveRequestedSearchSubdirectory rejects requests outside the indexed root", () => {
    const root = path.join(path.sep, "repo");
    for (const requestedPath of [
        path.join(path.sep, "elsewhere"),
        path.join(root, "..", "sibling"),
    ]) {
        assert.throws(
            () => resolveRequestedSearchSubdirectory({ indexedRoot: root, requestedPath }),
            /must remain within indexed root/,
        );
    }
});

test("candidateWithinRequestedSubdirectory admits every candidate for root requests", () => {
    assert.equal(candidateWithinRequestedSubdirectory("src/a.ts", null), true);
    assert.equal(candidateWithinRequestedSubdirectory("", null), true);
});

test("candidateWithinRequestedSubdirectory keeps sibling subdirectories disjoint", () => {
    const alpha = resolveRequestedSearchSubdirectory({
        indexedRoot: path.join(path.sep, "repo"),
        requestedPath: path.join(path.sep, "repo", "src", "alpha"),
    });
    const beta = resolveRequestedSearchSubdirectory({
        indexedRoot: path.join(path.sep, "repo"),
        requestedPath: path.join(path.sep, "repo", "src", "beta"),
    });
    assert.equal(candidateWithinRequestedSubdirectory("src/alpha/a.ts", alpha), true);
    assert.equal(candidateWithinRequestedSubdirectory("src/beta/b.ts", alpha), false);
    assert.equal(candidateWithinRequestedSubdirectory("src/alpha/a.ts", beta), false);
    assert.equal(candidateWithinRequestedSubdirectory("src/beta/b.ts", beta), true);
});

test("nested call graph target eligibility rejects symbols outside the requested subtree", () => {
    const requested = resolveRequestedSearchSubdirectory({
        indexedRoot: "/repo",
        requestedPath: "/repo/packages/a",
    });
    assert.equal(candidateWithinRequestedSubdirectory("packages/a/src/target.ts", requested), true);
    assert.equal(candidateWithinRequestedSubdirectory("packages/b/src/target.ts", requested), false);
});

test("candidateWithinRequestedSubdirectory rejects prefix collisions and escapes", () => {
    const scope = resolveRequestedSearchSubdirectory({
        indexedRoot: path.join(path.sep, "repo"),
        requestedPath: path.join(path.sep, "repo", "src", "alpha"),
    });
    assert.equal(candidateWithinRequestedSubdirectory("src/alpha-x/c.ts", scope), false);
    assert.equal(candidateWithinRequestedSubdirectory("src/alpha", scope), true);
    assert.equal(candidateWithinRequestedSubdirectory("src/alpha/nested/deep.ts", scope), true);
    assert.equal(candidateWithinRequestedSubdirectory("other/alpha/d.ts", scope), false);
    assert.equal(candidateWithinRequestedSubdirectory("src\\alpha\\win.ts", scope), true);
    assert.equal(candidateWithinRequestedSubdirectory("/src/alpha/lead.ts", scope), false);
});
