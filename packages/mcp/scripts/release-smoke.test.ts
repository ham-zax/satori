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

        if (process.platform !== "linux" || process.arch !== "x64") {
            t.skip("packed Potion execution requires Linux x64");
            return;
        }

        // Emulate npm publish mode normalization on the installed tarball.
        fs.chmodSync(helperPath, 0o644);

        await runPackedPotionSmoke(packedRuntime.runtimeRoot);

        assert.ok(
            (fs.statSync(helperPath).mode & 0o100) !== 0,
            "owner execute bit is restored after the packed Potion smoke",
        );
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
        fs.rmSync(smokeExecDir, { recursive: true, force: true });
    }
});
