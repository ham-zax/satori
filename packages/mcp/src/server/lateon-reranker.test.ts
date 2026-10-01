import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RerankExecutionDiagnostics } from "@satori-code/core";
import {
    LATEON_RUNTIME_PROFILE_IDS,
    LateOnOperationalError,
    LateOnReranker,
    loadLateOnRuntimeProfile,
} from "./lateon-reranker.js";
import { resolveSearchRerankQuery } from "../core/search-rerank-query-routing.js";
import { loadSearchRerankRequestContract } from "../core/search-rerank-request-contract.js";
import { buildSearchRerankDocument } from "../core/search-rerank-document.js";
import { buildSearchRerankQuery } from "../core/search-rerank-query.js";

type FakeWorkerOptions = Readonly<{
    readyDelayMilliseconds?: number;
    readinessMismatch?: boolean;
    pidLogPath?: string;
    bootstrapAttempts?: readonly (
        | "ready"
        | "exit"
        | "timeout"
        | "initialization_error"
        | "malformed"
    )[];
}>;

function createFakeWorker(t: { after(fn: () => void): void }, options: FakeWorkerOptions = {}): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-worker-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const workerPath = path.join(directory, "worker.cjs");
    const attemptLogPath = options.pidLogPath ?? path.join(directory, "worker-attempts.txt");
    fs.writeFileSync(workerPath, `
const fs = require("node:fs");
const options = ${JSON.stringify({ ...options, attemptLogPath })};
function sendResults(message) {
    if (message.query === "hang") return;
    if (message.query === "malformed") {
        process.send({
            type: "result",
            requestId: message.requestId,
            results: [{ index: 0, relevanceScore: 1 }, { index: 0, relevanceScore: 2 }],
        });
        return;
    }
    const respond = () => {
        const results = message.identities
            .map((identity, index) => ({
                index,
                identity,
                relevanceScore: message.documents[index].length,
            }))
            .sort((left, right) =>
                right.relevanceScore - left.relevanceScore
                || (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0)
            )
            .map(({ index, relevanceScore }) => ({ index, relevanceScore }));
        process.send({ type: "result", requestId: message.requestId, results });
    };
    const delay = message.query.startsWith("slow:")
        ? Number(message.query.slice("slow:".length))
        : 0;
    setTimeout(respond, delay);
}
process.on("message", (message) => {
    if (message.type === "initialize") {
        const previousAttempts = fs.existsSync(options.attemptLogPath)
            ? fs.readFileSync(options.attemptLogPath, "utf8").trim().split("\\n").filter(Boolean).length
            : 0;
        fs.appendFileSync(options.attemptLogPath, String(process.pid) + "\\n");
        const bootstrapBehavior = options.bootstrapAttempts?.[previousAttempts] || "ready";
        if (bootstrapBehavior === "exit") {
            process.exit(42);
        }
        if (bootstrapBehavior === "timeout") return;
        if (bootstrapBehavior === "initialization_error") {
            process.send({ type: "error", message: "LateOn fake initialization failed." });
            return;
        }
        if (bootstrapBehavior === "malformed") {
            process.send({ unexpected: "message" });
            return;
        }
        setTimeout(() => process.send({
            type: "ready",
            modelRevision: options.readinessMismatch ? "mismatched-revision" : message.profile.identity.revision,
            projectionVersion: message.profile.identity.projectionVersion,
            candidateDepth: message.profile.inference.candidateDepth,
        }), options.readyDelayMilliseconds || 0);
        return;
    }
    sendResults(message);
});
`, "utf8");
    return workerPath;
}

