import type { CallSite, LanguageAnalysisResult, ModuleBinding } from '../language-analysis';
import { isLanguageCapabilitySupportedForLanguage } from '../language';
import { isCallableSymbolKind } from '../symbols';
import type { RelationshipRecord, SymbolRecord, SymbolRegistry } from '../symbols';

export type RelationshipAnalysisEvidence = Pick<LanguageAnalysisResult, 'moduleBindings' | 'callSites'>;

export interface BuildCallRelationshipsForRegistryInput {
    registry: SymbolRegistry;
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
}

export type BuildRelationshipsForRegistryInput = BuildCallRelationshipsForRegistryInput;

export interface BuildRelationshipDeltaInput extends BuildRelationshipsForRegistryInput {
    previousRegistry: SymbolRegistry;
    existingRecords: readonly RelationshipRecord[];
    changedFiles: ReadonlySet<string>;
}

export interface BuildRelationshipDeltaResult {
    records: RelationshipRecord[];
    affectedFiles: string[];
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    const aLine = a.span?.startLine ?? 0;
    const bLine = b.span?.startLine ?? 0;
    if (aLine !== bLine) return aLine - bLine;
    const aStartByte = a.span?.startByte ?? 0;
    const bStartByte = b.span?.startByte ?? 0;
    if (aStartByte !== bStartByte) return aStartByte - bStartByte;
    const aEndByte = a.span?.endByte ?? 0;
    const bEndByte = b.span?.endByte ?? 0;
    if (aEndByte !== bEndByte) return aEndByte - bEndByte;
    const aStartColumn = a.span?.startColumn ?? 0;
    const bStartColumn = b.span?.startColumn ?? 0;
    if (aStartColumn !== bStartColumn) return aStartColumn - bStartColumn;
    const aEndColumn = a.span?.endColumn ?? 0;
    const bEndColumn = b.span?.endColumn ?? 0;
    if (aEndColumn !== bEndColumn) return aEndColumn - bEndColumn;
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
        record.span?.endLine ?? 0,
        record.span?.startByte ?? 0,
        record.span?.endByte ?? 0,
        record.span?.startColumn ?? 0,
        record.span?.endColumn ?? 0,
    ].join('\0');
}

function getEvidence(
    evidenceByFile: BuildRelationshipsForRegistryInput['analysisByFile'],
    file: string,
): RelationshipAnalysisEvidence | undefined {
    return evidenceByFile instanceof Map ? evidenceByFile.get(file) : evidenceByFile[file];
}

function getFileOwners(symbols: readonly SymbolRecord[]): Map<string, SymbolRecord> {
    return new Map(
        symbols
            .filter((symbol) => symbol.kind === 'file')
            .map((symbol) => [symbol.file, symbol]),
    );
}

function resolveUniqueLocalSymbol(
    file: string,
    name: string,
    symbols: readonly SymbolRecord[],
): SymbolRecord | undefined {
    const matches = symbols.filter((symbol) => (
        symbol.file === file
        && symbol.kind !== 'file'
        && symbol.name === name
        && symbol.parentQualifiedNamePath.length === 0
    ));
    return matches.length === 1 ? matches[0] : undefined;
}

function resolveUnambiguousTarget(source: SymbolRecord, candidates: readonly SymbolRecord[]): SymbolRecord | undefined {
    const nonSelfCandidates = candidates.filter((candidate) => candidate.symbolInstanceId !== source.symbolInstanceId);
    const sameFileCandidates = nonSelfCandidates.filter((candidate) => candidate.file === source.file);
    if (sameFileCandidates.length === 1) return sameFileCandidates[0];
    if (sameFileCandidates.length > 1) return undefined;
    return nonSelfCandidates.length === 1 ? nonSelfCandidates[0] : undefined;
}

function buildTargetIndex(symbols: readonly SymbolRecord[]): Map<string, SymbolRecord[]> {
    const targets = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols.filter((candidate) => candidate.kind !== 'file')) {
        const key = symbol.name;
        targets.set(key, [...(targets.get(key) ?? []), symbol]);
    }
    return targets;
}

