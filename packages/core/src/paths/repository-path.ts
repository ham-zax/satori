import path from 'node:path';

declare const repositoryRelativePathBrand: unique symbol;

export type RepositoryRelativePath = string & {
    readonly [repositoryRelativePathBrand]: true;
};

export function isRepositoryRelativePath(value: unknown): value is RepositoryRelativePath {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
        return false;
    }
    if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
        return false;
    }
    const segments = value.split('/');
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function validateRepositoryRelativePath(value: string): RepositoryRelativePath {
    if (!isRepositoryRelativePath(value)) {
        throw new Error(`Expected a canonical repository-relative path: ${JSON.stringify(value)}`);
    }
    return value;
}

export function canonicalizeRepositoryRelativePath(
    repositoryRoot: string,
    candidatePath: string,
): RepositoryRelativePath | null {
    if (typeof repositoryRoot !== 'string' || typeof candidatePath !== 'string') return null;
    if (candidatePath.length === 0) return null;

    const normalizedCandidate = candidatePath.replace(/\\/g, '/');
    const relativePath = path.isAbsolute(candidatePath)
        ? path.relative(path.resolve(repositoryRoot), path.resolve(candidatePath)).replace(/\\/g, '/')
        : normalizedCandidate;
    const normalizedRelativePath = path.posix.normalize(relativePath).replace(/\/+$/, '');

    return isRepositoryRelativePath(normalizedRelativePath)
        ? normalizedRelativePath
        : null;
}
