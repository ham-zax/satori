import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CliError } from "./errors.js";
import { satoriCliCommand } from "./cli-command.js";
import { resolveCliPackageJsonPath } from "./managed-package.js";

interface PackageJsonShape {
    name: string;
    version: string;
    satoriManagedRuntime?: {
        mcp?: unknown;
        core?: unknown;
    };
}

type ExecFileSyncLike = typeof execFileSync;

export interface PackageInstallabilityOptions {
    packageJsonPath?: string;
    execFileSyncImpl?: ExecFileSyncLike;
}

export interface ReleaseSmokeOptions extends PackageInstallabilityOptions {
    packageRoot?: string;
    tempDir?: string;
}

function resolveDefaultPackageJsonPath(): string {
    return resolveCliPackageJsonPath();
}

function readPackageJson(packageJsonPath: string): PackageJsonShape {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJsonShape;
}

function looksLikeExactVersion(value: string): boolean {
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
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

function assertPublishedVersion(
    packageName: string,
    version: string,
    ownerPackageName: string,
    ownerPackageVersion: string,
    execImpl: ExecFileSyncLike,
    relation: "self" | "dependency"
): void {
    try {
        execImpl("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch {
        if (relation === "self") {
            throw new CliError(
                "E_USAGE",
                `Cannot install ${ownerPackageName}@${ownerPackageVersion} because that package version is not published on npm. Publish ${ownerPackageName}@${ownerPackageVersion} first or use a local dev server config instead.`,
                2
            );
        }
        throw new CliError(
            "E_USAGE",
            `Cannot install ${ownerPackageName}@${ownerPackageVersion} because required dependency ${packageName}@${version} is not published on npm. Publish ${packageName}@${version} first, then rerun ${satoriCliCommand("install")}.`,
            2
        );
    }
}

export function verifyManagedPackageInstallability(options: PackageInstallabilityOptions = {}): string {
    const packageJsonPath = options.packageJsonPath ?? resolveDefaultPackageJsonPath();
    const execImpl = options.execFileSyncImpl ?? execFileSync;
    const pkg = readPackageJson(packageJsonPath);
    const runtime = pkg.satoriManagedRuntime;
    const mcpVersion = runtime?.mcp;
    const coreVersion = runtime?.core;
    if (!looksLikeExactVersion(String(mcpVersion ?? "")) || !looksLikeExactVersion(String(coreVersion ?? ""))) {
        throw new CliError("E_USAGE", `Cannot install ${pkg.name}@${pkg.version}: satoriManagedRuntime must pin exact MCP and Core versions.`, 2);
    }
    const mcp = String(mcpVersion);
    const core = String(coreVersion);
    assertPublishedVersion("@satori-code/mcp", mcp, pkg.name, pkg.version, execImpl, "dependency");
    assertPublishedVersion("@satori-code/core", core, pkg.name, pkg.version, execImpl, "dependency");
    return `@satori-code/mcp@${mcp}`;
}

export function runPublishedPackageReleaseSmoke(options: ReleaseSmokeOptions = {}): void {
    const packageJsonPath = options.packageJsonPath ?? resolveDefaultPackageJsonPath();
    const packageRoot = options.packageRoot ?? path.dirname(packageJsonPath);
    const tempDir = options.tempDir ?? os.tmpdir();
    const execImpl = options.execFileSyncImpl ?? execFileSync;

    verifyManagedPackageInstallability({ packageJsonPath, execFileSyncImpl: execImpl });

    const smokePackDir = fs.mkdtempSync(path.join(tempDir, "satori-release-smoke-"));
    const smokeExecDir = fs.mkdtempSync(path.join(tempDir, "satori-release-exec-"));
    const beforeFiles = new Set(fs.readdirSync(smokePackDir));
    execImpl("pnpm", ["pack", "--pack-destination", smokePackDir], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    const tarballName = fs.readdirSync(smokePackDir).find((entry) => entry.endsWith(".tgz") && !beforeFiles.has(entry));
    if (!tarballName) {
        throw new CliError("E_USAGE", "Release smoke failed: pnpm pack did not produce a tarball.", 2);
    }

    const tarballPath = path.join(smokePackDir, tarballName);
    try {
        for (const commandName of ["satori", "satori-cli"]) {
            const output = execImpl(
                "npm",
                ["exec", "--yes", "--package", tarballPath, "--", commandName, "--format", "json", "--help"],
                {
                    cwd: smokeExecDir,
                    encoding: "utf8",
                    env: {
                        ...process.env,
                        npm_config_package_lock: "false",
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            const help = JSON.parse(output) as { usage?: unknown };
            if (help.usage !== "satori <command>") {
                throw new Error(`${commandName} did not expose Satori CLI help.`);
            }
        }
    } catch (error) {
        const output = npmOutput(error);
        const pkg = readPackageJson(packageJsonPath);
        throw new CliError(
            "E_USAGE",
            `Release smoke failed for ${pkg.name}@${pkg.version}. The packed tarball did not expose CLI help through the primary and compatibility commands. ${output}`,
            2
        );
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
        fs.rmSync(smokeExecDir, { recursive: true, force: true });
    }
}
