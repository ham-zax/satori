import path from 'node:path';
import * as ts from './typescript-api';
import { createFileSystemLayer } from './typescript-api';

import { Utf8SourceMap } from '../language-analysis/source-map';
import type { SourceSpan } from '../language-analysis/types';
import {
    TYPESCRIPT_COMPILER_PROVIDER_ID,
    TYPESCRIPT_COMPILER_PROVIDER_VERSION,
} from './typescript-provider-identity';
import type { SemanticProjectInput } from './contracts';

export { TYPESCRIPT_COMPILER_PROVIDER_ID, TYPESCRIPT_COMPILER_PROVIDER_VERSION };

const VIRTUAL_ROOT = '/__satori__';
// Bounded call-site batch size: keeps generator frames small while amortizing
// TS 7.1 IPC round-trips and warming per-program caches across chunks.
const CALL_BATCH_CHUNK_SIZE = 256;
// A call chunk can expand to every receiver branch crossed with every class.
// Bound the number of generators passed as arguments to any prewarm batch.
const ASSIGNABILITY_BATCH_SIZE = 16_384;

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

export interface TypeScriptBindingProof {
    readonly kind: 'same_file_definition' | 'relative_import' | 'absolute_import'
        | 'constructor_origin' | 'allocation_origin' | 'assignment_origin'
        | 'alias_binding' | 'optional_receiver' | 'interface_contract'
        | 'branch_origin' | 'field_origin' | 'class_inheritance' | 'flow_hop';
    readonly subject: string;
    readonly span: SourceSpan;
    readonly detail?: string;
    readonly hop?: number;
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
    readonly bindingProofs?: readonly TypeScriptBindingProof[];
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
    readonly sourceFile?: ts.SourceFile;
}

interface CandidateSet {
    readonly decision: TypeScriptSemanticDecision;
    readonly reason: TypeScriptSemanticReason;
    readonly receiverType?: string;
    readonly targets: readonly TypeScriptSemanticTarget[];
    readonly bindingProofs?: readonly TypeScriptBindingProof[];
}

interface AnalysisCaches {
    readonly resolvedSymbolById: Map<number, ts.Symbol>;
    readonly propertyOfTypeByKey: Map<string, ts.Symbol | undefined>;
    readonly implementationsBySymbolId: Map<number, readonly TypeScriptSemanticTarget[]>;
    readonly assignableClassesByTypeId: Map<number, readonly ts.Type[]>;
    readonly baseConstraintByTypeId: Map<number, ts.Type | undefined>;
}

interface AnalysisContext {
    readonly projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>;
    readonly projectCanonicalPaths: ReadonlySet<string>;
    readonly caches: AnalysisCaches;
    readonly skipExternalHandles: boolean;
}

interface ProjectDispatchContext {
    readonly classTypes: readonly ts.Type[];
    readonly targetsByTypeAndMember: Map<ts.Type, Map<string, readonly TypeScriptSemanticTarget[]>>;
    readonly fieldBindingProofs: Map<ts.Symbol, TypeScriptBindingProof[]>;
}

interface CallWorkItem {
    readonly call: ts.CallExpression | ts.NewExpression;
    readonly sourceFile: ts.SourceFile;
    readonly projectFile: ProjectFile;
    readonly fileOccurrences: TypeScriptCallEvidence[];
}

function bindingProof(
    kind: TypeScriptBindingProof['kind'],
    node: ts.Node,
    projectFilesByVirtualPath: ReadonlyMap<string, ProjectFile>,
    detail?: string,
): TypeScriptBindingProof[] {
    const sourceFile = node.getSourceFile();
    const file = projectFilesByVirtualPath.get(path.posix.normalize(sourceFile.fileName.replace(/\\/g, '/')));
    if (!file) return [];
    return [{
        kind,
        subject: node.getText(sourceFile),
        span: file.sourceMap.spanFromUtf16(node.getStart(sourceFile), node.end),
        ...(detail ? { detail } : {}),
    }];
}

function normalizeProjectPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function virtualPathFor(projectPath: string): string {
    return path.posix.join(VIRTUAL_ROOT, normalizeProjectPath(projectPath));
}

function defaultCompilerOptions(): ts.CompilerOptions {
    return {
        allowJs: false,
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

function handleBelongsToProject(
    handle: ts.NodeHandle,
    context: AnalysisContext,
): boolean {
    const rawPath = String(handle.path);
    if (context.projectCanonicalPaths.has(rawPath)) return true;
    const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
    return context.projectFilesByVirtualPath.has(normalized);
}

function* resolveHandlesGen<T extends ts.Node>(
    handles: readonly ts.NodeHandle<T>[],
    context: AnalysisContext,
    projectOnly: boolean,
): ts.APIRequestGenerator<T[]> {
    const filtered = projectOnly && context.skipExternalHandles
        ? handles.filter((handle) => handleBelongsToProject(handle, context))
        : handles;
    if (filtered.length === 0) return [];
    const resolved = yield* ts.all(...filtered.map((handle) => handle.resolve.gen()));
    const nodes: T[] = [];
    for (const node of resolved) {
        if (node) nodes.push(node);
    }
    return nodes;
}

function* resolvedSymbolGen(
    checker: ts.Checker,
    symbol: ts.Symbol | undefined,
    caches: AnalysisCaches,
): ts.APIRequestGenerator<ts.Symbol | undefined> {
    if (!symbol) return undefined;
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    const cached = caches.resolvedSymbolById.get(symbol.id);
    if (cached !== undefined) return cached;

    let current: ts.Symbol | undefined = symbol;
    const seen = new Set<ts.Symbol>();
    const visitedIds: number[] = [];
    while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
        const hit = caches.resolvedSymbolById.get(current.id);
        if (hit !== undefined) {
            current = hit;
            break;
        }
        seen.add(current);
        visitedIds.push(current.id);
        const next: ts.Symbol | undefined = yield* checker.getAliasedSymbol.gen(current);
        if (!next || next === current) break;
        current = next;
    }
    if (current) {
        for (const id of visitedIds) caches.resolvedSymbolById.set(id, current);
    }
    return current;
}

function* propertyOfTypeGen(
    checker: ts.Checker,
    type: ts.Type,
    propertyName: string,
    caches: AnalysisCaches,
): ts.APIRequestGenerator<ts.Symbol | undefined> {
    const key = `${type.id}\0${propertyName}`;
    if (caches.propertyOfTypeByKey.has(key)) {
        return caches.propertyOfTypeByKey.get(key);
    }
    const property = yield* checker.getPropertyOfType.gen(type, propertyName);
    caches.propertyOfTypeByKey.set(key, property);
    return property;
}

function declarationName(declaration: ts.Declaration): string | undefined {
    if (ts.isConstructorDeclaration(declaration)) return 'constructor';
    if (!('name' in declaration)) return undefined;

    const name = (declaration as (ts.Declaration & { readonly name?: ts.DeclarationName })).name;
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return undefined;
}

function enclosingClassName(declaration: ts.Declaration): string | undefined {
    let current: ts.Node | undefined = declaration.parent;
    while (current) {
        if (ts.isClassLikeDeclaration(current)) {
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
        if (ts.isFunctionLikeDeclaration(current)) return true;
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
        return ts.isClassLikeDeclaration(declaration.parent);
    }
    if (ts.isMethodDeclaration(declaration)
        || ts.isGetAccessorDeclaration(declaration)
        || ts.isSetAccessorDeclaration(declaration)
        || ts.isConstructorDeclaration(declaration)) {
        return ts.isClassLikeDeclaration(declaration.parent);
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

function* implementationsForSymbolGen(
    checker: ts.Checker,
    symbol: ts.Symbol | undefined,
    context: AnalysisContext,
): ts.APIRequestGenerator<readonly TypeScriptSemanticTarget[]> {
    const resolved = yield* resolvedSymbolGen(checker, symbol, context.caches);
    if (!resolved) return [];

    const cached = context.caches.implementationsBySymbolId.get(resolved.id);
    if (cached !== undefined) return cached;

    const declarations = yield* resolveHandlesGen(resolved.declarations, context, true);
    const targets: TypeScriptSemanticTarget[] = [];
    for (const declaration of declarations) {
        const target = targetFromDeclaration(declaration, context.projectFilesByVirtualPath);
        if (target) targets.push(target);
    }
    const unique = uniqueTargets(targets);
    context.caches.implementationsBySymbolId.set(resolved.id, unique);
    return unique;
}

function* signatureTargetGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    context: AnalysisContext,
    preResolvedSignature?: ts.Signature,
): ts.APIRequestGenerator<TypeScriptSemanticTarget | undefined> {
    const signature = preResolvedSignature !== undefined
        ? preResolvedSignature
        : yield* checker.getResolvedSignature.gen(call);
    const declHandle = signature?.declaration;
    if (!declHandle) return undefined;
    if (context.skipExternalHandles && !handleBelongsToProject(declHandle, context)) {
        return undefined;
    }
    const declaration = yield* declHandle.resolve.gen();
    if (!declaration) return undefined;

    const direct = targetFromDeclaration(declaration, context.projectFilesByVirtualPath);
    if (direct) return direct;

    const named = declaration as (ts.Declaration & { readonly name?: ts.DeclarationName });
    const symbol = named.name ? yield* checker.getSymbolAtLocation.gen(named.name) : undefined;
    const targets = yield* implementationsForSymbolGen(checker, symbol, context);
    return targets.length === 1 ? targets[0] : undefined;
}

function callCalleeName(call: ts.CallExpression | ts.NewExpression): string {
    const expression = call.expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const arg = expression.argumentExpression;
        if (ts.isStringLiteralLikeNode(arg) || ts.isNumericLiteral(arg)) return arg.text;
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
    expression: ts.Expression,
): string | undefined {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        if (ts.isStringLiteralLikeNode(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression)) {
            return expression.argumentExpression.text;
        }
    }
    return undefined;
}

function receiverForExpression(expression: ts.Expression): ts.Expression | undefined {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
        return expression.expression;
    }
    return undefined;
}

function collectNonAbstractClassNames(sourceFiles: readonly ts.SourceFile[]): ts.Identifier[] {
    const classNames: ts.Identifier[] = [];
    for (const sourceFile of sourceFiles) {
        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) {
                const isAbstract = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword);
                if (!isAbstract) classNames.push(node.name);
            }
            node.forEachChild(visit);
        };
        visit(sourceFile);
    }
    return classNames;
}

