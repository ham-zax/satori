import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertPackedDoctorReport } from "./release-smoke-report.js";
import { isolatedSmokeEnv } from "./smoke-env.js";

test("release smoke isolates machine configuration and removes pnpm-only npm variables", () => {
    const smokeHome = "/tmp/satori-release-smoke-home";
    const isolated = isolatedSmokeEnv(smokeHome, {
        HOME: "/home/source",
        PATH: "/usr/bin",
        SATORI_RUNTIME_PROFILE: "connected",
        EMBEDDING_PROVIDER: "Ollama",
        MILVUS_ADDRESS: "ambient.example:19530",
        npm_config_shell_emulator: "true",
        npm_config_cache: "/home/source/.npm",
        npm_config_cache_dir: "/home/source/.pnpm-cache",
        npm_config_registry: "https://registry.npmjs.org/",
    });

    assert.equal(isolated.HOME, smokeHome);
    assert.equal(isolated.USERPROFILE, smokeHome);
    assert.equal(isolated.XDG_CONFIG_HOME, path.join(smokeHome, ".config"));
    assert.equal(isolated.npm_config_cache, "/home/source/.npm");
    assert.equal(isolated.npm_config_cache_dir, undefined);
    assert.equal(isolated.npm_config_package_lock, "false");
    assert.equal(isolated.npm_config_shell_emulator, undefined);
    assert.equal(isolated.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(isolated.SATORI_RUNTIME_PROFILE, undefined);
    assert.equal(isolated.EMBEDDING_PROVIDER, undefined);
    assert.equal(isolated.MILVUS_ADDRESS, undefined);
});

test("release smoke accepts an npm access warning before the MCP version is published", () => {
    const missingClient = { name: "managed_client_configuration", status: "error" };
    const npmWarning = { name: "npm_package_access", status: "warning" };

    assert.doesNotThrow(() => assertPackedDoctorReport({ status: "error", checks: [missingClient] }));
    assert.doesNotThrow(() => assertPackedDoctorReport({ status: "error", checks: [npmWarning, missingClient] }));
    assert.throws(() => assertPackedDoctorReport({ status: "error", checks: [npmWarning] }), /unexpected problems/);
    assert.throws(() => assertPackedDoctorReport({
        status: "error",
        checks: [missingClient, { name: "node_version", status: "error" }],
    }), /unexpected problems/);
});
