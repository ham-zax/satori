import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { readManagedRuntimeRelease } from "./managed-package.js";

const NAPI_DIRS = ["napi-v3", "napi-v6"] as const;

export interface ManagedRuntimePruneOptions {
    readonly platform?: NodeJS.Platform;
    readonly architecture?: string;
    readonly expectedOnnxRuntimeNodeVersion?: string;
    readonly expectedTransformersVersion?: string;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
    try {
        const realRoot = fs.realpathSync(rootPath);
        const realCandidate = fs.realpathSync(candidatePath);
        const relative = path.relative(realRoot, realCandidate);
        return relative.length > 0
            && relative !== ".."
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative);
    } catch {
        return false;
    }
}

function isDirectory(pathToCheck: string): boolean {
    try {
        return fs.lstatSync(pathToCheck).isDirectory();
    } catch {
        return false;
    }
}

function isSymlink(pathToCheck: string): boolean {
    try {
        return fs.lstatSync(pathToCheck).isSymbolicLink();
    } catch {
        return false;
    }
}

function findPackageRoot(fromPackageRoot: string, packageName: string): string | undefined {
    // Use Node's lookup paths so npm's nested and hoisted layouts share one policy.
    const requireFromPackage = createRequire(path.resolve(fromPackageRoot, "package.json"));
    return requireFromPackage.resolve.paths(packageName)
        ?.map((lookupPath) => path.join(lookupPath, packageName))
        .find((candidate) => fs.existsSync(candidate));
}

