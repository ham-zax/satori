import type { RelationshipRecord, SymbolRecord } from '../symbols';
import type { SymbolRegistry } from '../symbols';
import { isLanguageCapabilitySupportedForLanguage } from '../language';

export interface BuildCallRelationshipsForRegistryInput {
    registry: SymbolRegistry;
    contentByFile: Map<string, string> | Record<string, string>;
}

export type BuildRelationshipsForRegistryInput = BuildCallRelationshipsForRegistryInput;

const CALL_KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'function',
    'class',
    'return',
    'typeof',
    'sizeof',
    'new',
]);

function getContent(contentByFile: BuildCallRelationshipsForRegistryInput['contentByFile'], file: string): string | undefined {
    if (contentByFile instanceof Map) {
        return contentByFile.get(file);
    }
    return contentByFile[file];
}

function isSourceOwner(symbol: SymbolRecord): boolean {
    return symbol.kind === 'function' || symbol.kind === 'method';
}

function stripInlineComments(line: string, language: string): string {
    if (language === 'python') {
        return line.replace(/#.*$/, '');
    }
    return line.replace(/\/\/.*$/, '');
}

function extractCallNames(line: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const directCallRegex = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of line.matchAll(directCallRegex)) {
        const name = (match[1] || '').toLowerCase();
        if (!name || CALL_KEYWORDS.has(name) || seen.has(name)) {
            continue;
        }
        seen.add(name);
        names.push(name);
    }
    return names;
}

function looksLikeDefinition(line: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b(function|class|def)\\s+${escaped}\\b`, 'i');
    if (pattern.test(line)) {
        return true;
    }

    const methodPattern = new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(=>|\\{)`, 'i');
    return methodPattern.test(line);
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    const aLine = a.span?.startLine ?? 0;
    const bLine = b.span?.startLine ?? 0;
    if (aLine !== bLine) return aLine - bLine;
    if (a.sourceKey !== b.sourceKey) return compareStrings(a.sourceKey, b.sourceKey);
    return compareStrings(a.targetKey || '', b.targetKey || '');
}

function relationshipKey(record: RelationshipRecord): string {
    return [
        record.sourceInstanceId || record.sourceKey,
        record.targetInstanceId || record.targetKey || record.targetPath || '',
        record.type,
        record.file,
        record.span?.startLine ?? 0,
    ].join('\0');
}

function getFileOwners(symbols: SymbolRecord[]): Map<string, SymbolRecord> {
    const owners = new Map<string, SymbolRecord>();
    for (const symbol of symbols) {
        if (symbol.kind === 'file') {
            owners.set(symbol.file, symbol);
        }
    }
    return owners;
}

function isImportExportLanguage(language: string): boolean {
    return language === 'typescript'
        || language === 'javascript'
        || language === 'tsx'
        || language === 'jsx'
        || language === 'python';
}

function resolveRelativeModulePath(sourceFile: string, specifier: string, registry: SymbolRegistry, language: string): string | undefined {
    if (!specifier.startsWith('.')) {
        return undefined;
    }
    const candidates = language === 'python'
        ? resolvePythonRelativeModuleCandidates(sourceFile, specifier)
        : resolveJsRelativeModuleCandidates(sourceFile, specifier);
    const files = new Set(registry.manifest.files.map((file) => file.path));
    return candidates.find((candidate) => files.has(candidate));
}

