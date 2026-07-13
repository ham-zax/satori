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

test("prepared read cache expires a frequently used proof at its absolute age", () => {
    const cache = new PreparedReadCache<{ receipt: string }>(32, 10, 20);
    cache.seed("/repo", { receipt: "proof-1" }, "authority-1", 0);

    assert.equal(cache.lookupCandidate("/repo/src", 9, (path, root) => path.startsWith(root)).status, "hit");
    cache.seed("/repo", { receipt: "proof-2" }, "authority-1", 9, true);
    assert.equal(cache.lookupCandidate("/repo/src", 18, (path, root) => path.startsWith(root)).status, "hit");
    assert.deepEqual(
        cache.lookupCandidate("/repo/src", 20, (path, root) => path.startsWith(root)),
        { status: "miss", reason: "proof_expired" },
    );
    assert.equal(cache.size, 0);
});

test("prepared read cache preserves proof age across a warm navigation observation change", () => {
    const cache = new PreparedReadCache<{ receipt: string }>(32, 100, 20);
    cache.seed("/repo", { receipt: "proof-1" }, "navigation-1", 0);
    cache.seed("/repo", { receipt: "proof-1" }, "navigation-2", 19, true);

    assert.deepEqual(
        cache.lookupCandidate("/repo/src", 20, (path, root) => path.startsWith(root)),
        { status: "miss", reason: "proof_expired" },
    );
});

test("prepared read cache resets proof age after a cold proof", () => {
    const cache = new PreparedReadCache<{ receipt: string }>(32, 100, 20);
    cache.seed("/repo", { receipt: "proof-1" }, "navigation-1", 0);
    cache.seed("/repo", { receipt: "proof-2" }, "navigation-1", 19);

    assert.equal(
        cache.lookupCandidate("/repo/src", 20, (path, root) => path.startsWith(root)).status,
        "hit",
    );
});

test("prepared read cache does not fall back to a parent when the deepest proof expires", () => {
    const cache = new PreparedReadCache<{ root: string }>(32, 100, 20);
    cache.seed("/repo", { root: "/repo" }, "parent", 10);
    cache.seed("/repo/packages/child", { root: "/repo/packages/child" }, "child", 0);

    assert.deepEqual(
        cache.lookupCandidate(
            "/repo/packages/child/src/index.ts",
            20,
            (targetPath, root) => targetPath === root || targetPath.startsWith(`${root}/`),
        ),
        { status: "miss", reason: "proof_expired" },
    );
    assert.equal(cache.size, 1);
});

test("prepared read cache retains one bounded clone per root under repeated access", () => {
    const cache = new PreparedReadCache<{ sequence: number }>();
    cache.seed("/repo", { sequence: 0 }, "authority", 0);

    for (let sequence = 1; sequence <= 100; sequence += 1) {
        const candidate = cache.getCandidate(
            "/repo/src/index.ts",
            sequence,
            (targetPath, root) => targetPath.startsWith(root),
        );
        assert.ok(candidate);
        candidate.state.sequence = sequence;
    }

    assert.equal(cache.size, 1);
    assert.deepEqual(
        cache.getCandidate("/repo", 101, (targetPath, root) => targetPath.startsWith(root))?.state,
        { sequence: 0 },
    );
});

test("prepared read cache remains root-bounded across repeated multi-root access", () => {
    const cache = new PreparedReadCache<{ root: number }>();
    for (let root = 0; root < 20; root += 1) {
        const rootPath = `/repo-${root}`;
        cache.seed(rootPath, { root }, `authority-${root}`, 0);
        for (let access = 1; access <= 5; access += 1) {
            assert.ok(cache.getCandidate(
                `${rootPath}/src/index.ts`,
                access,
                (targetPath, candidateRoot) => targetPath.startsWith(candidateRoot),
            ));
        }
    }

    assert.equal(cache.size, 20);
});
