/// <reference types="node" />

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
    resolveLanceDbNativePackage,
    resolveLateOnNativePackages,
    resolveOxcParserNativePackage,
    resolveTypeScriptNativePackage,
} from "../src/managed-runtime-closure.js";
import { pruneManagedRuntimeDeadWeight } from "../src/managed-runtime-prune.js";
import { resolvePotionAssetsRoot } from "../src/managed-runtime-paths.js";
import {
    DEFAULT_LATEON_PROFILE_ID,
    readLateOnAcquisitionAuthority,
} from "../src/lateon-model-store.js";
import { assertPackedDoctorReport } from "../src/release-smoke-report.js";
import { probeLanceDbRuntime } from "../src/install-preflight.js";
import { assertReleaseWorkspaceLinks } from "../../../scripts/release-workspace.mjs";

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Optional native packages remain omitted; required host-native LanceDB,
// oxc-parser, TypeScript, and LateOn/Sharp packages are installed explicitly
// and measured by the gate below. The temporary 960 MiB budget covers the
// measured 919 MiB closure after the TypeScript compiler addition; the
// deferred size investigation is in docs/RELEASING.md.
const MAX_SUPPORTED_LINUX_MANAGED_RUNTIME_BYTES = 960 * 1024 * 1024;

/**
 * The packed runtime gates run on the qualified Linux targets only: Linux x64
 * and Linux ARM64 with glibc. Other hosts skip them rather than claim a pass.
 */
function isSupportedPackedLinuxHost(): boolean {
    return process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");
}

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