function isSourceOwner(symbol: SymbolRecord): boolean {
    return isCallableSymbolKind(symbol.kind);
}

function isEligibleCallTarget(call: CallSite, symbol: SymbolRecord): boolean {
    if (call.kind === 'direct') {
        return isCallableSymbolKind(symbol.kind);
    }
    if (call.kind === 'constructor') {
        return symbol.kind === 'class';
    }
    return false;
}

function ownerForCall(fileSymbols: readonly SymbolRecord[], call: CallSite): SymbolRecord | undefined {
    const lineCandidates = fileSymbols.filter((symbol) => (
        isSourceOwner(symbol)
        && symbol.span.startLine <= call.span.startLine
        && symbol.span.endLine >= call.span.endLine
    ));
    const byteCandidates = lineCandidates.filter((symbol) => (
        symbol.span.startByte !== undefined
        && symbol.span.endByte !== undefined
        && symbol.span.startByte <= call.span.startByte
        && symbol.span.endByte >= call.span.endByte
    ));
    const candidates = byteCandidates.length > 0
        ? byteCandidates
        : lineCandidates.filter((symbol) => (
            symbol.span.startByte === undefined || symbol.span.endByte === undefined
        ));
    candidates.sort((a, b) => {
        if (
            a.span.startByte !== undefined
            && a.span.endByte !== undefined
            && b.span.startByte !== undefined
            && b.span.endByte !== undefined
        ) {
            const byteSize = (a.span.endByte - a.span.startByte) - (b.span.endByte - b.span.startByte);
            if (byteSize !== 0) return byteSize;
        }
        const aSize = a.span.endLine - a.span.startLine;
        const bSize = b.span.endLine - b.span.startLine;
        if (aSize !== bSize) return aSize - bSize;
        return compareStrings(a.symbolInstanceId, b.symbolInstanceId);
    });
    return candidates[0];
}

function symbolContains(container: SymbolRecord, nested: SymbolRecord): boolean {
    if (
        container.span.startByte !== undefined
        && container.span.endByte !== undefined
        && nested.span.startByte !== undefined
        && nested.span.endByte !== undefined
    ) {
        return container.span.startByte <= nested.span.startByte
            && container.span.endByte >= nested.span.endByte;
    }
    return container.span.startLine <= nested.span.startLine
        && container.span.endLine >= nested.span.endLine;
}

function compareContainingClasses(left: SymbolRecord, right: SymbolRecord): number {
    if (
        left.span.startByte !== undefined
        && left.span.endByte !== undefined
        && right.span.startByte !== undefined
        && right.span.endByte !== undefined
    ) {
        const byteSize = (left.span.endByte - left.span.startByte)
            - (right.span.endByte - right.span.startByte);
        if (byteSize !== 0) return byteSize;
    }
    const lineSize = (left.span.endLine - left.span.startLine)
        - (right.span.endLine - right.span.startLine);
    if (lineSize !== 0) return lineSize;
    return compareStrings(left.symbolInstanceId, right.symbolInstanceId);
}

function enclosingClassForSymbol(
    symbol: SymbolRecord,
    classesByFile: ReadonlyMap<string, readonly SymbolRecord[]>,
): SymbolRecord | undefined {
    return classesByFile.get(symbol.file)
        ?.filter((candidate) => symbolContains(candidate, symbol))
        .sort(compareContainingClasses)[0];
}

function buildClassIndex(symbols: readonly SymbolRecord[]): {
    byFile: Map<string, SymbolRecord[]>;
    byName: Map<string, SymbolRecord[]>;
} {
    const byFile = new Map<string, SymbolRecord[]>();
    const byName = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
        if (symbol.kind !== 'class') continue;
        byFile.set(symbol.file, [...(byFile.get(symbol.file) ?? []), symbol]);
        byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
    }
    return { byFile, byName };
}

