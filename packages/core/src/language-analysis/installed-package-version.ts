import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Resolves the version an installed dependency advertises in its own manifest.
 *
 * The resolver is anchored in this module, not the process cwd, so compiling
 * to `dist/` and running from another directory still reads core's installed
 * packages. Identity assembly treats a missing or malformed version as fatal:
 * returning a fallback would let stale identity silently survive an update.
 */

export interface PackageManifestResolver {
    resolve(request: string): string;
}

const localRequire = createRequire(__filename);

interface PackageManifest {
    readonly name?: unknown;
    readonly version?: unknown;
}

function readValidatedVersion(manifestPath: string, packageName: string): string {
    let text: string;
    try {
        text = fs.readFileSync(manifestPath, 'utf8');
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read installed package manifest for '${packageName}' at ${manifestPath}: ${reason}`, { cause: error });
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Installed package manifest for '${packageName}' at ${manifestPath} is not valid JSON: ${reason}`, { cause: error });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Installed package manifest for '${packageName}' at ${manifestPath} is not a JSON object`);
    }

    const manifest = parsed as PackageManifest;
    if (manifest.name !== packageName) {
        throw new Error(
            `Installed package manifest at ${manifestPath} declares name '${String(manifest.name)}', expected '${packageName}'`,
        );
    }
    if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
        throw new Error(`Installed package '${packageName}' at ${manifestPath} declares no valid version`);
    }
    return manifest.version;
}

/** Reads a dependency manifest through its exported `<name>/package.json`. */
export function installedPackageVersion(
    packageName: string,
    resolver: PackageManifestResolver = localRequire,
): string {
    return readValidatedVersion(resolver.resolve(`${packageName}/package.json`), packageName);
}

/**
 * Reads a dependency manifest beside its resolved entry.
 *
 * `web-tree-sitter` forbids exporting `package.json` while its resolved entry
 * sits at the package root, so the manifest is read relative to that entry.
 */
export function installedPackageRootVersion(
    packageName: string,
    resolver: PackageManifestResolver = localRequire,
): string {
    const entryPath = resolver.resolve(packageName);
    return readValidatedVersion(path.join(path.dirname(entryPath), 'package.json'), packageName);
}
