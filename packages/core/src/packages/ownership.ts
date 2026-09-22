import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateRepositoryRelativePath } from '../paths/repository-path';
import { compareContractStrings } from '../utils/compare-contract-strings';

export const PACKAGE_OWNERSHIP_SCHEMA_VERSION = 'package_ownership_v1';

export type PackageWorkspaceKind = 'pnpm' | 'package_json';

export interface PackageWorkspaceRecord {
    readonly kind: PackageWorkspaceKind;
    readonly root: '';
    readonly manifestPath: string;
    readonly patterns: readonly string[];
}

export interface PackageOwnershipPackage {
    readonly ecosystem: 'node';
    readonly root: string;
    readonly manifestPath: string;
    readonly name: string | null;
    readonly workspaceMember: boolean;
}

export interface PackageFileOwnership {
    readonly path: string;
    readonly packageRoot: string | null;
}

export interface PublicationPackageOwnership {
    readonly schemaVersion: typeof PACKAGE_OWNERSHIP_SCHEMA_VERSION;
    readonly canonicalRoot: string;
    readonly workspace: PackageWorkspaceRecord | null;
    readonly packages: readonly PackageOwnershipPackage[];
    readonly files: readonly PackageFileOwnership[];
    readonly controlFiles: readonly (readonly [string, string])[];
}

export interface DiscoveredPackageOwnership {
    readonly workspace: PackageWorkspaceRecord | null;
    readonly packages: readonly PackageOwnershipPackage[];
    readonly controlFiles: readonly (readonly [string, string])[];
}

type NativeGlobSync = (
    pattern: string,
    options: {
        cwd: string;
        withFileTypes?: false;
    },
) => string[];

function canonicalizeRoot(root: string): string {
    const absolute = path.resolve(root);
    try {
        return fs.realpathSync.native(absolute);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
        throw error;
    }
}

function normalizeRelativePath(candidate: string, allowRoot = false): string {
    const normalized = candidate
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
    if (allowRoot && (normalized === '' || normalized === '.')) return '';
    return validateRepositoryRelativePath(normalized);
}

function hashBytes(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readControlFile(
    canonicalRoot: string,
    relativePath: string,
): { bytes: Buffer; hash: string } | null {
    const normalized = normalizeRelativePath(relativePath);
    const absolutePath = path.join(canonicalRoot, normalized);
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(absolutePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return null;

    const realPath = fs.realpathSync.native(absolutePath);
    if (realPath !== absolutePath) return null;

    const bytes = fs.readFileSync(realPath);
    return { bytes, hash: hashBytes(bytes) };
}

function stripYamlComment(value: string): string {
    let singleQuoted = false;
    let doubleQuoted = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char === "'" && !doubleQuoted) {
            if (singleQuoted && value[index + 1] === "'") {
                index += 1;
                continue;
            }
            singleQuoted = !singleQuoted;
            continue;
        }
        if (char === '"' && !singleQuoted && value[index - 1] !== '\\') {
            doubleQuoted = !doubleQuoted;
            continue;
        }
        if (char === '#' && !singleQuoted && !doubleQuoted) {
            return value.slice(0, index).trimEnd();
        }
    }
    return value.trimEnd();
}

function parseYamlScalar(raw: string): string {
    const value = stripYamlComment(raw).trim();
    if (value.length === 0) {
        throw new Error('pnpm workspace package pattern must not be empty.');
    }
    if (value.startsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(value);
            if (typeof parsed === 'string') return parsed;
        } catch {
            // Fall through to the unsupported syntax error below.
        }
        throw new Error('Unsupported pnpm workspace package scalar: ' + value);
    }
    if (value.startsWith("'")) {
        if (!value.endsWith("'") || value.length < 2) {
            throw new Error('Unsupported pnpm workspace package scalar: ' + value);
        }
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (/[:{}\[\],&|>@]/.test(value)) {
        throw new Error('Unsupported pnpm workspace package scalar: ' + value);
    }
    return value;
}

