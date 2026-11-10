import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPackedDoctorReport } from "./release-smoke-report.js";
import { isolatedSmokeEnv } from "./smoke-env.js";

const SUPPORTED_PACKED_LINUX_HOST = process.platform === "linux"
    && (process.arch === "x64" || process.arch === "arm64");
const SIZE_BUDGET_BYTES = 960 * 1024 * 1024;

interface ReleaseSmokeModule {
    runPackedOfflineJourney(options: Record<string, unknown>): Promise<void>;
    cleanupPackedSmokeDirectories(input: {
        smokePackDir: string;
        smokeExecDir: string;
        smokeHomeDir: string;
        bootstrapRoot: string;
        preservationReason?: string;
    }): void;
    assertManagedRuntimeSizeBudget(installRoot: string): void;
    assertPackedLateOnNativeRuntime(packedMcpRoot: string): void;
    assertPackedNativeProjectionRuntime(installRoot: string): Promise<void>;
    packedPotionSmokeEnv(
        baseEnv: NodeJS.ProcessEnv,
        packedMcpRoot: string,
        smokeHomeDir: string,
    ): NodeJS.ProcessEnv;
    assertPackedPotionExecutionCapability(installRoot: string, packedMcpRoot: string): Promise<void>;
}

/*
 * The release smoke script sits outside this package's `rootDir`, so it is
 * loaded at runtime instead of being compiled into the package program.
 */
const releaseSmokeModuleUrl = new URL("../scripts/release-smoke.ts", import.meta.url).href;
const releaseSmokeModule = import(releaseSmokeModuleUrl) as Promise<ReleaseSmokeModule>;

function temporaryRoot(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `satori-cli-${label}-`));
}

test("packed smoke preserves runtime evidence when termination is uncertain", async () => {
    const releaseSmoke = await releaseSmokeModule;
    for (const failure of ["partial", "unverified", "threw"] as const) {
        const root = temporaryRoot(`uncertain-${failure}`);
        const directories = {
            smokePackDir: path.join(root, "pack"),
            smokeExecDir: path.join(root, "runtime"),
            smokeHomeDir: path.join(root, "homes"),
            bootstrapRoot: path.join(root, "bootstrap"),
        };
        try {
            for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
            const modeHome = path.join(directories.smokeHomeDir, "offline-lateon");
            const stateRoot = path.join(modeHome, "satori-state");
            fs.mkdirSync(stateRoot, { recursive: true });
            const ownerRecord = path.join(stateRoot, "owner.json");
            const runtimeEvidence = path.join(directories.smokeExecDir, "evidence.txt");
            fs.writeFileSync(ownerRecord, "test-owned runtime record");
            fs.writeFileSync(runtimeEvidence, "test-owned packed closure");
            let preservationReason: string | undefined;

            await assert.rejects(releaseSmoke.runPackedOfflineJourney({
                modeHome,
                fixtureRepo: path.join(root, "fixture"),
                baseEnv: {},
                packageSpecifier: "@satori-code/mcp@0.0.0",
                runtimeCommand: { command: process.execPath, args: [path.join(root, "index.js")] },
                potionAssetsRoot: path.join(root, "assets"),
                reranker: undefined,
                expectedProvider: "lateon",
                packedInstall: { executeInstallCommand: async () => { throw new Error("injected setup failure"); } },
                packedInstallApplication: { exactRuntimePreflightDependencies: () => ({}) },
                packedClient: {},
                packedTerminate: {
                    terminateSatoriServers: async () => {
                        if (failure === "threw") throw new Error("injected termination failure");
                        return {
                            status: failure === "partial" ? "partial" : "terminated",
                            unverifiedRecordCount: failure === "unverified" ? 1 : 0,
                        };
                    },
                },
                onCleanupUncertain: (reason: string) => { preservationReason = reason; },
            }), /termination/);

            releaseSmoke.cleanupPackedSmokeDirectories({ ...directories, preservationReason });
            assert.equal(fs.existsSync(ownerRecord), true, `${failure}: keep runtime ownership evidence`);
            assert.equal(fs.existsSync(runtimeEvidence), true, `${failure}: keep the packed runtime`);
            assert.equal(fs.existsSync(directories.smokePackDir), false);
            assert.equal(fs.existsSync(directories.bootstrapRoot), false);
            assert.ok(preservationReason?.includes(modeHome));
            assert.ok(preservationReason?.includes(stateRoot));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test("release smoke isolates machine configuration and removes pnpm-only npm variables", () => {
    const smokeHome = "/tmp/satori-release-smoke-home";
    const isolated = isolatedSmokeEnv(smokeHome, {
        HOME: "/home/source",
        PATH: "/usr/bin",
        SATORI_RUNTIME_PROFILE: "connected",
        EMBEDDING_PROVIDER: "VoyageAI",
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

test("packed Potion artifacts fail explicitly when the host helper is missing", {
    skip: !SUPPORTED_PACKED_LINUX_HOST,
}, async () => {
    const root = temporaryRoot("potion-missing-helper");
    try {
        const packedMcpRoot = path.join(root, "mcp");
        fs.mkdirSync(packedMcpRoot, { recursive: true });

        const releaseSmoke = await releaseSmokeModule;
        assert.throws(
            () => releaseSmoke.packedPotionSmokeEnv({}, packedMcpRoot, root),
            /Packed Potion artifact is missing/,
        );
        // The capability gate validates the packed helper before it loads Core,
        // so a missing helper never reaches a native binary.
        await assert.rejects(
            releaseSmoke.assertPackedPotionExecutionCapability(path.join(root, "install"), packedMcpRoot),
            /Packed Potion artifact is missing/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("packed LateOn native closure rejects a missing packed runtime", {
    skip: !SUPPORTED_PACKED_LINUX_HOST,
}, async () => {
    const root = temporaryRoot("lateon-missing-runtime");
    try {
        const releaseSmoke = await releaseSmokeModule;
        assert.throws(
            () => releaseSmoke.assertPackedLateOnNativeRuntime(path.join(root, "missing-mcp")),
            /Cannot find module|native closure/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("packed managed runtime size budget rejects an oversized closure", {
    skip: !SUPPORTED_PACKED_LINUX_HOST,
}, async () => {
    const root = temporaryRoot("size-budget");
    try {
        // A sparse file keeps the check allocation-free.
        const oversized = path.join(root, "oversized.bin");
        const handle = fs.openSync(oversized, "w");
        try {
            fs.ftruncateSync(handle, SIZE_BUDGET_BYTES + 1);
        } finally {
            fs.closeSync(handle);
        }

        const releaseSmoke = await releaseSmokeModule;
        assert.throws(
            () => releaseSmoke.assertManagedRuntimeSizeBudget(root),
            new RegExp(`budget is ${SIZE_BUDGET_BYTES} bytes`),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("packed native projection proof rejects an install root without the packed Core", {
    skip: !SUPPORTED_PACKED_LINUX_HOST,
}, async () => {
    const root = temporaryRoot("missing-packed-core");
    try {
        const releaseSmoke = await releaseSmokeModule;
        await assert.rejects(
            releaseSmoke.assertPackedNativeProjectionRuntime(root),
            /Packed Core projection module is missing/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
