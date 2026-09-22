import path from 'node:path';
import ts from 'typescript';

import { Utf8SourceMap } from '../language-analysis/source-map';
import type { SourceSpan } from '../language-analysis/types';
import type { SemanticProjectInput } from './contracts';

const VIRTUAL_ROOT = '/__satori__';

export const TYPESCRIPT_COMPILER_PROVIDER_ID = 'satori-typescript-compiler';
export const TYPESCRIPT_COMPILER_PROVIDER_VERSION = 'ts-compiler-v3';

export type TypeScriptSemanticDecision =
    | 'resolved'
    | 'ambiguous'
    | 'unresolved'
    | 'unsupported';

export type TypeScriptSemanticReason =
    | 'single_executable_target'
    | 'multiple_executable_targets'
    | 'declaration_without_implementation'
    | 'dynamic_receiver'
    | 'generic_receiver'
    | 'dynamic_callee'
    | 'missing_symbol'
    | 'multiple_overload_candidates'
    | 'target_not_indexable';

export type TypeScriptSemanticTargetKind = 'function' | 'method' | 'constructor';

export interface TypeScriptSemanticTarget {
    readonly file: string;
    readonly span: SourceSpan;
    readonly name: string;
    readonly kind: TypeScriptSemanticTargetKind;
    readonly ownerName?: string;
}

export interface TypeScriptCallEvidence {
    readonly sourceFile: string;
    readonly callSpan: SourceSpan;
    readonly callKind: 'direct' | 'member' | 'constructor';
    readonly calleeName: string;
    readonly calleeText: string;
    readonly decision: TypeScriptSemanticDecision;
    readonly reason: TypeScriptSemanticReason;
    readonly receiverType?: string;
    readonly target?: TypeScriptSemanticTarget;
    readonly candidates?: readonly TypeScriptSemanticTarget[];
}

export interface TypeScriptProjectEvidence {
    readonly language: 'typescript';
    readonly providerId: typeof TYPESCRIPT_COMPILER_PROVIDER_ID;
    readonly providerVersion: typeof TYPESCRIPT_COMPILER_PROVIDER_VERSION;
    readonly compilerVersion: string;
    readonly occurrencesByFile: ReadonlyMap<string, readonly TypeScriptCallEvidence[]>;
    readonly diagnostics?: {
        readonly syntactic: number;
        readonly semantic: number;
    };
    readonly durationMs: number;
}

export interface TypeScriptCompilerProviderOptions {
    readonly compilerOptions?: ts.CompilerOptions;
    readonly collectDiagnostics?: boolean;
}

export interface TypeScriptProgramSourceFile {
    readonly projectPath: string;
    readonly sourceFile: ts.SourceFile;
}

interface ProjectFile {
    readonly projectPath: string;
    readonly virtualPath: string;
    readonly source: string;
    readonly sourceMap: Utf8SourceMap;
}

interface CandidateSet {
    readonly decision: TypeScriptSemanticDecision;
    readonly reason: TypeScriptSemanticReason;
    readonly receiverType?: string;
    readonly targets: readonly TypeScriptSemanticTarget[];
}

interface ProjectDispatchContext {
    readonly classTypes: readonly ts.Type[];
    readonly targetsByTypeAndMember: Map<ts.Type, Map<string, readonly TypeScriptSemanticTarget[]>>;
}

function normalizeProjectPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function virtualPathFor(projectPath: string): string {
    return path.posix.join(VIRTUAL_ROOT, normalizeProjectPath(projectPath));
}

function scriptKindFor(fileName: string): ts.ScriptKind {
    if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}

function defaultCompilerOptions(): ts.CompilerOptions {
    return {
        allowJs: false,
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        noLib: false,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
    };
}