function parseInlineYamlList(raw: string): string[] {
    const value = stripYamlComment(raw).trim();
    if (!value.startsWith('[') || !value.endsWith(']')) {
        throw new Error('Unsupported pnpm workspace packages syntax.');
    }

    const body = value.slice(1, -1);
    const items: string[] = [];
    let start = 0;
    let singleQuoted = false;
    let doubleQuoted = false;

    for (let index = 0; index <= body.length; index += 1) {
        const char = body[index];
        if (index < body.length) {
            if (char === "'" && !doubleQuoted) {
                if (singleQuoted && body[index + 1] === "'") {
                    index += 1;
                    continue;
                }
                singleQuoted = !singleQuoted;
                continue;
            }
            if (char === '"' && !singleQuoted && body[index - 1] !== '\\') {
                doubleQuoted = !doubleQuoted;
                continue;
            }
        }
        if (index === body.length || (char === ',' && !singleQuoted && !doubleQuoted)) {
            const item = body.slice(start, index).trim();
            if (item.length > 0) items.push(parseYamlScalar(item));
            start = index + 1;
        }
    }

    if (singleQuoted || doubleQuoted) {
        throw new Error('Unsupported pnpm workspace packages syntax.');
    }
    return items;
}

function normalizeWorkspacePattern(raw: string): string {
    const normalizedRaw = raw.replace(/\\/g, '/');
    if (
        /[{}\[\]]/.test(normalizedRaw)
        || /[!@+?*]\(/.test(normalizedRaw)
    ) {
        throw new Error("Invalid workspace package pattern '" + raw + "'.");
    }

    const negated = normalizedRaw.startsWith('!');
    const body = (negated ? normalizedRaw.slice(1) : normalizedRaw)
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
    if (
        body.length === 0
        || body.startsWith('/')
        || /^[A-Za-z]:/.test(body)
        || body.split('/').some((segment) => segment === '..')
    ) {
        throw new Error("Invalid workspace package pattern '" + raw + "'.");
    }
    return negated ? '!' + body : body;
}

function parsePnpmWorkspacePatterns(source: string): string[] {
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const rawLine = stripYamlComment(lines[index]);
        if (rawLine.trim().length === 0) continue;

        const match = /^(\s*)packages\s*:\s*(.*)$/.exec(rawLine);
        if (!match) continue;
        if (match[1].length !== 0) {
            throw new Error('pnpm workspace packages must be declared at the document root.');
        }

        const inline = match[2].trim();
        if (inline.length > 0) {
            return parseInlineYamlList(inline).map(normalizeWorkspacePattern);
        }

        const patterns: string[] = [];
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const candidate = stripYamlComment(lines[cursor]);
            if (candidate.trim().length === 0) continue;

            const indentation = /^\s*/.exec(candidate)?.[0].length ?? 0;
            if (indentation === 0) break;

            const item = /^\s*-\s+(.+)$/.exec(candidate);
            if (!item) {
                throw new Error('Unsupported pnpm workspace packages syntax.');
            }
            patterns.push(normalizeWorkspacePattern(parseYamlScalar(item[1])));
        }
        return patterns;
    }
    return [];
}

function parsePackageJson(bytes: Buffer): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function packageName(manifest: Record<string, unknown> | null): string | null {
    return typeof manifest?.name === 'string' && manifest.name.trim().length > 0
        ? manifest.name.trim()
        : null;
}

function packageJsonWorkspacePatterns(
    manifest: Record<string, unknown> | null,
): string[] | null {
    if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, 'workspaces')) {
        return null;
    }

    const raw = manifest.workspaces;
    let entries: unknown;
    if (Array.isArray(raw)) {
        entries = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        entries = (raw as Record<string, unknown>).packages;
    }

    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
        throw new Error('Unsupported package.json workspaces declaration.');
    }
    return entries.map((entry) => normalizeWorkspacePattern(String(entry)));
}

function nativeGlobSync(): NativeGlobSync {
    const candidate = (fs as unknown as { globSync?: NativeGlobSync }).globSync;
    if (typeof candidate !== 'function') {
        throw new Error('Package ownership requires Node.js fs.globSync support.');
    }
    return candidate;
}

function packageManifestMatchesForPattern(
    canonicalRoot: string,
    pattern: string,
): string[] {
    const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    const manifestPattern = body === '.'
        ? 'package.json'
        : body + '/package.json';

    return nativeGlobSync()(manifestPattern, {
        cwd: canonicalRoot,
        withFileTypes: false,
    })
        .map((candidate) => normalizeRelativePath(candidate))
        .filter((candidate) => (
            !candidate.split('/').includes('node_modules')
            && !candidate.split('/').includes('.git')
        ))
        .sort(compareContractStrings);
}

