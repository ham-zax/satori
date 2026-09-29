import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { RootMutationRuntime, createSharedPublicationRuntime } from "@satori-code/core/integration";
import { buildRuntimeIndexFingerprint, type ContextMcpConfig } from "../config.js";
import { createLocalOnlyContext } from "../server/provider-runtime.js";
import { CapabilityResolver } from "./capabilities.js";
import { ToolHandlers } from "./handlers.js";
import { SyncManager } from "./sync.js";

const LEGACY_ID = "legacy-publication";

test("manage_index reindex rebuilds over an incompatible current Publication without deleting it", async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-incompatible-reindex-"));
    const stateRoot = path.join(tempRoot, "state");
    const repo = path.join(tempRoot, "repo");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "main.py"), "def main():\n    return 1\n");
    const canonicalRepo = fs.realpathSync(repo);

    // Publication layout owned by core: <state>/publications/<sha256(root)>/generations/<id>.
    const generationRoot = path.join(
        stateRoot,
        "publications",
        crypto.createHash("sha256").update(canonicalRepo).digest("hex"),
        "generations",
        LEGACY_ID,
    );
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(
        path.join(generationRoot, "publication.json"),
        JSON.stringify({ version: 1, id: LEGACY_ID, canonicalRoot: canonicalRepo }),
    );
    fs.writeFileSync(
        path.join(path.dirname(path.dirname(generationRoot)), "current.json"),
        JSON.stringify({ version: 1, publicationId: LEGACY_ID }),
    );

    const config: ContextMcpConfig = {
        name: "incompatible-reindex-test",
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
        ownerId: "incompatible-reindex-test",
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
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    const response = await handlers.handleReindexCodebase({ path: repo });

    const text = response.content.map((item) => item.text).join("\n");
    assert.doesNotMatch(text, /Unsupported Publication version/);
    assert.match(text, /Started background indexing/);
    await Promise.all(detached);
    assert.ok(fs.existsSync(path.join(generationRoot, "publication.json")), "incompatible generation must be left on disk");
});
