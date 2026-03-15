import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

interface PackageJsonShape {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
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
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "..", "..", "package.json");
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

function resolveWorkspaceDependencyVersion(packageJsonPath: string, dependencyName: string): string | null {
    const packageRoot = path.dirname(packageJsonPath);
    const repoRoot = path.resolve(packageRoot, "..", "..");
    const packagesRoot = path.join(repoRoot, "packages");
    if (!fs.existsSync(packagesRoot)) {
        return null;
    }

    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidatePath = path.join(packagesRoot, entry.name, "package.json");
        if (!fs.existsSync(candidatePath)) {
            continue;
        }
        const candidate = readPackageJson(candidatePath);
        if (candidate.name === dependencyName && looksLikeExactVersion(candidate.version)) {
            return candidate.version;
        }
    }

    return null;
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
    } catch (error) {
        if (relation === "self") {
            throw new CliError(
                "E_USAGE",
                `Cannot install ${ownerPackageName}@${ownerPackageVersion} because that package version is not published on npm. Publish ${ownerPackageName}@${ownerPackageVersion} first or use a local dev server config instead.`,
                2
            );
        }
        throw new CliError(
            "E_USAGE",
            `Cannot install ${ownerPackageName}@${ownerPackageVersion} because required dependency ${packageName}@${version} is not published on npm. Publish ${packageName}@${version} first, then rerun satori-cli install.`,
            2
        );
    }
}

export function verifyManagedPackageInstallability(options: PackageInstallabilityOptions = {}): string {
    const packageJsonPath = options.packageJsonPath ?? resolveDefaultPackageJsonPath();
    const execImpl = options.execFileSyncImpl ?? execFileSync;
    const pkg = readPackageJson(packageJsonPath);
    const packageSpecifier = `${pkg.name}@${pkg.version}`;

    assertPublishedVersion(pkg.name, pkg.version, pkg.name, pkg.version, execImpl, "self");

    for (const [dependencyName, rawDependencyVersion] of Object.entries(pkg.dependencies ?? {})) {
        const dependencyVersion = looksLikeExactVersion(rawDependencyVersion)
            ? rawDependencyVersion
            : rawDependencyVersion.startsWith("workspace:")
                ? resolveWorkspaceDependencyVersion(packageJsonPath, dependencyName)
                : null;

        if (!dependencyVersion) {
            continue;
        }
        assertPublishedVersion(dependencyName, dependencyVersion, pkg.name, pkg.version, execImpl, "dependency");
    }

    return packageSpecifier;
}

export function runPublishedPackageReleaseSmoke(options: ReleaseSmokeOptions = {}): void {
    const packageJsonPath = options.packageJsonPath ?? resolveDefaultPackageJsonPath();
    const packageRoot = options.packageRoot ?? path.dirname(packageJsonPath);
    const tempDir = options.tempDir ?? os.tmpdir();
    const execImpl = options.execFileSyncImpl ?? execFileSync;

    verifyManagedPackageInstallability({ packageJsonPath, execFileSyncImpl: execImpl });

    const smokePackDir = fs.mkdtempSync(path.join(tempDir, "satori-release-smoke-"));
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
        execImpl("npm", ["exec", "--yes", "--package", tarballPath, "--", "satori", "--help"], {
            cwd: tempDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        const output = npmOutput(error);
        const pkg = readPackageJson(packageJsonPath);
        throw new CliError(
            "E_USAGE",
            `Release smoke failed for ${pkg.name}@${pkg.version}. The packed tarball did not start via 'npm exec --yes --package <tarball> -- satori --help'. ${output}`,
            2
        );
    } finally {
        fs.rmSync(smokePackDir, { recursive: true, force: true });
    }
}
