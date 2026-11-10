import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneManagedRuntimeDeadWeight } from "./managed-runtime-prune.js";

const NODE_VERSION = "1.30.0";
const TRANSFORMERS_VERSION = "4.3.1";
const WEB_VERSION = "1.31.0-dev.20260914-8d85527a0";

function makeRuntimeRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "satori-prune-"));
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeOnnxNodeTree(runtimeRoot: string, version: string = NODE_VERSION): string {
    const nodeRoot = path.join(runtimeRoot, "node_modules", "onnxruntime-node");
    writeJson(path.join(nodeRoot, "package.json"), {
        name: "onnxruntime-node",
        version,
    });
    for (const [platform, arch, file] of [
        ["linux", "x64", "libonnxruntime.so.1"],
        ["linux", "arm64", "libonnxruntime.so.1"],
        ["darwin", "arm64", "libonnxruntime.dylib"],
        ["win32", "x64", "onnxruntime.dll"],
        ["win32", "arm64", "onnxruntime.dll"],
    ] as const) {
        const dir = path.join(nodeRoot, "bin", "napi-v6", platform, arch);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), "binary", "utf8");
    }
    return nodeRoot;
}

function writeWebTree(runtimeRoot: string, webVersion: string = WEB_VERSION): string {
    const webRoot = path.join(runtimeRoot, "node_modules", "onnxruntime-web");
    writeJson(path.join(webRoot, "package.json"), {
        name: "onnxruntime-web",
        version: webVersion,
    });
    const distRoot = path.join(webRoot, "dist");
    fs.mkdirSync(distRoot, { recursive: true });
    fs.writeFileSync(path.join(distRoot, "ort.webgpu.bundle.min.mjs"), "bundle", "utf8");
    fs.writeFileSync(path.join(distRoot, "ort.wasm.min.mjs"), "wasm-wrapper", "utf8");
    fs.writeFileSync(path.join(distRoot, "ort-wasm-simd-threaded.wasm"), "wasm", "utf8");
    fs.writeFileSync(path.join(distRoot, "ort-wasm-simd-threaded.jsep.wasm"), "wasm", "utf8");
    const transformersRoot = path.join(runtimeRoot, "node_modules", "@huggingface", "transformers");
    writeJson(path.join(transformersRoot, "package.json"), {
        name: "@huggingface/transformers",
        version: TRANSFORMERS_VERSION,
        dependencies: {
            "onnxruntime-web": webVersion,
        },
    });
    return webRoot;
}

test("prune keeps host N-API arch and deletes other platforms", () => {
    const runtimeRoot = makeRuntimeRoot();
    try {
        const nodeRoot = writeOnnxNodeTree(runtimeRoot);
        pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "x64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        });
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "linux", "x64", "libonnxruntime.so.1")), true);
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "linux", "arm64")), false);
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "darwin", "arm64")), false);
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "win32", "x64")), false);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("prune keeps simulated arm64 host and deletes x64 binaries", () => {
    const runtimeRoot = makeRuntimeRoot();
    try {
        const nodeRoot = writeOnnxNodeTree(runtimeRoot);
        pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "arm64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        });
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "linux", "arm64", "libonnxruntime.so.1")), true);
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "linux", "x64")), false);
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "win32", "x64")), false);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("prune deletes only wasm files and keeps web bundles", () => {
    const runtimeRoot = makeRuntimeRoot();
    try {
        const webRoot = writeWebTree(runtimeRoot);
        pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "x64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        });
        assert.equal(fs.existsSync(path.join(webRoot, "dist", "ort.webgpu.bundle.min.mjs")), true);
        assert.equal(fs.existsSync(path.join(webRoot, "dist", "ort.wasm.min.mjs")), true);
        assert.equal(fs.existsSync(path.join(webRoot, "dist", "ort-wasm-simd-threaded.wasm")), false);
        assert.equal(fs.existsSync(path.join(webRoot, "dist", "ort-wasm-simd-threaded.jsep.wasm")), false);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("prune skips on version mismatch", () => {
    const runtimeRoot = makeRuntimeRoot();
    try {
        const nodeRoot = writeOnnxNodeTree(runtimeRoot, "9.9.9");
        pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "x64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        });
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "win32", "x64")), true);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("prune skips symlinked trees", () => {
    const runtimeRoot = makeRuntimeRoot();
    const outside = makeRuntimeRoot();
    try {
        const targetRoot = path.join(outside, "onnxruntime-node");
        writeJson(path.join(targetRoot, "package.json"), {
            name: "onnxruntime-node",
            version: NODE_VERSION,
        });
        const win32 = path.join(targetRoot, "bin", "napi-v6", "win32", "x64");
        fs.mkdirSync(win32, { recursive: true });
        fs.writeFileSync(path.join(win32, "onnxruntime.dll"), "binary", "utf8");
        fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
        fs.symlinkSync(targetRoot, path.join(runtimeRoot, "node_modules", "onnxruntime-node"), "dir");
        pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "x64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        });
        assert.equal(fs.existsSync(path.join(win32, "onnxruntime.dll")), true);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test("prune ignores missing packages", () => {
    const runtimeRoot = makeRuntimeRoot();
    try {
        assert.doesNotThrow(() => pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "x64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        }));
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("prune finds dependencies nested under the installed MCP package", () => {
    const runtimeRoot = makeRuntimeRoot();
    try {
        const mcpRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
        const nodeRoot = writeOnnxNodeTree(mcpRoot);
        const webRoot = writeWebTree(mcpRoot);
        pruneManagedRuntimeDeadWeight(runtimeRoot, {
            platform: "linux",
            architecture: "arm64",
            expectedOnnxRuntimeNodeVersion: NODE_VERSION,
            expectedTransformersVersion: TRANSFORMERS_VERSION,
        });
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "linux", "arm64", "libonnxruntime.so.1")), true);
        assert.equal(fs.existsSync(path.join(nodeRoot, "bin", "napi-v6", "linux", "x64")), false);
        assert.equal(fs.existsSync(path.join(webRoot, "dist", "ort-wasm-simd-threaded.wasm")), false);
        assert.equal(fs.existsSync(path.join(webRoot, "dist", "ort.webgpu.bundle.min.mjs")), true);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});
