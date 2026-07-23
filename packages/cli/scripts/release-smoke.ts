import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

interface PackageManifest {
    name?: unknown;
    version?: unknown;
    dependencies?: Record<string, unknown>;
    bin?: Record<string, unknown>;
    main?: unknown;
}

function npmOutput(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const stdout = "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    const stderr = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    return `${stdout}\n${stderr}\n${error.message}`.trim();
}

function packPackage(packageRoot: string, smokePackDir: string): string {
    const beforeFiles = new Set(fs.readdirSync(smokePackDir));
    execFileSync("pnpm", ["pack", "--pack-destination", smokePackDir], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const tarballName = fs.readdirSync(smokePackDir).find((entry) => entry.endsWith(".tgz") && !beforeFiles.has(entry));
    if (!tarballName) {
        throw new Error(`pnpm pack did not produce a tarball for ${packageRoot}.`);
    }
    return path.join(smokePackDir, tarballName);
}

const PNPM_ONLY_NPM_ENV_KEYS = new Set([
    "NPM_CONFIG__JSR_REGISTRY",
    "NPM_CONFIG_AUTO_INSTALL_PEERS",
    "NPM_CONFIG_CACHE_DIR",
    "NPM_CONFIG_CHILD_CONCURRENCY",
    "NPM_CONFIG_DEDUPE_PEER_DEPENDENTS",
    "NPM_CONFIG_DIR",
    "NPM_CONFIG_IGNORE_WORKSPACE_ROOT_CHECK",
    "NPM_CONFIG_NPM_GLOBALCONFIG",
    "NPM_CONFIG_PREFER_FROZEN_LOCKFILE",
    "NPM_CONFIG_SHELL_EMULATOR",
    "NPM_CONFIG_STORE_DIR",
    "NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN",
]);

function isSatoriRuntimeEnvKey(key: string): boolean {
    return /^(?:SATORI_|EMBEDDING_|OPENAI_|VOYAGEAI_|GEMINI_|OLLAMA_|POTION_|MILVUS_)/.test(key)
        || key === "VECTOR_STORE_PROVIDER"
        || key === "LANCEDB_PATH";
}

export function isolatedSmokeEnv(
    smokeHomeDir: string,
    sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(sourceEnv).filter(
        ([key]) => !PNPM_ONLY_NPM_ENV_KEYS.has(key.toUpperCase()) && !isSatoriRuntimeEnvKey(key),
    ));
    return {
        ...env,
        HOME: smokeHomeDir,
        USERPROFILE: smokeHomeDir,
        XDG_CONFIG_HOME: path.join(smokeHomeDir, ".config"),
        npm_config_package_lock: "false",
    };
}

function readManifest(packageJsonPath: string): PackageManifest {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageManifest;
}

function requireStableVersion(value: unknown, label: string): string {
    if (typeof value !== "string" || !STABLE_VERSION_PATTERN.test(value)) {
        throw new Error(`${label} must be an exact stable version; received ${JSON.stringify(value)}.`);
    }
    return value;
}