type NativeTypeScriptApi = InstanceType<typeof ts.API>;

function collectProjectDispatchContext(
    api: NativeTypeScriptApi | undefined,
    checker: ts.Checker,
    projectSourceFiles: readonly ts.SourceFile[],
    batched: boolean,
): ProjectDispatchContext {
    const classNames = collectNonAbstractClassNames(projectSourceFiles);
    const classTypes: ts.Type[] = [];
    if (classNames.length > 0) {
        if (batched && api) {
            const symbols = api.batch(...classNames.map((name) => checker.getSymbolAtLocation.gen(name)));
            const validSymbols = symbols.filter((symbol): symbol is ts.Symbol => Boolean(symbol));
            if (validSymbols.length > 0) {
                classTypes.push(
                    ...api.batch(...validSymbols.map((symbol) => checker.getDeclaredTypeOfSymbol.gen(symbol))),
                );
            }
        } else {
            for (const name of classNames) {
                const symbol = checker.getSymbolAtLocation(name);
                if (symbol) classTypes.push(checker.getDeclaredTypeOfSymbol(symbol));
            }
        }
    }
    return {
        classTypes,
        targetsByTypeAndMember: new Map(),
        fieldBindingProofs: new Map(),
    };
}

function* dispatchTargetsForTypeGen(
    checker: ts.Checker,
    receiverType: ts.Type,
    propertyName: string,
    dispatchContext: ProjectDispatchContext,
    context: AnalysisContext,
): ts.APIRequestGenerator<readonly TypeScriptSemanticTarget[]> {
    const cachedByMember = dispatchContext.targetsByTypeAndMember.get(receiverType);
    const cached = cachedByMember?.get(propertyName);
    if (cached) return cached;

    let assignableClasses = context.caches.assignableClassesByTypeId.get(receiverType.id);
    if (assignableClasses === undefined) {
        if (dispatchContext.classTypes.length === 0) {
            assignableClasses = [];
        } else {
            const flags = yield* ts.all(
                ...dispatchContext.classTypes.map((candidateType) => (
                    checker.isTypeAssignableTo.gen(candidateType, receiverType)
                )),
            );
            const matched: ts.Type[] = [];
            for (let index = 0; index < dispatchContext.classTypes.length; index++) {
                if (flags[index]) matched.push(dispatchContext.classTypes[index]);
            }
            assignableClasses = matched;
        }
        context.caches.assignableClassesByTypeId.set(receiverType.id, assignableClasses);
    }

    const targets: TypeScriptSemanticTarget[] = [];
    if (assignableClasses.length > 0) {
        const properties = yield* ts.all(
            ...assignableClasses.map((candidateType) => (
                propertyOfTypeGen(checker, candidateType, propertyName, context.caches)
            )),
        );
        const foundProperties = properties.filter((property): property is ts.Symbol => Boolean(property));
        if (foundProperties.length > 0) {
            const targetLists = yield* ts.all(
                ...foundProperties.map((property) => implementationsForSymbolGen(checker, property, context)),
            );
            for (const list of targetLists) targets.push(...list);
        }
    }

    const unique = uniqueTargets(targets);
    const byMember = cachedByMember ?? new Map<string, readonly TypeScriptSemanticTarget[]>();
    byMember.set(propertyName, unique);
    if (!cachedByMember) dispatchContext.targetsByTypeAndMember.set(receiverType, byMember);
    return unique;
}

function* hasUncertainArgumentGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
): ts.APIRequestGenerator<boolean> {
    const args = call.arguments;
    if (!args || args.length === 0) return false;
    const types = yield* ts.all(...args.map((argument) => checker.getTypeAtLocation.gen(argument)));
    return types.some((type) => (
        (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
    ));
}

function* overloadCandidatesGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    context: AnalysisContext,
): ts.APIRequestGenerator<readonly TypeScriptSemanticTarget[]> {
    if (!(yield* hasUncertainArgumentGen(checker, call))) return [];
    const calleeType = yield* checker.getTypeAtLocation.gen(call.expression);
    const signatures = ts.isNewExpression(call)
        ? yield* calleeType.getConstructSignatures.gen()
        : yield* calleeType.getCallSignatures.gen();
    if (signatures.length <= 1) return [];
    const handles = signatures
        .map((signature) => signature.declaration)
        .filter((handle): handle is ts.NodeHandle<ts.Declaration> => Boolean(handle));
    const declarations = yield* resolveHandlesGen(handles, context, true);
    return uniqueTargets(declarations
        .map((declaration) => targetFromDeclaration(declaration, context.projectFilesByVirtualPath, true))
        .filter((target): target is TypeScriptSemanticTarget => Boolean(target)));
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isTypeAssertion(current)
        || ts.isNonNullExpression(current)
        || ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function* symbolAtIdentifierGen(
    checker: ts.Checker,
    node: ts.Identifier,
    caches: AnalysisCaches,
): ts.APIRequestGenerator<ts.Symbol | undefined> {
    const symbol = yield* checker.getSymbolAtLocation.gen(node);
    return yield* resolvedSymbolGen(checker, symbol, caches);
}

function* assignmentTargetsForExpressionGen(
    checker: ts.Checker,
    expression: ts.Expression,
    propertyName: string,
    context: AnalysisContext,
    seenSymbols = new Set<ts.Symbol>(),
): ts.APIRequestGenerator<readonly TypeScriptSemanticTarget[] | undefined> {
    const current = unwrapTransparentExpression(expression);

    if (ts.isConditionalExpression(current)) {
        const [whenTrue, whenFalse] = yield* ts.all(
            assignmentTargetsForExpressionGen(checker, current.whenTrue, propertyName, context, seenSymbols),
            assignmentTargetsForExpressionGen(checker, current.whenFalse, propertyName, context, seenSymbols),
        );
        if (!whenTrue || !whenFalse) return undefined;
        return uniqueTargets([...whenTrue, ...whenFalse]);
    }

    if (ts.isIdentifier(current)) {
        const symbol = yield* symbolAtIdentifierGen(checker, current, context.caches);
        if (!symbol || seenSymbols.has(symbol)) return undefined;
        const declHandle = symbol.valueDeclaration;
        if (!declHandle) return undefined;
        if (context.skipExternalHandles && !handleBelongsToProject(declHandle, context)) return undefined;
        const declaration = yield* declHandle.resolve.gen();
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
        return yield* assignmentTargetsForExpressionGen(
            checker,
            declaration.initializer,
            propertyName,
            context,
            nextSeen,
        );
    }

    if (
        ts.isPropertyAccessExpression(current)
        && current.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        const rawProperty = yield* checker.getSymbolAtLocation.gen(current.name);
        const property = yield* resolvedSymbolGen(checker, rawProperty, context.caches);
        const declHandle = property?.valueDeclaration;
        if (declHandle && (!context.skipExternalHandles || handleBelongsToProject(declHandle, context))) {
            const declaration = yield* declHandle.resolve.gen();
            if (
                declaration
                && ts.isPropertyDeclaration(declaration)
                && declaration.initializer
                && declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
            ) {
                return yield* assignmentTargetsForExpressionGen(
                    checker,
                    declaration.initializer,
                    propertyName,
                    context,
                    seenSymbols,
                );
            }
        }
    }

    if (!ts.isNewExpression(current)) return undefined;

    const type = yield* checker.getTypeAtLocation.gen(current);
    const property = yield* propertyOfTypeGen(checker, type, propertyName, context.caches);
    if (!property) return undefined;
    const targets = yield* implementationsForSymbolGen(checker, property, context);
    return targets.length > 0 ? targets : undefined;
}

function isPrivateClassMemberDeclaration(declaration: ts.Declaration): boolean {
    if (!ts.isClassLikeDeclaration(declaration.parent)) return false;
    if ('name' in declaration && declaration.name && ts.isPrivateIdentifier(declaration.name as ts.Node)) {
        return true;
    }
    const modifiers = 'modifiers' in declaration ? declaration.modifiers as readonly ts.Node[] : undefined;
    return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
}

function* privateThisMemberCandidatesGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    receiver: ts.Expression,
    context: AnalysisContext,
): ts.APIRequestGenerator<CandidateSet | undefined> {
    if (receiver.kind !== ts.SyntaxKind.ThisKeyword || ts.isNewExpression(call)) return undefined;
    const expression = call.expression;
    const rawSymbol = ts.isPropertyAccessExpression(expression)
        ? yield* checker.getSymbolAtLocation.gen(expression.name)
        : yield* checker.getSymbolAtLocation.gen(expression);
    const symbol = yield* resolvedSymbolGen(checker, rawSymbol, context.caches);
    const declarations = symbol ? yield* resolveHandlesGen(symbol.declarations, context, false) : [];
    const executableDeclarations = declarations.filter(isExecutableDeclaration);
    if (
        executableDeclarations.length === 0
        || executableDeclarations.some((declaration) => !isPrivateClassMemberDeclaration(declaration))
    ) {
        return undefined;
    }
    const targets = uniqueTargets(executableDeclarations
        .map((declaration) => targetFromDeclaration(declaration, context.projectFilesByVirtualPath))
        .filter((target): target is TypeScriptSemanticTarget => Boolean(target)));
    if (targets.length === 0) return undefined;
    return {
        decision: targets.length === 1 ? 'resolved' : 'ambiguous',
        reason: targets.length === 1 ? 'single_executable_target' : 'multiple_executable_targets',
        targets,
    };
}

function* immutableLocalOriginCandidatesGen(
    checker: ts.Checker,
    receiver: ts.Expression,
    propertyName: string,
    context: AnalysisContext,
    rawReceiverType: ts.Type,
): ts.APIRequestGenerator<CandidateSet | undefined> {
    if (!ts.isIdentifier(receiver)) return undefined;

    const symbol = yield* symbolAtIdentifierGen(checker, receiver, context.caches);
    const declHandle = symbol?.valueDeclaration;
    if (!declHandle) return undefined;
    if (context.skipExternalHandles && !handleBelongsToProject(declHandle, context)) return undefined;
    const declaration = yield* declHandle.resolve.gen();
    if (
        !declaration
        || !ts.isVariableDeclaration(declaration)
        || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
        return undefined;
    }

    const targets = yield* assignmentTargetsForExpressionGen(
        checker,
        declaration.initializer,
        propertyName,
        context,
    );
    if (!targets || targets.length === 0) return undefined;

    const unique = uniqueTargets(targets);
    const staticProperty = yield* propertyOfTypeGen(checker, rawReceiverType, propertyName, context.caches);
    const staticTargets = yield* implementationsForSymbolGen(checker, staticProperty, context);
    // Preserve compiler binding authority when allocation confirms the same
    // target. Origin flow is needed only when it changes the static target set.
    const confirmsStaticBinding = unique.every((target) => (
        staticTargets.some((candidate) => targetKey(candidate) === targetKey(target))
    ));
    return {
        decision: unique.length === 1 ? 'resolved' : 'ambiguous',
        reason: unique.length === 1 ? 'single_executable_target' : 'multiple_executable_targets',
        targets: unique,
        bindingProofs: bindingProof(
            confirmsStaticBinding ? 'constructor_origin' : 'allocation_origin',
            receiver,
            context.projectFilesByVirtualPath,
        ),
    };
}

function enclosingFunctionLike(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isSourceFile(current)) {
        if (
            ts.isFunctionDeclaration(current)
            || ts.isMethodDeclaration(current)
            || ts.isConstructorDeclaration(current)
            || ts.isGetAccessorDeclaration(current)
            || ts.isSetAccessorDeclaration(current)
            || ts.isFunctionExpression(current)
            || ts.isArrowFunction(current)
        ) {
            return current;
        }
        current = current.parent;
    }
    return undefined;
}

function collectIdentifiersWithName(node: ts.Node, name: string): ts.Identifier[] {
    const matches: ts.Identifier[] = [];
    const visit = (current: ts.Node): void => {
        if (ts.isIdentifier(current) && current.text === name) {
            matches.push(current);
        }
        current.forEachChild(visit);
    };
    visit(node);
    return matches;
}

