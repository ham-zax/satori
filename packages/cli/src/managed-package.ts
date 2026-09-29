import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

const MANAGED_PACKAGE_NAME = "@satori-code/mcp";
const CORE_PACKAGE_NAME = "@satori-code/core";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export interface ManagedRuntimeRelease {
    mcp: string;
    core: string;
    lanceDb: string;
    oxcParser: string;
    lateOn: {
        transformers: string;
        onnxruntimeNode: string;
        sharpNativePackages: Readonly<Record<string, readonly string[]>>;
    };
}

interface CliPackageJsonShape {
    name?: unknown;
    version?: unknown;
    satoriManagedRuntime?: unknown;
}

export function resolveCliPackageJsonPath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "..", "package.json");
}

function exactVersion(value: unknown, field: string): string {
    if (typeof value !== "string" || !EXACT_VERSION.test(value)) {
        throw new CliError(
            "E_USAGE",
            `CLI managed-runtime metadata field ${field} must be an exact major.minor.patch version; received ${JSON.stringify(value)}.`,
            2,
        );
    }
    return value;
}

export function readManagedRuntimeRelease(): ManagedRuntimeRelease {
    const packageJsonPath = resolveCliPackageJsonPath();
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as CliPackageJsonShape;
    const raw = parsed.satoriManagedRuntime;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CliError("E_USAGE", `CLI package metadata at ${packageJsonPath} has no satoriManagedRuntime contract.`, 2);
    }
    const release = raw as Record<string, unknown>;
    const lateOnRaw = release.lateOn;
    if (!lateOnRaw || typeof lateOnRaw !== "object" || Array.isArray(lateOnRaw)) {
        throw new CliError("E_USAGE", "CLI managed-runtime metadata has no LateOn runtime contract.", 2);
    }
    const lateOn = lateOnRaw as Record<string, unknown>;
    const sharpRaw = lateOn.sharpNativePackages;
    if (!sharpRaw || typeof sharpRaw !== "object" || Array.isArray(sharpRaw)) {
        throw new CliError("E_USAGE", "CLI managed-runtime metadata has no LateOn Sharp native package map.", 2);
    }
    const sharpNativePackages: Record<string, readonly string[]> = {};
    for (const [platformKey, value] of Object.entries(sharpRaw as Record<string, unknown>)) {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.includes("@"))) {
            throw new CliError("E_USAGE", `CLI managed-runtime Sharp closure for ${platformKey} is invalid.`, 2);
        }
        sharpNativePackages[platformKey] = Object.freeze([...value] as string[]);
    }
    return Object.freeze({
        mcp: exactVersion(release.mcp, "mcp"),
        core: exactVersion(release.core, "core"),
        lanceDb: exactVersion(release.lanceDb, "lanceDb"),
        oxcParser: exactVersion(release.oxcParser, "oxcParser"),
        lateOn: Object.freeze({
            transformers: exactVersion(lateOn.transformers, "lateOn.transformers"),
            onnxruntimeNode: exactVersion(lateOn.onnxruntimeNode, "lateOn.onnxruntimeNode"),
            sharpNativePackages: Object.freeze(sharpNativePackages),
        }),
    });
}

export function resolveManagedPackageSpecifier(): string {
    return `${MANAGED_PACKAGE_NAME}@${readManagedRuntimeRelease().mcp}`;
}

export function resolveManagedCoreSpecifier(): string {
    return `${CORE_PACKAGE_NAME}@${readManagedRuntimeRelease().core}`;
}
