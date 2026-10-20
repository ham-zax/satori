import * as path from 'path';
import type { ResolutionProjectAnalyzer } from '../relationships';
import { discoverPackageOwnership } from '../packages/ownership';

const TYPESCRIPT_RESOLUTION_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

/** Shared control discovery keeps publication and read comparisons on the same policy. */
export async function collectPublicationSourceControls(
    codebasePath: string,
    sourcePaths: readonly string[],
    analyzer?: ResolutionProjectAnalyzer,
): Promise<{
    resolutionSourceControls: string[];
    packageOwnershipSourceControls: string[];
    publicationSourceControls: string[];
}> {
    let resolutionSourceControls: string[] = [];
    if (analyzer?.getSourceControlFiles && analyzer.supportsLanguage('typescript')) {
        const typeScriptFiles = sourcePaths
            .map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, ''))
            .filter((filePath) => TYPESCRIPT_RESOLUTION_SOURCE_EXTENSIONS.some((extension) =>
                filePath.toLowerCase().endsWith(extension)));
        if (typeScriptFiles.length > 0) {
            resolutionSourceControls = [...new Set(await analyzer.getSourceControlFiles({
                rootPath: codebasePath,
                language: 'typescript',
                sourceFiles: typeScriptFiles,
            }))].sort();
        }
    }
    const packageOwnershipSourceControls = discoverPackageOwnership(codebasePath).controlFiles
        .map(([filePath]) => filePath)
        .filter((filePath) => path.posix.basename(filePath) !== 'Cargo.toml');
    return {
        resolutionSourceControls,
        packageOwnershipSourceControls,
        publicationSourceControls: [...new Set([
            ...resolutionSourceControls,
            ...packageOwnershipSourceControls,
        ])].sort(),
    };
}

const warnedControlFailures = new Set<string>();

/**
 * Read-time variant: a failure to discover controls means freshness cannot be
 * proven, so callers get `null` (unavailable) instead of a rejected search.
 * The failure is warned once per publication id.
 */
export async function tryCollectPublicationSourceControls(
    publicationId: string,
    codebasePath: string,
    sourcePaths: readonly string[],
    analyzer?: ResolutionProjectAnalyzer,
): Promise<Awaited<ReturnType<typeof collectPublicationSourceControls>> | null> {
    try {
        return await collectPublicationSourceControls(codebasePath, sourcePaths, analyzer);
    } catch (error) {
        if (!warnedControlFailures.has(publicationId)) {
            warnedControlFailures.add(publicationId);
            console.warn(
                `[Context] Publication '${publicationId}' freshness is unavailable: source control discovery failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return null;
    }
}