function* nodeReferencesSymbolGen(
    checker: ts.Checker,
    node: ts.Node,
    symbol: ts.Symbol,
    caches: AnalysisCaches,
): ts.APIRequestGenerator<boolean> {
    const candidates = collectIdentifiersWithName(node, symbol.name);
    if (candidates.length === 0) return false;
    const symbols = yield* ts.all(...candidates.map((id) => symbolAtIdentifierGen(checker, id, caches)));
    return symbols.some((resolved) => resolved === symbol);
}

function isDirectEvalCall(call: ts.CallExpression): boolean {
    if (call.questionDotToken) return false;
    const callee = unwrapTransparentExpression(call.expression);
    return ts.isIdentifier(callee) && callee.text === 'eval';
}

function* mutableLocalOriginCandidatesGen(
    checker: ts.Checker,
    receiver: ts.Expression,
    propertyName: string,
    context: AnalysisContext,
): ts.APIRequestGenerator<CandidateSet | undefined> {
    if (!ts.isIdentifier(receiver)) return undefined;

    const symbol = yield* symbolAtIdentifierGen(checker, receiver, context.caches);
    const declHandle = symbol?.valueDeclaration;
    if (!symbol || !declHandle) return undefined;
    if (context.skipExternalHandles && !handleBelongsToProject(declHandle, context)) return undefined;
    const declaration = yield* declHandle.resolve.gen();
    if (
        !declaration
        || !ts.isVariableDeclaration(declaration)
        || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Let) === 0
    ) {
        return undefined;
    }

    const owner = enclosingFunctionLike(declaration);
    if (!owner?.body) return undefined;

    const targets: TypeScriptSemanticTarget[] = [];
    const originAlternatives: TypeScriptBindingProof[] = [];
    const assignedExpressions: ts.Expression[] = [];
    if (declaration.initializer) assignedExpressions.push(declaration.initializer);

    // Collect relevant AST nodes first so we can verify writes with batched symbol checks.
    let hasEval = false;
    const assignments: ts.BinaryExpression[] = [];
    const unaryUpdates: (ts.PrefixUnaryExpression | ts.PostfixUnaryExpression)[] = [];
    const loopAssignments: (ts.ForInStatement | ts.ForOfStatement)[] = [];

    const visit = (node: ts.Node): void => {
        if (hasEval) return;
        if (ts.isCallExpression(node) && isDirectEvalCall(node)) {
            hasEval = true;
            return;
        }
        if (
            ts.isBinaryExpression(node)
            && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
            assignments.push(node);
        }
        if (
            (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
            && (node.operator === ts.SyntaxKind.PlusPlusToken
                || node.operator === ts.SyntaxKind.MinusMinusToken)
        ) {
            unaryUpdates.push(node);
        }
        if (
            (ts.isForInStatement(node) || ts.isForOfStatement(node))
            && !ts.isVariableDeclarationList(node.initializer)
        ) {
            loopAssignments.push(node);
        }
        node.forEachChild(visit);
    };
    visit(owner.body);
    if (hasEval) return undefined;

    for (const node of unaryUpdates) {
        if (yield* nodeReferencesSymbolGen(checker, node.operand, symbol, context.caches)) {
            return undefined;
        }
    }
    for (const node of loopAssignments) {
        if (yield* nodeReferencesSymbolGen(checker, node.initializer, symbol, context.caches)) {
            return undefined;
        }
    }
    for (const node of assignments) {
        if (!(yield* nodeReferencesSymbolGen(checker, node.left, symbol, context.caches))) continue;
        if (
            node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
            || !ts.isIdentifier(node.left)
            || (yield* symbolAtIdentifierGen(checker, node.left, context.caches)) !== symbol
        ) {
            return undefined;
        }
        assignedExpressions.push(node.right);
    }

    for (const expression of assignedExpressions) {
        const assignedTargets = yield* assignmentTargetsForExpressionGen(
            checker,
            expression,
            propertyName,
            context,
        );
        if (!assignedTargets || assignedTargets.length === 0) return undefined;
        targets.push(...assignedTargets);
        originAlternatives.push(...bindingProof(
            'branch_origin', expression, context.projectFilesByVirtualPath,
            'Observed mutable-binding origin alternative; execution order and reachability are not established.',
        ));
    }

    const unique = uniqueTargets(targets);
    // Mutable-origin evidence is candidate-only. A single observed origin does
    // not establish a new authoritative runtime target.
    if (unique.length < 2) return undefined;
    return {
        decision: 'ambiguous',
        reason: 'multiple_executable_targets',
        targets: unique,
        bindingProofs: originAlternatives,
    };
}

const MAX_RECEIVER_TYPE_DESCRIPTION_LENGTH = 256;
const MAX_RECEIVER_TYPE_COMPONENTS = 8;

function clipReceiverTypeDescription(value: string): string {
    if (value.length <= MAX_RECEIVER_TYPE_DESCRIPTION_LENGTH) return value;
    return `${value.slice(0, MAX_RECEIVER_TYPE_DESCRIPTION_LENGTH - 3)}...`;
}

function* receiverTypeSymbolNameGen(type: ts.Type): ts.APIRequestGenerator<string | undefined> {
    const aliasName = (yield* type.getAliasSymbol.gen())?.name;
    if (aliasName) return clipReceiverTypeDescription(aliasName);

    const symbolName = (yield* type.getSymbol.gen())?.name;
    if (!symbolName || symbolName === '__type' || symbolName === '__object' || symbolName === '__function') {
        return undefined;
    }
    return clipReceiverTypeDescription(symbolName);
}

