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

function isolatedSmokeEnv(smokeHomeDir: string): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => !PNPM_ONLY_NPM_ENV_KEYS.has(key.toUpperCase()),
    ));
    return {
        ...env,
        HOME: smokeHomeDir,
        USERPROFILE: smokeHomeDir,
        XDG_CONFIG_HOME: path.join(smokeHomeDir, ".config"),
        EMBEDDING_PROVIDER: "Ollama",
        MILVUS_ADDRESS: "localhost:19530",
        npm_config_cache: path.join(smokeHomeDir, ".npm"),
        npm_config_package_lock: "false",
    };
}

function runCliSmoke(
    commandArgs: string[],
    coreTarballPath: string,
    mcpTarballPath: string,
    cliTarballPath: string,
    smokeExecDir: string,
    smokeHomeDir: string,
): void {
    execFileSync("npm", [
        "exec",
        "--yes",
        "--package",
        coreTarballPath,
        "--package",
        mcpTarballPath,
        "--package",
        cliTarballPath,
        "--",
        "satori-cli",
        ...commandArgs,
    ], {
        cwd: smokeExecDir,
        encoding: "utf8",
        env: isolatedSmokeEnv(smokeHomeDir),
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
        runCliSmoke(["--help"], coreTarballPath, mcpTarballPath, cliTarballPath, smokeExecDir, smokeHomeDir);
        runCliSmoke(["doctor"], coreTarballPath, mcpTarballPath, cliTarballPath, smokeExecDir, smokeHomeDir);
        console.log("[release:smoke] CLI tarball starts and runs doctor via npm exec.");
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