function resolveJsRelativeModuleCandidates(sourceFile: string, specifier: string): string[] {
    const sourceDir = sourceFile.includes('/') ? sourceFile.slice(0, sourceFile.lastIndexOf('/')) : '';
    const basePath = pathJoinPosix(sourceDir, specifier);
    return [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.jsx`,
        `${basePath}.mjs`,
        `${basePath}.cjs`,
        pathJoinPosix(basePath, 'index.ts'),
        pathJoinPosix(basePath, 'index.tsx'),
        pathJoinPosix(basePath, 'index.js'),
        pathJoinPosix(basePath, 'index.jsx'),
        pathJoinPosix(basePath, 'index.mjs'),
        pathJoinPosix(basePath, 'index.cjs'),
    ];
}

function resolvePythonRelativeModuleCandidates(sourceFile: string, specifier: string): string[] {
    let leadingDots = 0;
    while (leadingDots < specifier.length && specifier[leadingDots] === '.') {
        leadingDots += 1;
    }
    if (leadingDots === 0) {
        return [];
    }
    const sourceDir = sourceFile.includes('/') ? sourceFile.slice(0, sourceFile.lastIndexOf('/')) : '';
    const parentSteps = Math.max(0, leadingDots - 1);
    const relativeModule = specifier.slice(leadingDots).replace(/\./g, '/');
    const baseParts = sourceDir.length > 0 ? sourceDir.split('/') : [];
    const keptParts = baseParts.slice(0, Math.max(0, baseParts.length - parentSteps));
    const moduleBase = relativeModule.length > 0
        ? pathJoinPosix(...keptParts, relativeModule)
        : pathJoinPosix(...keptParts);
    return [
        `${moduleBase}.py`,
        pathJoinPosix(moduleBase, '__init__.py'),
    ];
}

function pathJoinPosix(...parts: string[]): string {
    const joined = parts
        .filter((part) => part.length > 0)
        .join('/');
    const segments: string[] = [];
    for (const segment of joined.split('/')) {
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join('/');
}

function extractImportSpecifier(line: string, language: string): string | undefined {
    if (language === 'python') {
        const match = line.match(/^\s*from\s+([.\w]+)\s+import\s+.+$/);
        return match?.[1];
    }
    const match = line.match(/^\s*import(?:\s+type)?(?:\s+[^'"]*?\s+from)?\s*['"]([^'"]+)['"]\s*;?\s*$/);
    return match?.[1];
}

function extractExportFromSpecifier(line: string, language: string): string | undefined {
    if (language === 'python') {
        return undefined;
    }
    const match = line.match(/^\s*export(?:\s+type)?\s+(?:\*|{[^}]*}|[A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
    return match?.[1];
}

function extractLocalExportName(line: string, language: string): string | undefined {
    if (language === 'python') {
        const match = line.match(/^\s*(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)\b/);
        return match?.[1];
    }
    const match = line.match(/^\s*export\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    return match?.[1];
}

function resolveUniqueLocalSymbol(file: string, name: string, symbols: SymbolRecord[], topLevelOnly = false): SymbolRecord | undefined {
    const matches = symbols.filter((symbol) => (
        symbol.file === file
        && symbol.kind !== 'file'
        && symbol.name === name
        && (!topLevelOnly || symbol.parentQualifiedNamePath.length === 0)
    ));
    return matches.length === 1 ? matches[0] : undefined;
}

function resolveUnambiguousTarget(source: SymbolRecord, candidates: SymbolRecord[]): SymbolRecord | undefined {
    const nonSelfCandidates = candidates.filter((candidate) => candidate.symbolInstanceId !== source.symbolInstanceId);
    const sameFileCandidates = nonSelfCandidates.filter((candidate) => candidate.file === source.file);
    if (sameFileCandidates.length === 1) {
        return sameFileCandidates[0];
    }
    if (sameFileCandidates.length > 1) {
        return undefined;
    }
    return nonSelfCandidates.length === 1 ? nonSelfCandidates[0] : undefined;
}

function buildTargetIndex(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
    const targets = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols.filter((candidate) => candidate.kind !== 'file')) {
        const key = symbol.name.toLowerCase();
        const existing = targets.get(key);
        if (existing) {
            existing.push(symbol);
        } else {
            targets.set(key, [symbol]);
        }
    }
    return targets;
}

export function buildCallRelationshipsForRegistry(input: BuildCallRelationshipsForRegistryInput): RelationshipRecord[] {
    const targetIndex = buildTargetIndex(input.registry.symbols);
    const recordsByKey = new Map<string, RelationshipRecord>();

    for (const source of input.registry.symbols.filter(isSourceOwner)) {
        if (!isLanguageCapabilitySupportedForLanguage(source.language, 'callGraphBuild')) {
            continue;
        }
        const content = getContent(input.contentByFile, source.file);
        if (content === undefined) {
            continue;
        }
        const lines = content.split(/\r?\n/);
        const maxLine = Math.min(source.span.endLine, lines.length);
        for (let lineNo = source.span.startLine; lineNo <= maxLine; lineNo++) {
            const line = stripInlineComments(lines[lineNo - 1] || '', source.language);
            if (line.trim().length === 0) {
                continue;
            }
            for (const callName of extractCallNames(line)) {
                if (looksLikeDefinition(line, callName)) {
                    continue;
                }
                const candidates = targetIndex.get(callName);
                if (!candidates || candidates.length === 0) {
                    continue;
                }
                const target = resolveUnambiguousTarget(source, candidates);
                if (!target) {
                    continue;
                }
                const record: RelationshipRecord = {
                    sourceKey: source.symbolKey,
                    sourceInstanceId: source.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    type: 'CALLS',
                    file: source.file,
                    span: { startLine: lineNo, endLine: lineNo },
                    confidence: target.file === source.file ? 'high' : 'low',
                };
                recordsByKey.set(relationshipKey(record), record);
            }
        }
    }

    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}

function buildImportExportRelationshipsForRegistry(input: BuildRelationshipsForRegistryInput): RelationshipRecord[] {
    const fileOwners = getFileOwners(input.registry.symbols);
    const recordsByKey = new Map<string, RelationshipRecord>();

    for (const source of input.registry.symbols.filter((symbol) => symbol.kind === 'file' && isImportExportLanguage(symbol.language))) {
        const content = getContent(input.contentByFile, source.file);
        if (content === undefined) {
            continue;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const lineNo = index + 1;
            const line = stripInlineComments(lines[index] || '', source.language).trim();
            if (line.length === 0) {
                continue;
            }

            const importSpecifier = extractImportSpecifier(line, source.language);
            if (importSpecifier) {
                const targetPath = resolveRelativeModulePath(source.file, importSpecifier, input.registry, source.language);
                const target = targetPath ? fileOwners.get(targetPath) : undefined;
                if (target) {
                    const record: RelationshipRecord = {
                        sourceKey: source.symbolKey,
                        sourceInstanceId: source.symbolInstanceId,
                        targetKey: target.symbolKey,
                        targetInstanceId: target.symbolInstanceId,
                        targetPath: target.file,
                        type: 'IMPORTS',
                        file: source.file,
                        span: { startLine: lineNo, endLine: lineNo },
                        confidence: 'high',
                    };
                    recordsByKey.set(relationshipKey(record), record);
                }
                continue;
            }

            const exportFromSpecifier = extractExportFromSpecifier(line, source.language);
            if (exportFromSpecifier) {
                const targetPath = resolveRelativeModulePath(source.file, exportFromSpecifier, input.registry, source.language);
                const target = targetPath ? fileOwners.get(targetPath) : undefined;
                if (target) {
                    const record: RelationshipRecord = {
                        sourceKey: source.symbolKey,
                        sourceInstanceId: source.symbolInstanceId,
                        targetKey: target.symbolKey,
                        targetInstanceId: target.symbolInstanceId,
                        targetPath: target.file,
                        type: 'EXPORTS',
                        file: source.file,
                        span: { startLine: lineNo, endLine: lineNo },
                        confidence: 'high',
                    };
                    recordsByKey.set(relationshipKey(record), record);
                }
                continue;
            }

            const localExportName = extractLocalExportName(line, source.language);
            const target = localExportName
                ? resolveUniqueLocalSymbol(source.file, localExportName, input.registry.symbols, source.language === 'python')
                : undefined;
            if (target) {
                const record: RelationshipRecord = {
                    sourceKey: source.symbolKey,
                    sourceInstanceId: source.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    type: 'EXPORTS',
                    file: source.file,
                    span: { startLine: lineNo, endLine: lineNo },
                    confidence: 'high',
                };
                recordsByKey.set(relationshipKey(record), record);
            }
        }
    }

    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}

export function buildRelationshipsForRegistry(input: BuildRelationshipsForRegistryInput): RelationshipRecord[] {
    const recordsByKey = new Map<string, RelationshipRecord>();
    for (const record of [
        ...buildImportExportRelationshipsForRegistry(input),
        ...buildCallRelationshipsForRegistry(input),
    ]) {
        recordsByKey.set(relationshipKey(record), record);
    }
    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}