function receiverTypePrimitiveName(type: ts.Type): string | undefined {
    const flags = type.flags;
    if ((flags & ts.TypeFlags.Any) !== 0) return 'any';
    if ((flags & ts.TypeFlags.Unknown) !== 0) return 'unknown';
    if ((flags & ts.TypeFlags.Never) !== 0) return 'never';
    if ((flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0) return 'string';
    if ((flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0) return 'number';
    if ((flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) !== 0) return 'bigint';
    if ((flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0) return 'boolean';
    if ((flags & ts.TypeFlags.ESSymbol) !== 0) return 'symbol';
    if ((flags & ts.TypeFlags.Void) !== 0) return 'void';
    if ((flags & ts.TypeFlags.Undefined) !== 0) return 'undefined';
    if ((flags & ts.TypeFlags.Null) !== 0) return 'null';
    return undefined;
}

function* describeReceiverTypeGen(type: ts.Type, depth = 0): ts.APIRequestGenerator<string> {
    const symbolName = yield* receiverTypeSymbolNameGen(type);
    if (symbolName) return symbolName;

    const primitiveName = receiverTypePrimitiveName(type);
    if (primitiveName) return primitiveName;

    if (depth < 2 && (type.isUnionType() || type.isIntersectionType())) {
        const separator = type.isUnionType() ? ' | ' : ' & ';
        const allTypes = (yield* type.getTypes.gen()) ?? [];
        const slice = allTypes.slice(0, MAX_RECEIVER_TYPE_COMPONENTS);
        const parts: string[] = slice.length > 0
            ? yield* ts.all(...slice.map((part) => describeReceiverTypeGen(part, depth + 1)))
            : [];
        if (allTypes.length > MAX_RECEIVER_TYPE_COMPONENTS) parts.push('...');
        return clipReceiverTypeDescription(parts.join(separator));
    }

    if ((type.flags & ts.TypeFlags.Object) !== 0) return 'object';
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) return 'type_parameter';
    return 'type';
}

// Inside a class, `this` has the polymorphic this-type: a type parameter
// constrained to the class instance type. Dispatch on that constraint so a
// public `this.m()` gets the same override-aware dispatch as `c: C; c.m()`.
// Unconstrained `this` parameters keep their type parameter.
function* thisReceiverDispatchTypeGen(
    checker: ts.Checker,
    receiver: ts.Expression,
    type: ts.Type,
    caches: AnalysisCaches,
): ts.APIRequestGenerator<ts.Type> {
    if (receiver.kind !== ts.SyntaxKind.ThisKeyword || (type.flags & ts.TypeFlags.TypeParameter) === 0) return type;
    let constraint: ts.Type | undefined;
    if (caches.baseConstraintByTypeId.has(type.id)) {
        constraint = caches.baseConstraintByTypeId.get(type.id);
    } else {
        constraint = yield* checker.getBaseConstraintOfType.gen(type);
        caches.baseConstraintByTypeId.set(type.id, constraint);
    }
    if (!constraint || (constraint.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return type;
    return constraint;
}

function* memberCandidatesWithoutBindingProofsGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    context: AnalysisContext,
    dispatchContext: ProjectDispatchContext,
    rawReceiverType: ts.Type,
    receiverType: ts.Type,
    receiver: ts.Expression,
    propertyName: string,
): ts.APIRequestGenerator<CandidateSet> {
    // Descriptive evidence only. Do not call TypeChecker.typeToString here:
    // project noErrorTruncation settings can force anonymous structural types
    // to expand into very large strings retained once per call during indexing.
    const [receiverTypeText, privateThisCandidates] = yield* ts.all(
        describeReceiverTypeGen(receiverType),
        privateThisMemberCandidatesGen(checker, call, receiver, context),
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

    const overloads = yield* overloadCandidatesGen(checker, call, context);
    if (overloads.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_overload_candidates',
            receiverType: receiverTypeText,
            targets: overloads,
        };
    }

    if (!ts.isIdentifier(receiver)) {
        const expressionTargets = yield* assignmentTargetsForExpressionGen(
            checker,
            receiver,
            propertyName,
            context,
        );
        if (expressionTargets && expressionTargets.length > 0) {
            const targets = uniqueTargets(expressionTargets);
            return {
                decision: targets.length === 1 ? 'resolved' : 'ambiguous',
                reason: targets.length === 1 ? 'single_executable_target' : 'multiple_executable_targets',
                receiverType: receiverTypeText,
                targets,
                bindingProofs: ts.isNewExpression(unwrapTransparentExpression(receiver))
                    ? bindingProof('constructor_origin', receiver, context.projectFilesByVirtualPath)
                    : [],
            };
        }
    }

    const originCandidates = yield* immutableLocalOriginCandidatesGen(
        checker,
        receiver,
        propertyName,
        context,
        rawReceiverType,
    );
    if (originCandidates) {
        return {
            ...originCandidates,
            receiverType: receiverTypeText,
        };
    }

    const mutableOriginCandidates = yield* mutableLocalOriginCandidatesGen(
        checker,
        receiver,
        propertyName,
        context,
    );
    if (mutableOriginCandidates) {
        return {
            ...mutableOriginCandidates,
            receiverType: receiverTypeText,
        };
    }

    const optionalReceiver = callUsesOptionalReceiver(call);
    const branches = receiverType.isUnionType()
        ? ((yield* receiverType.getTypes.gen()) ?? []).filter((part) => !(optionalReceiver && nullableType(part)))
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

        const property = yield* propertyOfTypeGen(checker, branch, propertyName, context.caches);
        if (!property) {
            unresolvedBranch = true;
            continue;
        }

        const [resolvedProperty, dispatchTargets] = yield* ts.all(
            resolvedSymbolGen(checker, property, context.caches),
            dispatchTargetsForTypeGen(checker, branch, propertyName, dispatchContext, context),
        );

        const declHandles = resolvedProperty?.declarations ?? [];
        const declarations = yield* resolveHandlesGen(declHandles, context, true);
        const executableDeclarations = declarations.filter(isExecutableDeclaration);
        const hasProjectDeclaration = declarations.some((declaration) => (
            declarationBelongsToProject(declaration, context.projectFilesByVirtualPath)
        ));
        const ownTargets = executableDeclarations
            .map((declaration) => targetFromDeclaration(declaration, context.projectFilesByVirtualPath))
            .filter((target): target is TypeScriptSemanticTarget => Boolean(target));

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

function* fieldBindingProofsGen(
    checker: ts.Checker,
    receiver: ts.Expression,
    context: AnalysisContext,
    cache: Map<ts.Symbol, TypeScriptBindingProof[]>,
): ts.APIRequestGenerator<TypeScriptBindingProof[]> {
    if (!ts.isPropertyAccessExpression(receiver)
        || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return [];
    const rawSymbol = yield* checker.getSymbolAtLocation.gen(receiver.name);
    const symbol = yield* resolvedSymbolGen(checker, rawSymbol, context.caches);
    const declHandle = symbol?.valueDeclaration;
    if (!symbol || !declHandle) return [];
    if (context.skipExternalHandles && !handleBelongsToProject(declHandle, context)) return [];
    const declaration = yield* declHandle.resolve.gen();
    if (!declaration || declaration.getSourceFile().fileName !== receiver.getSourceFile().fileName) return [];
    const cached = cache.get(symbol);
    if (cached) return cached;
    const save = (proof: TypeScriptBindingProof[]): TypeScriptBindingProof[] => {
        cache.set(symbol, proof);
        return proof;
    };
    if (declaration.kind === ts.SyntaxKind.Parameter
        && ts.isConstructorDeclaration(declaration.parent)) {
        return save([
            ...bindingProof('field_origin', declaration, context.projectFilesByVirtualPath),
            ...bindingProof('constructor_origin', declaration, context.projectFilesByVirtualPath),
        ]);
    }
    if (!ts.isPropertyDeclaration(declaration)) return save([]);
    const proof = bindingProof('field_origin', declaration, context.projectFilesByVirtualPath);
    if (declaration.initializer) {
        return save(ts.isNewExpression(unwrapTransparentExpression(declaration.initializer))
            ? [...proof, ...bindingProof('constructor_origin', declaration.initializer, context.projectFilesByVirtualPath)]
            : []);
    }
    const owner = declaration.parent;
    if (!ts.isClassLikeDeclaration(owner)) return save([]);
    const candidateWrites: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node)
            && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && ts.isPropertyAccessExpression(node.left)
            && node.left.expression.kind === ts.SyntaxKind.ThisKeyword
            && node.left.name.text === symbol.name) {
            candidateWrites.push(node);
        }
        node.forEachChild(visit);
    };
    visit(owner);
    const writes: ts.BinaryExpression[] = [];
    if (candidateWrites.length > 0) {
        const writeSymbols = yield* ts.all(
            ...candidateWrites.map((write) => (
                resolvedSymbolFromLocationGen(checker, (write.left as ts.PropertyAccessExpression).name, context.caches)
            )),
        );
        for (let index = 0; index < candidateWrites.length; index++) {
            if (writeSymbols[index] === symbol) writes.push(candidateWrites[index]);
        }
    }
    // Only one direct constructor write establishes this specific parameter
    // link. Uncertain or overwritten fields do not get origin evidence.
    if (writes.length !== 1) return save([]);
    const write = writes[0];
    if (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        || write.parent.kind !== ts.SyntaxKind.ExpressionStatement
        || write.parent.parent.kind !== ts.SyntaxKind.Block
        || !ts.isConstructorDeclaration(write.parent.parent.parent)) return save([]);
    const constructor = write.parent.parent.parent;
    const value = unwrapTransparentExpression(write.right);
    if (!ts.isIdentifier(value)) return save([]);
    const paramSymbol = yield* symbolAtIdentifierGen(checker, value, context.caches);
    const paramHandle = paramSymbol?.valueDeclaration;
    const parameter = paramHandle ? yield* paramHandle.resolve.gen() : undefined;
    if (parameter?.kind !== ts.SyntaxKind.Parameter || parameter.parent !== constructor) return save([]);
    return save([
        ...proof,
        ...bindingProof('constructor_origin', parameter, context.projectFilesByVirtualPath),
        ...bindingProof('assignment_origin', write, context.projectFilesByVirtualPath),
        ...bindingProof('flow_hop', write, context.projectFilesByVirtualPath).map((step) => ({ ...step, hop: 1 })),
    ]);
}

function* resolvedSymbolFromLocationGen(
    checker: ts.Checker,
    node: ts.Node,
    caches: AnalysisCaches,
): ts.APIRequestGenerator<ts.Symbol | undefined> {
    const raw = yield* checker.getSymbolAtLocation.gen(node);
    return yield* resolvedSymbolGen(checker, raw, caches);
}

function* memberCandidatesGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    context: AnalysisContext,
    dispatchContext: ProjectDispatchContext,
    preFetchedRawReceiverType?: ts.Type,
    preFetchedReceiverType?: ts.Type,
): ts.APIRequestGenerator<CandidateSet | undefined> {
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

    const rawReceiverType = preFetchedRawReceiverType ?? (yield* checker.getTypeAtLocation.gen(receiver));
    const receiverType = preFetchedReceiverType
        ?? (yield* thisReceiverDispatchTypeGen(checker, receiver, rawReceiverType, context.caches));

    const [candidates, fieldProof] = yield* ts.all(
        memberCandidatesWithoutBindingProofsGen(
            checker,
            call,
            context,
            dispatchContext,
            rawReceiverType,
            receiverType,
            receiver,
            propertyName,
        ),
        fieldBindingProofsGen(checker, receiver, context, dispatchContext.fieldBindingProofs),
    );

    const proof = [...(candidates.bindingProofs ?? []), ...fieldProof];
    if (callUsesOptionalReceiver(call)) {
        proof.push(...bindingProof('optional_receiver', call.expression, context.projectFilesByVirtualPath));
    }

    const branches = receiverType.isUnionType()
        ? ((yield* receiverType.getTypes.gen()) ?? [])
        : [receiverType];
    for (const branch of branches) {
        const branchRawSymbol = yield* branch.getSymbol.gen();
        const branchSymbol = yield* resolvedSymbolGen(checker, branchRawSymbol, context.caches);
        const declHandles = branchSymbol?.declarations ?? [];

        if (context.skipExternalHandles) {
            if (declHandles.some((handle) => handle.kind === ts.SyntaxKind.InterfaceDeclaration)) {
                proof.push(...bindingProof('interface_contract', receiver, context.projectFilesByVirtualPath));
            }
        } else {
            const declarations = yield* resolveHandlesGen(declHandles, context, false);
            if (declarations.some(ts.isInterfaceDeclaration)) {
                proof.push(...bindingProof('interface_contract', receiver, context.projectFilesByVirtualPath));
            }
        }

        if (!candidates.targets.length) continue;

        const classHandles = declHandles.filter((handle) => (
            handle.kind === ts.SyntaxKind.ClassDeclaration
            || handle.kind === ts.SyntaxKind.ClassExpression
        ));
        if (classHandles.length === 0) continue;

        const classDeclarations = yield* resolveHandlesGen(classHandles, context, false);
        const extendsTypes: ts.HeritageClauseElement[] = [];
        for (const declaration of classDeclarations) {
            if (!ts.isClassLikeDeclaration(declaration)) continue;
            for (const clause of declaration.heritageClauses ?? []) {
                if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
                for (const base of clause.types) extendsTypes.push(base);
            }
        }
        if (extendsTypes.length === 0) continue;

        const rawProperty = yield* propertyOfTypeGen(checker, branch, propertyName, context.caches);
        const property = yield* resolvedSymbolGen(checker, rawProperty, context.caches);
        const propertyDeclarations = property
            ? yield* resolveHandlesGen(property.declarations, context, false)
            : [];
        const methodOwners = propertyDeclarations
            .map((declaration) => declaration.parent)
            .filter((node): node is ts.ClassLikeDeclaration => Boolean(node && ts.isClassLikeDeclaration(node)));
        if (methodOwners.length === 0) continue;

        for (const base of extendsTypes) {
            const baseName = 'expression' in base ? base.expression : base.typeName;
            const baseSymbol = yield* resolvedSymbolFromLocationGen(checker, baseName, context.caches);
            const baseDeclarations = baseSymbol
                ? yield* resolveHandlesGen(baseSymbol.declarations, context, false)
                : [];
            if (methodOwners.some((owner) => baseDeclarations.some((baseDeclaration) => (
                baseDeclaration.getSourceFile().fileName === owner.getSourceFile().fileName
                && baseDeclaration.pos === owner.pos && baseDeclaration.end === owner.end
            )))) {
                proof.push(...bindingProof('class_inheritance', receiver, context.projectFilesByVirtualPath, base.getText()));
            }
        }
    }
    return { ...candidates, bindingProofs: proof };
}

function* directCandidatesGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    context: AnalysisContext,
): ts.APIRequestGenerator<CandidateSet> {
    const [overloads, binding, resolvedSig] = yield* ts.all(
        overloadCandidatesGen(checker, call, context),
        checker.getSymbolAtLocation.gen(call.expression),
        checker.getResolvedSignature.gen(call),
    );
    if (overloads.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_overload_candidates',
            targets: overloads,
        };
    }

    const symbol = yield* resolvedSymbolGen(checker, binding, context.caches);
    const [symbolTargets, signature] = yield* ts.all(
        implementationsForSymbolGen(checker, symbol, context),
        signatureTargetGen(checker, call, context, resolvedSig),
    );
    const targets = uniqueTargets(signature ? [...symbolTargets, signature] : symbolTargets);

    if (targets.length > 1) {
        return {
            decision: 'ambiguous',
            reason: 'multiple_executable_targets',
            targets,
        };
    }
    if (targets.length === 1) {
        const proofs: TypeScriptBindingProof[] = [];
        if (ts.isNewExpression(call) && signature?.kind === 'constructor') {
            proofs.push(...bindingProof('constructor_origin', call, context.projectFilesByVirtualPath));
        }
        // A signature target alone does not prove a lexical symbol binding.
        if (symbolTargets.some((target) => targetKey(target) === targetKey(targets[0]))) {
            if (binding && (binding.flags & ts.SymbolFlags.Alias) !== 0) {
                const aliasDeclarations = yield* resolveHandlesGen(binding.declarations, context, false);
                for (let declaration of aliasDeclarations as (ts.Node | undefined)[]) {
                    while (declaration && declaration.kind !== ts.SyntaxKind.ImportDeclaration) {
                        declaration = declaration.parent;
                    }
                    if (!declaration) continue;
                    const module = (declaration as ts.ImportDeclaration).moduleSpecifier;
                    if (!ts.isStringLiteralLikeNode(module)) continue;
                    proofs.push(...bindingProof(
                        module.text.startsWith('.') ? 'relative_import' : 'absolute_import',
                        call.expression,
                        context.projectFilesByVirtualPath,
                        module.text,
                    ));
                    proofs.push(...bindingProof('alias_binding', call.expression, context.projectFilesByVirtualPath, module.text));
                }
            } else if (targets[0].file === context.projectFilesByVirtualPath.get(
                path.posix.normalize(call.getSourceFile().fileName.replace(/\\/g, '/')),
            )?.projectPath) {
                proofs.push(...bindingProof('same_file_definition', call.expression, context.projectFilesByVirtualPath));
            }
        }
        return {
            decision: 'resolved',
            reason: 'single_executable_target',
            targets,
            bindingProofs: proofs,
        };
    }

    const declHandles = symbol?.declarations ?? [];
    const projectDeclarations = yield* resolveHandlesGen(declHandles, context, true);
    const declarationCount = context.skipExternalHandles ? declHandles.length : projectDeclarations.length;
    const hasProjectDeclaration = projectDeclarations.some((declaration) => (
        declarationBelongsToProject(declaration, context.projectFilesByVirtualPath)
    ));
    return {
        decision: declarationCount > 0 && hasProjectDeclaration ? 'unresolved' : 'unsupported',
        reason: declarationCount > 0
            ? (hasProjectDeclaration ? 'declaration_without_implementation' : 'target_not_indexable')
            : 'missing_symbol',
        targets: [],
    };
}

