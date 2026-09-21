/// <reference types="node" />

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    resolveLanceDbNativePackage,
    resolveLateOnNativePackages,
    resolveOxcParserNativePackage,
} from "../src/managed-runtime-closure.js";
import {
    DEFAULT_LATEON_PROFILE_ID,
    readLateOnAcquisitionAuthority,
} from "../src/lateon-model-store.js";
import { assertReleaseWorkspaceLinks } from "../../../scripts/release-workspace.mjs";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Optional native packages remain omitted; required host-native LanceDB,
// oxc-parser, and LateOn/Sharp packages are installed explicitly and measured
// by the gate below.
const MAX_LINUX_X64_MANAGED_RUNTIME_BYTES = 700 * 1024 * 1024;

interface PackageManifest {
    name?: unknown;
    version?: unknown;
    dependencies?: Record<string, unknown>;
    satoriManagedRuntime?: {
        mcp?: unknown;
        core?: unknown;
    };
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

import { isolatedSmokeEnv } from "../src/smoke-env.js";

export { isolatedSmokeEnv };

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
    packedCliRoot: string;
    packedMcpRoot: string;
} {
    const sourceCli = readManifest(path.join(sourceRoots.cli, "package.json"));
    const sourceMcp = readManifest(path.join(sourceRoots.mcp, "package.json"));
    const sourceCore = readManifest(path.join(sourceRoots.core, "package.json"));
    const runtimeClosure = {
        vectorStore: "LanceDB" as const,
        lateOn: process.platform === "linux" && process.arch === "x64",
    };
    const lanceDbNativePackage = resolveLanceDbNativePackage(runtimeClosure);
    const lateOnNativePackages = resolveLateOnNativePackages(runtimeClosure);
    execFileSync("npm", [
        "install",
        "--prefix",
        installRoot,
        "--omit=dev",
        "--omit=optional",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        "--",
        tarballs.core,
        tarballs.mcp,
        tarballs.cli,
        lanceDbNativePackage,
        resolveOxcParserNativePackage(runtimeClosure),
        ...lateOnNativePackages,
    ], {
        cwd: installRoot,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const cliVersion = requireStableVersion(sourceCli.version, "Source CLI version");
    const mcpVersion = requireStableVersion(sourceMcp.version, "Source MCP version");
    const coreVersion = requireStableVersion(sourceCore.version, "Source Core version");
    if (
        sourceCli.dependencies?.["@zokizuan/satori-mcp"] !== undefined
        || sourceCli.dependencies?.["@zokizuan/satori-core"] !== undefined
        || sourceCli.satoriManagedRuntime?.mcp !== mcpVersion
        || sourceCli.satoriManagedRuntime?.core !== coreVersion
        || sourceMcp.dependencies?.["@zokizuan/satori-core"] !== "workspace:*"
    ) {
        throw new Error("Source Satori package closure must keep the CLI bootstrap separate and pin the managed runtime explicitly.");
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
    if (
        packedCli.dependencies?.["@zokizuan/satori-mcp"] !== undefined
        || packedCli.dependencies?.["@zokizuan/satori-core"] !== undefined
        || packedCli.satoriManagedRuntime?.mcp !== mcpVersion
        || packedCli.satoriManagedRuntime?.core !== coreVersion
    ) {
        throw new Error("Packed CLI must remain a lightweight bootstrap with exact satoriManagedRuntime targets.");
    }
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

    const requireFromMcp = createRequire(mcpEntry);
    const resolvedOxcPackageJson = requireFromMcp.resolve("oxc-parser/package.json");
    const oxcNativeSpecifier = resolveOxcParserNativePackage({ vectorStore: "LanceDB" });
    const oxcNativePackageName = oxcNativeSpecifier.slice(0, oxcNativeSpecifier.lastIndexOf("@"));
    const resolvedOxcBinding = requireFromMcp.resolve(oxcNativePackageName);
    if (!isPathWithin(installRoot, resolvedOxcPackageJson)) {
        throw new Error("Packed MCP resolved oxc-parser outside the installed release closure.");
    }
    if (!isPathWithin(installRoot, resolvedOxcBinding)) {
        throw new Error("Packed MCP resolved the oxc-parser native binding outside the installed release closure.");
    }
    const { parseSync } = requireFromMcp("oxc-parser") as {
        parseSync?: (
            filePath: string,
            sourceText: string,
            options: { lang: string; sourceType: string },
        ) => { program?: unknown; errors?: Array<{ severity?: string }> };
    };
    const parsed = parseSync?.("probe.ts", "export const value: number = 1;", {
        lang: "ts",
        sourceType: "module",
    });
    if (!parsed?.program || parsed.errors?.some((error) => error.severity === "Error")) {
        throw new Error("Packed oxc-parser did not parse the TypeScript probe source.");
    }

    return {
        cliEntry,
        packedCliRoot: cliRoot,
        packedMcpRoot: mcpRoot,
    };
}

function assertPackedBootstrapCli(
    cliTarballPath: string,
    bootstrapRoot: string,
    env: NodeJS.ProcessEnv,
): void {
    const bootstrapEnv = { ...env };
    delete bootstrapEnv.ONNXRUNTIME_NODE_INSTALL_CUDA;
    delete bootstrapEnv.npm_config_onnxruntime_node_install_cuda;
    execFileSync("npm", [
        "install",
        "--prefix",
        bootstrapRoot,
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--",
        cliTarballPath,
    ], {
        encoding: "utf8",
        env: bootstrapEnv,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const nodeModulesRoot = path.join(bootstrapRoot, "node_modules");
    for (const forbiddenPath of [
        path.join(nodeModulesRoot, "@zokizuan", "satori-core"),
        path.join(nodeModulesRoot, "@zokizuan", "satori-mcp"),
        path.join(nodeModulesRoot, "onnxruntime-node"),
        path.join(nodeModulesRoot, "@huggingface", "transformers"),
    ]) {
        if (fs.existsSync(forbiddenPath)) {
            throw new Error(`Packed bootstrap CLI must not install managed-runtime dependency '${forbiddenPath}'.`);
        }
    }

    const cliEntry = path.join(nodeModulesRoot, "@zokizuan", "satori-cli", "dist", "index.js");
    assertPackedCliHelp(runCliSmoke(["--format", "json", "--help"], cliEntry, bootstrapRoot, bootstrapEnv));
}

function directorySize(filePath: string): number {
    const stat = fs.lstatSync(filePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return stat.size;
    }
    return fs.readdirSync(filePath)
        .map((entry) => directorySize(path.join(filePath, entry)))
        .reduce((total, size) => total + size, 0);
}

function assertManagedRuntimeSizeBudget(installRoot: string): void {
    if (process.platform !== "linux" || process.arch !== "x64") {
        return;
    }
    const installedBytes = directorySize(installRoot);
    console.log(`[release:smoke] Packed managed runtime is ${installedBytes} bytes; budget is ${MAX_LINUX_X64_MANAGED_RUNTIME_BYTES} bytes.`);
    if (installedBytes > MAX_LINUX_X64_MANAGED_RUNTIME_BYTES) {
        throw new Error(
            `Packed Linux x64 managed runtime is ${installedBytes} bytes; `
            + `budget is ${MAX_LINUX_X64_MANAGED_RUNTIME_BYTES} bytes.`,
        );
    }
}

function listFilesRecursive(directory: string): string[] {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    return entries.flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory()
            ? listFilesRecursive(entryPath)
            : [entryPath];
    });
}

function assertPackedLateOnAcquisitionAuthority(packedMcpRoot: string, packedCliRoot: string): void {
    const assetsRoot = path.join(packedMcpRoot, "assets", "lateon");
    const shippedFiles = fs.existsSync(assetsRoot)
        ? fs.readdirSync(assetsRoot).sort()
        : [];
    for (const requiredFile of [
        "runtime-profile-v5-d32.json",
        "runtime-profile-v5-d32.acquisition.json",
    ]) {
        if (!shippedFiles.includes(requiredFile)) {
            throw new Error(
                `Packed LateOn assets must ship '${requiredFile}'; received ${JSON.stringify(shippedFiles)}.`,
            );
        }
    }
    const authority = readLateOnAcquisitionAuthority(packedMcpRoot);
    if (authority.profileId !== DEFAULT_LATEON_PROFILE_ID) {
        throw new Error(
            `Packed LateOn acquisition authority must be ${DEFAULT_LATEON_PROFILE_ID}; received ${authority.profileId}.`,
        );
    }
    for (const artifact of authority.artifacts) {
        const artifactPath = path.join(assetsRoot, artifact.path);
        if (fs.existsSync(artifactPath)) {
            throw new Error(`Packed MCP must not ship LateOn weights; found '${artifact.path}'.`);
        }
    }
    for (const packedRoot of [packedMcpRoot, packedCliRoot]) {
        const onnxArtifacts = listFilesRecursive(packedRoot)
            .filter((entry) => entry.toLowerCase().endsWith(".onnx"));
        if (onnxArtifacts.length > 0) {
            throw new Error(
                `Packed release closure must not ship ONNX weights: ${onnxArtifacts.join(", ")}.`,
            );
        }
    }
}

function assertPackedLateOnNativeRuntime(packedMcpRoot: string): void {
    if (process.platform !== "linux" || process.arch !== "x64") {
        return;
    }
    const requireFromMcp = createRequire(path.join(packedMcpRoot, "package.json"));
    const transformersEntry = requireFromMcp.resolve("@huggingface/transformers");
    const requireFromTransformers = createRequire(transformersEntry);
    try {
        requireFromTransformers("sharp");
    } catch (error) {
        throw new Error(
            `Packed LateOn runtime cannot load Sharp's Linux x64 native closure: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function assertPackedCliLateOnAcquisition(packedCliRoot: string): void {
    const storePath = path.join(packedCliRoot, "dist", "lateon-model-store.js");
    const installPath = path.join(packedCliRoot, "dist", "install.js");
    if (!fs.existsSync(storePath) || !fs.existsSync(installPath)) {
        throw new Error("Packed CLI must ship the LateOn acquisition module.");
    }
    const storeSource = fs.readFileSync(storePath, "utf8");
    const policyMissing = !storeSource.includes("lateon_context_v5_d32_owner_default_v1");
    const frozenDigestMissing = !storeSource.includes("04958f55784968a2a45c1499adc2fcb706dcd23e9813c8e8da7e3f31f43777f6");
    const installSource = fs.readFileSync(installPath, "utf8");
    const resolutionMissing = !installSource.includes("resolveVerifiedLateOnModel");
    if (policyMissing || frozenDigestMissing || resolutionMissing) {
        throw new Error(
            "Packed CLI acquisition flow must carry the frozen D32 identity "
            + `(policy=${!policyMissing}, frozenDigest=${!frozenDigestMissing}, resolver=${!resolutionMissing}).`,
        );
    }
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
    const helperPath = path.join(assetsRoot, "satori-potion");
    const modelPath = path.join(assetsRoot, "model");
    for (const requiredPath of [
        helperPath,
        path.join(modelPath, "model.safetensors"),
        path.join(modelPath, "config.json"),
        path.join(modelPath, "tokenizer.json"),
        path.join(assetsRoot, "MODEL_CARD.md"),
        path.join(assetsRoot, "MODEL2VEC_RS_LICENSE"),
    ]) {
        if (!fs.existsSync(requiredPath)) {
            throw new Error(`Packed Potion artifact is missing: ${requiredPath}.`);
        }
    }
    return {
        ...baseEnv,
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: path.join(smokeHomeDir, ".satori", "vector", "lancedb"),
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: helperPath,
        POTION_MODEL_PATH: modelPath,
        POTION_REQUEST_TIMEOUT_MS: "5000",
    };
}

async function assertPackedPotionExecutionCapability(installRoot: string, packedMcpRoot: string): Promise<void> {
    if (process.platform !== "linux" || process.arch !== "x64") {
        return;
    }
    const assetsRoot = path.join(packedMcpRoot, "assets", "potion", "linux-x64");
    const helperPath = path.join(assetsRoot, "satori-potion");
    const modelPath = path.join(assetsRoot, "model");

    const coreEntry = path.join(installRoot, "node_modules", "@zokizuan", "satori-core", "dist", "index.js");
    if (!fs.existsSync(coreEntry)) {
        throw new Error(`Packed Core entry is missing under ${installRoot}.`);
    }

    const core = await import(pathToFileURL(coreEntry).href) as {
        PotionEmbedding: {
            create(config: Readonly<{ helperPath: string; modelPath: string }>): Promise<{
                embedDocuments(texts: string[]): Promise<Array<{ vector: number[]; dimension: number }>>;
                close(): Promise<void>;
            }>;
        };
        restoreVerifiedOwnerExecutableBit(input: {
            filePath: string;
            expectedSha256: string;
            label: string;
        }): Promise<void>;
    };

    // Packaging strips the owner execute bit; the install-side repair is the
    // single integrity owner, performed here against the packed closure before
    // runtime validation executes the helper.
    const packedManifest = JSON.parse(fs.readFileSync(path.join(assetsRoot, "manifest.json"), "utf8")) as {
        files?: Array<{ path?: string; sha256?: string }>;
    };
    const packedHelper = packedManifest.files?.find((artifact) => artifact.path === "satori-potion");
    if (!packedHelper?.sha256) {
        throw new Error("Packed Potion manifest does not declare the helper artifact.");
    }
    await core.restoreVerifiedOwnerExecutableBit({
        filePath: helperPath,
        expectedSha256: packedHelper.sha256,
        label: "helper",
    });
    const embedding = await core.PotionEmbedding.create({ helperPath, modelPath });
    try {
        const [result] = await embedding.embedDocuments([
            "satori packed release capability smoke test document",
        ]);
        if (
            !result
            || result.dimension !== 256
            || !Array.isArray(result.vector)
            || result.vector.length !== 256
            || !result.vector.every((value) => Number.isFinite(value))
        ) {
            throw new Error("Packed Potion smoke did not return a finite 256-dimensional embedding.");
        }
        const norm = Math.sqrt(result.vector.reduce((sum: number, v: number) => sum + v * v, 0));
        if (Math.abs(norm - 1.0) > 1e-4) {
            throw new Error(`Packed Potion smoke vector norm ${norm} is not normalized.`);
        }
    } finally {
        await embedding.close();
    }
}

async function main(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(currentFile), "..");
    const repoRoot = path.resolve(packageRoot, "../..");
    assertReleaseWorkspaceLinks(repoRoot);
    const corePackageRoot = path.resolve(packageRoot, "..", "core");
    const mcpPackageRoot = path.resolve(packageRoot, "..", "mcp");
    const smokePackDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-release-smoke-"));
    const smokeExecDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-release-exec-"));
    const smokeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-release-home-"));
    const bootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-bootstrap-smoke-"));

    try {
        const coreTarballPath = packPackage(corePackageRoot, smokePackDir);
        const mcpTarballPath = packPackage(mcpPackageRoot, smokePackDir);
        const cliTarballPath = packPackage(packageRoot, smokePackDir);
        const baseEnv = isolatedSmokeEnv(smokeHomeDir);
        assertPackedBootstrapCli(cliTarballPath, bootstrapRoot, baseEnv);
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
        assertManagedRuntimeSizeBudget(smokeExecDir);
        assertPackedLateOnAcquisitionAuthority(packed.packedMcpRoot, packed.packedCliRoot);
        assertPackedLateOnNativeRuntime(packed.packedMcpRoot);
        assertPackedCliLateOnAcquisition(packed.packedCliRoot);
        assertPackedCliHelp(runCliSmoke(["--format", "json", "--help"], packed.cliEntry, smokeExecDir, baseEnv));
        await assertPackedPotionExecutionCapability(smokeExecDir, packed.packedMcpRoot);
        const doctorEnv = packedPotionSmokeEnv(baseEnv, packed.packedMcpRoot, smokeHomeDir);
        runCliSmoke(["doctor"], packed.cliEntry, smokeExecDir, doctorEnv);
        console.log("[release:smoke] Lightweight bootstrap CLI, packed MCP/Core closure, offline Potion runtime, LateOn native runtime, and D32 acquisition authority passed.");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = error instanceof Error ? npmOutput(error) : "";
        console.error(`[release:smoke] ${message}${detail ? ` ${detail}` : ""}`);
        process.exitCode = 1;
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
        fs.rmSync(smokeExecDir, { recursive: true, force: true });
        fs.rmSync(smokeHomeDir, { recursive: true, force: true });
        fs.rmSync(bootstrapRoot, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[release:smoke] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
