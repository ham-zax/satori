import test from "node:test";
import assert from "node:assert/strict";
import { PreparedReadCache } from "./prepared-read-cache.js";

test("prepared read cache reuses only an identical authority observation", () => {
    const cache = new PreparedReadCache<{ root: string }>();
    cache.seed("/repo", { root: "/repo" }, "proof-1", 0);

    assert.deepEqual(cache.get("/repo/src", 1, (path, root) => path.startsWith(root), () => "proof-1"), {
        root: "/repo",
    });
    assert.equal(cache.get("/repo/src", 2, (path, root) => path.startsWith(root), () => "proof-2"), null);
    assert.equal(cache.size, 0);
});

test("prepared read cache is idle-bounded, root-bounded, and LRU-bounded", () => {
    const cache = new PreparedReadCache<number>(2, 10);
    cache.seed("/a", 1, "a", 0);
    cache.seed("/b", 2, "b", 1);
    cache.get("/a/x", 2, (path, root) => path.startsWith(root), () => "a");
    cache.seed("/c", 3, "c", 3);

    assert.equal(cache.get("/b", 3, (path, root) => path.startsWith(root), () => "b"), null);
    assert.equal(cache.get("/a", 11, (path, root) => path.startsWith(root), () => "a"), 1);
    assert.equal(cache.get("/c", 14, (path, root) => path.startsWith(root), () => "c"), null);
    cache.evict("/a");
    assert.equal(cache.size, 0);
});

test("prepared read cache selects the deepest matching tracked root", () => {
    const cache = new PreparedReadCache<{ root: string }>();
    cache.seed("/repo", { root: "/repo" }, "parent", 0);
    cache.seed("/repo/packages/child", { root: "/repo/packages/child" }, "child", 0);

    assert.deepEqual(cache.get(
        "/repo/packages/child/src/index.ts",
        1,
        (targetPath, root) => targetPath === root || targetPath.startsWith(`${root}/`),
        (root) => root === "/repo" ? "parent" : "child",
    ), { root: "/repo/packages/child" });
});

test("prepared read cache exposes a cloned vector candidate without evicting on navigation observation drift", () => {
    const cache = new PreparedReadCache<{ receipt: { collectionName: string } }>();
    cache.seed("/repo", { receipt: { collectionName: "generation-a" } }, "navigation-1", 0);

    const candidate = cache.getCandidate(
        "/repo/src/index.ts",
        1,
        (targetPath, root) => targetPath === root || targetPath.startsWith(`${root}/`),
    );
    assert.deepEqual(candidate, {
        root: "/repo",
        state: { receipt: { collectionName: "generation-a" } },
        observation: "navigation-1",
    });
    assert.ok(candidate);
    candidate.state.receipt.collectionName = "forged";

    assert.deepEqual(cache.getCandidate(
        "/repo/src/index.ts",
        2,
        (targetPath, root) => targetPath === root || targetPath.startsWith(`${root}/`),
    )?.state, { receipt: { collectionName: "generation-a" } });
    assert.equal(cache.size, 1);
});