function* evidenceForCallGen(
    checker: ts.Checker,
    call: ts.CallExpression | ts.NewExpression,
    sourceFile: ts.SourceFile,
    projectFile: ProjectFile,
    context: AnalysisContext,
    dispatchContext: ProjectDispatchContext,
    preFetchedRawReceiverType?: ts.Type,
    preFetchedReceiverType?: ts.Type,
): ts.APIRequestGenerator<TypeScriptCallEvidence> {
    const member = yield* memberCandidatesGen(
        checker,
        call,
        context,
        dispatchContext,
        preFetchedRawReceiverType,
        preFetchedReceiverType,
    );
    const candidates = member ?? (yield* directCandidatesGen(checker, call, context));
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
        ...(candidates.bindingProofs?.length ? { bindingProofs: candidates.bindingProofs } : {}),
    };
}

function resolveBatchApi(program: ts.Program, explicitApi?: NativeTypeScriptApi): NativeTypeScriptApi | undefined {
    if (explicitApi && typeof explicitApi.batch === 'function') return explicitApi;
    const projectApi = (program.getProject() as unknown as { readonly api?: NativeTypeScriptApi }).api;
    return projectApi && typeof projectApi.batch === 'function' ? projectApi : undefined;
}

/**
 * Pre-fetches receiver types and deduplicated `isTypeAssignableTo` checks for
 * a chunk of calls so repeated receiver types across calls in the same batch
 * never send duplicate assignability checks over IPC.
 */