function resolveRelativeModulePath(
    sourceFile: string,
    specifier: string,
    registry: SymbolRegistry,
    language: string,
    availableFiles: ReadonlySet<string> = new Set(registry.manifest.files.map((file) => file.path)),
): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const candidates = language === 'python'
        ? resolvePythonRelativeModuleCandidates(sourceFile, specifier)
        : resolveJsRelativeModuleCandidates(sourceFile, specifier);
    return candidates.find((candidate) => availableFiles.has(candidate));
}

function pathJoinPosix(...parts: string[]): string | undefined {
    const segments: string[] = [];
    for (const segment of parts.filter(Boolean).join('/').split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (segments.length === 0) return undefined;
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    return segments.join('/');
}

function resolveJsRelativeModuleCandidates(sourceFile: string, specifier: string): string[] {
    const sourceDir = sourceFile.includes('/') ? sourceFile.slice(0, sourceFile.lastIndexOf('/')) : '';
    const basePath = pathJoinPosix(sourceDir, specifier);
    if (!basePath) return [];
    const runtimeExtensionSubstitutions: Record<string, string[]> = {
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.mjs': ['.mts', '.mjs'],
        '.cjs': ['.cts', '.cjs'],
    };
    const explicitRuntimeExtension = Object.keys(runtimeExtensionSubstitutions)
        .find((extension) => basePath.endsWith(extension));
    if (explicitRuntimeExtension) {
        const withoutExtension = basePath.slice(0, -explicitRuntimeExtension.length);
        return runtimeExtensionSubstitutions[explicitRuntimeExtension]
            .map((extension) => `${withoutExtension}${extension}`);
    }
    return [
        basePath,
        ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].map((extension) => `${basePath}.${extension}`),
        ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']
            .map((extension) => pathJoinPosix(basePath, `index.${extension}`))
            .filter((candidate): candidate is string => candidate !== undefined),
    ];
}

function resolvePythonRelativeModuleCandidates(sourceFile: string, specifier: string): string[] {
    let leadingDots = 0;
    while (specifier[leadingDots] === '.') leadingDots += 1;
    if (leadingDots === 0) return [];
    const sourceDir = sourceFile.includes('/') ? sourceFile.slice(0, sourceFile.lastIndexOf('/')) : '';
    const baseParts = sourceDir ? sourceDir.split('/') : [];
    const parentLevels = Math.max(0, leadingDots - 1);
    if (leadingDots > baseParts.length) return [];
    const keptParts = baseParts.slice(0, baseParts.length - parentLevels);
    const modulePath = specifier.slice(leadingDots).replace(/\./g, '/');
    const moduleBase = pathJoinPosix(...keptParts, modulePath);
    if (!moduleBase) return [];
    const packageCandidate = pathJoinPosix(moduleBase, '__init__.py');
    return [`${moduleBase}.py`, ...(packageCandidate ? [packageCandidate] : [])];
}

function relationshipSpan(binding: ModuleBinding | CallSite): RelationshipRecord['span'] {
    return { ...binding.span };
}

function resolvePythonMemberTarget(input: {
    call: CallSite;
    source: SymbolRecord;
    candidates: readonly SymbolRecord[];
    evidence: RelationshipAnalysisEvidence;
    registry: SymbolRegistry;
    classesByFile: ReadonlyMap<string, readonly SymbolRecord[]>;
    classesByName: ReadonlyMap<string, readonly SymbolRecord[]>;
    availableFiles: ReadonlySet<string>;
}): SymbolRecord | undefined {
    if (
        input.call.kind !== 'member'
        || input.source.language !== 'python'
        || !input.call.receiverText
    ) {
        return undefined;
    }

    const receiver = input.call.receiverText.trim();
    if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(receiver)
        || input.call.qualifiedCallee?.trim() !== `${receiver}.${input.call.calleeName}`
    ) {
        return undefined;
    }

    let targetClass: SymbolRecord | undefined;
    if (receiver === 'self' || receiver === 'cls') {
        if (input.source.kind !== 'method') return undefined;
        targetClass = enclosingClassForSymbol(input.source, input.classesByFile);
    } else {
        const authorizedFiles = new Set([input.source.file]);
        for (const binding of input.evidence.moduleBindings) {
            if (
                (binding.kind !== 'import' && binding.kind !== 'reexport')
                || !binding.moduleSpecifier
                || binding.importedName !== receiver
                || binding.localName !== receiver
            ) {
                continue;
            }
            const importedFile = resolveRelativeModulePath(
                input.source.file,
                binding.moduleSpecifier,
                input.registry,
                input.source.language,
                input.availableFiles,
            );
            if (importedFile) authorizedFiles.add(importedFile);
        }
        const classCandidates = (input.classesByName.get(receiver) ?? [])
            .filter((candidate) => authorizedFiles.has(candidate.file));
        if (classCandidates.length === 1) {
            [targetClass] = classCandidates;
        }
    }
    if (!targetClass) return undefined;

    const matchingMembers = input.candidates.filter((candidate) => (
        candidate.kind === 'method'
        && candidate.symbolInstanceId !== input.source.symbolInstanceId
        && enclosingClassForSymbol(candidate, input.classesByFile)?.symbolInstanceId
            === targetClass.symbolInstanceId
    ));
    return matchingMembers.length === 1 ? matchingMembers[0] : undefined;
}

