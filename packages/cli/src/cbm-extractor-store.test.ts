import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    CBM_EXTENDED_REPOSITORY,
    CBM_EXTENDED_REVISION,
    plannedCbmExtendedDirectory,
    readCbmExtendedPackSpec,
    resolveCbmExtendedPath,
} from "./cbm-extractor-store.js";

function fakeRuntime(root: string, wasm: Buffer): string {
    const runtime = path.join(root, "runtime");
    const core = path.join(runtime, "node_modules", "@satori-code", "core");
    fs.mkdirSync(path.join(core, "dist"), { recursive: true });
    fs.mkdirSync(path.join(core, "assets", "cbm-extractor"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ name: "@satori-code/mcp", version: "1.0.0" }));
    fs.writeFileSync(path.join(core, "package.json"), JSON.stringify({ name: "@satori-code/core", version: "1.0.0", main: "dist/index.js" }));
    fs.writeFileSync(path.join(core, "dist", "index.js"), "");
    fs.writeFileSync(path.join(core, "assets", "cbm-extractor", "manifest.json"), JSON.stringify({
        modules: [
            { file: "kotlin.wasm", sizeBytes: 3, sha256: "core-only", pack: "core" },
            { file: "odin.wasm", sizeBytes: wasm.length, sha256: crypto.createHash("sha256").update(wasm).digest("hex"), pack: "extended" },
        ],
    }));
    return runtime;
}

test("extended pack spec lists only extended modules from the installed core manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cbm-pack-"));
    try {
        const spec = readCbmExtendedPackSpec(fakeRuntime(root, Buffer.from("wasm")));
        assert.equal(spec.repository, CBM_EXTENDED_REPOSITORY);
        assert.equal(spec.revision, CBM_EXTENDED_REVISION);
        assert.deepEqual(spec.artifacts.map((artifact) => artifact.path), ["odin.wasm"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("extended pack downloads into the planned directory and degrades with a warning when unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cbm-pack-"));
    const wasm = Buffer.from("odin-module");
    try {
        const runtimePackageRoot = fakeRuntime(root, wasm);
        const homeDir = path.join(root, "home");
        const requested: string[] = [];
        const fetchImpl = (async (url: string | URL) => {
            requested.push(String(url));
            return new Response(wasm, { status: 200, headers: { "content-length": String(wasm.length) } });
        }) as typeof fetch;
        const directory = await resolveCbmExtendedPath({ homeDir, runtimePackageRoot, env: {}, options: { fetchImpl, modelRetryDelaysMs: [] } });
        assert.equal(directory, plannedCbmExtendedDirectory(homeDir));
        assert.deepEqual(fs.readFileSync(path.join(directory!, "odin.wasm")), wasm);
        assert.deepEqual(requested, [`https://huggingface.co/${CBM_EXTENDED_REPOSITORY}/resolve/${CBM_EXTENDED_REVISION}/odin.wasm`]);

        const warnings: string[] = [];
        const offline = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
        const missing = await resolveCbmExtendedPath({
            homeDir: path.join(root, "offline-home"),
            runtimePackageRoot,
            env: {},
            options: { fetchImpl: offline, modelRetryDelaysMs: [], onInstallWarning: (message) => warnings.push(message) },
        });
        assert.equal(missing, undefined);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /stay search-only/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
