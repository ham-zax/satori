import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

test("release smoke isolates machine configuration and removes pnpm-only npm variables", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-release-smoke-test-"));
    const fakeBin = path.join(fixtureRoot, "bin");
    const sourceHome = path.join(fixtureRoot, "source-home");
    const capturePath = path.join(fixtureRoot, "npm-env.jsonl");
    const packedMcpRoot = path.join(fixtureRoot, "packed-mcp");
    const potionAssetsRoot = path.join(packedMcpRoot, "assets", "potion", "linux-x64");

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.mkdirSync(path.join(potionAssetsRoot, "model"), { recursive: true });
    fs.writeFileSync(path.join(potionAssetsRoot, "manifest.json"), JSON.stringify({
        model: { identity: "minishlab/potion-code-16M-v2@fixture" },
    }));
    fs.writeFileSync(path.join(potionAssetsRoot, "satori-potion"), "fixture");
    fs.writeFileSync(path.join(potionAssetsRoot, "model", "model.safetensors"), "fixture");
    fs.writeFileSync(path.join(fakeBin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const index = process.argv.indexOf("--pack-destination");
const destination = process.argv[index + 1];
const packageName = path.basename(process.cwd());
fs.writeFileSync(path.join(destination, packageName + "-fixture.tgz"), "fixture");
`);
    fs.writeFileSync(path.join(fakeBin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.RELEASE_SMOKE_CAPTURE, JSON.stringify({
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  npmCache: process.env.npm_config_cache,
  shellEmulator: process.env.npm_config_shell_emulator,
  registry: process.env.npm_config_registry,
  runtimeProfile: process.env.SATORI_RUNTIME_PROFILE,
  vectorStore: process.env.VECTOR_STORE_PROVIDER,
  embeddingProvider: process.env.EMBEDDING_PROVIDER,
  embeddingModel: process.env.EMBEDDING_MODEL,
  embeddingDimension: process.env.EMBEDDING_OUTPUT_DIMENSION,
  potionHelperPath: process.env.POTION_HELPER_PATH,
  potionModelPath: process.env.POTION_MODEL_PATH,
  milvusAddress: process.env.MILVUS_ADDRESS,
}) + "\\n");
if (process.argv.includes("node")) process.stdout.write(process.env.RELEASE_SMOKE_PACKED_MCP_ROOT);
`);
    fs.chmodSync(path.join(fakeBin, "pnpm"), 0o755);
    fs.chmodSync(path.join(fakeBin, "npm"), 0o755);

    try {
        execFileSync(process.execPath, ["--import", "tsx", "scripts/release-smoke.ts"], {
            cwd: PACKAGE_ROOT,
            env: {
                ...process.env,
                HOME: sourceHome,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
                RELEASE_SMOKE_CAPTURE: capturePath,
                RELEASE_SMOKE_PACKED_MCP_ROOT: packedMcpRoot,
                SATORI_RUNTIME_PROFILE: "connected",
                EMBEDDING_PROVIDER: "Ollama",
                MILVUS_ADDRESS: "ambient.example:19530",
                npm_config_shell_emulator: "true",
                npm_config_registry: "https://registry.npmjs.org/",
            },
            stdio: "pipe",
        });

        const captures = fs.readFileSync(capturePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, string | undefined>);
        assert.equal(captures.length, 3);
        for (const capture of captures) {
            assert.notEqual(capture.home, sourceHome);
            assert.match(capture.home || "", /satori-cli-release-home-/);
            assert.equal(capture.xdgConfigHome, path.join(capture.home || "", ".config"));
            assert.equal(capture.npmCache, path.join(capture.home || "", ".npm"));
            assert.equal(capture.shellEmulator, undefined);
            assert.equal(capture.registry, "https://registry.npmjs.org/");
            assert.equal(capture.milvusAddress, undefined);
        }
        assert.equal(captures[0]?.runtimeProfile, undefined);
        assert.equal(captures[0]?.embeddingProvider, undefined);
        assert.equal(captures[1]?.runtimeProfile, undefined);
        assert.equal(captures[1]?.embeddingProvider, undefined);
        assert.equal(captures[2]?.runtimeProfile, "offline");
        assert.equal(captures[2]?.vectorStore, "LanceDB");
        assert.equal(captures[2]?.embeddingProvider, "Potion");
        assert.equal(captures[2]?.embeddingModel, "minishlab/potion-code-16M-v2@fixture");
        assert.equal(captures[2]?.embeddingDimension, "256");
        assert.equal(captures[2]?.potionHelperPath, path.join(potionAssetsRoot, "satori-potion"));
        assert.equal(captures[2]?.potionModelPath, path.join(potionAssetsRoot, "model"));
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