function readWorkerPids(pidLogPath: string): number[] {
    if (!fs.existsSync(pidLogPath)) return [];
    return fs.readFileSync(pidLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
}

async function waitForWorkerAttempts(pidLogPath: string, expected: number): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (readWorkerPids(pidLogPath).length < expected) {
        if (Date.now() >= deadline) {
            assert.fail(`Expected ${expected} LateOn worker attempts.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function assertOperationalReason(
    promise: Promise<unknown>,
    reason: LateOnOperationalError["reason"],
): Promise<void> {
    await assert.rejects(promise, (error: unknown) => (
        error instanceof LateOnOperationalError && error.reason === reason
    ));
}

test("LateOn runtime profile loading defaults to the V6 D128 context profile and rejects any other profile id", () => {
    const defaultProfile = loadLateOnRuntimeProfile();

    assert.equal(defaultProfile.schemaVersion, "satori_lateon_runtime_profile_v6");
    assert.equal(defaultProfile.identity.projectionVersion, "search_rerank_document_v5");
    assert.equal(defaultProfile.identity.queryProjectionVersion, "search_rerank_query_v2");
    assert.equal(defaultProfile.inference.candidateDepth, 128);

    assert.throws(
        () => loadLateOnRuntimeProfile("lateon_offline_quality_projection_v4_d32_v1"),
        /Unsupported LateOn runtime profile 'lateon_offline_quality_projection_v4_d32_v1'; reinstall is required/,
    );
});

test("LateOn native request scores all 128 candidates and rejects overflow before execution", async (t) => {
    const reranker = new LateOnReranker({ modelDirectory: "/unused", workerPath: createFakeWorker(t) });
    t.after(async () => reranker.close());
    const documents = Array.from({ length: 128 }, (_, index) => "x".repeat(index + 1));
    const diagnostics: RerankExecutionDiagnostics[] = [];
    const results = await reranker.rerank("capacity", documents, {
        onExecutionDiagnostics: (value) => diagnostics.push(value),
    });
    assert.deepEqual(results.map((row) => row.index), Array.from({ length: 128 }, (_, index) => 127 - index));
    assert.deepEqual(results.map((row) => row.relevanceScore), Array.from({ length: 128 }, (_, index) => 128 - index));
    assert.equal(diagnostics.length, 1, "one native execution owns the complete candidate set");
    await assert.rejects(reranker.rerank("overflow", [...documents, "extra"]), /at most 128 documents/);
    assert.equal(reranker.getOperationalSnapshot().pendingWorkerRequests, 0);
});

test("LateOn context-v6 profile keeps query-v2 and document-v5 semantic projections", () => {
    const v5 = loadLateOnRuntimeProfile(LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
    assert.equal(v5.schemaVersion, "satori_lateon_runtime_profile_v6");
    assert.equal(v5.profileId, "lateon_offline_quality_projection_v6_d128_v1");
    assert.equal(v5.qualificationStatus, "owner_activated_not_held_out");
    assert.equal(v5.identity.projectionVersion, "search_rerank_document_v5");
    assert.equal(v5.identity.queryProjectionVersion, "search_rerank_query_v2");
    assert.equal(
        v5.identity.projectionSha256,
        "b9131931424dae9430e0f954af1f79dec1b12fed76dc785bb9b73351fff7f712",
    );
    assert.equal(
        v5.identity.requestContractSha256,
        loadSearchRerankRequestContract().contractSha256,
    );
});

test("LateOn reranker defaults to the V5 profile and reports semantic projection identities", async (t) => {
    const workerPath = createFakeWorker(t);
    const defaulted = new LateOnReranker({ modelDirectory: "/unused", workerPath });
    const contextV4 = new LateOnReranker({
        modelDirectory: "/unused",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath,
    });
    t.after(async () => Promise.all([
        defaulted.close(),
        contextV4.close(),
    ]).then(() => undefined));

    assert.equal(defaulted.getProfileId(), LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
    assert.equal(defaulted.getMaxDocuments(), 128);
    assert.equal(defaulted.getDocumentProjectionVersion(), "search_rerank_document_v5");
    assert.equal(defaulted.getQueryProjectionVersion(), "search_rerank_query_v2");
    assert.equal(contextV4.getProfileId(), LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
    assert.equal(contextV4.getMaxDocuments(), 128);
    assert.equal(contextV4.getDocumentProjectionVersion(), "search_rerank_document_v5");
    assert.equal(contextV4.getQueryProjectionVersion(), "search_rerank_query_v2");
});

test("LateOn reranker rejects unknown profile selections at construction", () => {
    assert.throws(
        () => new LateOnReranker({
            modelDirectory: "/unused",
            profileId: "lateon_offline_quality_projection_v4_d32_v1" as never,
        }),
        /Unsupported LateOn runtime profile[\s\S]*reinstall is required/,
    );
});

test("LateOn advertised query identities route to the promised query projection", async (t) => {
    const workerPath = createFakeWorker(t);
    const contextV4 = new LateOnReranker({ modelDirectory: "/unused", workerPath });
    t.after(() => contextV4.close());

    const rawQuestion = "how does Shariah compliance checking block trades";
    const focusedV2 = "Question:\nhow does Shariah compliance checking block trades\n\nRequested answer type:\nproduction implementation, control flow, and integration path";

    const v4 = resolveSearchRerankQuery({
        semanticQuery: rawQuestion,
        focusedQueryV2: focusedV2,
        projectionIdentity: contextV4.getQueryProjectionVersion(),
    });
    assert.equal(v4.query, focusedV2);
    assert.equal(v4.queryProjectionIdentity, "search_rerank_query_v2");

    const raw = resolveSearchRerankQuery({
        semanticQuery: rawQuestion,
        focusedQueryV2: focusedV2,
        projectionIdentity: "semantic_query_raw_v1",
    });
    assert.equal(raw.query, rawQuestion);
    assert.equal(raw.queryProjectionIdentity, "semantic_query_raw_v1");
});

test("LateOn identity binds the semantic profile rather than machine-speed settings", async (t) => {
    const workerPath = createFakeWorker(t);
    const first = new LateOnReranker({
        modelDirectory: "/unused",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath,
    });
    const second = new LateOnReranker({
        modelDirectory: "/other",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath,
    });
    t.after(async () => Promise.all([
        first.close(),
        second.close(),
    ]).then(() => undefined));

    assert.equal(first.getMaxDocuments(), 128);
    assert.equal(first.getDocumentProjectionVersion(), "search_rerank_document_v5");
    assert.equal(first.getQueryProjectionVersion(), "search_rerank_query_v2");
    assert.equal(first.getIdentity().profile, second.getIdentity().profile);
});

test("the first rerank starts the worker and waits for readiness", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { readyDelayMilliseconds: 100 }),
    });
    t.after(() => reranker.close());

    assert.deepEqual(
        await reranker.rerank("find owner", ["document"]),
        [{ index: 0, relevanceScore: 8 }],
    );
    assert.equal(reranker.getOperationalState(), "ready");
});

test("LateOn waits through one pre-ready worker retry", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-exit-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["exit", "ready"],
            pidLogPath,
            readyDelayMilliseconds: 100,
        }),
    });
    t.after(() => reranker.close());

    const rerank = reranker.rerank("find owner", ["document"]);
    await waitForWorkerAttempts(pidLogPath, 2);
    assert.deepEqual(await rerank, [{ index: 0, relevanceScore: 8 }]);
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.deepEqual(reranker.getOperationalSnapshot().bootstrap, {
        attemptCount: 2,
        initialFailureReason: "lateon_worker_failure",
        lastFailureReason: "lateon_worker_failure",
    });
});

test("LateOn retries one worker-reported initialization failure", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-init-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["initialization_error", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());

    await reranker.waitUntilReady();
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalState(), "ready");
});

test("LateOn stops after two retryable bootstrap failures and retains the final cause", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-terminal-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["initialization_error", "exit"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());

    await assert.rejects(reranker.waitUntilReady(), (error: unknown) => (
        error instanceof LateOnOperationalError
        && error.reason === "lateon_worker_failure"
        && error.message.includes("exited before completion")
    ));
    await waitForWorkerAttempts(pidLogPath, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalState(), "unhealthy");
    assert.deepEqual(reranker.getOperationalSnapshot().bootstrap, {
        attemptCount: 2,
        initialFailureReason: "lateon_worker_failure",
        lastFailureReason: "lateon_worker_failure",
    });
    await assert.rejects(
        reranker.rerank("find owner", ["document"]),
        (error: unknown) => (
            error instanceof LateOnOperationalError
            && error.reason === "lateon_worker_failure"
            && error.message.includes("exited before completion")
        ),
    );
});

test("LateOn fails closed when worker readiness identity mismatches the selected profile", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-identity-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { readinessMismatch: true, pidLogPath }),
    });
    t.after(() => reranker.close());

    await assertOperationalReason(reranker.waitUntilReady(), "lateon_worker_failure");
    assert.equal(reranker.getOperationalState(), "unhealthy");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 1);
    await assertOperationalReason(
        reranker.rerank("find owner", ["document"]),
        "lateon_worker_failure",
    );
});

test("LateOn treats malformed bootstrap protocol as terminal without retry", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-protocol-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["malformed", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());

    await assertOperationalReason(reranker.waitUntilReady(), "lateon_invalid_output");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 1);
    await assertOperationalReason(
        reranker.rerank("find owner", ["document"]),
        "lateon_invalid_output",
    );
});

test("LateOn close prevents a loading worker from spawning a bootstrap retry", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-close-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["timeout", "ready"],
            pidLogPath,
        }),
    });

    const readiness = reranker.waitUntilReady();
    void readiness.catch(() => undefined);
    await waitForWorkerAttempts(pidLogPath, 1);
    await reranker.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 1);
    assert.equal(reranker.getOperationalState(), "closed");
});

test("LateOn starts its worker on first use, releases it when idle, and restarts on demand", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-idle-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { pidLogPath }),
        idleShutdownMs: 50,
    });
    t.after(() => reranker.close());

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 0);
    assert.equal(reranker.getOperationalSnapshot().workerAttached, false);

    assert.deepEqual(await reranker.rerank("first", ["document"]), [{ index: 0, relevanceScore: 8 }]);
    assert.equal(readWorkerPids(pidLogPath).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(reranker.getOperationalSnapshot().workerAttached, false);
    assert.equal(reranker.getOperationalState(), "idle");

    assert.deepEqual(await reranker.rerank("second", ["document"]), [{ index: 0, relevanceScore: 8 }]);
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalSnapshot().bootstrap.attemptCount, 1);
});

test("LateOn serializes overlapping reranks through one FIFO queue", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const first = reranker.rerank("slow:80", ["first"]);
    const second = reranker.rerank("second", ["second"]);
    const third = reranker.rerank("third", ["third"]);
    assert.deepEqual(await first, [{ index: 0, relevanceScore: 5 }]);
    assert.deepEqual(await second, [{ index: 0, relevanceScore: 6 }]);
    assert.deepEqual(await third, [{ index: 0, relevanceScore: 5 }]);
});

test("LateOn rejects requests beyond the bounded wait queue", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const active = reranker.rerank("slow:80", ["active"]);
    const queued = Array.from({ length: 16 }, (_, index) => reranker.rerank(`queued-${index}`, ["queued"]));
    await assertOperationalReason(reranker.rerank("overflow", ["overflow"]), "lateon_not_ready");
    await active;
    await Promise.all(queued);
});

test("LateOn queued work waits for the active rerank instead of falling back", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const active = reranker.rerank("slow:80", ["active"]);
    const queued = reranker.rerank("queued", ["queued"]);
    assert.deepEqual(await active, [{ index: 0, relevanceScore: 6 }]);
    assert.deepEqual(await queued, [{ index: 0, relevanceScore: 6 }]);
});

test("LateOn invalid output is rejected transactionally and restarts the worker", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    await assertOperationalReason(
        reranker.rerank("malformed", ["first", "second"]),
        "lateon_invalid_output",
    );
    await reranker.waitUntilReady();
    assert.deepEqual(
        await reranker.rerank("recover", ["document"]),
        [{ index: 0, relevanceScore: 8 }],
    );
});

test("LateOn cancellation removes queued work and terminates executing work", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = reranker.rerank("hang", ["active"], {
        signal: activeController.signal,
    } as Parameters<LateOnReranker["rerank"]>[2]);
    const queued = reranker.rerank("queued", ["queued"], {
        signal: queuedController.signal,
    } as Parameters<LateOnReranker["rerank"]>[2]);
    queuedController.abort();
    await assertOperationalReason(queued, "lateon_cancelled");
    activeController.abort();
    await assertOperationalReason(active, "lateon_cancelled");
    await reranker.waitUntilReady();
});

test("LateOn cancellation during worker startup rejects before readiness without failing other waiters", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { readyDelayMilliseconds: 500 }),
    });
    t.after(() => reranker.close());

    const controller = new AbortController();
    const cancelled = reranker.rerank("find owner", ["cancelled"], {
        signal: controller.signal,
    } as Parameters<LateOnReranker["rerank"]>[2]);
    const waiter = reranker.rerank("find owner", ["document"]);
    controller.abort();
    await assertOperationalReason(cancelled, "lateon_cancelled");
    assert.equal(reranker.getOperationalState(), "loading");
    assert.deepEqual(await waiter, [{ index: 0, relevanceScore: 8 }]);
    assert.equal(reranker.getOperationalState(), "ready");
});

test("LateOn close rejects active and queued work and joins its worker", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    await reranker.waitUntilReady();

    const active = reranker.rerank("hang", ["active"]);
    const queued = reranker.rerank("queued", ["queued"]);
    const activeRejection = assertOperationalReason(active, "lateon_cancelled");
    const queuedRejection = assertOperationalReason(queued, "lateon_cancelled");
    await reranker.close();
    await activeRejection;
    await queuedRejection;
    assert.equal(reranker.getOperationalState(), "closed");
    assert.deepEqual(reranker.getOperationalSnapshot(), {
        state: "closed",
        closed: true,
        workerAttached: false,
        activeRequest: false,
        activeTask: false,
        queuedRequest: false,
        pendingWorkerRequests: 0,
        readinessTimerActive: false,
        terminationActive: false,
        bootstrap: {
            attemptCount: 1,
        },
    });
});

test("LateOn successful execution reports queue wait and a hard safety ceiling", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const reported: { diagnostics: RerankExecutionDiagnostics | null } = { diagnostics: null };
    assert.deepEqual(
        await reranker.rerank("scored", ["alpha", "alphabetic"], {
            onExecutionDiagnostics: (diagnostics) => { reported.diagnostics = diagnostics; },
        }),
        [{ index: 1, relevanceScore: 10 }, { index: 0, relevanceScore: 5 }],
    );

    assert.ok(reported.diagnostics);
    assert.equal(reported.diagnostics.attempts, 1);
    assert.equal(reported.diagnostics.retries, 0);
    assert.equal(reported.diagnostics.timeouts, 0);
    assert.ok(typeof reported.diagnostics.queueWaitMs === "number" && reported.diagnostics.queueWaitMs >= 0);
    assert.ok(
        reported.diagnostics.effectiveScoreDeadlineMs !== undefined
        && reported.diagnostics.effectiveScoreDeadlineMs >= 60_000,
    );
    assert.equal(reported.diagnostics.effectiveStageDeadlineMs, undefined);
    assert.ok(typeof reported.diagnostics.observedWallMs === "number" && reported.diagnostics.observedWallMs >= 0);
    assert.equal(reported.diagnostics.deadlineLatenessMs, undefined);
});

test("LateOn queued execution reports the actual queue wait without a queue timeout", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const reported: { diagnostics: RerankExecutionDiagnostics | null } = { diagnostics: null };
    const active = reranker.rerank("slow:80", ["active"]);
    const queued = reranker.rerank("queued", ["queued"], {
        onExecutionDiagnostics: (diagnostics) => { reported.diagnostics = diagnostics; },
    });
    await active;
    await queued;

    assert.ok(reported.diagnostics);
    assert.equal(reported.diagnostics.timeouts, 0);
    assert.ok(
        typeof reported.diagnostics.queueWaitMs === "number"
        && reported.diagnostics.queueWaitMs >= 50,
    );
    assert.equal(reported.diagnostics.effectiveStageDeadlineMs, undefined);
});

test("LateOn diagnostics callback failure never changes rerank behavior", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const throwing = (): void => { throw new Error("telemetry boom"); };
    assert.deepEqual(
        await reranker.rerank("scored", ["document"], { onExecutionDiagnostics: throwing }),
        [{ index: 0, relevanceScore: 8 }],
    );
});

const realLateOnModelDirectory = process.env.SATORI_LATEON_MODEL_PATH;
test("LateOn v6 accepts query-v2 and the canonical document projection through the real tokenizer and model", {
    skip: !realLateOnModelDirectory || !fs.existsSync(path.join(realLateOnModelDirectory, "model.onnx")),
}, async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: realLateOnModelDirectory as string,
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
    });
    t.after(async () => reranker.close());
    await reranker.waitUntilReady();
    const query = buildSearchRerankQuery({
        semanticQuery: "how does Shariah compliance checking block trades",
        answerFocus: "implementation",
    });
    const documents = [
        buildSearchRerankDocument({
            relativePath: "src/veto.ts",
            language: "typescript",
            candidateRole: "implementation",
            symbolKind: "function",
            canonicalSymbolLabel: "validate_order",
            symbolSpan: { startLine: 1, endLine: 3 },
            content: [
                "function validate_order(order) {",
                "    return check_shariah_compliance(order);",
                "}",
            ].join("\n"),
            query: "how does Shariah compliance checking block trades",
        }).text,
        buildSearchRerankDocument({
            relativePath: "tests/veto.test.ts",
            language: "typescript",
            candidateRole: "test",
            symbolKind: "test",
            canonicalSymbolLabel: "validates_trade_veto",
            symbolSpan: { startLine: 1, endLine: 3 },
            content: [
                "test(\"validates trade veto\", () => {",
                "    assert.equal(validate_order(order), false);",
                "});",
            ].join("\n"),
            query: "how does Shariah compliance checking block trades",
        }).text,
    ];
    const results = await reranker.rerank(query, documents);
    assert.equal(results.length, documents.length);
    assert.deepEqual(results.map((result) => result.index).sort(), [0, 1]);
    assert.ok(results.every((result) => Number.isFinite(result.relevanceScore)));
});