export function buildCallRelationshipsForRegistry(input: BuildCallRelationshipsForRegistryInput): RelationshipRecord[] {
    const targetIndex = buildTargetIndex(input.registry.symbols);
    const symbolsByFile = input.registry.symbolsByFile;
    const classes = buildClassIndex(input.registry.symbols);
    const availableFiles = new Set(input.registry.manifest.files.map((file) => file.path));
    const recordsByKey = new Map<string, RelationshipRecord>();

    for (const file of input.registry.manifest.files) {
        if (!isLanguageCapabilitySupportedForLanguage(file.language, 'callGraphBuild')) continue;
        const evidence = getEvidence(input.analysisByFile, file.path);
        if (!evidence) continue;
        for (const call of evidence.callSites) {
            const source = ownerForCall(symbolsByFile.get(file.path) ?? [], call);
            if (!source) continue;
            const candidates = targetIndex.get(call.calleeName);
            if (!candidates || candidates.length === 0) continue;
            const target = call.kind === 'member'
                ? resolvePythonMemberTarget({
                    call,
                    source,
                    candidates,
                    evidence,
                    registry: input.registry,
                    classesByFile: classes.byFile,
                    classesByName: classes.byName,
                    availableFiles,
                })
                : resolveUnambiguousTarget(
                    source,
                    candidates.filter((candidate) => isEligibleCallTarget(call, candidate)),
                );
            if (!target) continue;
            const record: RelationshipRecord = {
                sourceKey: source.symbolKey,
                sourceInstanceId: source.symbolInstanceId,
                targetKey: target.symbolKey,
                targetInstanceId: target.symbolInstanceId,
                type: 'CALLS',
                file: source.file,
                span: relationshipSpan(call),
                confidence: target.file === source.file ? 'high' : 'low',
            };
            recordsByKey.set(relationshipKey(record), record);
        }
    }

    return [...recordsByKey.values()].sort(compareRelationshipRecords);
}

