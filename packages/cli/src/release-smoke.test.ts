import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { isolatedSmokeEnv } from "../scripts/release-smoke.js";

test("release smoke isolates machine configuration and removes pnpm-only npm variables", () => {
    const smokeHome = "/tmp/satori-release-smoke-home";
    const isolated = isolatedSmokeEnv(smokeHome, {
        HOME: "/home/source",
        PATH: "/usr/bin",
        SATORI_RUNTIME_PROFILE: "connected",
        EMBEDDING_PROVIDER: "Ollama",
        MILVUS_ADDRESS: "ambient.example:19530",
        npm_config_shell_emulator: "true",
        npm_config_registry: "https://registry.npmjs.org/",
    });

    assert.equal(isolated.HOME, smokeHome);
    assert.equal(isolated.USERPROFILE, smokeHome);
    assert.equal(isolated.XDG_CONFIG_HOME, path.join(smokeHome, ".config"));
    assert.equal(isolated.npm_config_cache, path.join(smokeHome, ".npm"));
    assert.equal(isolated.npm_config_package_lock, "false");
    assert.equal(isolated.npm_config_shell_emulator, undefined);
    assert.equal(isolated.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(isolated.SATORI_RUNTIME_PROFILE, undefined);
    assert.equal(isolated.EMBEDDING_PROVIDER, undefined);
    assert.equal(isolated.MILVUS_ADDRESS, undefined);
});
