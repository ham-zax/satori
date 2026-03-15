import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

interface ManagedPackageJsonShape {
    name?: unknown;
    version?: unknown;
    main?: unknown;
}

const MANAGED_PACKAGE_NAME = "@zokizuan/satori-mcp";
const require = createRequire(import.meta.url);

function fallbackManagedPackageJsonPath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "..", "..", "mcp", "package.json");
}

export function resolveManagedPackageJsonPath(): string {
    try {
        return require.resolve(`${MANAGED_PACKAGE_NAME}/package.json`);
    } catch {
        const fallbackPath = fallbackManagedPackageJsonPath();
        if (fs.existsSync(fallbackPath)) {
            return fallbackPath;
        }
        throw new CliError(
            "E_USAGE",
            `Unable to resolve installed package metadata for ${MANAGED_PACKAGE_NAME}. Install ${MANAGED_PACKAGE_NAME} or use a local dev server config instead.`,
            2
        );
    }
}

export function resolveManagedPackageRoot(): string {
    return path.dirname(resolveManagedPackageJsonPath());
}

export function readManagedPackageJson(): Required<Pick<ManagedPackageJsonShape, "name" | "version">> & ManagedPackageJsonShape {
    const packageJsonPath = resolveManagedPackageJsonPath();
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as ManagedPackageJsonShape;
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
        throw new CliError(
            "E_USAGE",
            `Unable to read valid package metadata from ${packageJsonPath}.`,
            2
        );
    }
    return parsed as Required<Pick<ManagedPackageJsonShape, "name" | "version">> & ManagedPackageJsonShape;
}

export function resolveManagedPackageSpecifier(): string {
    const pkg = readManagedPackageJson();
    return `${pkg.name}@${pkg.version}`;
}
