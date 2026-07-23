import { execFileSync } from "node:child_process";
import { CliError } from "./errors.js";

const CLI_PACKAGE_NAME = "@zokizuan/satori-cli";
const MANAGED_PACKAGE_NAME = "@zokizuan/satori-mcp";
const CORE_PACKAGE_NAME = "@zokizuan/satori-core";

type ExecFileSyncLike = typeof execFileSync;

interface PublishedPackageManifest {
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
}

export interface SatoriUpgradeTarget {
    cliPackageSpecifier: string;
    cliVersion: string;
    mcpPackageSpecifier: string;
    mcpVersion: string;
    coreVersion: string;
}

export interface ResolveSatoriUpgradeTargetOptions {
    execFileSyncImpl?: ExecFileSyncLike;
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

export function parseStableVersion(value: unknown, source: string): readonly [number, number, number] {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
        throw new CliError(
            "E_USAGE",
            `${source} must be a stable major.minor.patch version; received ${JSON.stringify(value)}.`,
            2,
        );
    }
    const parts = value.split(".").map((part) => Number.parseInt(part, 10));
    return [parts[0], parts[1], parts[2]];
}

export function compareStableVersions(left: string, right: string): number {
    const leftParts = parseStableVersion(left, "Installed version");
    const rightParts = parseStableVersion(right, "Latest version");
    for (let index = 0; index < leftParts.length; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] < rightParts[index] ? -1 : 1;
        }
    }
    return 0;
}

function readManifest(raw: string): PublishedPackageManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError("E_UPGRADE", `npm returned malformed Satori package metadata: ${message}`, 1);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError("E_UPGRADE", "npm returned an invalid Satori CLI package manifest.", 1);
    }
    return parsed as PublishedPackageManifest;
}

function exactDependency(
    dependencies: Record<string, unknown>,
    packageName: string,
): string {
    const version = dependencies[packageName];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new CliError(
            "E_UPGRADE",
            `${packageName} dependency must be an exact stable major.minor.patch version; received ${JSON.stringify(version)}.`,
            1,
        );
    }
    return version as string;
}

export function resolveSatoriUpgradeTarget(
    options: ResolveSatoriUpgradeTargetOptions = {},
): SatoriUpgradeTarget {
    const execImpl = options.execFileSyncImpl ?? execFileSync;
    let rawManifest: string;
    try {
        rawManifest = execImpl("npm", ["view", `${CLI_PACKAGE_NAME}@latest`, "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        throw new CliError(
            "E_UPGRADE",
            `Unable to resolve the latest Satori release from npm. ${npmOutput(error)}`,
            1,
        );
    }

    const manifest = readManifest(rawManifest);
    if (manifest.name !== CLI_PACKAGE_NAME) {
        throw new CliError(
            "E_UPGRADE",
            `npm resolved an unexpected package identity: ${JSON.stringify(manifest.name)}.`,
            1,
        );
    }
    const cliVersion = manifest.version;
    if (typeof cliVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(cliVersion)) {
        throw new CliError(
            "E_UPGRADE",
            `Latest CLI version must be an exact stable major.minor.patch version; received ${JSON.stringify(cliVersion)}.`,
            1,
        );
    }

    const dependencies = manifest.dependencies;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
        throw new CliError("E_UPGRADE", "Latest Satori CLI manifest has no usable runtime dependencies.", 1);
    }
    const dependencyMap = dependencies as Record<string, unknown>;
    const mcpVersion = exactDependency(dependencyMap, MANAGED_PACKAGE_NAME);
    const coreVersion = exactDependency(dependencyMap, CORE_PACKAGE_NAME);

    return {
        cliPackageSpecifier: `${CLI_PACKAGE_NAME}@${cliVersion}`,
        cliVersion: cliVersion as string,
        mcpPackageSpecifier: `${MANAGED_PACKAGE_NAME}@${mcpVersion}`,
        mcpVersion,
        coreVersion,
    };
}