function prewarmMemberReceiversForChunk(
    api: NativeTypeScriptApi,
    checker: ts.Checker,
    chunk: readonly CallWorkItem[],
    dispatchContext: ProjectDispatchContext,
    caches: AnalysisCaches,
): {
    readonly rawByIndex: Map<number, ts.Type>;
    readonly effectiveByIndex: Map<number, ts.Type>;
} {
    const rawByIndex = new Map<number, ts.Type>();
    const effectiveByIndex = new Map<number, ts.Type>();

    const memberEntries: { readonly index: number; readonly receiver: ts.Expression }[] = [];
    for (let index = 0; index < chunk.length; index++) {
        const expr = chunk[index].call.expression;
        const receiver = receiverForExpression(expr);
        if (receiver && propertyNameForExpression(expr)) {
            memberEntries.push({ index, receiver });
        }
    }
    if (memberEntries.length === 0) return { rawByIndex, effectiveByIndex };

    // Wave 1: raw receiver types for every member call in the chunk.
    const rawTypes = api.batch(
        ...memberEntries.map(({ receiver }) => checker.getTypeAtLocation.gen(receiver)),
    );
    const thisParamIndices: { readonly entryIndex: number; readonly type: ts.Type }[] = [];
    for (let i = 0; i < memberEntries.length; i++) {
        const entry = memberEntries[i];
        const rawType = rawTypes[i];
        rawByIndex.set(entry.index, rawType);
        if (entry.receiver.kind === ts.SyntaxKind.ThisKeyword && (rawType.flags & ts.TypeFlags.TypeParameter) !== 0) {
            thisParamIndices.push({ entryIndex: i, type: rawType });
        } else {
            effectiveByIndex.set(entry.index, rawType);
        }
    }

    // Wave 2: polymorphic `this` constraints (only for class methods calling `this.m()`).
    if (thisParamIndices.length > 0) {
        const uncachedThisTypes = new Map<number, ts.Type>();
        for (const { type } of thisParamIndices) {
            if (!caches.baseConstraintByTypeId.has(type.id)) {
                uncachedThisTypes.set(type.id, type);
            }
        }
        if (uncachedThisTypes.size > 0) {
            const uniqueList = [...uncachedThisTypes.values()];
            const constraints = api.batch(
                ...uniqueList.map((type) => checker.getBaseConstraintOfType.gen(type)),
            );
            for (let i = 0; i < uniqueList.length; i++) {
                caches.baseConstraintByTypeId.set(uniqueList[i].id, constraints[i]);
            }
        }
        for (const { entryIndex, type } of thisParamIndices) {
            const constraint = caches.baseConstraintByTypeId.get(type.id);
            const effective = constraint && (constraint.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0
                ? constraint
                : type;
            effectiveByIndex.set(memberEntries[entryIndex].index, effective);
        }
    }

    // Wave 3 & 4: expand union branches and precompute deduplicated class assignability.
    if (dispatchContext.classTypes.length === 0) return { rawByIndex, effectiveByIndex };

    const unionTypes = new Map<number, ts.UnionType>();
    for (const type of effectiveByIndex.values()) {
        if (type.isUnionType()) unionTypes.set(type.id, type);
    }
    const unionBranchesById = new Map<number, readonly ts.Type[]>();
    if (unionTypes.size > 0) {
        const uniqueUnions = [...unionTypes.values()];
        const expanded = api.batch(...uniqueUnions.map((type) => type.getTypes.gen()));
        for (let i = 0; i < uniqueUnions.length; i++) {
            unionBranchesById.set(uniqueUnions[i].id, expanded[i] ?? []);
        }
    }

    const uncachedBranches = new Map<number, ts.Type>();
    for (const type of effectiveByIndex.values()) {
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) continue;
        const branches = type.isUnionType() ? (unionBranchesById.get(type.id) ?? []) : [type];
        for (const branch of branches) {
            if ((branch.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) continue;
            if (!caches.assignableClassesByTypeId.has(branch.id)) {
                uncachedBranches.set(branch.id, branch);
            }
        }
    }

    if (uncachedBranches.size > 0) {
        const branchList = [...uncachedBranches.values()];
        const classTypes = dispatchContext.classTypes;
        const classCount = classTypes.length;
        const matchedByBranch = branchList.map((): ts.Type[] => []);
        const checkCount = branchList.length * classCount;
        for (let start = 0; start < checkCount; start += ASSIGNABILITY_BATCH_SIZE) {
            const end = Math.min(start + ASSIGNABILITY_BATCH_SIZE, checkCount);
            const checks: ts.AnyAPIRequestGenerator<boolean>[] = [];
            for (let index = start; index < end; index++) {
                const branch = branchList[Math.floor(index / classCount)];
                checks.push(checker.isTypeAssignableTo.gen(classTypes[index % classCount], branch));
            }
            const results = api.batch(...checks);
            for (let index = start; index < end; index++) {
                if (results[index - start]) {
                    matchedByBranch[Math.floor(index / classCount)].push(classTypes[index % classCount]);
                }
            }
        }
        for (let index = 0; index < branchList.length; index++) {
            caches.assignableClassesByTypeId.set(branchList[index].id, matchedByBranch[index]);
        }
    }

    return { rawByIndex, effectiveByIndex };
}

function analyzeProgramEvidence(
    program: ts.Program,
    projectFiles: readonly ProjectFile[],
    collectDiagnostics: boolean,
    startedAt: number,
    sourceFiles?: ReadonlySet<string>,
    explicitApi?: NativeTypeScriptApi,
    executionMode: 'batched' | 'serial' = 'batched',
): TypeScriptProjectEvidence {
    const api = resolveBatchApi(program, explicitApi);
    const batched = executionMode === 'batched' && Boolean(api);
    const projectFilesByVirtualPath = new Map(projectFiles.map((file) => [file.virtualPath, file]));
    const projectCanonicalPaths = new Set(
        projectFiles.map((file) => program.getCanonicalFileName(file.virtualPath)),
    );
    const checker = program.getProject().checker;

    // Fetch missing SourceFiles for project files only (never external .d.ts files).
    const resolvedSourceFilesByVirtualPath = new Map<string, ts.SourceFile>();
    const missingFiles: ProjectFile[] = [];
    for (const projectFile of projectFiles) {
        if (projectFile.sourceFile) {
            resolvedSourceFilesByVirtualPath.set(projectFile.virtualPath, projectFile.sourceFile);
        } else {
            missingFiles.push(projectFile);
        }
    }
    if (missingFiles.length > 0) {
        if (batched && api) {
            const fetched = api.batch(...missingFiles.map((file) => program.getSourceFile.gen(file.virtualPath)));
            for (let index = 0; index < missingFiles.length; index++) {
                const sf = fetched[index];
                if (sf) resolvedSourceFilesByVirtualPath.set(missingFiles[index].virtualPath, sf);
            }
        } else {
            for (const file of missingFiles) {
                const sf = program.getSourceFile(file.virtualPath);
                if (sf) resolvedSourceFilesByVirtualPath.set(file.virtualPath, sf);
            }
        }
    }

    // Preserve program.getSourceFileNames() order so concrete class dispatch
    // candidates keep the compiler program's exact order without fetching
    // external .d.ts files over IPC.
    const allProjectSourceFiles: ts.SourceFile[] = [];
    const seenDispatchFiles = new Set<string>();
    for (const fileName of program.getSourceFileNames()) {
        const normalized = path.posix.normalize(fileName.replace(/\\/g, '/'));
        const sf = resolvedSourceFilesByVirtualPath.get(normalized);
        if (sf && !seenDispatchFiles.has(normalized)) {
            seenDispatchFiles.add(normalized);
            allProjectSourceFiles.push(sf);
        }
    }
    for (const [normalized, sf] of resolvedSourceFilesByVirtualPath) {
        if (!seenDispatchFiles.has(normalized)) {
            allProjectSourceFiles.push(sf);
        }
    }
    const dispatchContext = collectProjectDispatchContext(api, checker, allProjectSourceFiles, batched);
    const caches: AnalysisCaches = {
        resolvedSymbolById: new Map(),
        propertyOfTypeByKey: new Map(),
        implementationsBySymbolId: new Map(),
        assignableClassesByTypeId: new Map(),
        baseConstraintByTypeId: new Map(),
    };
    const context: AnalysisContext = {
        projectFilesByVirtualPath,
        projectCanonicalPaths,
        caches,
        skipExternalHandles: batched,
    };

    const occurrencesByFile = new Map<string, TypeScriptCallEvidence[]>();
    const workItems: CallWorkItem[] = [];

    for (const projectFile of projectFiles) {
        if (sourceFiles && !sourceFiles.has(projectFile.projectPath)) continue;
        const sourceFile = resolvedSourceFilesByVirtualPath.get(projectFile.virtualPath);
        const fileOccurrences: TypeScriptCallEvidence[] = [];
        occurrencesByFile.set(projectFile.projectPath, fileOccurrences);
        if (!sourceFile || sourceFile.isDeclarationFile) continue;

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                workItems.push({ call: node, sourceFile, projectFile, fileOccurrences });
            }
            node.forEachChild(visit);
        };
        visit(sourceFile);
    }

    if (api && workItems.length > 0) {
        const chunkSize = batched ? CALL_BATCH_CHUNK_SIZE : 1;
        for (let start = 0; start < workItems.length; start += chunkSize) {
            const chunk = workItems.slice(start, start + chunkSize);
            const prewarmed = batched
                ? prewarmMemberReceiversForChunk(api, checker, chunk, dispatchContext, caches)
                : undefined;
            const results = api.batch(
                ...chunk.map((item, index) => evidenceForCallGen(
                    checker,
                    item.call,
                    item.sourceFile,
                    item.projectFile,
                    context,
                    dispatchContext,
                    prewarmed?.rawByIndex.get(index),
                    prewarmed?.effectiveByIndex.get(index),
                )),
            );
            for (let index = 0; index < chunk.length; index++) {
                chunk[index].fileOccurrences.push(results[index]);
            }
        }
    }

    let diagnostics: { readonly syntactic: number; readonly semantic: number } | undefined;
    if (collectDiagnostics) {
        if (batched && api) {
            const [syntactic, semantic] = api.batch(
                program.getSyntacticDiagnostics.gen(),
                program.getSemanticDiagnostics.gen(),
            );
            diagnostics = { syntactic: syntactic.length, semantic: semantic.length };
        } else {
            diagnostics = {
                syntactic: program.getSyntacticDiagnostics().length,
                semantic: program.getSemanticDiagnostics().length,
            };
        }
    }

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
        readonly api?: NativeTypeScriptApi;
        readonly executionMode?: 'batched' | 'serial';
    } = {},
): TypeScriptProjectEvidence {
    const startedAt = performance.now();
    const projectFiles = sourceFiles.map(({ projectPath, sourceFile }): ProjectFile => ({
        projectPath: normalizeProjectPath(projectPath),
        virtualPath: path.posix.normalize(sourceFile.fileName.replace(/\\/g, '/')),
        source: sourceFile.text,
        sourceMap: new Utf8SourceMap(sourceFile.text),
        sourceFile,
    }));
    return analyzeProgramEvidence(
        program,
        projectFiles,
        providerOptions.collectDiagnostics ?? false,
        startedAt,
        providerOptions.sourceFiles,
        providerOptions.api,
        providerOptions.executionMode ?? 'batched',
    );
}