function readPackageMeta(packageRoot: string, runtimeRoot: string): { name?: unknown; version?: unknown; dependencies?: Record<string, unknown> } | null {
    const packageJsonPath = path.join(packageRoot, "package.json");
    try {
        if (!fs.existsSync(packageJsonPath) || isSymlink(packageJsonPath) || !isPathWithin(runtimeRoot, packageJsonPath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
            name?: unknown;
            version?: unknown;
            dependencies?: Record<string, unknown>;
        };
    } catch {
        return null;
    }
}

function pruneOnnxRuntimeNode(
    runtimeRoot: string,
    platform: NodeJS.Platform,
    architecture: string,
    expectedVersion: string,
): void {
    const mcpRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
    const nodeRoot = findPackageRoot(mcpRoot, "onnxruntime-node");
    if (!nodeRoot) return;
    try {
        if (!fs.existsSync(nodeRoot) || isSymlink(nodeRoot) || !isPathWithin(runtimeRoot, nodeRoot) || !isDirectory(nodeRoot)) {
            return;
        }
    } catch {
        return;
    }
    const meta = readPackageMeta(nodeRoot, runtimeRoot);
    if (!meta || meta.name !== "onnxruntime-node" || meta.version !== expectedVersion) {
        return;
    }
    const binRoot = path.join(nodeRoot, "bin");
    if (!fs.existsSync(binRoot) || isSymlink(binRoot) || !isPathWithin(runtimeRoot, binRoot) || !isDirectory(binRoot)) {
        return;
    }
    for (const napiDir of NAPI_DIRS) {
        const napiRoot = path.join(binRoot, napiDir);
        if (!fs.existsSync(napiRoot) || isSymlink(napiRoot) || !isPathWithin(runtimeRoot, napiRoot) || !isDirectory(napiRoot)) {
            continue;
        }
        let platformEntries: string[];
        try {
            platformEntries = fs.readdirSync(napiRoot);
        } catch {
            continue;
        }
        for (const platformEntry of platformEntries) {
            const platformPath = path.join(napiRoot, platformEntry);
            if (isSymlink(platformPath) || !isPathWithin(runtimeRoot, platformPath) || !isDirectory(platformPath)) {
                continue;
            }
            let archEntries: string[];
            try {
                archEntries = fs.readdirSync(platformPath);
            } catch {
                continue;
            }
            for (const archEntry of archEntries) {
                const targetPath = path.join(platformPath, archEntry);
                if (isSymlink(targetPath) || !isPathWithin(runtimeRoot, targetPath)) {
                    continue;
                }
                if (platformEntry === platform && archEntry === architecture) {
                    continue;
                }
                try {
                    if (isDirectory(targetPath)) {
                        fs.rmSync(targetPath, { recursive: true, force: true });
                    }
                } catch {
                    continue;
                }
            }
        }
    }
}

function pruneOnnxRuntimeWeb(runtimeRoot: string, expectedTransformersVersion: string): void {
    const mcpRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
    const transformersRoot = findPackageRoot(mcpRoot, "@huggingface/transformers");
    if (!transformersRoot) return;
    const webRoot = findPackageRoot(transformersRoot, "onnxruntime-web");
    if (!webRoot) return;
    try {
        if (!fs.existsSync(transformersRoot) || isSymlink(transformersRoot) || !isPathWithin(runtimeRoot, transformersRoot) || !isDirectory(transformersRoot)) {
            return;
        }
        if (!fs.existsSync(webRoot) || isSymlink(webRoot) || !isPathWithin(runtimeRoot, webRoot) || !isDirectory(webRoot)) {
            return;
        }
    } catch {
        return;
    }
    const transformersMeta = readPackageMeta(transformersRoot, runtimeRoot);
    if (!transformersMeta || transformersMeta.name !== "@huggingface/transformers" || transformersMeta.version !== expectedTransformersVersion) {
        return;
    }
    const expectedWebVersion = transformersMeta.dependencies?.["onnxruntime-web"];
    if (typeof expectedWebVersion !== "string" || expectedWebVersion.length === 0) {
        return;
    }
    const webMeta = readPackageMeta(webRoot, runtimeRoot);
    if (!webMeta || webMeta.name !== "onnxruntime-web" || webMeta.version !== expectedWebVersion) {
        return;
    }
    const distRoot = path.join(webRoot, "dist");
    if (!fs.existsSync(distRoot) || isSymlink(distRoot) || !isPathWithin(runtimeRoot, distRoot) || !isDirectory(distRoot)) {
        return;
    }
    let entries: string[];
    try {
        entries = fs.readdirSync(distRoot);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.endsWith(".wasm")) {
            continue;
        }
        const wasmPath = path.join(distRoot, entry);
        if (isSymlink(wasmPath) || !isPathWithin(runtimeRoot, wasmPath)) {
            continue;
        }
        try {
            if (!fs.lstatSync(wasmPath).isFile() || fs.lstatSync(wasmPath).isSymbolicLink()) {
                continue;
            }
            fs.rmSync(wasmPath, { force: true });
        } catch {
            continue;
        }
    }
}

/**
 * Removes third-party binaries Node never loads on the host.
 * Keeps only the host-native ONNX Runtime N-API tree and deletes
 * onnxruntime-web WASM payloads. All deletions require the pinned
 * versions, stay inside the runtime root, and reject symlinks.
 * Missing or mismatched packages are left untouched.
 */
export function pruneManagedRuntimeDeadWeight(
    runtimeRoot: string,
    options: ManagedRuntimePruneOptions = {},
): void {
    let expectedNodeVersion = options.expectedOnnxRuntimeNodeVersion;
    let expectedTransformersVersion = options.expectedTransformersVersion;
    if (expectedNodeVersion === undefined || expectedTransformersVersion === undefined) {
        const release = readManagedRuntimeRelease();
        expectedNodeVersion ??= release.lateOn.onnxruntimeNode;
        expectedTransformersVersion ??= release.lateOn.transformers;
    }
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    try {
        if (!fs.existsSync(runtimeRoot)) {
            return;
        }
    } catch {
        return;
    }
    pruneOnnxRuntimeNode(runtimeRoot, platform, architecture, expectedNodeVersion);
    pruneOnnxRuntimeWeb(runtimeRoot, expectedTransformersVersion);
}
