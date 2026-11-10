import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    installPackedRuntimeClosure,
    packPackage,
    resolveInstalledPotionPaths,
    runPackedPotionSmoke,
} from "./release-smoke.js";

const SUPPORTED_PACKED_LINUX_HOST = process.platform === "linux"
    && (process.arch === "x64" || process.arch === "arm64");

test("packed Potion paths select the installed host architecture asset root", () => {
    const runtimeRoot = path.join(os.tmpdir(), "satori-mcp-smoke-resolver");
    const assetsRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp", "assets", "potion");

    const x64 = resolveInstalledPotionPaths(runtimeRoot, "x64");
    assert.equal(x64.helperPath, path.join(assetsRoot, "linux-x64", "satori-potion"));

    const arm64 = resolveInstalledPotionPaths(runtimeRoot, "arm64");
    assert.equal(arm64.helperPath, path.join(assetsRoot, "linux-arm64", "satori-potion"));

    // The workspace Potion model fixture is architecture-neutral.
    assert.equal(arm64.modelPath, x64.modelPath);

    const unsupported = resolveInstalledPotionPaths(runtimeRoot, "ia32");
    assert.equal(unsupported.helperPath, x64.helperPath);
});

test("packed Potion smoke rejects a missing host helper on supported Linux", {
    skip: !SUPPORTED_PACKED_LINUX_HOST,
}, async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-smoke-missing-helper-"));
    try {
        await assert.rejects(runPackedPotionSmoke(runtimeRoot), /Packed Potion assets are missing/);
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
});

test("packed Potion runtime repairs the helper mode and returns a 256-dimensional embedding", async (t) => {
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(currentFile), "..");
    const corePackageRoot = path.resolve(packageRoot, "..", "core");
    const smokePackDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-smoke-pack-"));
    const smokeExecDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-smoke-exec-"));

    try {
        const coreTarballPath = packPackage(corePackageRoot, smokePackDir);
        const tarballPath = packPackage(packageRoot, smokePackDir);
        const packedRuntime = installPackedRuntimeClosure(coreTarballPath, tarballPath, smokeExecDir);

        const { helperPath, modelPath } = resolveInstalledPotionPaths(packedRuntime.runtimeRoot);
        assert.ok(fs.existsSync(helperPath), `packed Potion helper exists at ${helperPath}`);
        assert.ok(fs.existsSync(modelPath), `workspace Potion model directory exists at ${modelPath}`);

        if (!SUPPORTED_PACKED_LINUX_HOST) {
            t.skip("packed Potion execution requires Linux x64 or Linux ARM64");
            return;
        }

        // Emulate npm publish mode normalization on the installed tarball.
        fs.chmodSync(helperPath, 0o644);

        await runPackedPotionSmoke(packedRuntime.runtimeRoot);

        assert.ok(
            (fs.statSync(helperPath).mode & 0o100) !== 0,
            "owner execute bit is restored after the packed Potion smoke",
        );

        // Negative proof inside the same installed closure: the packed artifact
        // gate must reject a missing helper instead of skipping execution.
        fs.rmSync(helperPath);
        await assert.rejects(
            runPackedPotionSmoke(packedRuntime.runtimeRoot),
            /Packed Potion assets are missing/,
        );
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
        fs.rmSync(smokeExecDir, { recursive: true, force: true });
    }
});