function buildCompilerHost(
    filesByVirtualPath: ReadonlyMap<string, ProjectFile>,
    options: ts.CompilerOptions,
): ts.CompilerHost {
    const base = ts.createCompilerHost(options, true);
    const virtualDirectories = new Set<string>([VIRTUAL_ROOT]);

    for (const fileName of filesByVirtualPath.keys()) {
        let current = path.posix.dirname(fileName);
        while (current.startsWith(VIRTUAL_ROOT)) {
            virtualDirectories.add(current);
            if (current === VIRTUAL_ROOT) break;
            current = path.posix.dirname(current);
        }
    }

    const normalizeVirtual = (fileName: string): string => path.posix.normalize(fileName.replace(/\\/g, '/'));

    return {
        ...base,
        getCurrentDirectory: () => VIRTUAL_ROOT,
        fileExists: (fileName) => {
            const normalized = normalizeVirtual(fileName);
            return filesByVirtualPath.has(normalized) || base.fileExists(fileName);
        },
        readFile: (fileName) => {
            const normalized = normalizeVirtual(fileName);
            return filesByVirtualPath.get(normalized)?.source ?? base.readFile(fileName);
        },
        getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
            const normalized = normalizeVirtual(fileName);
            const projectFile = filesByVirtualPath.get(normalized);
            if (projectFile) {
                return ts.createSourceFile(
                    normalized,
                    projectFile.source,
                    languageVersion,
                    true,
                    scriptKindFor(projectFile.projectPath),
                );
            }
            return base.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        },
        directoryExists: (directoryName) => (
            virtualDirectories.has(normalizeVirtual(directoryName))
            || base.directoryExists?.(directoryName)
            || false
        ),
        realpath: (fileName) => {
            const normalized = normalizeVirtual(fileName);
            return filesByVirtualPath.has(normalized) || normalized.startsWith(VIRTUAL_ROOT)
                ? normalized
                : (base.realpath?.(fileName) ?? fileName);
        },
    };
}

function resolvedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
        seen.add(current);
        const next = checker.getAliasedSymbol(current);
        if (!next || next === current) break;
        current = next;
    }
    return current;
}

function declarationName(declaration: ts.Declaration): string | undefined {
    if (ts.isConstructorDeclaration(declaration)) return 'constructor';
    if (!('name' in declaration)) return undefined;

    const name = (declaration as ts.NamedDeclaration).name;
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return undefined;
}

function enclosingClassName(declaration: ts.Declaration): string | undefined {
    let current: ts.Node | undefined = declaration.parent;
    while (current) {
        if (ts.isClassLike(current)) {
            return current.name?.text;
        }
        current = current.parent;
    }
    return undefined;
}

