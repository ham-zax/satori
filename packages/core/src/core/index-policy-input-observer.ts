import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import {
    parseSatoriRepoConfig,
    SATORI_REPO_CONFIG_FILENAME,
    type SatoriRepoConfig,
} from '../config/repo-config';
import {
    observeIgnoreFileInputs,
    readPolicyControlFile,
    type ObservedIgnoreFile,
} from './ignore-file-inputs';

export const INDEX_POLICY_CONTROL_FILE_NAMES = [
    '.satoriignore',
    '.gitignore',
    SATORI_REPO_CONFIG_FILENAME,
] as const;

export type IndexPolicyControlFileName = typeof INDEX_POLICY_CONTROL_FILE_NAMES[number];

export type ObservedIndexPolicyInputs = Readonly<{
    profileConfig: SatoriRepoConfig;
    fileBasedIgnorePatterns: readonly string[];
    controlSignature: string;
}>;

type ObservedControlFile = Readonly<{
    name: IndexPolicyControlFileName;
    content: Buffer | null;
}>;

async function observeControlFile(
    canonicalRoot: string,
    name: IndexPolicyControlFileName,
): Promise<ObservedControlFile> {
    const filePath = path.join(canonicalRoot, name);
    let pathStat;
    try {
        pathStat = await lstat(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { name, content: null };
        }
        throw error;
    }
    const isIgnoreFile = name === '.satoriignore' || name === '.gitignore';
    if (pathStat.isSymbolicLink()) {
        throw new Error(isIgnoreFile
            ? `Ignore file '${name}' must not be a symbolic link.`
            : `${name} must not be a symbolic link.`);
    }
    if (!pathStat.isFile()) {
        throw new Error(isIgnoreFile
            ? `Ignore file '${name}' is not a regular file.`
            : `${name} is not a regular file.`);
    }

    return { name, content: await readPolicyControlFile(filePath, canonicalRoot, name) };
}

type ObservedControlInputs = Readonly<{
    files: readonly ObservedControlFile[];
    fileBasedIgnorePatterns: string[];
    additionalIgnoreFiles: readonly ObservedIgnoreFile[];
}>;

function digestPart(label: string, content: Buffer): string {
    const digest = createHash('sha256').update(content).digest('hex');
    return `${label}:sha256:${digest}:${content.length}`;
}

// The root parts keep their historical format. Nested `.gitignore` files and
// `.git/info/exclude` are appended only when present, so repositories without
// them keep a byte-identical signature.
function buildControlSignature(inputs: ObservedControlInputs): string {
    const parts = [
        ...inputs.files.map(({ name, content }) => (
            content === null ? `${name}:missing` : digestPart(name, content)
        )),
        ...inputs.additionalIgnoreFiles.map(({ relativePath, content }) => digestPart(relativePath, content)),
    ];
    return `v1:${parts.join('|')}`;
}

/**
 * Search admission recomputes the control signature several times per request,
 * and observing nested `.gitignore` files walks every admitted directory. An
 * observation is reused while every path it read (each walked directory, each
 * control file, and the absent ones) has the same lstat identity: adding,
 * removing, or renaming an entry changes its directory's mtime, and editing a
 * file changes the file's own stat. Like git's racy-index rule, an observation
 * that saw a timestamp close to its own start is not reused, because a later
 * write within the same timestamp tick would be invisible.
 */
type ControlInputsWitness = ReadonlyArray<readonly [relativePath: string, signature: string]>;

const CONTROL_INPUTS_CACHE_ENTRIES = 8;
const RACY_TIMESTAMP_MARGIN_NS = 1_000_000_000n;
const controlInputsCache = new Map<string, { witness: ControlInputsWitness; inputs: ObservedControlInputs }>();

