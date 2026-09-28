import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureModel, resolveModelDirectory, type ModelSpec } from "./model-store.js";

const CONTENT = "0123456789abcdefghij";

function spec(): ModelSpec {
    return {
        id: "fixture",
        label: "fixture model",
        repository: "org/fixture-model",
        revision: "abc123",
        artifacts: [{
            path: "model.bin",
            sizeBytes: CONTENT.length,
            sha256: crypto.createHash("sha256").update(CONTENT).digest("hex"),
        }],
    };
}

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-model-store-"));
    try {
        await run(homeDir);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
}

function stagedFile(homeDir: string): string {
    const modelDirectory = resolveModelDirectory(homeDir, spec());
    return path.join(path.dirname(modelDirectory), `.${path.basename(modelDirectory)}.partial`, "model.bin");
}

test("an interrupted download resumes from the staged bytes with a Range request", async () => {
    await withHome(async (homeDir) => {
        fs.mkdirSync(path.dirname(stagedFile(homeDir)), { recursive: true });
        fs.writeFileSync(stagedFile(homeDir), CONTENT.slice(0, 8));
        const ranges: Array<string | null> = [];
        const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
            const range = new Headers(init?.headers).get("range");
            ranges.push(range);
            return new Response(CONTENT.slice(8), { status: 206 });
        }) as typeof fetch;
        const events: string[] = [];
        const result = await ensureModel({
            homeDir,
            spec: spec(),
            env: {},
            fetchImpl,
            onProgress: (event) => {
                if (event.phase === "downloading") events.push(`resumed:${event.resumedBytes}`);
            },
        });
        assert.deepEqual(ranges, ["bytes=8-"]);
        assert.deepEqual(events, ["resumed:8"]);
        assert.equal(fs.readFileSync(path.join(result.modelDirectory, "model.bin"), "utf8"), CONTENT);
        assert.equal(fs.existsSync(path.dirname(stagedFile(homeDir))), false);
    });
});

test("a server that ignores Range restarts the artifact instead of corrupting it", async () => {
    await withHome(async (homeDir) => {
        fs.mkdirSync(path.dirname(stagedFile(homeDir)), { recursive: true });
        fs.writeFileSync(stagedFile(homeDir), CONTENT.slice(0, 8));
        const fetchImpl = (async () => new Response(CONTENT, { status: 200 })) as typeof fetch;
        const result = await ensureModel({ homeDir, spec: spec(), env: {}, fetchImpl });
        assert.equal(fs.readFileSync(path.join(result.modelDirectory, "model.bin"), "utf8"), CONTENT);
    });
});

test("a stalled download is retried and then reported with a resume hint", async () => {
    await withHome(async (homeDir) => {
        let calls = 0;
        const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
            calls += 1;
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(CONTENT.slice(0, 4)));
                    init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
                },
            }), { status: 200 });
        }) as typeof fetch;
        await assert.rejects(
            ensureModel({ homeDir, spec: spec(), env: {}, fetchImpl, stallTimeoutMs: 20, retryDelaysMs: [0] }),
            (error: unknown) => {
                assert.equal((error as { reason?: string }).reason, "stalled");
                assert.match((error as Error).message, /stalled .* rerunning resumes where it stopped/);
                return true;
            },
        );
        assert.equal(calls, 2);
        assert.equal(fs.statSync(stagedFile(homeDir)).size, 4);
    });
});

test("an unreachable host is classified as offline with recovery guidance", async () => {
    await withHome(async (homeDir) => {
        const fetchImpl = (async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
        }) as typeof fetch;
        await assert.rejects(
            ensureModel({ homeDir, spec: spec(), env: {}, fetchImpl, retryDelaysMs: [] }),
            (error: unknown) => {
                assert.equal((error as { reason?: string }).reason, "offline");
                assert.match((error as Error).message, /Could not reach huggingface\.co .*ENOTFOUND.*HF_ENDPOINT/);
                return true;
            },
        );
    });
});

test("HF_ENDPOINT selects a mirror and must use https", async () => {
    await withHome(async (homeDir) => {
        const urls: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            urls.push(String(input));
            return new Response(CONTENT, { status: 200 });
        }) as typeof fetch;
        await ensureModel({ homeDir, spec: spec(), env: { HF_ENDPOINT: "https://mirror.example/hf/" }, fetchImpl });
        assert.deepEqual(urls, ["https://mirror.example/hf/org/fixture-model/resolve/abc123/model.bin"]);
    });
    await withHome(async (homeDir) => {
        await assert.rejects(
            ensureModel({ homeDir, spec: spec(), env: { HF_ENDPOINT: "http://mirror.example" } }),
            /HF_ENDPOINT must use https/,
        );
    });
});

test("ensureModel downloads several artifacts at once when concurrency is raised", async () => {
    await withHome(async (homeDir) => {
        const files = Array.from({ length: 5 }, (_, index) => ({ path: `m${index}.wasm`, body: Buffer.from(`module-${index}`) }));
        const pack: ModelSpec = {
            id: "pack",
            label: "Test pack",
            repository: "example/pack",
            revision: "0123456789abcdef0123456789abcdef01234567",
            artifacts: files.map((file) => ({
                path: file.path,
                sizeBytes: file.body.length,
                sha256: crypto.createHash("sha256").update(file.body).digest("hex"),
            })),
        };
        let active = 0;
        let peak = 0;
        const fetchImpl = (async (url: string | URL) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            const body = files.find((file) => String(url).endsWith(`/${file.path}`))!.body;
            return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
        }) as typeof fetch;
        const { modelDirectory } = await ensureModel({ homeDir, spec: pack, fetchImpl, concurrency: 3, retryDelaysMs: [] });
        assert.equal(peak, 3);
        for (const file of files) assert.deepEqual(fs.readFileSync(path.join(modelDirectory, file.path)), file.body);
    });
});