function isFunctionInitializer(node: ts.Expression | undefined): boolean {
    return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function isExecutableDeclaration(declaration: ts.Declaration): boolean {
    if (ts.isFunctionDeclaration(declaration)) return Boolean(declaration.body);
    if (ts.isMethodDeclaration(declaration)) return Boolean(declaration.body);
    if (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) {
        return Boolean(declaration.body);
    }
    if (ts.isConstructorDeclaration(declaration)) return Boolean(declaration.body);
    if (ts.isVariableDeclaration(declaration)) return isFunctionInitializer(declaration.initializer);
    if (ts.isPropertyDeclaration(declaration)) return isFunctionInitializer(declaration.initializer);
    return false;
}

function targetKind(declaration: ts.Declaration): TypeScriptSemanticTargetKind | undefined {
    if (ts.isConstructorDeclaration(declaration)) return 'constructor';
    if (ts.isMethodDeclaration(declaration)
        || ts.isGetAccessorDeclaration(declaration)
        || ts.isSetAccessorDeclaration(declaration)
        || ts.isPropertyDeclaration(declaration)) {
        return 'method';
    }
    if (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) {
        return 'function';
    }
    return undefined;
}

function isInsideCallableVariable(declaration: ts.VariableDeclaration): boolean {
    let current: ts.Node | undefined = declaration.parent;
    while (current) {
        if (ts.isFunctionLike(current)) return true;
        if (ts.isSourceFile(current)) return false;
        current = current.parent;
    }
    return false;
}

function isSatoriIndexableDeclaration(declaration: ts.Declaration): boolean {
    if (ts.isVariableDeclaration(declaration)) {
        return !isInsideCallableVariable(declaration);
    }
    if (ts.isPropertyDeclaration(declaration)) {
        return ts.isClassLike(declaration.parent);
    }
    if (ts.isMethodDeclaration(declaration)
        || ts.isGetAccessorDeclaration(declaration)
        || ts.isSetAccessorDeclaration(declaration)
        || ts.isConstructorDeclaration(declaration)) {
        return ts.isClassLike(declaration.parent);
    }
    return ts.isFunctionDeclaration(declaration);
}

function declarationBelongsToProject(
    declaration: ts.Declaration,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): boolean {
    const sourceFileName = path.posix.normalize(declaration.getSourceFile().fileName.replace(/\\/g, '/'));
    return projectFilesByVirtualPath.has(sourceFileName);
}

function registryCompatibleDeclarationStart(
    declaration: ts.Declaration,
    sourceFile: ts.SourceFile,
): number {
    if (!ts.isFunctionDeclaration(declaration) || declaration.parent !== sourceFile) {
        return declaration.getStart(sourceFile);
    }

    const semanticModifier = declaration.modifiers?.find((modifier) => (
        modifier.kind !== ts.SyntaxKind.ExportKeyword
        && modifier.kind !== ts.SyntaxKind.DefaultKeyword
    ));
    if (semanticModifier) return semanticModifier.getStart(sourceFile);

    const functionKeyword = declaration.getChildren(sourceFile)
        .find((child) => child.kind === ts.SyntaxKind.FunctionKeyword);
    return functionKeyword?.getStart(sourceFile) ?? declaration.getStart(sourceFile);
}

function targetFromDeclaration(
    declaration: ts.Declaration,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
    allowDeclarationOnly = false,
): TypeScriptSemanticTarget | undefined {
    if ((!allowDeclarationOnly && !isExecutableDeclaration(declaration)) || !isSatoriIndexableDeclaration(declaration)) {
        return undefined;
    }

    const kind = targetKind(declaration);
    const name = declarationName(declaration);
    if (!kind || !name) return undefined;

    const sourceFile = declaration.getSourceFile();
    const projectFile = projectFilesByVirtualPath.get(path.posix.normalize(sourceFile.fileName.replace(/\\/g, '/')));
    if (!projectFile) return undefined;

    return {
        file: projectFile.projectPath,
        span: projectFile.sourceMap.spanFromUtf16(
            registryCompatibleDeclarationStart(declaration, sourceFile),
            declaration.end,
        ),
        name,
        kind,
        ...(enclosingClassName(declaration) ? { ownerName: enclosingClassName(declaration) } : {}),
    };
}

function targetKey(target: TypeScriptSemanticTarget): string {
    return [
        target.file,
        target.span.startByte,
        target.span.endByte,
        target.kind,
        target.ownerName ?? '',
        target.name,
    ].join(':');
}

function uniqueTargets(targets: readonly TypeScriptSemanticTarget[]): TypeScriptSemanticTarget[] {
    const byKey = new Map<string, TypeScriptSemanticTarget>();
    for (const target of targets) {
        byKey.set(targetKey(target), target);
    }
    return [...byKey.values()];
}

function implementationsForSymbol(
    checker: ts.TypeChecker,
    symbol: ts.Symbol | undefined,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): TypeScriptSemanticTarget[] {
    const resolved = resolvedSymbol(checker, symbol);
    if (!resolved) return [];

    const targets: TypeScriptSemanticTarget[] = [];
    for (const declaration of resolved.declarations ?? []) {
        const target = targetFromDeclaration(declaration, projectFilesByVirtualPath);
        if (target) targets.push(target);
    }
    return uniqueTargets(targets);
}

function signatureTarget(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): TypeScriptSemanticTarget | undefined {
    const signature = checker.getResolvedSignature(call);
    const declaration = signature?.declaration;
    if (!declaration) return undefined;

    const direct = targetFromDeclaration(declaration, projectFilesByVirtualPath);
    if (direct) return direct;

    const named = declaration as ts.NamedDeclaration;
    const symbol = named.name ? checker.getSymbolAtLocation(named.name) : undefined;
    const targets = implementationsForSymbol(checker, symbol, projectFilesByVirtualPath);
    return targets.length === 1 ? targets[0] : undefined;
}

function callCalleeName(call: ts.CallExpression | ts.NewExpression): string {
    const expression = call.expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const arg = expression.argumentExpression;
        if (ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg)) return arg.text;
    }
    return expression.getText(call.getSourceFile());
}