function discoverWorkspaceManifestPaths(
    canonicalRoot: string,
    patterns: readonly string[],
): string[] {
    const included = new Set<string>();
    for (const pattern of patterns.filter((candidate) => !candidate.startsWith('!'))) {
        for (const candidate of packageManifestMatchesForPattern(canonicalRoot, pattern)) {
            included.add(candidate);
        }
    }
    for (const pattern of patterns.filter((candidate) => candidate.startsWith('!'))) {
        for (const candidate of packageManifestMatchesForPattern(canonicalRoot, pattern)) {
            included.delete(candidate);
        }
    }
    return [...included].sort(compareContractStrings);
}

function packageRootForManifest(manifestPath: string): string {
    const directory = path.posix.dirname(manifestPath);
    return directory === '.' ? '' : normalizeRelativePath(directory, true);
}

function packageForManifest(
    canonicalRoot: string,
    manifestPath: string,
    workspaceMember: boolean,
): { record: PackageOwnershipPackage; control: readonly [string, string] } | null {
    const read = readControlFile(canonicalRoot, manifestPath);
    if (!read) return null;
    return {
        record: {
            ecosystem: 'node',
            root: packageRootForManifest(manifestPath),
            manifestPath,
            name: packageName(parsePackageJson(read.bytes)),
            workspaceMember,
        },
        control: [manifestPath, read.hash] as const,
    };
}

function comparePackageRecords(
    left: PackageOwnershipPackage,
    right: PackageOwnershipPackage,
): number {
    return compareContractStrings(left.root, right.root)
        || compareContractStrings(left.manifestPath, right.manifestPath);
}

export function discoverPackageOwnership(
    canonicalRootInput: string,
): DiscoveredPackageOwnership {
    const canonicalRoot = canonicalizeRoot(canonicalRootInput);
    const controls = new Map<string, string>();
    const packages: PackageOwnershipPackage[] = [];

    const rootManifestPath = 'package.json';
    const rootManifest = readControlFile(canonicalRoot, rootManifestPath);
    const parsedRootManifest = rootManifest ? parsePackageJson(rootManifest.bytes) : null;
    if (rootManifest) {
        controls.set(rootManifestPath, rootManifest.hash);
        packages.push({
            ecosystem: 'node',
            root: '',
            manifestPath: rootManifestPath,
            name: packageName(parsedRootManifest),
            workspaceMember: false,
        });
    }

    const pnpmWorkspacePath = 'pnpm-workspace.yaml';
    const pnpmWorkspace = readControlFile(canonicalRoot, pnpmWorkspacePath);
    if (pnpmWorkspace) {
        controls.set(pnpmWorkspacePath, pnpmWorkspace.hash);
        const patterns = parsePnpmWorkspacePatterns(pnpmWorkspace.bytes.toString('utf8'));
        for (const manifestPath of discoverWorkspaceManifestPaths(canonicalRoot, patterns)) {
            if (manifestPath === rootManifestPath) continue;
            const discovered = packageForManifest(canonicalRoot, manifestPath, true);
            if (!discovered) continue;
            packages.push(discovered.record);
            controls.set(discovered.control[0], discovered.control[1]);
        }
        return {
            workspace: {
                kind: 'pnpm',
                root: '',
                manifestPath: pnpmWorkspacePath,
                patterns: [...patterns],
            },
            packages: packages.sort(comparePackageRecords),
            controlFiles: [...controls.entries()]
                .sort(([left], [right]) => compareContractStrings(left, right)),
        };
    }

    if (!rootManifest) {
        return {
            workspace: null,
            packages: [],
            controlFiles: [],
        };
    }

    const workspacePatterns = packageJsonWorkspacePatterns(parsedRootManifest);
    if (workspacePatterns !== null) {
        for (const manifestPath of discoverWorkspaceManifestPaths(canonicalRoot, workspacePatterns)) {
            if (manifestPath === rootManifestPath) continue;
            const discovered = packageForManifest(canonicalRoot, manifestPath, true);
            if (!discovered) continue;
            packages.push(discovered.record);
            controls.set(discovered.control[0], discovered.control[1]);
        }
        return {
            workspace: {
                kind: 'package_json',
                root: '',
                manifestPath: rootManifestPath,
                patterns: [...workspacePatterns],
            },
            packages: packages.sort(comparePackageRecords),
            controlFiles: [...controls.entries()]
                .sort(([left], [right]) => compareContractStrings(left, right)),
        };
    }

    return {
        workspace: null,
        packages,
        controlFiles: [...controls.entries()]
            .sort(([left], [right]) => compareContractStrings(left, right)),
    };
}

