import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RootMutationRuntime, createSharedPublicationRuntime } from "@satori-code/core/integration";
import { buildRuntimeIndexFingerprint, type ContextMcpConfig } from "../config.js";
import { createLocalOnlyContext } from "../server/provider-runtime.js";
import { CapabilityResolver } from "./capabilities.js";
import { ToolHandlers } from "./handlers.js";
import { SyncManager } from "./sync.js";

function fixture(t: test.TestContext) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mutation-trigger-"));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const stateRoot = path.join(tempRoot, "state");
    const repo = path.join(tempRoot, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "main.py"), "def main():\n    return 1\n");
    const config: ContextMcpConfig = {
        name: "mutation-trigger-test",
        version: "1.0.0",
        stateRoot,
        executionProfile: "offline",
        networkPolicy: { kind: "remote-allowed" },
        vectorStoreProvider: "Milvus",
        milvusEndpoint: "localhost:19530",
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-code-3",
        encoderOutputDimension: 1024,
        watchSyncEnabled: false,
    };
    const mutationRuntime = new RootMutationRuntime({
        stateDir: path.join(tempRoot, "mutations"),
        ownerId: "mutation-trigger-test",
    });
    const publicationRuntime = createSharedPublicationRuntime(mutationRuntime, { stateRoot });
    const detached: Promise<void>[] = [];
    const context = createLocalOnlyContext(config, mutationRuntime, publicationRuntime);
    const syncManager = new SyncManager(context, { watchEnabled: false, mutationRuntime });
    const handlers = new ToolHandlers(
        context,
        syncManager,
        buildRuntimeIndexFingerprint(config, 1024),
        new CapabilityResolver(config),
        mutationRuntime,
        undefined, undefined, undefined, undefined, null, undefined,
        { ownDetachedMutationCompletion: (completion) => { detached.push(completion.catch(() => undefined)); } },
    );
    return { repo, mutationRuntime, handlers, detached };
}

test("an explicit manage_index reindex records the manage_index trigger", async (t) => {
    const { repo, mutationRuntime, handlers, detached } = fixture(t);

    const response = await handlers.handleReindexCodebase({ path: repo });

    assert.match(response.content.map((item) => item.text).join("\n"), /Started background indexing/);
    assert.equal(mutationRuntime.getActiveMutation(repo)?.trigger ?? mutationRuntime.getOperation(repo)?.trigger, "manage_index");
    await Promise.all(detached);
    assert.equal(mutationRuntime.getOperation(repo)?.trigger, "manage_index");
});

test("a maintenance-started reindex records the automatic trigger", async (t) => {
    const { repo, mutationRuntime, handlers, detached } = fixture(t);

    const launch = await handlers.startAutomaticReindex(repo);

    assert.equal(launch.accepted, true);
    await launch.completion?.catch(() => undefined);
    await Promise.all(detached);
    assert.equal(mutationRuntime.getOperation(repo)?.trigger, "automatic");
});
