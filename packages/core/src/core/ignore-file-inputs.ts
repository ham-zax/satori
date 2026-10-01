import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
    openRegularFileInsideRootNoFollow,
    readFileHandleExactly,
    verifyStableFileObservation,
} from '../sync/root-bound-fs';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { createIndexIgnoreMatcher } from './ignore-matcher';

/**
 * Owner of the file-based ignore pattern list for one codebase root.
 *
 * Precedence, lowest to highest (the matcher is last-match-wins):
 *   .git/info/exclude -> root .gitignore -> nested .gitignore files
 *   (parent before child) -> .satoriignore
 * Nested files are translated to root-relative patterns so one flat list can
 * represent them.
 */

const MAXIMUM_CONTROL_FILE_BYTES = 1_048_576;

export function parseIgnorePatterns(content: string): string[] {
    return content
        .split('\n')
        .map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Read a policy control file: root-bound, never through a symlink, size-capped, stable. */
export async function readPolicyControlFile(
    filePath: string,
    canonicalRoot: string,
    label: string,
): Promise<Buffer> {
    const handle = await openRegularFileInsideRootNoFollow(filePath, canonicalRoot);
    try {
        const stat = await handle.stat();
        if (stat.size > MAXIMUM_CONTROL_FILE_BYTES) {
            throw new Error(`${label} exceeds the ${MAXIMUM_CONTROL_FILE_BYTES}-byte policy limit.`);
        }
        const content = await readFileHandleExactly(handle, stat.size);
        await verifyStableFileObservation(handle, filePath, canonicalRoot, stat, {
            rejectFinalSymlink: true,
        });
        return content;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

// Directory names are literal path text; keep glob syntax in them inert.
function escapeGlobLiteral(value: string): string {
    return value.replace(/[\\*?[\]!#]/g, '\\$&');
}

/**
 * Translate the patterns of `<directory>/.gitignore` into root-relative
 * patterns. `directory` is root-relative with POSIX separators.
 */
export function translateNestedGitignorePatterns(
    directory: string,
    patterns: readonly string[],
): string[] {
    const prefix = escapeGlobLiteral(directory);
    return patterns.map((pattern) => {
        const negated = pattern.startsWith('!');
        let body = negated ? pattern.slice(1) : pattern;
        const hadLeadingSlash = body.startsWith('/');
        if (hadLeadingSlash) body = body.slice(1);
        const anchored = hadLeadingSlash || body.replace(/\/$/, '').includes('/');
        return `${negated ? '!' : ''}${prefix}/${anchored ? '' : '**/'}${body}`;
    });
}

export type ObservedIgnoreFile = Readonly<{
    /** Root-relative POSIX path of the file. */
    relativePath: string;
    content: Buffer;
}>;

export type ObservedIgnoreFileInputs = Readonly<{
    /** Ordered file-based patterns, lowest precedence first. */
    patterns: string[];
    /** Observed files beyond the root `.gitignore` / `.satoriignore`, in signature order. */
    additionalFiles: readonly ObservedIgnoreFile[];
}>;

async function observeInfoExclude(canonicalRoot: string): Promise<ObservedIgnoreFile | null> {
    try {
        for (const directory of ['.git', '.git/info']) {
            const stat = await lstat(path.join(canonicalRoot, directory));
            if (!stat.isDirectory()) return null;
        }
        const relativePath = '.git/info/exclude';
        const filePath = path.join(canonicalRoot, relativePath);
        if (!(await lstat(filePath)).isFile()) return null;
        return { relativePath, content: await readPolicyControlFile(filePath, canonicalRoot, relativePath) };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
    }
}

type NestedGitignore = Readonly<{ directory: string; content: Buffer }>;

/**
 * Discover nested `.gitignore` files below the root. Directories are walked
 * without following symlinks, in deterministic order, and a directory that the
 * patterns known at that point already ignore is never entered.
 */
async function observeNestedGitignores(
    canonicalRoot: string,
    lowPatterns: readonly string[],
    satoriignorePatterns: readonly string[],
    visitDirectory?: (directory: string) => void,
): Promise<NestedGitignore[]> {
    const found: NestedGitignore[] = [];

    const walk = async (
        directory: string,
        ancestorNested: readonly string[],
        parentMatcher: ReturnType<typeof createIndexIgnoreMatcher>,
    ): Promise<void> => {
        visitDirectory?.(directory);
        let entries;
        try {
            entries = await readdir(path.join(canonicalRoot, directory), { withFileTypes: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return;
            throw error;
        }
        entries.sort((left, right) => compareContractStrings(left.name, right.name));

        let nested = ancestorNested;
        let matcher = parentMatcher;
        const ownFile = directory === '' ? undefined : entries.find((entry) => entry.name === '.gitignore');
        if (ownFile) {
            const relativePath = `${directory}/.gitignore`;
            if (ownFile.isSymbolicLink()) {
                throw new Error(`Ignore file '${relativePath}' must not be a symbolic link.`);
            }
            if (!ownFile.isFile()) {
                throw new Error(`Ignore file '${relativePath}' is not a regular file.`);
            }
            const content = await readPolicyControlFile(
                path.join(canonicalRoot, relativePath),
                canonicalRoot,
                relativePath,
            );
            found.push({ directory, content });
            nested = [
                ...ancestorNested,
                ...translateNestedGitignorePatterns(directory, parseIgnorePatterns(content.toString('utf8'))),
            ];
            matcher = createIndexIgnoreMatcher([...lowPatterns, ...nested, ...satoriignorePatterns]);
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const child = directory === '' ? entry.name : `${directory}/${entry.name}`;
            if (matcher.ignores(child) || matcher.ignores(`${child}/`)) continue;
            await walk(child, nested, matcher);
        }
    };

    await walk('', [], createIndexIgnoreMatcher([...lowPatterns, ...satoriignorePatterns]));
    const depth = (directory: string): number => directory.split('/').length;
    return found.sort((left, right) => (
        depth(left.directory) - depth(right.directory)
        || compareContractStrings(left.directory, right.directory)
    ));
}

/**
 * Resolve the ordered file-based ignore patterns for a root, given the already
 * observed root `.gitignore` and `.satoriignore` contents.
 */
export async function observeIgnoreFileInputs(
    canonicalRoot: string,
    rootFiles: Readonly<{ gitignore: Buffer | null; satoriignore: Buffer | null }>,
    /** Receives every root-relative directory whose entries the walk reads. */
    visitDirectory?: (directory: string) => void,
): Promise<ObservedIgnoreFileInputs> {
    const parse = (content: Buffer | null): string[] => (
        content === null ? [] : parseIgnorePatterns(content.toString('utf8'))
    );
    const infoExclude = await observeInfoExclude(canonicalRoot);
    const lowPatterns = [...parse(infoExclude?.content ?? null), ...parse(rootFiles.gitignore)];
    const satoriignorePatterns = parse(rootFiles.satoriignore);
    const nested = await observeNestedGitignores(canonicalRoot, lowPatterns, satoriignorePatterns, visitDirectory);

    const nestedPatterns = nested.flatMap(({ directory, content }) => (
        translateNestedGitignorePatterns(directory, parseIgnorePatterns(content.toString('utf8')))
    ));
    const additionalFiles: ObservedIgnoreFile[] = [
        ...(infoExclude ? [infoExclude] : []),
        ...nested.map(({ directory, content }) => ({
            relativePath: `${directory}/.gitignore`,
            content,
        })),
    ];
    return {
        patterns: [...lowPatterns, ...nestedPatterns, ...satoriignorePatterns],
        additionalFiles,
    };
}