/** Returns null when a timestamp is at or after `racyAfterNs`. */
function witnessSignature(canonicalRoot: string, relativePath: string, racyAfterNs: bigint | null): string | null {
    const stat = lstatSync(path.join(canonicalRoot, relativePath), { bigint: true, throwIfNoEntry: false });
    if (!stat) return 'absent';
    if (racyAfterNs !== null && (stat.mtimeNs >= racyAfterNs || stat.ctimeNs >= racyAfterNs)) return null;
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function isWitnessCurrent(canonicalRoot: string, witness: ControlInputsWitness): boolean {
    try {
        return witness.every(([relativePath, signature]) => (
            witnessSignature(canonicalRoot, relativePath, null) === signature
        ));
    } catch {
        return false;
    }
}

function recordWitness(
    canonicalRoot: string,
    relativePaths: Iterable<string>,
    observationStartedAtMs: number,
): ControlInputsWitness | null {
    const racyAfterNs = BigInt(observationStartedAtMs) * 1_000_000n - RACY_TIMESTAMP_MARGIN_NS;
    const witness: Array<readonly [string, string]> = [];
    try {
        for (const relativePath of new Set(relativePaths)) {
            const signature = witnessSignature(canonicalRoot, relativePath, racyAfterNs);
            if (signature === null || (relativePath === '' && signature === 'absent')) return null;
            witness.push([relativePath, signature]);
        }
    } catch {
        return null;
    }
    return witness;
}

async function observeControlInputs(canonicalRoot: string): Promise<ObservedControlInputs> {
    const cached = controlInputsCache.get(canonicalRoot);
    if (cached && isWitnessCurrent(canonicalRoot, cached.witness)) {
        controlInputsCache.delete(canonicalRoot);
        controlInputsCache.set(canonicalRoot, cached);
        return cached.inputs;
    }
    controlInputsCache.delete(canonicalRoot);

    const observationStartedAtMs = Date.now();
    const visitedDirectories: string[] = [];
    const inputs = await observeControlInputsUncached(canonicalRoot, (directory) => {
        visitedDirectories.push(directory);
    });
    const witness = recordWitness(canonicalRoot, [
        '',
        ...INDEX_POLICY_CONTROL_FILE_NAMES,
        '.git',
        '.git/info',
        ...visitedDirectories,
        ...inputs.additionalIgnoreFiles.map((file) => file.relativePath),
    ], observationStartedAtMs);
    if (witness) {
        controlInputsCache.set(canonicalRoot, { witness, inputs });
        for (const key of controlInputsCache.keys()) {
            if (controlInputsCache.size <= CONTROL_INPUTS_CACHE_ENTRIES) break;
            controlInputsCache.delete(key);
        }
    }
    return inputs;
}

async function observeControlInputsUncached(
    canonicalRoot: string,
    visitDirectory?: (directory: string) => void,
): Promise<ObservedControlInputs> {
    const files: ObservedControlFile[] = [];
    for (const name of INDEX_POLICY_CONTROL_FILE_NAMES) {
        files.push(await observeControlFile(canonicalRoot, name));
    }
    const contentOf = (name: IndexPolicyControlFileName): Buffer | null => (
        files.find((file) => file.name === name)?.content ?? null
    );
    const ignoreInputs = await observeIgnoreFileInputs(canonicalRoot, {
        gitignore: contentOf('.gitignore'),
        satoriignore: contentOf('.satoriignore'),
    }, visitDirectory);
    return {
        files,
        fileBasedIgnorePatterns: ignoreInputs.patterns,
        additionalIgnoreFiles: ignoreInputs.additionalFiles,
    };
}

/**
 * Observe only the ignore control files (the same observation the policy
 * signature covers) and return the ordered file-based ignore patterns.
 */
export async function observeFileBasedIgnorePatterns(canonicalRoot: string): Promise<string[]> {
    const gitignore = await observeControlFile(canonicalRoot, '.gitignore');
    const satoriignore = await observeControlFile(canonicalRoot, '.satoriignore');
    return (await observeIgnoreFileInputs(canonicalRoot, {
        gitignore: gitignore.content,
        satoriignore: satoriignore.content,
    })).patterns;
}

export async function computeIndexPolicyControlSignature(canonicalRoot: string): Promise<string> {
    return buildControlSignature(await observeControlInputs(canonicalRoot));
}

export async function observeIndexPolicyInputs(canonicalRoot: string): Promise<ObservedIndexPolicyInputs> {
    const inputs = await observeControlInputs(canonicalRoot);
    const profileContent = inputs.files.find((file) => file.name === SATORI_REPO_CONFIG_FILENAME)?.content ?? null;
    const profileConfig = profileContent === null
        ? { profile: 'default' as const }
        : parseSatoriRepoConfig(
            profileContent.toString('utf8'),
            path.join(canonicalRoot, SATORI_REPO_CONFIG_FILENAME),
        );

    return {
        profileConfig,
        fileBasedIgnorePatterns: [...inputs.fileBasedIgnorePatterns],
        controlSignature: buildControlSignature(inputs),
    };
}
