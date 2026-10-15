import path from "node:path";
import fs from "node:fs";
import {
    MANAGED_BIN_DIR,
    MANAGED_LAUNCHER_FILE,
    MANAGED_RUNTIME_DIR,
    type ManagedRuntimeCommand,
} from "./install-contracts.js";

export function packageNameFromSpecifier(packageSpecifier: string): string {
    if (packageSpecifier.startsWith("@")) {
        const versionMarker = packageSpecifier.indexOf("@", 1);
        return versionMarker === -1 ? packageSpecifier : packageSpecifier.slice(0, versionMarker);
    }
    const versionMarker = packageSpecifier.indexOf("@");
    return versionMarker === -1 ? packageSpecifier : packageSpecifier.slice(0, versionMarker);
}

export function safeRuntimeDirName(packageSpecifier: string): string {
    return packageSpecifier.replace(/[^A-Za-z0-9._@-]+/g, "-");
}

export function resolveRuntimeRoot(homeDir: string, packageSpecifier: string): string {
    return path.join(homeDir, ".satori", MANAGED_RUNTIME_DIR, safeRuntimeDirName(packageSpecifier));
}

export function resolveRuntimePackageRoot(homeDir: string, packageSpecifier: string): string {
    return path.join(resolveRuntimeRoot(homeDir, packageSpecifier), "node_modules", ...packageNameFromSpecifier(packageSpecifier).split("/"));
}

export function resolveRuntimePackageRootFromRoot(runtimeRoot: string, packageSpecifier: string): string {
    return path.join(runtimeRoot, "node_modules", ...packageNameFromSpecifier(packageSpecifier).split("/"));
}

export function resolvePotionAssetsRoot(packageRoot: string): string {
    return path.join(packageRoot, "assets", "potion", "linux-x64");
}

export function resolveRuntimeEntryPath(packageRoot: string, packageJson?: { bin?: unknown; main?: unknown }): string {
    const bin = packageJson?.bin;
    let relativeEntry = "dist/index.js";
    if (bin && typeof bin === "object" && !Array.isArray(bin) && typeof (bin as Record<string, unknown>).satori === "string") {
        relativeEntry = (bin as Record<string, string>).satori;
    } else if (typeof bin === "string") {
        relativeEntry = bin;
    } else if (typeof packageJson?.main === "string") {
        relativeEntry = packageJson.main;
    }
    return path.resolve(packageRoot, relativeEntry);
}

export function resolveLauncherPath(homeDir: string): string {
    return path.join(homeDir, ".satori", MANAGED_BIN_DIR, MANAGED_LAUNCHER_FILE);
}

export function plannedManagedRuntimeCommand(homeDir: string, packageSpecifier: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(resolveRuntimePackageRoot(homeDir, packageSpecifier))],
    };
}

export function resolveManagedClientCommand(homeDir: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveLauncherPath(homeDir)],
    };
}

/** Ownership is this home's launcher exactly; another home's launcher belongs to that install. */
export function isManagedLauncherPath(value: unknown, expectedLauncher: string): value is string {
    return typeof value === "string" && canonicalPath(value) === canonicalPath(expectedLauncher);
}

/**
 * Resolves symlinks through the deepest existing ancestor, so a symlinked HOME
 * spelling matches even while the launcher file itself does not exist yet.
 */
function canonicalPath(value: string): string {
    const missing: string[] = [];
    let current = path.resolve(value);
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...missing.reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(value);
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

export function isManagedCommandParts(command: unknown, args: unknown, expectedLauncher: string): boolean {
    if (!Array.isArray(args)) {
        return false;
    }

    const entryPath = args[0];
    return typeof command === "string"
        && command.length > 0
        && args.length === 1
        && isManagedLauncherPath(entryPath, expectedLauncher);
}