function nearestPackageRoot(
    packages: readonly PackageOwnershipPackage[],
    filePath: string,
): string | null {
    let best: string | null = null;
    for (const candidate of packages) {
        if (
            candidate.root === ''
            || filePath === candidate.root
            || filePath.startsWith(candidate.root + '/')
        ) {
            if (best === null || candidate.root.length > best.length) {
                best = candidate.root;
            }
        }
    }
    return best;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
): boolean {
    const actual = Object.keys(value).sort(compareContractStrings);
    const expected = [...keys].sort(compareContractStrings);
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function validatePackageRoot(value: unknown): string | null {
    if (value === '') return '';
    if (typeof value !== 'string') return null;
    try {
        return normalizeRelativePath(value, true);
    } catch {
        return null;
    }
}

export function parsePublicationPackageOwnership(
    data: string,
    expectedCanonicalRoot: string,
): PublicationPackageOwnership {
    const parsed: unknown = JSON.parse(data);
    if (
        !isRecord(parsed)
        || !hasExactKeys(
            parsed,
            ['schemaVersion', 'canonicalRoot', 'workspace', 'packages', 'files', 'controlFiles'],
        )
        || parsed.schemaVersion !== PACKAGE_OWNERSHIP_SCHEMA_VERSION
        || parsed.canonicalRoot !== expectedCanonicalRoot
        || !Array.isArray(parsed.packages)
        || !Array.isArray(parsed.files)
        || !Array.isArray(parsed.controlFiles)
    ) {
        throw new Error('Invalid or unsupported Publication package ownership snapshot.');
    }

    let workspace: PackageWorkspaceRecord | null = null;
    if (parsed.workspace !== null) {
        if (
            !isRecord(parsed.workspace)
            || !hasExactKeys(parsed.workspace, ['kind', 'root', 'manifestPath', 'patterns'])
            || (parsed.workspace.kind !== 'pnpm' && parsed.workspace.kind !== 'package_json')
            || parsed.workspace.root !== ''
            || typeof parsed.workspace.manifestPath !== 'string'
            || !Array.isArray(parsed.workspace.patterns)
            || parsed.workspace.patterns.some((entry) => typeof entry !== 'string')
        ) {
            throw new Error('Invalid Publication package workspace record.');
        }
        const workspaceKind = parsed.workspace.kind;
        const workspaceManifestPath = normalizeRelativePath(parsed.workspace.manifestPath);
        const expectedWorkspaceManifestPath = workspaceKind === 'pnpm'
            ? 'pnpm-workspace.yaml'
            : 'package.json';
        if (workspaceManifestPath !== expectedWorkspaceManifestPath) {
            throw new Error('Publication package workspace manifest path does not match its workspace kind.');
        }
        workspace = {
            kind: workspaceKind,
            root: '',
            manifestPath: workspaceManifestPath,
            patterns: parsed.workspace.patterns.map((entry) => normalizeWorkspacePattern(String(entry))),
        };
    }

    const packageRoots = new Set<string>();
    const packages: PackageOwnershipPackage[] = parsed.packages.map((entry) => {
        if (
            !isRecord(entry)
            || !hasExactKeys(entry, ['ecosystem', 'root', 'manifestPath', 'name', 'workspaceMember'])
            || entry.ecosystem !== 'node'
            || typeof entry.manifestPath !== 'string'
            || (entry.name !== null && typeof entry.name !== 'string')
            || typeof entry.workspaceMember !== 'boolean'
        ) {
            throw new Error('Invalid Publication package record.');
        }

        const root = validatePackageRoot(entry.root);
        if (root === null || packageRoots.has(root)) {
            throw new Error('Invalid or duplicate Publication package root.');
        }
        packageRoots.add(root);

        const manifestPath = normalizeRelativePath(entry.manifestPath);
        const expectedManifestPath = root === '' ? 'package.json' : root + '/package.json';
        if (manifestPath !== expectedManifestPath) {
            throw new Error('Publication package manifest path does not match its package root.');
        }

        const name = entry.name === null ? null : entry.name.trim();
        if (name !== null && (name.length === 0 || name !== entry.name)) {
            throw new Error('Invalid Publication package identity.');
        }
        if (root === '' && entry.workspaceMember) {
            throw new Error('Publication workspace root package cannot be marked as a workspace member.');
        }
        if (root !== '' && (!workspace || !entry.workspaceMember)) {
            throw new Error('Publication child package must be a workspace member.');
        }

        return {
            ecosystem: 'node' as const,
            root,
            manifestPath,
            name,
            workspaceMember: entry.workspaceMember,
        };
    }).sort(comparePackageRecords);

    if (
        workspace?.kind === 'package_json'
        && !packages.some((entry) => entry.root === '')
    ) {
        throw new Error('package.json workspace Publication is missing its root package.');
    }

    const seenFiles = new Set<string>();
    const files: PackageFileOwnership[] = parsed.files.map((entry) => {
        if (
            !isRecord(entry)
            || !hasExactKeys(entry, ['path', 'packageRoot'])
            || typeof entry.path !== 'string'
            || (entry.packageRoot !== null && typeof entry.packageRoot !== 'string')
        ) {
            throw new Error('Invalid Publication file package ownership record.');
        }

        const filePath = normalizeRelativePath(entry.path);
        if (seenFiles.has(filePath)) {
            throw new Error('Duplicate Publication file package ownership path.');
        }
        seenFiles.add(filePath);

        const packageRoot = entry.packageRoot === null
            ? null
            : validatePackageRoot(entry.packageRoot);
        if (packageRoot === null && entry.packageRoot !== null) {
            throw new Error('Invalid Publication file package owner root.');
        }
        if (packageRoot !== null && !packageRoots.has(packageRoot)) {
            throw new Error('Publication file package owner does not name a persisted package root.');
        }
        if (packageRoot !== nearestPackageRoot(packages, filePath)) {
            throw new Error('Publication file package owner is not the nearest enclosing package root.');
        }

        return { path: filePath, packageRoot };
    }).sort((left, right) => compareContractStrings(left.path, right.path));

    const seenControls = new Set<string>();
    const controlFiles: Array<readonly [string, string]> = parsed.controlFiles.map((entry) => {
        if (
            !Array.isArray(entry)
            || entry.length !== 2
            || typeof entry[0] !== 'string'
            || typeof entry[1] !== 'string'
            || !/^[a-f0-9]{64}$/.test(entry[1])
        ) {
            throw new Error('Invalid Publication package ownership control file.');
        }

        const controlPath = normalizeRelativePath(entry[0]);
        if (seenControls.has(controlPath)) {
            throw new Error('Duplicate Publication package ownership control path.');
        }
        seenControls.add(controlPath);
        return [controlPath, entry[1]] as const;
    }).sort(([left], [right]) => compareContractStrings(left, right));

    const expectedControlPaths = new Set<string>();
    if (workspace) expectedControlPaths.add(workspace.manifestPath);
    for (const pkg of packages) expectedControlPaths.add(pkg.manifestPath);
    if (
        seenControls.size !== expectedControlPaths.size
        || [...expectedControlPaths].some((controlPath) => !seenControls.has(controlPath))
    ) {
        throw new Error('Publication package ownership control set does not match its package/workspace manifests.');
    }

    return {
        schemaVersion: PACKAGE_OWNERSHIP_SCHEMA_VERSION,
        canonicalRoot: expectedCanonicalRoot,
        workspace,
        packages,
        files,
        controlFiles,
    };
}

export function computePublicationPackageOwnershipDigest(
    ownership: PublicationPackageOwnership,
): string {
    const validated = parsePublicationPackageOwnership(
        JSON.stringify(ownership),
        ownership.canonicalRoot,
    );
    return hashBytes(Buffer.from(JSON.stringify(validated), 'utf8'));
}

export function buildPublicationPackageOwnership(
    canonicalRootInput: string,
    indexedFiles: readonly string[],
    observedFileHashes: ReadonlyMap<string, string>,
): PublicationPackageOwnership {
    const canonicalRoot = canonicalizeRoot(canonicalRootInput);
    const discovered = discoverPackageOwnership(canonicalRoot);

    for (const [controlPath, observedHash] of discovered.controlFiles) {
        if (observedFileHashes.get(controlPath) !== observedHash) {
            throw new Error(
                "Package ownership control '" + controlPath
                + "' does not match the prepared Publication source observation.",
            );
        }
    }

    const files = [...new Set(indexedFiles.map((candidate) => normalizeRelativePath(candidate)))]
        .sort(compareContractStrings)
        .map((filePath) => ({
            path: filePath,
            packageRoot: nearestPackageRoot(discovered.packages, filePath),
        }));

    const snapshot: PublicationPackageOwnership = {
        schemaVersion: PACKAGE_OWNERSHIP_SCHEMA_VERSION,
        canonicalRoot,
        workspace: discovered.workspace,
        packages: discovered.packages,
        files,
        controlFiles: discovered.controlFiles,
    };
    return parsePublicationPackageOwnership(JSON.stringify(snapshot), canonicalRoot);
}