function nullableType(type: ts.Type): boolean {
    return (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0;
}

function callUsesOptionalReceiver(call: ts.CallExpression | ts.NewExpression): boolean {
    if (ts.isNewExpression(call)) return false;
    if (call.questionDotToken) return true;
    return ts.isPropertyAccessExpression(call.expression) && Boolean(call.expression.questionDotToken)
        || ts.isElementAccessExpression(call.expression) && Boolean(call.expression.questionDotToken);
}

function propertyNameForExpression(
    expression: ts.LeftHandSideExpression,
): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        if (ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression)) {
            return expression.argumentExpression.text;
        }
    }
    return undefined;
}

function receiverForExpression(expression: ts.LeftHandSideExpression): ts.Expression | undefined {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        return expression.expression;
    }
    return undefined;
}

function collectProjectDispatchContext(
    checker: ts.TypeChecker,
    program: ts.Program,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): ProjectDispatchContext {
    const classTypes: ts.Type[] = [];
    for (const sourceFile of program.getSourceFiles()) {
        const normalized = path.posix.normalize(sourceFile.fileName.replace(/\\/g, '/'));
        if (!projectFilesByVirtualPath.has(normalized)) continue;
        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) {
                const isAbstract = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword);
                if (!isAbstract) {
                    const symbol = checker.getSymbolAtLocation(node.name);
                    if (symbol) {
                        classTypes.push(checker.getDeclaredTypeOfSymbol(symbol));
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    return {
        classTypes,
        targetsByTypeAndMember: new Map(),
    };
}

function dispatchTargetsForType(
    checker: ts.TypeChecker,
    receiverType: ts.Type,
    propertyName: string,
    dispatchContext: ProjectDispatchContext,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): readonly TypeScriptSemanticTarget[] {
    const cachedByMember = dispatchContext.targetsByTypeAndMember.get(receiverType);
    const cached = cachedByMember?.get(propertyName);
    if (cached) return cached;

    const targets: TypeScriptSemanticTarget[] = [];
    for (const candidateType of dispatchContext.classTypes) {
        if (!checker.isTypeAssignableTo(candidateType, receiverType)) continue;
        const property = checker.getPropertyOfType(candidateType, propertyName);
        if (!property) continue;
        targets.push(...implementationsForSymbol(checker, property, projectFilesByVirtualPath));
    }

    const unique = uniqueTargets(targets);
    const byMember = cachedByMember ?? new Map<string, readonly TypeScriptSemanticTarget[]>();
    byMember.set(propertyName, unique);
    if (!cachedByMember) dispatchContext.targetsByTypeAndMember.set(receiverType, byMember);
    return unique;
}

function hasUncertainArgument(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
): boolean {
    return (call.arguments ?? []).some((argument) => {
        const type = checker.getTypeAtLocation(argument);
        return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0;
    });
}

function overloadCandidates(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): readonly TypeScriptSemanticTarget[] {
    if (!hasUncertainArgument(checker, call)) return [];
    const signatures: ts.Signature[] = [];
    checker.getResolvedSignature(call, signatures);
    if (signatures.length <= 1) return [];
    return uniqueTargets(signatures
        .map((signature) => signature.declaration
            ? targetFromDeclaration(signature.declaration, projectFilesByVirtualPath, true)
            : undefined)
        .filter((target): target is TypeScriptSemanticTarget => Boolean(target)));
}

function assignmentTargetsForExpression(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    propertyName: string,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
    seenSymbols = new Set<ts.Symbol>(),
): readonly TypeScriptSemanticTarget[] | undefined {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current)
        || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }

    if (ts.isConditionalExpression(current)) {
        const whenTrue = assignmentTargetsForExpression(
            checker,
            current.whenTrue,
            propertyName,
            projectFilesByVirtualPath,
            seenSymbols,
        );
        const whenFalse = assignmentTargetsForExpression(
            checker,
            current.whenFalse,
            propertyName,
            projectFilesByVirtualPath,
            seenSymbols,
        );
        if (!whenTrue || !whenFalse) return undefined;
        return uniqueTargets([...whenTrue, ...whenFalse]);
    }

    if (ts.isIdentifier(current)) {
        const symbol = symbolAtIdentifier(checker, current);
        if (!symbol || seenSymbols.has(symbol)) return undefined;
        const declaration = symbol.valueDeclaration;
        if (
            !declaration
            || !ts.isVariableDeclaration(declaration)
            || !declaration.initializer
            || !ts.isVariableDeclarationList(declaration.parent)
            || (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
            return undefined;
        }
        const nextSeen = new Set(seenSymbols);
        nextSeen.add(symbol);
        return assignmentTargetsForExpression(
            checker,
            declaration.initializer,
            propertyName,
            projectFilesByVirtualPath,
            nextSeen,
        );
    }

    if (
        ts.isPropertyAccessExpression(current)
        && current.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        const property = resolvedSymbol(checker, checker.getSymbolAtLocation(current.name));
        const declaration = property?.valueDeclaration;
        if (
            declaration
            && ts.isPropertyDeclaration(declaration)
            && declaration.initializer
            && declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
        ) {
            return assignmentTargetsForExpression(
                checker,
                declaration.initializer,
                propertyName,
                projectFilesByVirtualPath,
                seenSymbols,
            );
        }
    }

    if (!ts.isNewExpression(current)) return undefined;

    const type = checker.getTypeAtLocation(current);
    const property = checker.getPropertyOfType(type, propertyName);
    if (!property) return undefined;
    const targets = implementationsForSymbol(checker, property, projectFilesByVirtualPath);
    return targets.length > 0 ? targets : undefined;
}

function symbolAtIdentifier(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
    return resolvedSymbol(checker, checker.getSymbolAtLocation(node));
}

function isPrivateClassMemberDeclaration(declaration: ts.Declaration): boolean {
    if (!ts.isClassElement(declaration)) return false;
    if ('name' in declaration && declaration.name && ts.isPrivateIdentifier(declaration.name)) {
        return true;
    }
    const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
    return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
}

function privateThisMemberCandidates(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    receiver: ts.Expression,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): CandidateSet | undefined {
    if (receiver.kind !== ts.SyntaxKind.ThisKeyword || ts.isNewExpression(call)) return undefined;
    const expression = call.expression;
    const symbol = ts.isPropertyAccessExpression(expression)
        ? resolvedSymbol(checker, checker.getSymbolAtLocation(expression.name))
        : resolvedSymbol(checker, checker.getSymbolAtLocation(expression));
    const executableDeclarations = (symbol?.declarations ?? []).filter(isExecutableDeclaration);
    if (
        executableDeclarations.length === 0
        || executableDeclarations.some((declaration) => !isPrivateClassMemberDeclaration(declaration))
    ) {
        return undefined;
    }
    const targets = uniqueTargets(executableDeclarations
        .map((declaration) => targetFromDeclaration(declaration, projectFilesByVirtualPath))
        .filter((target): target is TypeScriptSemanticTarget => Boolean(target)));
    if (targets.length === 0) return undefined;
    return {
        decision: targets.length === 1 ? 'resolved' : 'ambiguous',
        reason: targets.length === 1 ? 'single_executable_target' : 'multiple_executable_targets',
        targets,
    };
}

function immutableLocalOriginCandidates(
    checker: ts.TypeChecker,
    receiver: ts.Expression,
    propertyName: string,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): CandidateSet | undefined {
    if (!ts.isIdentifier(receiver)) return undefined;

    const symbol = symbolAtIdentifier(checker, receiver);
    const declaration = symbol?.valueDeclaration;
    if (
        !declaration
        || !ts.isVariableDeclaration(declaration)
        || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
        return undefined;
    }

    const targets = assignmentTargetsForExpression(
        checker,
        declaration.initializer,
        propertyName,
        projectFilesByVirtualPath,
    );
    if (!targets || targets.length === 0) return undefined;

    const unique = uniqueTargets(targets);
    return {
        decision: unique.length === 1 ? 'resolved' : 'ambiguous',
        reason: unique.length === 1 ? 'single_executable_target' : 'multiple_executable_targets',
        targets: unique,
    };
}

function memberCandidates(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
    dispatchContext: ProjectDispatchContext,
): CandidateSet | undefined {
    const receiver = receiverForExpression(call.expression);
    if (!receiver) return undefined;

    const propertyName = propertyNameForExpression(call.expression);
    if (!propertyName) {
        return {
            decision: 'unsupported',
            reason: 'dynamic_callee',
            targets: [],
        };
    }

    const receiverType = checker.getTypeAtLocation(receiver);
    const receiverTypeText = checker.typeToString(
        receiverType,
        receiver,
        ts.TypeFormatFlags.NoTruncation,
    );

    const privateThisCandidates = privateThisMemberCandidates(
        checker,
        call,
        receiver,
        projectFilesByVirtualPath,
    );
    if (privateThisCandidates) {
        return {
            ...privateThisCandidates,
            receiverType: receiverTypeText,
        };
    }

    if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
        return {
            decision: 'unsupported',
            reason: 'dynamic_receiver',
            receiverType: receiverTypeText,
            targets: [],
        };
    }

    if ((receiverType.flags & ts.TypeFlags.TypeParameter) !== 0) {
        return {
            decision: 'unresolved',
            reason: 'generic_receiver',
            receiverType: receiverTypeText,
            targets: [],
        };
    }

    const overloads = overloadCandidates(checker, call, projectFilesByVirtualPath);
    if (overloads.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_overload_candidates',
            receiverType: receiverTypeText,
            targets: overloads,
        };
    }

    if (!ts.isIdentifier(receiver)) {
        const expressionTargets = assignmentTargetsForExpression(
            checker,
            receiver,
            propertyName,
            projectFilesByVirtualPath,
        );
        if (expressionTargets && expressionTargets.length > 0) {
            const targets = uniqueTargets(expressionTargets);
            return {
                decision: targets.length === 1 ? 'resolved' : 'ambiguous',
                reason: targets.length === 1 ? 'single_executable_target' : 'multiple_executable_targets',
                receiverType: receiverTypeText,
                targets,
            };
        }
    }

    const originCandidates = immutableLocalOriginCandidates(
        checker,
        receiver,
        propertyName,
        projectFilesByVirtualPath,
    );
    if (originCandidates) {
        return {
            ...originCandidates,
            receiverType: receiverTypeText,
        };
    }

    const optionalReceiver = callUsesOptionalReceiver(call);
    const branches = receiverType.isUnion()
        ? receiverType.types.filter((part) => !(optionalReceiver && nullableType(part)))
        : [receiverType];

    if (branches.length === 0) {
        return {
            decision: 'unresolved',
            reason: 'missing_symbol',
            receiverType: receiverTypeText,
            targets: [],
        };
    }

    const allTargets: TypeScriptSemanticTarget[] = [];
    let unresolvedBranch = false;
    let nonIndexableBranch = false;

    for (const branch of branches) {
        if ((branch.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) {
            unresolvedBranch = true;
            continue;
        }

        const property = checker.getPropertyOfType(branch, propertyName);
        if (!property) {
            unresolvedBranch = true;
            continue;
        }

        const declarations = resolvedSymbol(checker, property)?.declarations ?? [];
        const executableDeclarations = declarations.filter(isExecutableDeclaration);
        const hasProjectDeclaration = declarations.some((declaration) => (
            declarationBelongsToProject(declaration, projectFilesByVirtualPath)
        ));
        const ownTargets = executableDeclarations
            .map((declaration) => targetFromDeclaration(declaration, projectFilesByVirtualPath))
            .filter((target): target is TypeScriptSemanticTarget => Boolean(target));

        const dispatchTargets = dispatchTargetsForType(
            checker,
            branch,
            propertyName,
            dispatchContext,
            projectFilesByVirtualPath,
        );
        if (dispatchTargets.length > 1) {
            allTargets.push(...dispatchTargets);
            continue;
        }
        if (dispatchTargets.length === 1) {
            allTargets.push(dispatchTargets[0]);
            const receiverOwnsTarget = ownTargets.some(
                (target) => targetKey(target) === targetKey(dispatchTargets[0]),
            );
            if (!receiverOwnsTarget) {
                // Project-local assignability is candidate evidence, not a closed-world
                // proof that an interface/structural contract has one runtime implementation.
                unresolvedBranch = true;
            }
            continue;
        }

        if (ownTargets.length === 0) {
            if (!hasProjectDeclaration || executableDeclarations.length > 0) {
                nonIndexableBranch = true;
            } else {
                unresolvedBranch = true;
            }
            continue;
        }

        allTargets.push(...ownTargets);
    }

    const targets = uniqueTargets(allTargets);
    if (targets.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_executable_targets',
            receiverType: receiverTypeText,
            targets,
        };
    }
    if (unresolvedBranch) {
        return {
            decision: 'unresolved',
            reason: 'declaration_without_implementation',
            receiverType: receiverTypeText,
            targets,
        };
    }
    if (nonIndexableBranch) {
        return {
            decision: 'unsupported',
            reason: 'target_not_indexable',
            receiverType: receiverTypeText,
            targets,
        };
    }
    if (targets.length === 1) {
        return {
            decision: 'resolved',
            reason: 'single_executable_target',
            receiverType: receiverTypeText,
            targets,
        };
    }

    return {
        decision: 'unresolved',
        reason: 'missing_symbol',
        receiverType: receiverTypeText,
        targets: [],
    };
}