async function installAndVerifyPackedReleaseClosure(
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
        lateOn: isSupportedPackedLinuxHost(),
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
        resolveTypeScriptNativePackage(runtimeClosure),
        ...lateOnNativePackages,
    ], {
        cwd: installRoot,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });

    // Prune immediately after install so size measurement and every LateOn
    // probe exercise the exact tree users launch.
    pruneManagedRuntimeDeadWeight(installRoot);

    const cliVersion = requireStableVersion(sourceCli.version, "Source CLI version");
    const mcpVersion = requireStableVersion(sourceMcp.version, "Source MCP version");
    const coreVersion = requireStableVersion(sourceCore.version, "Source Core version");
    if (
        sourceCli.dependencies?.["@satori-code/mcp"] !== undefined
        || sourceCli.dependencies?.["@satori-code/core"] !== undefined
        || sourceCli.satoriManagedRuntime?.mcp !== mcpVersion
        || sourceCli.satoriManagedRuntime?.core !== coreVersion
        || sourceMcp.dependencies?.["@satori-code/core"] !== "workspace:*"
    ) {
        throw new Error("Source Satori package closure must keep the CLI bootstrap separate and pin the managed runtime explicitly.");
    }

    const nodeModulesRoot = path.join(installRoot, "node_modules");
    const cliRoot = path.join(nodeModulesRoot, "@satori-code", "cli");
    const mcpRoot = path.join(nodeModulesRoot, "@satori-code", "mcp");
    const coreRoot = path.join(nodeModulesRoot, "@satori-code", "core");
    const packedCli = readManifest(path.join(cliRoot, "package.json"));
    const packedMcp = readManifest(path.join(mcpRoot, "package.json"));
    const packedCore = readManifest(path.join(coreRoot, "package.json"));

    if (
        packedCli.name !== "@satori-code/cli"
        || requireStableVersion(packedCli.version, "Packed CLI version") !== cliVersion
        || packedMcp.name !== "@satori-code/mcp"
        || requireStableVersion(packedMcp.version, "Packed MCP version") !== mcpVersion
        || packedCore.name !== "@satori-code/core"
        || requireStableVersion(packedCore.version, "Packed Core version") !== coreVersion
    ) {
        throw new Error("Packed Satori package identities do not match their source manifests.");
    }
    if (
        packedCli.dependencies?.["@satori-code/mcp"] !== undefined
        || packedCli.dependencies?.["@satori-code/core"] !== undefined
        || packedCli.satoriManagedRuntime?.mcp !== mcpVersion
        || packedCli.satoriManagedRuntime?.core !== coreVersion
    ) {
        throw new Error("Packed CLI must remain a lightweight bootstrap with exact satoriManagedRuntime targets.");
    }
    requireDependency(packedMcp, "@satori-code/core", coreVersion, "Packed MCP");

    const cliEntryRelative = packedCli.bin?.satori;
    if (typeof cliEntryRelative !== "string" || Object.keys(packedCli.bin ?? {}).join() !== "satori") {
        throw new Error("Packed CLI must expose exactly the 'satori' binary.");
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
        .resolve("@satori-code/core/package.json");
    if (!isPathWithin(installRoot, resolvedCorePackageJson)) {
        throw new Error("Packed MCP resolved Core outside the installed release closure.");
    }
    const resolvedCore = readManifest(resolvedCorePackageJson);
    if (
        resolvedCore.name !== "@satori-code/core"
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
    const typeScriptNativeSpecifier = resolveTypeScriptNativePackage({ vectorStore: "LanceDB" });
    const typeScriptNativePackageName = typeScriptNativeSpecifier.slice(
        0,
        typeScriptNativeSpecifier.lastIndexOf("@"),
    );
    const resolvedTypeScriptPackageJson = requireFromMcp.resolve("typescript/package.json");
    const resolvedTypeScriptNative = requireFromMcp.resolve(
        `${typeScriptNativePackageName}/package.json`,
    );
    if (!isPathWithin(installRoot, resolvedTypeScriptPackageJson)) {
        throw new Error("Packed MCP resolved typescript outside the installed release closure.");
    }
    if (!isPathWithin(installRoot, resolvedTypeScriptNative)) {
        throw new Error("Packed MCP resolved the TypeScript host compiler outside the installed release closure.");
    }
    // TypeScript does not export the internal resolver, so import the installed
    // file by path. Its own `import.meta.resolve` call then starts from the
    // packed `typescript/lib` directory and must find the host package there.
    const typeScriptGetExePath = path.join(
        path.dirname(resolvedTypeScriptPackageJson),
        "lib",
        "getExePath.js",
    );
    const { default: getTypeScriptExePath } = (await import(
        pathToFileURL(typeScriptGetExePath).href
    )) as { default: () => string };
    const typeScriptExe = getTypeScriptExePath();
    if (!isPathWithin(installRoot, typeScriptExe)) {
        throw new Error("TypeScript resolved its host compiler outside the installed release closure.");
    }
    const { API } = requireFromMcp("typescript/sync") as typeof import("typescript/sync");
    const typeScriptApi = new API({ runExternalCode: false });
    try {
        const sourceText = "export const value: number = 1;";
        const retained = typeScriptApi.createSourceFile("packed-runtime-probe.ts", sourceText);
        try {
            if (retained.sourceFile.text !== sourceText) {
                throw new Error("Packed TypeScript native API did not parse the probe source.");
            }
        } finally {
            retained.dispose();
        }
    } finally {
        typeScriptApi.close();
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
        path.join(nodeModulesRoot, "@satori-code", "core"),
        path.join(nodeModulesRoot, "@satori-code", "mcp"),
        path.join(nodeModulesRoot, "onnxruntime-node"),
        path.join(nodeModulesRoot, "@huggingface", "transformers"),
    ]) {
        if (fs.existsSync(forbiddenPath)) {
            throw new Error(`Packed bootstrap CLI must not install managed-runtime dependency '${forbiddenPath}'.`);
        }
    }

    const cliEntry = path.join(nodeModulesRoot, "@satori-code", "cli", "dist", "index.js");
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

export function assertManagedRuntimeSizeBudget(installRoot: string): void {
    if (!isSupportedPackedLinuxHost()) {
        return;
    }
    const installedBytes = directorySize(installRoot);
    console.log(`[release:smoke] Packed managed runtime is ${installedBytes} bytes; budget is ${MAX_SUPPORTED_LINUX_MANAGED_RUNTIME_BYTES} bytes.`);
    if (installedBytes > MAX_SUPPORTED_LINUX_MANAGED_RUNTIME_BYTES) {
        throw new Error(
            `Packed Linux ${process.arch} managed runtime is ${installedBytes} bytes; `
            + `budget is ${MAX_SUPPORTED_LINUX_MANAGED_RUNTIME_BYTES} bytes.`,
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
        "runtime-profile-v6-d128.json",
        "runtime-profile-v6-d128.acquisition.json",
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

export function assertPackedLateOnNativeRuntime(packedMcpRoot: string): void {
    if (!isSupportedPackedLinuxHost()) {
        return;
    }
    const requireFromMcp = createRequire(path.join(packedMcpRoot, "package.json"));
    const transformersEntry = requireFromMcp.resolve("@huggingface/transformers");
    const requireFromTransformers = createRequire(transformersEntry);
    try {
        requireFromTransformers("sharp");
    } catch (error) {
        throw new Error(
            `Packed LateOn runtime cannot load Sharp's Linux ${process.arch} native closure: ${error instanceof Error ? error.message : String(error)}`,
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
    const policyMissing = !storeSource.includes("lateon_context_v6_d128_owner_default_v1");
    const installSource = fs.readFileSync(installPath, "utf8");
    const resolutionMissing = !installSource.includes("resolveVerifiedLateOnModel");
    if (policyMissing || resolutionMissing) {
        throw new Error(
            "Packed CLI acquisition flow must carry the frozen D128 identity "
            + `(policy=${!policyMissing}, resolver=${!resolutionMissing}).`,
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
 * The smoke home has no client configured, so the packed doctor must run to
 * completion and report that error, exiting 1. The pinned MCP version may not
 * be published yet during release qualification, so npm access can warn.
 */
function assertPackedDoctorReportsNotInstalled(
    cliEntry: string,
    smokeExecDir: string,
    env: NodeJS.ProcessEnv,
): void {
    const result = spawnSync(process.execPath, [cliEntry, "doctor", "--json"], {
        cwd: smokeExecDir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 1) {
        throw new Error(`Packed doctor exited ${String(result.status)}; expected 1. ${result.stderr}`);
    }
    const report = JSON.parse(result.stdout) as { status?: unknown; checks?: Array<{ name?: unknown; status?: unknown }> };
    assertPackedDoctorReport(report);
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

// The runtime package ships only the Potion helper; installs acquire the model
// from Hugging Face. The smoke uses the workspace copy of the same pinned files.
const WORKSPACE_POTION_MODEL_PATH = fileURLToPath(
    new URL("../../mcp/assets/potion/linux-x64/model/", import.meta.url),
);

export function packedPotionSmokeEnv(
    baseEnv: NodeJS.ProcessEnv,
    packedMcpRoot: string,
    smokeHomeDir: string,
): NodeJS.ProcessEnv {
    const assetsRoot = resolvePotionAssetsRoot(packedMcpRoot);
    const helperPath = path.join(assetsRoot, "satori-potion");
    const modelPath = WORKSPACE_POTION_MODEL_PATH;
    for (const requiredPath of [
        helperPath,
        path.join(assetsRoot, "manifest.json"),
        path.join(assetsRoot, "MODEL_CARD.md"),
        path.join(assetsRoot, "MODEL2VEC_RS_LICENSE"),
    ]) {
        if (!fs.existsSync(requiredPath)) {
            throw new Error(`Packed Potion artifact is missing: ${requiredPath}.`);
        }
    }
    if (fs.existsSync(path.join(assetsRoot, "model"))) {
        throw new Error("Packed MCP runtime must not bundle Potion model files; installs acquire them.");
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

export async function assertPackedPotionExecutionCapability(installRoot: string, packedMcpRoot: string): Promise<void> {
    if (!isSupportedPackedLinuxHost()) {
        return;
    }
    // The validated helper/model paths come from the packed artifact gate, so a
    // missing or bundled helper fails here instead of skipping the capability
    // check. No native binary runs before this validation.
    const smokeEnv = packedPotionSmokeEnv({}, packedMcpRoot, installRoot);
    const helperPath = smokeEnv.POTION_HELPER_PATH as string;
    const modelPath = smokeEnv.POTION_MODEL_PATH as string;
    const assetsRoot = path.dirname(helperPath);

    const coreEntry = path.join(installRoot, "node_modules", "@satori-code", "core", "dist", "index.js");
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

/*
 * The packed Core must load its own shipped addon and publish exactly what the
 * TypeScript oracle publishes for the same input. An empty env keeps ambient
 * SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS overrides out of the check.
 */
export async function assertPackedNativeProjectionRuntime(installRoot: string): Promise<void> {
    if (!isSupportedPackedLinuxHost()) {
        return;
    }
    const coreRoot = path.join(installRoot, "node_modules", "@satori-code", "core");
    const nativeModulePath = path.join(coreRoot, "dist", "core", "native-search-projections.js");
    const projectionsModulePath = path.join(coreRoot, "dist", "core", "search-projections.js");
    for (const requiredPath of [nativeModulePath, projectionsModulePath]) {
        if (!fs.existsSync(requiredPath)) {
            throw new Error(`Packed Core projection module is missing: ${requiredPath}.`);
        }
    }
    const nativeModule = await import(pathToFileURL(nativeModulePath).href) as {
        resolveNativeProjectionAddonPath(env: NodeJS.ProcessEnv): string | undefined;
        loadAddon(addonPath?: string): {
            buildProjectionBatch(inputs: unknown[]): Promise<Array<unknown>>;
        } | undefined;
        flatten(input: unknown): unknown;
    };
    const projectionsModule = await import(pathToFileURL(projectionsModulePath).href) as {
        buildSearchProjections(input: unknown): unknown;
    };

    const addonPath = nativeModule.resolveNativeProjectionAddonPath({});
    const expectedAddonPath = path.join(
        coreRoot,
        "assets",
        "native-projections",
        `linux-${process.arch}`,
        "projection.node",
    );
    if (!addonPath || path.resolve(addonPath) !== path.resolve(expectedAddonPath)) {
        throw new Error(
            `Packed Core did not select its shipped linux-${process.arch} projection addon; `
            + `received ${JSON.stringify(addonPath ?? null)}.`,
        );
    }
    const addon = nativeModule.loadAddon(addonPath);
    if (!addon) {
        throw new Error(`Packed Core could not load its shipped projection addon at ${addonPath}.`);
    }

    const fixture = {
        chunk: {
            content: "export function parseHeader(value) { return value.trim(); }",
            metadata: { startLine: 1, endLine: 1, language: "typescript" },
        },
        relativePath: "src/probe.ts",
    };
    const nativeResults = await addon.buildProjectionBatch([nativeModule.flatten(fixture)]);
    const nativeProjection = nativeResults[0];
    if (nativeProjection === null || nativeProjection === undefined) {
        throw new Error("Packed native projection addon returned no projection for the probe fixture.");
    }
    const expectedProjection = projectionsModule.buildSearchProjections(fixture);
    if (!isDeepStrictEqual(nativeProjection, expectedProjection)) {
        throw new Error(
            "Packed native projection output differs from the packed TypeScript projections "
            + "for the same probe fixture.",
        );
    }
}

const OFFLINE_JOURNEY_INDEX_TIMEOUT_MS = 120_000;
const OFFLINE_JOURNEY_POLL_INTERVAL_MS = 100;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function readToolJson(result: { isError?: boolean; content?: unknown }): Record<string, unknown> {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
        .map((part) => asRecord(part))
        .find((part) => part?.type === "text")?.text;
    if (typeof text !== "string") {
        throw new Error("Satori tool response did not contain text.");
    }
    if (result.isError === true) {
        throw new Error(`Satori tool failed: ${text}`);
    }
    return JSON.parse(text) as Record<string, unknown>;
}

function readIndexOperation(response: Record<string, unknown>): { id: string; phase: string } | undefined {
    const operation = asRecord(response.operation);
    if (!operation || typeof operation.id !== "string" || typeof operation.phase !== "string") {
        return undefined;
    }
    return { id: operation.id, phase: operation.phase };
}

function readIndexPublication(response: Record<string, unknown>): { publicationId: string } | undefined {
    const publication = asRecord(response.publication);
    if (
        !publication
        || typeof publication.publicationId !== "string"
        || publication.publicationId.length === 0
    ) {
        return undefined;
    }
    return { publicationId: publication.publicationId };
}

function writeOfflineJourneyFixture(fixtureRepo: string): void {
    fs.mkdirSync(path.join(fixtureRepo, "src"), { recursive: true });
    fs.writeFileSync(
        path.join(fixtureRepo, "package.json"),
        `${JSON.stringify({ name: "satori-offline-journey-fixture", private: true, type: "module" }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(fixtureRepo, "src", "http.ts"), [
        "/**",
        " * Parse incoming HTTP request headers.",
        " */",
        "export function parseIncomingRequestHeaders(rawHeaders: readonly string[]): Map<string, string> {",
        "    const headers = new Map<string, string>();",
        "    for (const line of rawHeaders) {",
        "        const separator = line.indexOf(\":\");",
        "        if (separator <= 0) continue;",
        "        const name = line.slice(0, separator).trim().toLowerCase();",
        "        const value = line.slice(separator + 1).trim();",
        "        if (name.length > 0) headers.set(name, value);",
        "    }",
        "    return headers;",
        "}",
        "",
        "export function readRequestHeader(rawHeaders: readonly string[], name: string): string | undefined {",
        "    return parseIncomingRequestHeaders(rawHeaders).get(name.toLowerCase());",
        "}",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(fixtureRepo, "src", "session.ts"), [
        "const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9._-]{16,}$/;",
        "",
        "export function validateSessionToken(token: string, now: number, expiresAt: number): boolean {",
        "    if (!SESSION_TOKEN_PATTERN.test(token)) return false;",
        "    return now < expiresAt;",
        "}",
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(fixtureRepo, "src", "totals.ts"), [
        "export interface InvoiceLine {",
        "    readonly quantity: number;",
        "    readonly unitPriceCents: number;",
        "}",
        "",
        "export function calculateInvoiceTotal(lines: readonly InvoiceLine[]): number {",
        "    return lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0);",
        "}",
        "",
    ].join("\n"));
}

async function assertOfflineJourneySearch(
    session: { callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content?: unknown }> },
    fixtureRepo: string,
    expectedProvider: "lateon" | "none",
): Promise<{ publicationId: string }> {
    const start = readToolJson(await session.callTool("manage_index", { action: "create", path: fixtureRepo }));
    const started = readIndexOperation(start);
    const deadline = Date.now() + OFFLINE_JOURNEY_INDEX_TIMEOUT_MS;
    let publication: { publicationId: string } | undefined;
    while (Date.now() < deadline) {
        const status = readToolJson(await session.callTool("manage_index", { action: "status", path: fixtureRepo }));
        const operation = readIndexOperation(status);
        if (operation?.phase === "failed" || operation?.phase === "blocked") {
            throw new Error(`Packed offline journey indexing ${operation.phase}: ${JSON.stringify(status)}`);
        }
        if (operation?.phase === "completed" && (!started || operation.id === started.id)) {
            publication = readIndexPublication(status);
            if (!publication) {
                throw new Error("Packed offline journey indexing completed without a Publication identity.");
            }
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, OFFLINE_JOURNEY_POLL_INTERVAL_MS));
    }
    if (!publication) {
        if (started) {
            // Release the live operation before the caller closes the session.
            await session.callTool("manage_index", {
                action: "cancel",
                operationId: started.id,
                path: fixtureRepo,
            }).catch(() => undefined);
        }
        throw new Error(
            `Timed out after ${OFFLINE_JOURNEY_INDEX_TIMEOUT_MS}ms waiting for the packed offline journey Publication.`,
        );
    }

    const search = readToolJson(await session.callTool("search_codebase", {
        path: fixtureRepo,
        query: "Where does the code parse incoming HTTP request headers?",
        scope: "runtime",
        resultMode: "grouped",
        groupBy: "symbol",
        limit: 10,
        disclosureLimit: 10,
        debugMode: "full",
    }));
    if (search.status !== "ok") {
        throw new Error(`Packed offline journey search returned status ${JSON.stringify(search.status)}.`);
    }
    const results = Array.isArray(search.results) ? search.results : [];
    if (results.length === 0) {
        throw new Error("Packed offline journey search returned no results.");
    }
    const files = results.map((result) => asRecord(asRecord(result)?.target)?.file);
    if (!files.includes("src/http.ts")) {
        throw new Error(
            `Packed offline journey search did not return src/http.ts; received ${JSON.stringify(files)}.`,
        );
    }
    const rerank = asRecord(asRecord(asRecord(search.hints)?.debugSearch)?.rerank);
    const applied = rerank?.applied;
    const expectedApplied = expectedProvider === "lateon";
    if (applied !== expectedApplied) {
        throw new Error(
            `Packed offline journey reranker applied=${JSON.stringify(applied ?? null)}; `
            + `expected ${String(expectedApplied)} for ${expectedProvider}.`,
        );
    }
    return publication;
}

export async function runPackedOfflineJourney(options: {
    modeHome: string;
    fixtureRepo: string;
    baseEnv: NodeJS.ProcessEnv;
    packageSpecifier: string;
    runtimeCommand: { command: string; args: string[] };
    potionAssetsRoot: string;
    reranker: "none" | undefined;
    expectedProvider: "lateon" | "none";
    packedInstall: typeof import("../src/install.js");
    packedInstallApplication: typeof import("../src/install-application.js");
    packedClient: typeof import("../src/client.js");
    packedTerminate: typeof import("../src/terminate.js");
    packedSharedIdentity: typeof import("../../mcp/src/server/shared-runtime-identity.js");
    packedSharedLifecycle: typeof import("../../mcp/src/server/shared-runtime-lifecycle.js");
    onCleanupUncertain?: (reason: string) => void;
}): Promise<void> {
    const { modeHome, fixtureRepo } = options;
    fs.mkdirSync(modeHome, { recursive: true });
    const journeyEnv: NodeJS.ProcessEnv = {
        ...isolatedSmokeEnv(modeHome, options.baseEnv),
        SATORI_STATE_ROOT: path.join(modeHome, "satori-state"),
        SATORI_SESSION_ROOTS_JSON: JSON.stringify([fixtureRepo]),
        MCP_ENABLE_WATCHER: "false",
    };
    const command = options.reranker === undefined
        ? { kind: "install" as const, client: "codex" as const, dryRun: false as const, runtime: "offline" as const }
        : {
            kind: "install" as const,
            client: "codex" as const,
            dryRun: false as const,
            runtime: "offline" as const,
            reranker: options.reranker,
        };

    const failures: unknown[] = [];
    let session: Awaited<ReturnType<typeof options.packedClient.connectCliMcpSession>> | null = null;
    let peerSession: Awaited<ReturnType<typeof options.packedClient.connectCliMcpSession>> | null = null;
    try {
        const installed = await options.packedInstall.executeInstallCommand(command, {
            homeDir: modeHome,
            repoDir: fixtureRepo,
            env: journeyEnv,
            packageSpecifier: options.packageSpecifier,
            runtimeCommand: options.runtimeCommand,
            potionAssetsRoot: options.potionAssetsRoot,
            potionModelPath: WORKSPACE_POTION_MODEL_PATH,
            // The packed runtime lives outside this temporary home, so the
            // installer's in-home auto-binding does not apply. Bind the same
            // production verifier the local-runtime installer uses
            // (scripts/install-local-mcp-runtime.mjs) to the packed closure.
            preflightDependencies: options.packedInstallApplication.exactRuntimePreflightDependencies(
                options.runtimeCommand,
            ),
        });
        const provider = installed.runtimeEnvironment?.SATORI_RERANKER_PROVIDER;
        if (provider !== options.expectedProvider) {
            throw new Error(
                `Packed offline install selected reranker ${JSON.stringify(provider ?? null)}; `
                + `expected ${options.expectedProvider}.`,
            );
        }
        const effectiveEnv = { ...journeyEnv, ...installed.runtimeEnvironment };
        if (!options.packedSharedIdentity.isSharedOfflineRuntimeEligible(effectiveEnv)) {
            throw new Error(`Packed offline ${options.expectedProvider} runtime is not eligible for its shared host.`);
        }
        const identity = options.packedSharedIdentity.buildSharedRuntimeIdentity(
            options.runtimeCommand.args[0]!, effectiveEnv,
        );
        const sharedPaths = options.packedSharedIdentity.resolveSharedRuntimePaths(identity, effectiveEnv);
        const readSharedHost = () => {
            const metadata = options.packedSharedLifecycle.readHostMetadata(sharedPaths.metadataPath);
            if (!metadata || metadata.sharedRuntimeIdentityHash !== identity.hash
                || !options.packedSharedLifecycle.isLinuxProcessIdentityLive({
                    pid: metadata.hostPid, bootId: metadata.bootId, startTime: metadata.processStartTime,
                })) {
                throw new Error("Packed managed clients must attach to their live shared host.");
            }
            return metadata;
        };
        const launcherPath = path.join(modeHome, ".satori", "bin", "satori-mcp.js");
        if (!fs.existsSync(launcherPath)) {
            throw new Error(`Packed offline install did not write the managed launcher at ${launcherPath}.`);
        }
        const connection = {
            command: process.execPath,
            args: [launcherPath],
            cwd: fixtureRepo,
            env: journeyEnv,
            startupTimeoutMs: 30_000,
            callTimeoutMs: 60_000,
            writeStderr: (text: string) => process.stderr.write(text),
        };
        session = await options.packedClient.connectCliMcpSession(connection);
        const firstHost = readSharedHost();
        peerSession = await options.packedClient.connectCliMcpSession(connection);
        const peerHost = readSharedHost();
        if (peerHost.hostPid !== firstHost.hostPid || peerHost.bootId !== firstHost.bootId
            || peerHost.processStartTime !== firstHost.processStartTime
            || session.launcherPid === firstHost.hostPid || peerSession.launcherPid === firstHost.hostPid) {
            throw new Error("Packed managed clients did not retain one shared host process.");
        }
        const publication = await assertOfflineJourneySearch(session, fixtureRepo, options.expectedProvider);
        const peerStatus = readToolJson(await peerSession.callTool("manage_index", { action: "status", path: fixtureRepo }));
        if (readIndexPublication(peerStatus)?.publicationId !== publication.publicationId) {
            throw new Error("Packed managed clients did not observe the same Publication.");
        }
        console.log(
            `[release:smoke] Packed offline ${options.expectedProvider} journey indexed and searched the fixture repository with two clients sharing host ${firstHost.hostPid}.`,
        );
    } catch (error) {
        failures.push(error);
    } finally {
        for (const opened of [peerSession, session]) {
            try {
                await opened?.close();
            } catch (error) {
                failures.push(error);
            }
        }
        try {
            const termination = await options.packedTerminate.terminateSatoriServers({
                homeDir: modeHome,
                env: journeyEnv,
            });
            if (termination.status === "partial" || termination.unverifiedRecordCount > 0) {
                const reason = `Packed offline journey termination reported ${termination.status} `
                    + `with ${termination.unverifiedRecordCount} unverified runtime records `
                    + `for ${modeHome} (state ${journeyEnv.SATORI_STATE_ROOT}).`;
                options.onCleanupUncertain?.(reason);
                failures.push(new Error(reason));
            }
        } catch (error) {
            options.onCleanupUncertain?.(
                `Packed offline journey termination failed for ${modeHome} `
                + `(state ${journeyEnv.SATORI_STATE_ROOT}): ${error instanceof Error ? error.message : String(error)}`,
            );
            failures.push(error);
        }
    }
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new Error(failures
            .map((failure) => failure instanceof Error ? failure.message : String(failure))
            .join(" | "));
    }
}

/*
 * Two real packed offline journeys: the default LateOn runtime and the explicit
 * `--reranker none` runtime. Each journey installs into its own temporary home
 * with the packed installer and connects through the installed managed launcher.
 * No provider, preflight, or fetch stub replaces real validation.
 */
export async function assertPackedManagedOfflineJourneys(input: {
    packedCliRoot: string;
    packedMcpRoot: string;
    installRoot: string;
    smokeHomeDir: string;
    baseEnv: NodeJS.ProcessEnv;
    onCleanupUncertain?: (reason: string) => void;
}): Promise<void> {
    if (!isSupportedPackedLinuxHost()) {
        return;
    }
    if (!isPathWithin(input.installRoot, input.packedMcpRoot)) {
        throw new Error("Packed MCP runtime must live inside the installed release closure.");
    }
    const packedMcp = readManifest(path.join(input.packedMcpRoot, "package.json"));
    if (typeof packedMcp.name !== "string" || packedMcp.name.length === 0) {
        throw new Error("Packed MCP manifest must declare its package name.");
    }
    const packageSpecifier = `${packedMcp.name}@${requireStableVersion(packedMcp.version, "Packed MCP version")}`;

    const installEntry = path.join(input.packedCliRoot, "dist", "install.js");
    const installApplicationEntry = path.join(input.packedCliRoot, "dist", "install-application.js");
    const clientEntry = path.join(input.packedCliRoot, "dist", "client.js");
    const terminateEntry = path.join(input.packedCliRoot, "dist", "terminate.js");
    const sharedIdentityEntry = path.join(input.packedMcpRoot, "dist", "server", "shared-runtime-identity.js");
    const sharedLifecycleEntry = path.join(input.packedMcpRoot, "dist", "server", "shared-runtime-lifecycle.js");
    for (const requiredPath of [installEntry, installApplicationEntry, clientEntry, terminateEntry, sharedIdentityEntry, sharedLifecycleEntry]) {
        if (!fs.existsSync(requiredPath)) {
            throw new Error(`Packed CLI module is missing: ${requiredPath}.`);
        }
    }
    // Import the installed closure before any journey starts, so a missing
    // module fails before temporary state exists.
    const packedInstall = await import(pathToFileURL(installEntry).href) as typeof import("../src/install.js");
    const packedInstallApplication = await import(
        pathToFileURL(installApplicationEntry).href
    ) as typeof import("../src/install-application.js");
    const packedClient = await import(pathToFileURL(clientEntry).href) as typeof import("../src/client.js");
    const packedTerminate = await import(pathToFileURL(terminateEntry).href) as typeof import("../src/terminate.js");
    const packedSharedIdentity = await import(pathToFileURL(sharedIdentityEntry).href) as typeof import("../../mcp/src/server/shared-runtime-identity.js");
    const packedSharedLifecycle = await import(pathToFileURL(sharedLifecycleEntry).href) as typeof import("../../mcp/src/server/shared-runtime-lifecycle.js");

    const fixtureRepo = path.join(input.smokeHomeDir, "offline-journey-repository");
    writeOfflineJourneyFixture(fixtureRepo);
    const runtimeCommand = {
        command: process.execPath,
        args: [path.join(input.packedMcpRoot, "dist", "index.js")],
    };
    const potionAssetsRoot = resolvePotionAssetsRoot(input.packedMcpRoot);

    for (const mode of [
        { id: "offline-lateon", reranker: undefined, expectedProvider: "lateon" as const },
        { id: "offline-none", reranker: "none" as const, expectedProvider: "none" as const },
    ]) {
        await runPackedOfflineJourney({
            modeHome: path.join(input.smokeHomeDir, mode.id),
            fixtureRepo,
            baseEnv: input.baseEnv,
            packageSpecifier,
            runtimeCommand,
            potionAssetsRoot,
            reranker: mode.reranker,
            expectedProvider: mode.expectedProvider,
            packedInstall,
            packedInstallApplication,
            packedClient,
            packedTerminate,
            packedSharedIdentity,
            packedSharedLifecycle,
            onCleanupUncertain: input.onCleanupUncertain,
        });
    }
}

export function cleanupPackedSmokeDirectories(input: {
    smokePackDir: string;
    smokeExecDir: string;
    smokeHomeDir: string;
    bootstrapRoot: string;
    preservationReason?: string;
}): void {
    fs.rmSync(input.smokePackDir, { recursive: true, force: true });
    if (input.preservationReason) {
        console.error(
            `[release:smoke] ${input.preservationReason} `
            + `Preserved runtime ${input.smokeExecDir} and home ${input.smokeHomeDir}.`,
        );
        fs.rmSync(input.bootstrapRoot, { recursive: true, force: true });
        return;
    }
    fs.rmSync(input.smokeExecDir, { recursive: true, force: true });
    fs.rmSync(input.smokeHomeDir, { recursive: true, force: true });
    fs.rmSync(input.bootstrapRoot, { recursive: true, force: true });
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
    let smokeStatePreservationReason: string | undefined;

    try {
        const coreTarballPath = packPackage(corePackageRoot, smokePackDir);
        const mcpTarballPath = packPackage(mcpPackageRoot, smokePackDir);
        const cliTarballPath = packPackage(packageRoot, smokePackDir);
        const baseEnv = isolatedSmokeEnv(smokeHomeDir);
        assertPackedBootstrapCli(cliTarballPath, bootstrapRoot, baseEnv);
        const packed = await installAndVerifyPackedReleaseClosure(
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
        const packedCoreRequire = createRequire(path.join(smokeExecDir, "node_modules", "@satori-code", "core", "package.json"));
        await probeLanceDbRuntime(path.join(smokeExecDir, "preflight-db"), {
            loadLanceDb: async () => packedCoreRequire("@satori-code/core/lancedb"),
        });
        assertPackedLateOnAcquisitionAuthority(packed.packedMcpRoot, packed.packedCliRoot);
        assertPackedLateOnNativeRuntime(packed.packedMcpRoot);
        assertPackedCliLateOnAcquisition(packed.packedCliRoot);
        assertPackedCliHelp(runCliSmoke(["--format", "json", "--help"], packed.cliEntry, smokeExecDir, baseEnv));
        await assertPackedPotionExecutionCapability(smokeExecDir, packed.packedMcpRoot);
        await assertPackedNativeProjectionRuntime(smokeExecDir);
        const doctorEnv = packedPotionSmokeEnv(baseEnv, packed.packedMcpRoot, smokeHomeDir);
        assertPackedDoctorReportsNotInstalled(packed.cliEntry, smokeExecDir, doctorEnv);
        await assertPackedManagedOfflineJourneys({
            packedCliRoot: packed.packedCliRoot,
            packedMcpRoot: packed.packedMcpRoot,
            installRoot: smokeExecDir,
            smokeHomeDir,
            baseEnv,
            onCleanupUncertain: (reason) => { smokeStatePreservationReason = reason; },
        });
        console.log("[release:smoke] Lightweight bootstrap CLI, packed MCP/Core closure, offline Potion runtime, LateOn native runtime, D128 acquisition authority, packed native projections, and default/explicit-none offline journeys passed.");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = error instanceof Error ? npmOutput(error) : "";
        console.error(`[release:smoke] ${message}${detail ? ` ${detail}` : ""}`);
        process.exitCode = 1;
    } finally {
        cleanupPackedSmokeDirectories({
            smokePackDir, smokeExecDir, smokeHomeDir, bootstrapRoot,
            preservationReason: smokeStatePreservationReason,
        });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`[release:smoke] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