function buildImportExportRelationshipsForRegistry(input: BuildRelationshipsForRegistryInput): RelationshipRecord[] {
    const fileOwners = getFileOwners(input.registry.symbols);
    const symbolsByFile = input.registry.symbolsByFile;
    const availableFiles = new Set(input.registry.manifest.files.map((file) => file.path));
    const recordsByKey = new Map<string, RelationshipRecord>();

    for (const source of input.registry.symbols.filter((symbol) => symbol.kind === 'file')) {
        const evidence = getEvidence(input.analysisByFile, source.file);
        if (!evidence) continue;
        for (const binding of evidence.moduleBindings) {
            if (binding.kind === 'import' || binding.kind === 'reexport') {
                const specifier = binding.moduleSpecifier;
                const targetPath = specifier
                    ? resolveRelativeModulePath(
                        source.file,
                        specifier,
                        input.registry,
                        source.language,
                        availableFiles,
                    )
                    : undefined;
                const target = targetPath ? fileOwners.get(targetPath) : undefined;
                if (!target) continue;
                const record: RelationshipRecord = {
                    sourceKey: source.symbolKey,
                    sourceInstanceId: source.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    targetPath: target.file,
                    type: binding.kind === 'import' ? 'IMPORTS' : 'EXPORTS',
                    file: source.file,
                    span: relationshipSpan(binding),
                    confidence: 'high',
                };
                recordsByKey.set(relationshipKey(record), record);
                continue;
            }

            const localName = binding.localName ?? binding.exportedName;
            const target = localName
                ? resolveUniqueLocalSymbol(source.file, localName, symbolsByFile.get(source.file) ?? [])
                : undefined;
            if (!target) continue;
            const record: RelationshipRecord = {
                sourceKey: source.symbolKey,
                sourceInstanceId: source.symbolInstanceId,
                targetKey: target.symbolKey,
                targetInstanceId: target.symbolInstanceId,
                type: 'EXPORTS',
                file: source.file,
                span: relationshipSpan(binding),
                confidence: 'high',
            };
            recordsByKey.set(relationshipKey(record), record);
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

export function buildRelationshipDelta(input: BuildRelationshipDeltaInput): BuildRelationshipDeltaResult {
    const affectedFiles = new Set(input.changedFiles);
    const changedTargetNames = new Set<string>();
    const previousFilesByPath = new Map(
        input.previousRegistry.manifest.files.map((file) => [file.path, file]),
    );
    const previousAvailableFiles = new Set(previousFilesByPath.keys());
    const availableFiles = new Set(input.registry.manifest.files.map((file) => file.path));
    for (const symbol of [...input.previousRegistry.symbols, ...input.registry.symbols]) {
        if (symbol.kind !== 'file' && input.changedFiles.has(symbol.file)) {
            changedTargetNames.add(symbol.name);
        }
    }

    for (const file of input.registry.manifest.files) {
        if (affectedFiles.has(file.path)) continue;
        const evidence = getEvidence(input.analysisByFile, file.path);
        if (!evidence) continue;
        if (evidence.callSites.some((call) => changedTargetNames.has(call.calleeName))) {
            affectedFiles.add(file.path);
            continue;
        }
        const previousFile = previousFilesByPath.get(file.path);
        const language = previousFile?.language ?? file.language;
        const resolutionChanged = evidence.moduleBindings.some((binding) => {
            if ((binding.kind !== 'import' && binding.kind !== 'reexport') || !binding.moduleSpecifier) {
                return false;
            }
            const previousTarget = resolveRelativeModulePath(
                file.path,
                binding.moduleSpecifier,
                input.previousRegistry,
                language,
                previousAvailableFiles,
            );
            const nextTarget = resolveRelativeModulePath(
                file.path,
                binding.moduleSpecifier,
                input.registry,
                file.language,
                availableFiles,
            );
            return previousTarget !== nextTarget
                || (previousTarget !== undefined && input.changedFiles.has(previousTarget))
                || (nextTarget !== undefined && input.changedFiles.has(nextTarget));
        });
        if (resolutionChanged) affectedFiles.add(file.path);
    }

    const affectedEvidence = new Map<string, RelationshipAnalysisEvidence>();
    for (const filePath of [...affectedFiles].sort(compareStrings)) {
        const evidence = getEvidence(input.analysisByFile, filePath);
        if (evidence) affectedEvidence.set(filePath, evidence);
    }
    const retained = input.existingRecords.filter((record) => !affectedFiles.has(record.file));
    const rebuilt = buildRelationshipsForRegistry({
        registry: input.registry,
        analysisByFile: affectedEvidence,
    });
    const recordsByKey = new Map<string, RelationshipRecord>();
    for (const record of [...retained, ...rebuilt]) {
        recordsByKey.set(relationshipKey(record), record);
    }
    return {
        records: [...recordsByKey.values()].sort(compareRelationshipRecords),
        affectedFiles: [...affectedFiles].sort(compareStrings),
    };
}
