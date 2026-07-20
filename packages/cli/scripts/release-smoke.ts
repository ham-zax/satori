import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function isolatedSmokeEnv(smokeHomeDir: string): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => !PNPM_ONLY_NPM_ENV_KEYS.has(key.toUpperCase()) && !isSatoriRuntimeEnvKey(key),
    ));
    return {
        ...env,
        HOME: smokeHomeDir,
        USERPROFILE: smokeHomeDir,
        XDG_CONFIG_HOME: path.join(smokeHomeDir, ".config"),
        npm_config_cache: path.join(smokeHomeDir, ".npm"),
        npm_config_package_lock: "false",
    };
}

function npmExecArgs(
    coreTarballPath: string,
    mcpTarballPath: string,
    cliTarballPath: string,
): string[] {
    return [
        "exec",
        "--yes",
        "--package",
        coreTarballPath,
        "--package",
        mcpTarballPath,
        "--package",
        cliTarballPath,
        "--",
    ];
}

function resolvePackedMcpRoot(
    coreTarballPath: string,
    mcpTarballPath: string,
    cliTarballPath: string,
    smokeExecDir: string,
    env: NodeJS.ProcessEnv,
): string {
    const script = [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'const names = process.platform === "win32" ? ["satori.cmd", "satori"] : ["satori"]',
        'const bin = (process.env.PATH || "").split(path.delimiter).flatMap((dir) => names.map((name) => path.join(dir, name))).find((candidate) => fs.existsSync(candidate))',
        'if (!bin) throw new Error("Packed Satori MCP executable was not added to PATH")',
        'process.stdout.write(path.dirname(path.dirname(fs.realpathSync(bin))))',
    ].join(";");
    const packageRoot = execFileSync("npm", [
        ...npmExecArgs(coreTarballPath, mcpTarballPath, cliTarballPath),
        "node",
        "-e",
        script,
    ], {
        cwd: smokeExecDir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!path.isAbsolute(packageRoot)) {
        throw new Error(`Packed Satori MCP root is not absolute: ${packageRoot || "<empty>"}.`);
    }
    return packageRoot;
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

function runCliSmoke(
    commandArgs: string[],
    coreTarballPath: string,
    mcpTarballPath: string,
    cliTarballPath: string,
    smokeExecDir: string,
    env: NodeJS.ProcessEnv,
): void {
    execFileSync("npm", [
        ...npmExecArgs(coreTarballPath, mcpTarballPath, cliTarballPath),
        "satori-cli",
        ...commandArgs,
    ], {
        cwd: smokeExecDir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
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
        runCliSmoke(["--help"], coreTarballPath, mcpTarballPath, cliTarballPath, smokeExecDir, baseEnv);
        const packedMcpRoot = resolvePackedMcpRoot(
            coreTarballPath,
            mcpTarballPath,
            cliTarballPath,
            smokeExecDir,
            baseEnv,
        );
        const doctorEnv = packedPotionSmokeEnv(baseEnv, packedMcpRoot, smokeHomeDir);
        runCliSmoke(["doctor"], coreTarballPath, mcpTarballPath, cliTarballPath, smokeExecDir, doctorEnv);
        console.log("[release:smoke] CLI tarball starts and doctor accepts the packed offline Potion runtime.");
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

main();
