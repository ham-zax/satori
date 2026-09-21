export type PublishedPathScope = Readonly<{
    subtree?: string;
    includePaths?: readonly string[];
    excludePaths?: readonly string[];
}>;

export function normalizePublishedPath(value: string): string {
    return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
}

function matchesPrefix(file: string, prefix: string): boolean {
    return file === prefix || file.startsWith(prefix + "/");
}

export function matchesPublishedPathScope(file: string, scope: PublishedPathScope): boolean {
    const normalizedFile = normalizePublishedPath(file);
    const subtree = scope.subtree ? normalizePublishedPath(scope.subtree) : "";
    if (subtree && !matchesPrefix(normalizedFile, subtree)) {
        return false;
    }

    const includePaths = (scope.includePaths ?? [])
        .map(normalizePublishedPath)
        .filter(Boolean);
    if (includePaths.length > 0 && !includePaths.some((prefix) => matchesPrefix(normalizedFile, prefix))) {
        return false;
    }

    const excludePaths = (scope.excludePaths ?? [])
        .map(normalizePublishedPath)
        .filter(Boolean);
    if (excludePaths.some((prefix) => matchesPrefix(normalizedFile, prefix))) {
        return false;
    }

    return true;
}