function directCandidates(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
): CandidateSet {
    const overloads = overloadCandidates(checker, call, projectFilesByVirtualPath);
    if (overloads.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_overload_candidates',
            targets: overloads,
        };
    }

    const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(call.expression));
    const symbolTargets = implementationsForSymbol(checker, symbol, projectFilesByVirtualPath);
    const signature = signatureTarget(checker, call, projectFilesByVirtualPath);
    const targets = uniqueTargets(signature ? [...symbolTargets, signature] : symbolTargets);

    if (targets.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_executable_targets',
            targets,
        };
    }
    if (targets.length === 1) {
        return {
            decision: 'resolved',
            reason: 'single_executable_target',
            targets,
        };
    }

    const declarations = symbol?.declarations ?? [];
    const declarationCount = declarations.length;
    const hasProjectDeclaration = declarations.some((declaration) => (
        declarationBelongsToProject(declaration, projectFilesByVirtualPath)
    ));
    return {
        decision: declarationCount > 0 && hasProjectDeclaration ? 'unresolved' : 'unsupported',
        reason: declarationCount > 0
            ? (hasProjectDeclaration ? 'declaration_without_implementation' : 'target_not_indexable')
            : 'missing_symbol',
        targets: [],
    };
}

function evidenceForCall(
    checker: ts.TypeChecker,
    call: ts.CallExpression | ts.NewExpression,
    sourceFile: ts.SourceFile,
    projectFile: ProjectFile,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
    dispatchContext: ProjectDispatchContext,
): TypeScriptCallEvidence {
    const member = memberCandidates(checker, call, projectFilesByVirtualPath, dispatchContext);
    const candidates = member ?? directCandidates(checker, call, projectFilesByVirtualPath);
    const [target] = candidates.targets;

    return {
        sourceFile: projectFile.projectPath,
        callSpan: projectFile.sourceMap.spanFromUtf16(call.getStart(sourceFile), call.end),
        callKind: ts.isNewExpression(call)
            ? 'constructor'
            : receiverForExpression(call.expression)
                ? 'member'
                : 'direct',
        calleeName: callCalleeName(call),
        calleeText: call.expression.getText(sourceFile),
        decision: candidates.decision,
        reason: candidates.reason,
        ...(candidates.receiverType ? { receiverType: candidates.receiverType } : {}),
        ...(candidates.decision === 'resolved' && target ? { target } : {}),
        ...(candidates.targets.length > 0 ? { candidates: candidates.targets } : {}),
    };
}