export function analyzeTypeScriptProject(
    input: SemanticProjectInput,
    providerOptions: TypeScriptCompilerProviderOptions & {
        readonly executionMode?: 'batched' | 'serial';
    } = {},
): TypeScriptProjectEvidence {
    const startedAt = performance.now();

    const projectFiles = input.sourceFiles.map((file): ProjectFile => ({
        projectPath: normalizeProjectPath(file.path),
        virtualPath: virtualPathFor(file.path),
        source: file.source,
        sourceMap: new Utf8SourceMap(file.source),
    }));
    const compilerOptions = {
        ...defaultCompilerOptions(),
        ...providerOptions.compilerOptions,
        noEmit: true,
    };
    const api = new ts.API({ runExternalCode: false });
    try {
        const snapshot = api.createSnapshot({
            fileSystem: createFileSystemLayer(projectFiles.map(file => [file.virtualPath, file.source] as const)),
            createPrograms: [{ rootFiles: projectFiles.map(file => file.virtualPath), compilerOptions }],
        });
        try {
            return analyzeProgramEvidence(
                snapshot.operation.createdPrograms[0],
                projectFiles,
                providerOptions.collectDiagnostics ?? false,
                startedAt,
                undefined,
                api,
                providerOptions.executionMode ?? 'batched',
            );
        } finally { snapshot.dispose(); }
    } finally { api.close(); }
}