function requireDependency(
    manifest: PackageManifest,
    dependencyName: string,
    expectedVersion: string,
    ownerLabel: string,
): void {
    const actualVersion = manifest.dependencies?.[dependencyName];
    if (actualVersion !== expectedVersion) {
        throw new Error(
            `${ownerLabel} must depend on ${dependencyName}@${expectedVersion}; received ${JSON.stringify(actualVersion)}.`,
        );
    }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
    const relative = path.relative(fs.realpathSync(rootPath), fs.realpathSync(candidatePath));
    return relative.length > 0
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function installAndVerifyPackedReleaseClosure(
    sourceRoots: {
        cli: string;
        mcp: string;
        core: string;
    },
    tarballs: {
        cli: string;
        mcp: string;
        core: string;
    },
    installRoot: string,
    env: NodeJS.ProcessEnv,
): {
    cliEntry: string;
    packedMcpRoot: string;
} {
    execFileSync("npm", [
        "install",
        "--prefix",
        installRoot,
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        "--",
        tarballs.core,
        tarballs.mcp,
        tarballs.cli,
    ], {
        cwd: installRoot,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const sourceCli = readManifest(path.join(sourceRoots.cli, "package.json"));
    const sourceMcp = readManifest(path.join(sourceRoots.mcp, "package.json"));
    const sourceCore = readManifest(path.join(sourceRoots.core, "package.json"));
    const cliVersion = requireStableVersion(sourceCli.version, "Source CLI version");
    const mcpVersion = requireStableVersion(sourceMcp.version, "Source MCP version");
    const coreVersion = requireStableVersion(sourceCore.version, "Source Core version");
    if (
        sourceCli.dependencies?.["@zokizuan/satori-mcp"] !== "workspace:*"
        || sourceCli.dependencies?.["@zokizuan/satori-core"] !== "workspace:*"
        || sourceMcp.dependencies?.["@zokizuan/satori-core"] !== "workspace:*"
    ) {
        throw new Error("Source Satori package closure must use the existing workspace:* authority.");
    }

    const nodeModulesRoot = path.join(installRoot, "node_modules");
    const cliRoot = path.join(nodeModulesRoot, "@zokizuan", "satori-cli");
    const mcpRoot = path.join(nodeModulesRoot, "@zokizuan", "satori-mcp");
    const coreRoot = path.join(nodeModulesRoot, "@zokizuan", "satori-core");
    const packedCli = readManifest(path.join(cliRoot, "package.json"));
    const packedMcp = readManifest(path.join(mcpRoot, "package.json"));
    const packedCore = readManifest(path.join(coreRoot, "package.json"));

    if (
        packedCli.name !== "@zokizuan/satori-cli"
        || requireStableVersion(packedCli.version, "Packed CLI version") !== cliVersion
        || packedMcp.name !== "@zokizuan/satori-mcp"
        || requireStableVersion(packedMcp.version, "Packed MCP version") !== mcpVersion
        || packedCore.name !== "@zokizuan/satori-core"
        || requireStableVersion(packedCore.version, "Packed Core version") !== coreVersion
    ) {
        throw new Error("Packed Satori package identities do not match their source manifests.");
    }
    requireDependency(packedCli, "@zokizuan/satori-mcp", mcpVersion, "Packed CLI");
    requireDependency(packedCli, "@zokizuan/satori-core", coreVersion, "Packed CLI");
    requireDependency(packedMcp, "@zokizuan/satori-core", coreVersion, "Packed MCP");

    const cliEntryRelative = packedCli.bin?.satori;
    if (
        typeof cliEntryRelative !== "string"
        || packedCli.bin?.["satori-cli"] !== cliEntryRelative
    ) {
        throw new Error("Packed CLI must expose matching 'satori' and 'satori-cli' binaries.");
    }
    const cliEntry = path.resolve(cliRoot, cliEntryRelative);
    const mcpEntry = path.resolve(
        mcpRoot,
        typeof packedMcp.main === "string" ? packedMcp.main : "dist/index.js",
    );
    if (!fs.existsSync(cliEntry) || !fs.existsSync(mcpEntry)) {
        throw new Error("Packed Satori CLI or MCP entry is missing.");
    }

    const resolvedCorePackageJson = createRequire(mcpEntry)
        .resolve("@zokizuan/satori-core/package.json");
    if (!isPathWithin(installRoot, resolvedCorePackageJson)) {
        throw new Error("Packed MCP resolved Core outside the installed release closure.");
    }
    const resolvedCore = readManifest(resolvedCorePackageJson);
    if (
        resolvedCore.name !== "@zokizuan/satori-core"
        || resolvedCore.version !== coreVersion
    ) {
        throw new Error("Packed MCP did not resolve the expected packed Core version.");
    }

    return {
        cliEntry,
        packedMcpRoot: mcpRoot,
    };
}

function runCliSmoke(
    commandArgs: string[],
    cliEntry: string,
    smokeExecDir: string,
    env: NodeJS.ProcessEnv,
): string {
    return execFileSync(process.execPath, [
        cliEntry,
        ...commandArgs,
    ], {
        cwd: smokeExecDir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/*
 * The packed closure is installed once above. Avoid separate npm exec
 * environments, which can hide dependency or binary collisions.
 */
function assertPackedCliHelp(output: string): void {
    const help = JSON.parse(output) as { usage?: unknown };
    if (help.usage !== "satori <command>") {
        throw new Error("Packed CLI did not expose structured command help.");
    }
}

function packedPotionSmokeEnv(
    baseEnv: NodeJS.ProcessEnv,
    packedMcpRoot: string,
    smokeHomeDir: string,
): NodeJS.ProcessEnv {
    const assetsRoot = path.join(packedMcpRoot, "assets", "potion", "linux-x64");
    const manifestPath = path.join(assetsRoot, "manifest.json");
    const helperPath = path.join(assetsRoot, "satori-potion");
    const modelPath = path.join(assetsRoot, "model");
    for (const requiredPath of [manifestPath, helperPath, path.join(modelPath, "model.safetensors")]) {
        if (!fs.existsSync(requiredPath)) {
            throw new Error(`Packed Potion artifact is missing: ${requiredPath}.`);
        }
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        model?: { identity?: unknown };
    };
    if (typeof manifest.model?.identity !== "string" || manifest.model.identity.length === 0) {
        throw new Error("Packed Potion manifest has no model identity.");
    }
    return {
        ...baseEnv,
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: path.join(smokeHomeDir, ".satori", "vector", "lancedb"),
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: manifest.model.identity,
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: helperPath,
        POTION_MODEL_PATH: modelPath,
        POTION_REQUEST_TIMEOUT_MS: "5000",
    };
}

function main(): void {
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(currentFile), "..");
    const corePackageRoot = path.resolve(packageRoot, "..", "core");
    const mcpPackageRoot = path.resolve(packageRoot, "..", "mcp");
    const smokePackDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-release-smoke-"));
    const smokeExecDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-release-exec-"));
    const smokeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-release-home-"));

    try {
        const coreTarballPath = packPackage(corePackageRoot, smokePackDir);
        const mcpTarballPath = packPackage(mcpPackageRoot, smokePackDir);
        const cliTarballPath = packPackage(packageRoot, smokePackDir);
        const baseEnv = isolatedSmokeEnv(smokeHomeDir);
        const packed = installAndVerifyPackedReleaseClosure(
            {
                cli: packageRoot,
                mcp: mcpPackageRoot,
                core: corePackageRoot,
            },
            {
                cli: cliTarballPath,
                mcp: mcpTarballPath,
                core: coreTarballPath,
            },
            smokeExecDir,
            baseEnv,
        );
        assertPackedCliHelp(runCliSmoke(["--format", "json", "--help"], packed.cliEntry, smokeExecDir, baseEnv));
        const doctorEnv = packedPotionSmokeEnv(baseEnv, packed.packedMcpRoot, smokeHomeDir);
        runCliSmoke(["doctor"], packed.cliEntry, smokeExecDir, doctorEnv);
        console.log("[release:smoke] Packed CLI→MCP→Core closure and offline Potion runtime passed.");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = error instanceof Error ? npmOutput(error) : "";
        console.error(`[release:smoke] ${message}${detail ? ` ${detail}` : ""}`);
        process.exit(1);
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
        fs.rmSync(smokeExecDir, { recursive: true, force: true });
        fs.rmSync(smokeHomeDir, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