function analyzeProgramEvidence(
    program: ts.Program,
    projectFiles: readonly ProjectFile[],
    collectDiagnostics: boolean,
    startedAt: number,
    sourceFiles?: ReadonlySet<string>,
): TypeScriptProjectEvidence {
    const projectFilesByVirtualPath = new Map(projectFiles.map((file) => [file.virtualPath, file]));
    const checker = program.getTypeChecker();
    const dispatchContext = collectProjectDispatchContext(checker, program, projectFilesByVirtualPath);
    const occurrencesByFile = new Map<string, TypeScriptCallEvidence[]>();

    for (const projectFile of projectFiles) {
        if (sourceFiles && !sourceFiles.has(projectFile.projectPath)) continue;
        const sourceFile = program.getSourceFile(projectFile.virtualPath);
        if (!sourceFile || sourceFile.isDeclarationFile) {
            occurrencesByFile.set(projectFile.projectPath, []);
            continue;
        }

        const occurrences: TypeScriptCallEvidence[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                occurrences.push(evidenceForCall(
                    checker,
                    node,
                    sourceFile,
                    projectFile,
                    projectFilesByVirtualPath,
                    dispatchContext,
                ));
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        occurrencesByFile.set(projectFile.projectPath, occurrences);
    }

    const diagnostics = collectDiagnostics
        ? {
            syntactic: program.getSyntacticDiagnostics().length,
            semantic: program.getSemanticDiagnostics().length,
        }
        : undefined;

    return {
        language: 'typescript',
        providerId: TYPESCRIPT_COMPILER_PROVIDER_ID,
        providerVersion: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
        compilerVersion: ts.version,
        occurrencesByFile,
        ...(diagnostics ? { diagnostics } : {}),
        durationMs: performance.now() - startedAt,
    };
}

export function analyzeTypeScriptProgram(
    program: ts.Program,
    sourceFiles: readonly TypeScriptProgramSourceFile[],
    providerOptions: Pick<TypeScriptCompilerProviderOptions, 'collectDiagnostics'> & {
        readonly sourceFiles?: ReadonlySet<string>;
    } = {},
): TypeScriptProjectEvidence {
    const startedAt = performance.now();
    const projectFiles = sourceFiles.map(({ projectPath, sourceFile }): ProjectFile => ({
        projectPath: normalizeProjectPath(projectPath),
        virtualPath: path.posix.normalize(sourceFile.fileName.replace(/\\\\/g, '/')),
        source: sourceFile.text,
        sourceMap: new Utf8SourceMap(sourceFile.text),
    }));
    return analyzeProgramEvidence(
        program,
        projectFiles,
        providerOptions.collectDiagnostics ?? false,
        startedAt,
        providerOptions.sourceFiles,
    );
}

export function analyzeTypeScriptProject(
    input: SemanticProjectInput,
    providerOptions: TypeScriptCompilerProviderOptions = {},
): TypeScriptProjectEvidence {
    const startedAt = performance.now();

    const projectFiles = input.sourceFiles.map((file): ProjectFile => ({
        projectPath: normalizeProjectPath(file.path),
        virtualPath: virtualPathFor(file.path),
        source: file.source,
        sourceMap: new Utf8SourceMap(file.source),
    }));
    const projectFilesByVirtualPath = new Map(projectFiles.map((file) => [file.virtualPath, file]));
    const compilerOptions = {
        ...defaultCompilerOptions(),
        ...providerOptions.compilerOptions,
        noEmit: true,
    };
    const host = buildCompilerHost(projectFilesByVirtualPath, compilerOptions);
    const program = ts.createProgram({
        rootNames: projectFiles.map((file) => file.virtualPath),
        options: compilerOptions,
        host,
    });
    return analyzeProgramEvidence(
        program,
        projectFiles,
        providerOptions.collectDiagnostics ?? false,
        startedAt,
    );
}
