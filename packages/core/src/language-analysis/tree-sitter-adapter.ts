import path from 'node:path';
import { createRequire } from 'node:module';

import { Language, Parser, type Node } from 'web-tree-sitter';

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import { Utf8SourceMap } from './source-map';
import type {
    CallSite,
    LanguageAnalysisInput,
    ModuleBinding,
    PythonFlowFact,
    ReceiverTypeBinding,
    SourceSpan,
} from './types';

const localRequire = createRequire(__filename);

const ASSET_NAMES: Readonly<Record<string, string>> = {
    python: 'tree-sitter-python.wasm',
    go: 'tree-sitter-go.wasm',
    rust: 'tree-sitter-rust.wasm',
    java: 'tree-sitter-java.wasm',
    csharp: 'tree-sitter-c-sharp.wasm',
    cpp: 'tree-sitter-cpp.wasm',
    scala: 'tree-sitter-scala.wasm',
};

const SYMBOL_NODES: Readonly<Record<string, Readonly<Record<string, ExtractedSymbolKind>>>> = {
    python: {
        class_definition: 'class',
        function_definition: 'function',
    },
    go: {
        function_declaration: 'function',
        method_declaration: 'method',
        type_spec: 'type',
    },
    rust: {
        function_item: 'function',
        function_signature_item: 'method',
        struct_item: 'struct',
        enum_item: 'enum',
        trait_item: 'trait',
        mod_item: 'module',
        type_item: 'type',
        union_item: 'type',
        macro_definition: 'macro',
    },
    java: {
        class_declaration: 'class',
        interface_declaration: 'interface',
        enum_declaration: 'enum',
        method_declaration: 'method',
        constructor_declaration: 'constructor',
    },
    csharp: {
        namespace_declaration: 'namespace',
        file_scoped_namespace_declaration: 'namespace',
        class_declaration: 'class',
        interface_declaration: 'interface',
        struct_declaration: 'struct',
        enum_declaration: 'enum',
        method_declaration: 'method',
        constructor_declaration: 'constructor',
    },
    cpp: {
        class_specifier: 'class',
        struct_specifier: 'struct',
        enum_specifier: 'enum',
        union_specifier: 'type',
        type_definition: 'type',
        namespace_definition: 'namespace',
        function_definition: 'function',
    },
    scala: {
        package_clause: 'namespace',
        enum_definition: 'enum',
        type_definition: 'type',
        val_definition: 'constant',
        var_definition: 'variable',
        given_definition: 'variable',
        class_definition: 'class',
        trait_definition: 'trait',
        object_definition: 'module',
        function_definition: 'function',
    },
};

let parserInitialization: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();

function parserAssetRoot(): string {
    return path.dirname(localRequire.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm'));
}

function languageAssetPath(language: string, assetRoot?: string): string {
    const name = ASSET_NAMES[language];
    if (!name) throw new Error(`Unsupported Tree-sitter WASM language: ${language}`);
    if (language === 'scala') {
        return path.join(assetRoot ?? path.resolve(__dirname, '../../assets/tree-sitter'), name);
    }
    return path.join(assetRoot ?? parserAssetRoot(), name);
}

async function loadLanguage(language: string, assetRoot?: string): Promise<Language> {
    const initialization = parserInitialization ??= Parser.init();
    try {
        await initialization;
    } catch (error) {
        if (parserInitialization === initialization) {
            parserInitialization = undefined;
        }
        throw error;
    }
    const cacheKey = `${assetRoot ?? '<default>'}:${language}`;
    const existing = languages.get(cacheKey);
    if (existing) {
        return existing;
    }
    const loading = Language.load(languageAssetPath(language, assetRoot));
    languages.set(cacheKey, loading);
    try {
        return await loading;
    } catch (error) {
        if (languages.get(cacheKey) === loading) {
            languages.delete(cacheKey);
        }
        throw error;
    }
}

function nameForNode(node: Node): string | undefined {
    const named = node.childForFieldName('name');
    if (named?.text.trim()) return named.text.trim();
    if (node.type === 'type_definition') {
        const declarator = node.childForFieldName('declarator');
        if (declarator?.type === 'type_identifier' && declarator.text.trim()) {
            return declarator.text.trim();
        }
    }
    if (node.type === 'function_definition') {
        const declarator = node.childForFieldName('declarator');
        const identifier = declarator?.descendantsOfType(['identifier', 'field_identifier'])[0];
        if (identifier?.text.trim()) return identifier.text.trim();
    }
    return undefined;
}

type CppCallableDeclaration = Readonly<{
    kind: 'function' | 'method';
    name: string;
    explicitParents?: readonly string[];
    spanNode: Node;
}>;

type CppNamespaceIdentity = Readonly<{
    name: string;
    parentSegments: readonly string[];
}>;

type CSharpNamespaceIdentity = Readonly<{
    name: string;
    parentSegments: readonly string[];
    fileScoped: boolean;
}>;

type ScalaPackageIdentity = Readonly<{
    name: string;
    parentSegments: readonly string[];
    bodyless: boolean;
}>;

function cppNamespaceIdentity(node: Node): CppNamespaceIdentity | undefined {
    if (node.type !== 'namespace_definition') return undefined;
    const declaredName = node.childForFieldName('name');
    if (!declaredName || declaredName.hasError || declaredName.isError || declaredName.isMissing) {
        return undefined;
    }
    if (declaredName.type === 'namespace_identifier') {
        const name = declaredName.text.trim();
        return name ? { name, parentSegments: [] } : undefined;
    }
    if (declaredName.type !== 'nested_namespace_specifier') return undefined;
    const segments = declaredName.text
        .split('::')
        .map((segment) => segment.trim())
        .filter(Boolean);
    const name = segments.pop();
    return name ? { name, parentSegments: segments } : undefined;
}

function csharpNamespaceIdentity(node: Node): CSharpNamespaceIdentity | undefined {
    if (
        node.type !== 'namespace_declaration'
        && node.type !== 'file_scoped_namespace_declaration'
    ) {
        return undefined;
    }
    const declaredName = node.childForFieldName('name')?.text.trim();
    if (!declaredName) return undefined;
    const segments = declaredName
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);
    const name = segments.pop();
    return name
        ? {
            name,
            parentSegments: segments,
            fileScoped: node.type === 'file_scoped_namespace_declaration',
        }
        : undefined;
}

function scalaPackageIdentity(node: Node): ScalaPackageIdentity | undefined {
    if (node.type !== 'package_clause') return undefined;
    const declaredName = node.childForFieldName('name')?.text.trim();
    if (!declaredName) return undefined;
    const segments = declaredName
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);
    const name = segments.pop();
    return name
        ? {
            name,
            parentSegments: segments,
            bodyless: !node.childForFieldName('body'),
        }
        : undefined;
}

function scalaBindingName(node: Node): string | undefined {
    if (node.type === 'given_definition') {
        return node.childForFieldName('name')?.text.trim() || undefined;
    }
    if (node.type !== 'val_definition' && node.type !== 'var_definition') {
        return undefined;
    }
    const pattern = node.childForFieldName('pattern');
    return pattern?.type === 'identifier' ? pattern.text.trim() || undefined : undefined;
}

function cppCallableTerminal(node: Node, allowMacroWrapper = false): { name: string; parents?: string[] } | undefined {
    const terminal = node.childForFieldName('declarator');
    if (!terminal) return undefined;
    // CBM 2ef6ba71: direct nesting spells a macro, while pointer returns have
    // an intervening parenthesized declarator. Only one bare name is unambiguous.
    if (allowMacroWrapper && node.type === 'function_declarator' && terminal.type === 'function_declarator') {
        const macroName = terminal.childForFieldName('declarator');
        const args = terminal.childForFieldName('parameters');
        const arg = args?.namedChild(0);
        const name = arg?.childForFieldName('type');
        if (
            (macroName?.type === 'identifier' || macroName?.type === 'qualified_identifier')
            && args?.namedChildCount === 1
            && arg?.type === 'parameter_declaration'
            && arg.namedChildCount === 1
            && (name?.type === 'type_identifier' || name?.type === 'identifier')
        ) {
            const callable = cppCallableTerminal(terminal);
            return callable ? { ...callable, name: name.text.trim() } : undefined;
        }
    }
    if (terminal.type === 'identifier' || terminal.type === 'field_identifier') {
        const name = terminal.text.trim();
        return name ? { name } : undefined;
    }
    if (terminal.type !== 'qualified_identifier') return undefined;
    const parts = terminal.text
        .split('::')
        .map((part) => part.trim())
        .filter(Boolean);
    const name = parts.pop();
    return name ? { name, ...(parts.length > 0 ? { parents: parts } : {}) } : undefined;
}

function cppCallableDeclaration(
    node: Node,
    semanticContainer: 'module' | 'class' | 'callable',
): CppCallableDeclaration | undefined {
    if (node.type !== 'function_declarator' || semanticContainer === 'callable') {
        return undefined;
    }
    const declaration = node.parent;
    if (!declaration || (declaration.type !== 'declaration' && declaration.type !== 'field_declaration')) {
        return undefined;
    }
    const callable = cppCallableTerminal(node);
    if (!callable) return undefined;
    const callableSiblings = declaration
        .childrenForFieldName('declarator')
        .filter((candidate) => candidate.type === 'function_declarator');
    return {
        kind: declaration.type === 'field_declaration' || callable.parents ? 'method' : 'function',
        name: callable.name,
        ...(callable.parents ? { explicitParents: callable.parents } : {}),
        spanNode: callableSiblings.length === 1 ? declaration : node,
    };
}

function cppCallableDefinition(node: Node): { name: string; parents?: string[] } | undefined {
    if (node.type !== 'function_definition') return undefined;
    const declarator = node.childForFieldName('declarator');
    const callable = declarator ? cppCallableTerminal(declarator, true) : undefined;
    if (callable) return callable;
    const qualified = declarator
        ?.descendantsOfType('qualified_identifier')
        .at(0);
    if (!qualified) return undefined;
    const parts = qualified.text
        .split('::')
        .map((part) => part.trim())
        .filter(Boolean);
    const name = parts.pop();
    return name && parts.length > 0 ? { name, parents: parts } : undefined;
}

function goSymbolKind(node: Node, kind: ExtractedSymbolKind | undefined): ExtractedSymbolKind | undefined {
    if (node.type !== 'type_spec') return kind;
    const declaredType = node.childForFieldName('type');
    if (declaredType?.type === 'struct_type') return 'struct';
    if (declaredType?.type === 'interface_type') return 'interface';
    return kind;
}

function goReceiverOwner(node: Node): string | undefined {
    if (node.type !== 'method_declaration') return undefined;
    return node
        .childForFieldName('receiver')
        ?.descendantsOfType('type_identifier')
        .at(-1)
        ?.text
        .trim() || undefined;
}

function rustImplOwner(node: Node): string | undefined {
    if (node.type !== 'impl_item') return undefined;
    const implementedType = node.childForFieldName('type');
    return implementedType
        ?.descendantsOfType('type_identifier')
        .at(0)
        ?.text
        .trim()
        || implementedType?.text.trim()
        || undefined;
}

function pythonBindingName(node: Node, semanticContainer: 'module' | 'class' | 'callable'): string | undefined {
    if (node.type !== 'assignment' || node.parent?.type !== 'expression_statement') {
        return undefined;
    }
    const scope = node.parent.parent;
    const isModuleBinding = scope?.type === 'module';
    // Only a lambda class attribute is extracted: it is a callable owner of
    // the calls in its body. Plain class attributes stay out of the outline.
    const isClassLambda = semanticContainer === 'class'
        && scope?.type === 'block'
        && scope.parent?.type === 'class_definition'
        && node.childForFieldName('right')?.type === 'lambda';
    if (!isModuleBinding && !isClassLambda) {
        return undefined;
    }
    const left = node.childForFieldName('left');
    return left?.type === 'identifier' ? left.text.trim() || undefined : undefined;
}

function extractSymbols(root: Node, language: string, sourceMap: Utf8SourceMap): ExtractedSymbol[] {
    const declarations = SYMBOL_NODES[language] ?? {};
    const symbols: ExtractedSymbol[] = [];
    const visit = (
        node: Node,
        parents: readonly string[],
        insideRustImpl = false,
        parentNode?: Node,
        semanticContainer: 'module' | 'class' | 'callable' = 'module',
    ): void => {
        const cppNamespace = language === 'cpp' ? cppNamespaceIdentity(node) : undefined;
        const cppNamespaceBody = cppNamespace && node.hasError
            ? node.childForFieldName('body')
            : undefined;
        const openingBrace = cppNamespaceBody?.firstChild;
        const closingBrace = cppNamespaceBody?.lastChild;
        // A clean name and real body delimiters preserve ownership for intact children,
        // but the errored namespace itself must not become an authoritative symbol.
        const recoverCppNamespace = Boolean(
            cppNamespaceBody?.type === 'declaration_list'
            && !cppNamespaceBody.isError
            && !cppNamespaceBody.isMissing
            && openingBrace?.type === '{'
            && !openingBrace.isError
            && !openingBrace.isMissing
            && closingBrace?.type === '}'
            && !closingBrace.isError
            && !closingBrace.isMissing
        );
        // A malformed definition cannot supply a trustworthy identity or owner for descendants.
        if (node.isError || node.isMissing || (node.hasError && !recoverCppNamespace && (
            declarations[node.type]
            || node.type === 'decorated_definition'
            || node.type === 'impl_item'
            || (language === 'python' && node.type === 'assignment')
            || (language === 'cpp' && (
                node.type === 'declaration' || node.type === 'field_declaration'
            ))
        ))) return;
        let kind: ExtractedSymbolKind | undefined = declarations[node.type];
        if (language === 'go') kind = goSymbolKind(node, kind);
        if (language === 'go' && node.type === 'type_spec' && semanticContainer === 'callable') {
            kind = undefined;
        }
        if (language === 'java' && semanticContainer === 'callable') {
            kind = undefined;
        }
        if (language === 'scala' && semanticContainer === 'callable') {
            kind = undefined;
        }
        if (
            language === 'scala'
            && (
                node.type === 'val_definition'
                || node.type === 'var_definition'
                || node.type === 'given_definition'
            )
            && semanticContainer !== 'module'
        ) {
            kind = undefined;
        }
        if (language === 'python' && node.type === 'function_definition' && semanticContainer === 'class') {
            kind = 'method';
        }
        if (language === 'scala' && node.type === 'function_definition' && semanticContainer === 'class') {
            kind = 'method';
        }
        if (language === 'rust' && node.type === 'function_item' && insideRustImpl) {
            kind = 'method';
        }
        if (
            language === 'rust'
            && (
                semanticContainer === 'callable'
                || (
                    (semanticContainer === 'class' || insideRustImpl)
                    && (
                        node.type === 'struct_item'
                        || node.type === 'enum_item'
                        || node.type === 'trait_item'
                        || node.type === 'mod_item'
                        || node.type === 'type_item'
                        || node.type === 'union_item'
                        || node.type === 'macro_definition'
                    )
                )
            )
            && node.type !== 'function_item'
            && node.type !== 'function_signature_item'
        ) {
            kind = undefined;
        }
        const pythonBinding = language === 'python'
            ? pythonBindingName(node, semanticContainer)
            : undefined;
        if (pythonBinding) {
            // A lambda binding is a callable owner, as an arrow-function const is in TS.
            kind = node.childForFieldName('right')?.type === 'lambda'
                ? (semanticContainer === 'class' ? 'method' : 'function')
                : 'variable';
        }
        const cppDeclaration = language === 'cpp'
            ? cppCallableDeclaration(node, semanticContainer)
            : undefined;
        if (cppDeclaration) {
            kind = cppDeclaration.kind;
        }
        if (
            language === 'cpp'
            && semanticContainer === 'callable'
            && (
                node.type === 'class_specifier'
                || node.type === 'struct_specifier'
                || node.type === 'enum_specifier'
                || node.type === 'union_specifier'
                || node.type === 'type_definition'
            )
        ) {
            kind = undefined;
        }
        const csharpNamespace = language === 'csharp' ? csharpNamespaceIdentity(node) : undefined;
        const scalaPackage = language === 'scala' ? scalaPackageIdentity(node) : undefined;
        const scalaBinding = language === 'scala' ? scalaBindingName(node) : undefined;
        const cppDefinition = language === 'cpp' ? cppCallableDefinition(node) : undefined;
        if (
            language === 'cpp'
            && node.type === 'function_definition'
            && (semanticContainer === 'class' || cppDefinition?.parents)
        ) {
            kind = 'method';
        }
        const name = kind
            ? pythonBinding
                ?? cppNamespace?.name
                ?? csharpNamespace?.name
                ?? scalaPackage?.name
                ?? scalaBinding
                ?? cppDeclaration?.name
                ?? cppDefinition?.name
                ?? nameForNode(node)
            : undefined;
        const implOwner = language === 'rust' ? rustImplOwner(node) : undefined;
        const receiverOwner = language === 'go' ? goReceiverOwner(node) : undefined;
        const symbolParents = cppNamespace
            ? [...parents, ...cppNamespace.parentSegments]
            : csharpNamespace
                ? [...parents, ...csharpNamespace.parentSegments]
            : scalaPackage
                ? [...parents, ...scalaPackage.parentSegments]
            : cppDeclaration?.explicitParents
                ? [...parents, ...cppDeclaration.explicitParents]
                : cppDefinition?.parents
                    ? [...parents, ...cppDefinition.parents]
                    : receiverOwner
                        ? [...parents, receiverOwner]
                        : parents;
        const nextParents = implOwner
            ? [...parents, implOwner]
            : name && (
                kind === 'class'
                || kind === 'interface'
                || kind === 'trait'
                || kind === 'struct'
                || kind === 'enum'
                || kind === 'module'
                || kind === 'namespace'
            )
                ? [...symbolParents, name]
                : language === 'python' && name && node.type === 'function_definition'
                    ? [...parents, name]
                : parents;
        const nextSemanticContainer = kind && (
            kind === 'class'
            || kind === 'interface'
            || kind === 'trait'
            || kind === 'struct'
            || kind === 'enum'
            || (language === 'scala' && kind === 'module')
        )
            ? 'class'
            : kind && (kind === 'function' || kind === 'method' || kind === 'constructor')
                ? 'callable'
                : semanticContainer;
        if (kind && name && !recoverCppNamespace) {
            symbols.push({
                kind,
                name,
                label: `${kind} ${name}`,
                qualifiedName: [...symbolParents, name].join('.'),
                parentQualifiedNamePath: symbolParents,
                span: nodeSpan(
                    cppDeclaration?.spanNode
                    ?? (
                        language === 'python'
                        && parentNode?.type === 'decorated_definition'
                            ? parentNode
                            : node
                    ),
                    sourceMap,
                ),
            });
        }
        let siblingParents = nextParents;
        for (const child of node.namedChildren) {
            visit(
                child,
                siblingParents,
                insideRustImpl || (language === 'rust' && node.type === 'impl_item'),
                node,
                nextSemanticContainer,
            );
            const fileScopedNamespace = language === 'csharp'
                ? csharpNamespaceIdentity(child)
                : undefined;
            if (fileScopedNamespace?.fileScoped) {
                siblingParents = [
                    ...siblingParents,
                    ...fileScopedNamespace.parentSegments,
                    fileScopedNamespace.name,
                ];
            }
            const bodylessPackage = language === 'scala'
                ? scalaPackageIdentity(child)
                : undefined;
            if (bodylessPackage?.bodyless) {
                siblingParents = [
                    ...siblingParents,
                    ...bodylessPackage.parentSegments,
                    bodylessPackage.name,
                ];
            }
        }
    };
    visit(root, []);
    return symbols;
}

const CALL_NODE_TYPES = new Set([
    'call',
    'call_expression',
    'invocation_expression',
    'method_invocation',
    'object_creation_expression',
    'new_expression',
]);

const CONSTRUCTOR_NODE_TYPES = new Set([
    'object_creation_expression',
    'new_expression',
]);

export const PYTHON_STRUCTURAL_ANALYSIS_VERSION = 'python_structural_v1' as const;

export type PythonStructuralMetric<T> = Readonly<{
    derivationKind: 'exact_syntax' | 'structural_metric';
    availability: 'available';
    value: T;
}>;

export type PythonStructuralAnalysis = Readonly<{
    analysisVersion: typeof PYTHON_STRUCTURAL_ANALYSIS_VERSION;
    language: 'python';
    backend: 'tree_sitter_wasm';
    sourceBinding: 'current_source';
    metrics: Readonly<{
        parameterCount: PythonStructuralMetric<number>;
        loopCount: PythonStructuralMetric<number>;
        maxLoopDepth: PythonStructuralMetric<number>;
        cyclomaticComplexity: PythonStructuralMetric<number>;
        signature: PythonStructuralMetric<string>;
        declaredReturnType: PythonStructuralMetric<string | null>;
    }>;
}>;

export type PythonStructuralAnalysisResult =
    | Readonly<{ status: 'ok'; analysis: PythonStructuralAnalysis }>
    | Readonly<{
        status: 'unavailable';
        reason:
            | 'unsupported_symbol_kind'
            | 'parser_unavailable'
            | 'syntax_error'
            | 'symbol_not_found'
            | 'analysis_failure';
    }>;

export type PythonStructuralSymbolInput = Readonly<{
    content: string;
    symbol: Readonly<{
        kind: string;
        name: string;
        qualifiedName: string;
        span: Readonly<{
            startLine: number;
            endLine: number;
            startByte?: number;
            endByte?: number;
        }>;
    }>;
}>;

const PYTHON_COMPREHENSION_NODE_TYPES = new Set([
    'list_comprehension',
    'set_comprehension',
    'dictionary_comprehension',
    'generator_expression',
]);

const PYTHON_NESTED_SCOPE_NODE_TYPES = new Set([
    'function_definition',
    'class_definition',
    'lambda',
    'decorated_definition',
]);

function matchesPythonStructuralSymbol(
    node: Node,
    spanNode: Node,
    qualifiedName: string,
    input: PythonStructuralSymbolInput['symbol'],
    sourceMap: Utf8SourceMap,
): boolean {
    if (qualifiedName !== input.qualifiedName || nameForNode(node) !== input.name) {
        return false;
    }
    if (input.span.startByte !== undefined && input.span.endByte !== undefined) {
        const currentSpan = sourceMap.spanFromUtf16(
            spanNode.startIndex,
            spanNode.endIndex,
        );
        return currentSpan.startByte === input.span.startByte
            && currentSpan.endByte === input.span.endByte;
    }
    return spanNode.startPosition.row + 1 === input.span.startLine
        && spanNode.endPosition.row + 1 === input.span.endLine;
}

function findPythonStructuralFunction(
    root: Node,
    input: PythonStructuralSymbolInput['symbol'],
    sourceMap: Utf8SourceMap,
): Node | undefined {
    let match: Node | undefined;
    const visit = (node: Node, parents: readonly string[]): void => {
        if (match) return;
        if (node.type === 'class_definition') {
            const name = nameForNode(node);
            const nextParents = name ? [...parents, name] : parents;
            for (const child of node.namedChildren) {
                visit(child, nextParents);
            }
            return;
        }
        if (node.type === 'function_definition') {
            const name = nameForNode(node);
            const qualifiedName = name ? [...parents, name].join('.') : '';
            const spanNode = node.parent?.type === 'decorated_definition'
                ? node.parent
                : node;
            if (
                name
                && matchesPythonStructuralSymbol(
                    node,
                    spanNode,
                    qualifiedName,
                    input,
                    sourceMap,
                )
            ) {
                match = node;
                return;
            }
            const nextParents = name ? [...parents, name] : parents;
            for (const child of node.namedChildren) {
                visit(child, nextParents);
            }
            return;
        }
        for (const child of node.namedChildren) {
            visit(child, parents);
        }
    };
    visit(root, []);
    return match;
}

function comprehensionLoopOrdinal(node: Node): number {
    const parent = node.parent;
    if (!parent || !PYTHON_COMPREHENSION_NODE_TYPES.has(parent.type)) {
        return 1;
    }
    let ordinal = 0;
    for (const sibling of parent.namedChildren) {
        if (sibling.type === 'for_in_clause') {
            ordinal += 1;
        }
        if (sibling.id === node.id) {
            return Math.max(1, ordinal);
        }
    }
    return 1;
}

function measurePythonStructure(body: Node): {
    loopCount: number;
    maxLoopDepth: number;
    cyclomaticComplexity: number;
} {
    let loopCount = 0;
    let maxLoopDepth = 0;
    let decisionCount = 0;
    const visit = (node: Node, loopDepth: number): void => {
        if (node !== body && PYTHON_NESTED_SCOPE_NODE_TYPES.has(node.type)) {
            return;
        }

        let childLoopDepth = loopDepth;
        if (node.type === 'for_statement' || node.type === 'while_statement') {
            loopCount += 1;
            decisionCount += 1;
            childLoopDepth = loopDepth + 1;
            maxLoopDepth = Math.max(maxLoopDepth, childLoopDepth);
        } else if (node.type === 'for_in_clause') {
            loopCount += 1;
            decisionCount += 1;
            childLoopDepth = loopDepth + comprehensionLoopOrdinal(node);
            maxLoopDepth = Math.max(maxLoopDepth, childLoopDepth);
        } else if (
            node.type === 'if_statement'
            || node.type === 'elif_clause'
            || node.type === 'except_clause'
            || node.type === 'case_clause'
            || node.type === 'conditional_expression'
            || node.type === 'if_clause'
            || node.type === 'boolean_operator'
        ) {
            decisionCount += 1;
        }

        for (const child of node.namedChildren) {
            visit(child, childLoopDepth);
        }
    };
    visit(body, 0);
    return {
        loopCount,
        maxLoopDepth,
        cyclomaticComplexity: 1 + decisionCount,
    };
}

function countPythonParameters(parameters: Node): number {
    return parameters.namedChildren.filter((parameter) => (
        parameter.type !== 'positional_separator'
        && parameter.type !== 'keyword_separator'
    )).length;
}

export async function analyzePythonSymbolStructure(
    input: PythonStructuralSymbolInput,
    assetRoot?: string,
): Promise<PythonStructuralAnalysisResult> {
    if (input.symbol.kind !== 'function' && input.symbol.kind !== 'method') {
        return { status: 'unavailable', reason: 'unsupported_symbol_kind' };
    }

    let language: Language;
    try {
        language = await loadLanguage('python', assetRoot);
    } catch {
        return { status: 'unavailable', reason: 'parser_unavailable' };
    }

    let parser: Parser | undefined;
    let tree: ReturnType<Parser['parse']> | null = null;
    try {
        parser = new Parser();
        parser.setLanguage(language);
        tree = parser.parse(input.content);
        if (!tree) {
            return { status: 'unavailable', reason: 'analysis_failure' };
        }
        if (tree.rootNode.hasError) {
            return { status: 'unavailable', reason: 'syntax_error' };
        }
        const functionNode = findPythonStructuralFunction(
            tree.rootNode,
            input.symbol,
            new Utf8SourceMap(input.content),
        );
        if (!functionNode) {
            return { status: 'unavailable', reason: 'symbol_not_found' };
        }
        const parameters = functionNode.childForFieldName('parameters');
        const body = functionNode.childForFieldName('body');
        if (!parameters || !body) {
            return { status: 'unavailable', reason: 'analysis_failure' };
        }
        const signature = functionNode.text
            .slice(0, body.startIndex - functionNode.startIndex)
            .trimEnd();
        const declaredReturnType = functionNode
            .childForFieldName('return_type')
            ?.text
            .trim() || null;
        const structure = measurePythonStructure(body);
        return {
            status: 'ok',
            analysis: {
                analysisVersion: PYTHON_STRUCTURAL_ANALYSIS_VERSION,
                language: 'python',
                backend: 'tree_sitter_wasm',
                sourceBinding: 'current_source',
                metrics: {
                    parameterCount: {
                        derivationKind: 'exact_syntax',
                        availability: 'available',
                        value: countPythonParameters(parameters),
                    },
                    loopCount: {
                        derivationKind: 'structural_metric',
                        availability: 'available',
                        value: structure.loopCount,
                    },
                    maxLoopDepth: {
                        derivationKind: 'structural_metric',
                        availability: 'available',
                        value: structure.maxLoopDepth,
                    },
                    cyclomaticComplexity: {
                        derivationKind: 'structural_metric',
                        availability: 'available',
                        value: structure.cyclomaticComplexity,
                    },
                    signature: {
                        derivationKind: 'exact_syntax',
                        availability: 'available',
                        value: signature,
                    },
                    declaredReturnType: {
                        derivationKind: 'exact_syntax',
                        availability: 'available',
                        value: declaredReturnType,
                    },
                },
            },
        };
    } catch {
        return { status: 'unavailable', reason: 'analysis_failure' };
    } finally {
        tree?.delete();
        parser?.delete();
    }
}

export const GO_STRUCTURAL_ANALYSIS_VERSION = 'go_structural_v1' as const;

export type GoStructuralMetric<T> = PythonStructuralMetric<T>;

export type GoStructuralAnalysis = Readonly<{
    analysisVersion: typeof GO_STRUCTURAL_ANALYSIS_VERSION;
    language: 'go';
    backend: 'tree_sitter_wasm';
    sourceBinding: 'current_source';
    metrics: Readonly<{
        parameterCount: GoStructuralMetric<number>;
        loopCount: GoStructuralMetric<number>;
        maxLoopDepth: GoStructuralMetric<number>;
        cyclomaticComplexity: GoStructuralMetric<number>;
        signature: GoStructuralMetric<string>;
        declaredReturnType: GoStructuralMetric<string | null>;
    }>;
}>;

export type GoStructuralAnalysisResult =
    | Readonly<{ status: 'ok'; analysis: GoStructuralAnalysis }>
    | Readonly<{
        status: 'unavailable';
        reason:
            | 'unsupported_symbol_kind'
            | 'parser_unavailable'
            | 'syntax_error'
            | 'symbol_not_found'
            | 'analysis_failure';
    }>;

export type GoStructuralSymbolInput = PythonStructuralSymbolInput;

function matchesGoStructuralSymbol(
    node: Node,
    input: GoStructuralSymbolInput['symbol'],
    sourceMap: Utf8SourceMap,
): boolean {
    const name = nameForNode(node);
    const receiver = goReceiverOwner(node);
    const qualifiedName = name ? (receiver ? `${receiver}.${name}` : name) : '';
    if (qualifiedName !== input.qualifiedName || name !== input.name) {
        return false;
    }
    if (input.span.startByte !== undefined && input.span.endByte !== undefined) {
        const currentSpan = sourceMap.spanFromUtf16(node.startIndex, node.endIndex);
        return currentSpan.startByte === input.span.startByte
            && currentSpan.endByte === input.span.endByte;
    }
    return node.startPosition.row + 1 === input.span.startLine
        && node.endPosition.row + 1 === input.span.endLine;
}

function findGoStructuralFunction(
    root: Node,
    input: GoStructuralSymbolInput['symbol'],
    sourceMap: Utf8SourceMap,
): Node | undefined {
    let match: Node | undefined;
    const visit = (node: Node): void => {
        if (match) return;
        if (
            (node.type === 'function_declaration' || node.type === 'method_declaration')
            && matchesGoStructuralSymbol(node, input, sourceMap)
        ) {
            match = node;
            return;
        }
        for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return match;
}

function measureGoStructure(body: Node): {
    loopCount: number;
    maxLoopDepth: number;
    cyclomaticComplexity: number;
} {
    let loopCount = 0;
    let maxLoopDepth = 0;
    let decisionCount = 0;
    const visit = (node: Node, loopDepth: number): void => {
        if (node !== body && node.type === 'func_literal') return;

        let childLoopDepth = loopDepth;
        if (node.type === 'for_statement') {
            loopCount += 1;
            decisionCount += 1;
            childLoopDepth = loopDepth + 1;
            maxLoopDepth = Math.max(maxLoopDepth, childLoopDepth);
        } else if (
            node.type === 'if_statement'
            || node.type === 'expression_case'
            || node.type === 'type_case'
            || node.type === 'communication_case'
        ) {
            decisionCount += 1;
        } else if (
            node.type === 'binary_expression'
            && node.children.some((child) => child.type === '&&' || child.type === '||')
        ) {
            decisionCount += 1;
        }

        for (const child of node.namedChildren) visit(child, childLoopDepth);
    };
    visit(body, 0);
    return {
        loopCount,
        maxLoopDepth,
        cyclomaticComplexity: 1 + decisionCount,
    };
}

function countGoParameters(parameters: Node): number {
    let count = 0;
    for (const parameter of parameters.namedChildren) {
        if (parameter.type !== 'parameter_declaration' && parameter.type !== 'variadic_parameter_declaration') {
            continue;
        }
        const named = parameter.namedChildren.filter((child) => child.type === 'identifier').length;
        count += Math.max(1, named);
    }
    return count;
}

export async function analyzeGoSymbolStructure(
    input: GoStructuralSymbolInput,
    assetRoot?: string,
): Promise<GoStructuralAnalysisResult> {
    if (input.symbol.kind !== 'function' && input.symbol.kind !== 'method') {
        return { status: 'unavailable', reason: 'unsupported_symbol_kind' };
    }

    let language: Language;
    try {
        language = await loadLanguage('go', assetRoot);
    } catch {
        return { status: 'unavailable', reason: 'parser_unavailable' };
    }

    let parser: Parser | undefined;
    let tree: ReturnType<Parser['parse']> | null = null;
    try {
        parser = new Parser();
        parser.setLanguage(language);
        tree = parser.parse(input.content);
        if (!tree) return { status: 'unavailable', reason: 'analysis_failure' };
        if (tree.rootNode.hasError) return { status: 'unavailable', reason: 'syntax_error' };

        const functionNode = findGoStructuralFunction(
            tree.rootNode,
            input.symbol,
            new Utf8SourceMap(input.content),
        );
        if (!functionNode) return { status: 'unavailable', reason: 'symbol_not_found' };

        const parameters = functionNode.childForFieldName('parameters');
        const body = functionNode.childForFieldName('body');
        if (!parameters || !body) return { status: 'unavailable', reason: 'analysis_failure' };

        const signature = functionNode.text
            .slice(0, body.startIndex - functionNode.startIndex)
            .trimEnd();
        const declaredReturnType = functionNode.childForFieldName('result')?.text.trim() || null;
        const structure = measureGoStructure(body);
        return {
            status: 'ok',
            analysis: {
                analysisVersion: GO_STRUCTURAL_ANALYSIS_VERSION,
                language: 'go',
                backend: 'tree_sitter_wasm',
                sourceBinding: 'current_source',
                metrics: {
                    parameterCount: {
                        derivationKind: 'exact_syntax',
                        availability: 'available',
                        value: countGoParameters(parameters),
                    },
                    loopCount: {
                        derivationKind: 'structural_metric',
                        availability: 'available',
                        value: structure.loopCount,
                    },
                    maxLoopDepth: {
                        derivationKind: 'structural_metric',
                        availability: 'available',
                        value: structure.maxLoopDepth,
                    },
                    cyclomaticComplexity: {
                        derivationKind: 'structural_metric',
                        availability: 'available',
                        value: structure.cyclomaticComplexity,
                    },
                    signature: {
                        derivationKind: 'exact_syntax',
                        availability: 'available',
                        value: signature,
                    },
                    declaredReturnType: {
                        derivationKind: 'exact_syntax',
                        availability: 'available',
                        value: declaredReturnType,
                    },
                },
            },
        };
    } catch {
        return { status: 'unavailable', reason: 'analysis_failure' };
    } finally {
        tree?.delete();
        parser?.delete();
    }
}

export type SymbolStructuralAnalysis = PythonStructuralAnalysis | GoStructuralAnalysis;

function callableName(node: Node): string | undefined {
    const callable = node.childForFieldName('function')
        ?? node.childForFieldName('name')
        ?? node.childForFieldName('type');
    if (!callable) return undefined;
    const leaf = callable.descendantsOfType([
        'identifier',
        'field_identifier',
        'property_identifier',
        'type_identifier',
    ]).at(-1) ?? callable;
    return leaf.text.trim() || undefined;
}

function callSiteEvidence(node: Node): Pick<CallSite, 'kind' | 'receiverText' | 'qualifiedCallee'> {
    if (CONSTRUCTOR_NODE_TYPES.has(node.type)) {
        return { kind: 'constructor' };
    }
    const callable = node.childForFieldName('function') ?? node.childForFieldName('name');
    const receiver = node.childForFieldName('object') ?? callable?.childForFieldName('object');
    const callableType = callable?.type ?? '';
    const member = Boolean(receiver)
        || callableType === 'attribute'
        || callableType === 'member_expression'
        || callableType === 'field_expression'
        || (node.type === 'method_invocation' && node.namedChildren.filter((child) => child.type !== 'argument_list').length > 1);
    if (!member) return { kind: 'direct' };
    return {
        kind: 'member',
        ...(receiver?.text.trim() ? { receiverText: receiver.text.trim() } : {}),
        ...(callable?.text.trim() ? { qualifiedCallee: callable.text.trim() } : {}),
    };
}

function nodeSpan(node: Node, sourceMap: Utf8SourceMap) {
    return sourceMap.spanFromUtf16(node.startIndex, node.endIndex);
}

function nearestPythonStatementBlock(node: Node): Node | undefined {
    let current = node.parent;
    while (current) {
        if (current.type === 'block' || current.type === 'module') return current;
        current = current.parent;
    }
    return undefined;
}

function extractCallSites(root: Node, sourceMap: Utf8SourceMap, language: string): CallSite[] {
    const calls: CallSite[] = [];
    const visit = (node: Node): void => {
        if (CALL_NODE_TYPES.has(node.type)) {
            const name = callableName(node);
            const statementBlock = language === 'python' ? nearestPythonStatementBlock(node) : undefined;
            const argumentsNode = node.childForFieldName('arguments')
                ?? node.namedChildren.find(child => child.type === 'argument_list' || child.type === 'arguments');
            if (name) calls.push({
                calleeName: name,
                ...callSiteEvidence(node),
                ...(argumentsNode ? { args: argumentsNode.namedChildren.filter(child => child.type !== 'comment').map(child => child.text) } : {}),
                span: nodeSpan(node, sourceMap),
                ...(statementBlock ? { statementBlockSpan: nodeSpan(statementBlock, sourceMap) } : {}),
            });
        }
        for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return calls;
}

function isPythonTypeCheckingImport(node: Node): boolean {
    let child = node;
    for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (parent.type !== 'if_statement'
            || parent.childForFieldName('consequence')?.id !== child.id) continue;
        const condition = parent.childForFieldName('condition');
        const name = condition?.type === 'attribute'
            ? condition.childForFieldName('attribute')
            : condition;
        if (name?.type === 'identifier' && name.text === 'TYPE_CHECKING') return true;
    }
    return false;
}

function extractPythonModuleBindings(
    root: Node,
    symbols: readonly ExtractedSymbol[],
    sourceMap: Utf8SourceMap,
): ModuleBinding[] {
    const bindings: ModuleBinding[] = symbols
        .filter((symbol) => (
            symbol.kind !== 'variable'
            && symbol.parentQualifiedNamePath?.length === 0
        ))
        .map((symbol) => ({
            kind: 'export' as const,
            exportedName: symbol.name,
            localName: symbol.name,
            typeOnly: false,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
                startByte: symbol.span.startByte ?? 0,
                endByte: symbol.span.endByte ?? 0,
                startColumn: symbol.span.startColumn ?? 0,
                endColumn: symbol.span.endColumn ?? 0,
            },
        }));
    for (const node of root.descendantsOfType('import_from_statement')) {
        const moduleName = node.childForFieldName('module_name')?.text.trim();
        if (moduleName) {
            for (const imported of node.childrenForFieldName('name')) {
                const importedNameNode = imported.type === 'aliased_import'
                    ? imported.childForFieldName('name')
                    : imported;
                const aliasNode = imported.type === 'aliased_import'
                    ? imported.childForFieldName('alias')
                    : undefined;
                const importedName = importedNameNode?.text.trim();
                const localName = aliasNode?.text.trim() || importedName;
                if (!importedName || !localName) continue;
                bindings.push({
                    kind: 'import',
                    moduleSpecifier: moduleName,
                    importedName,
                    localName,
                    typeOnly: isPythonTypeCheckingImport(node),
                    span: nodeSpan(node, sourceMap),
                });
            }
        }
    }
    for (const node of root.descendantsOfType('import_statement')) {
        for (const child of node.namedChildren) {
            if (child.type === 'aliased_import') {
                const moduleName = child.childForFieldName('name')?.text.trim();
                const alias = child.childForFieldName('alias')?.text.trim();
                if (!moduleName || !alias) continue;
                bindings.push({
                    kind: 'import',
                    moduleSpecifier: moduleName,
                    localName: alias,
                    typeOnly: isPythonTypeCheckingImport(node),
                    span: nodeSpan(node, sourceMap),
                });
                continue;
            }
            if (child.type !== 'dotted_name') continue;
            const moduleSpecifier = child.text.trim();
            if (!moduleSpecifier) continue;
            bindings.push({
                kind: 'import',
                moduleSpecifier,
                typeOnly: isPythonTypeCheckingImport(node),
                span: nodeSpan(node, sourceMap),
            });
        }
    }
    return bindings;
}

function directPythonConstructorType(node: Node): string | undefined {
    if (node.type !== 'call') return undefined;
    const callable = node.childForFieldName('function');
    if (callable?.type !== 'identifier') return undefined;
    const typeName = callable.text.trim();
    return /^[A-Z][A-Za-z0-9_]*$/.test(typeName) ? typeName : undefined;
}

function enclosingPythonFunction(node: Node): Node | undefined {
    let current = node.parent;
    while (current) {
        if (current.type === 'function_definition') return current;
        current = current.parent;
    }
    return undefined;
}

function enclosingPythonClass(node: Node): Node | undefined {
    let current = node.parent;
    while (current) {
        if (current.type === 'class_definition') return current;
        current = current.parent;
    }
    return undefined;
}

function simplePythonAnnotationTypeName(node: Node | null | undefined): string | undefined {
    if (!node) return undefined;
    if (node.type === 'identifier') return node.text.trim() || undefined;
    if (node.type === 'type' && node.namedChildren.length === 1) {
        return simplePythonAnnotationTypeName(node.namedChildren[0]);
    }
    const raw = node.text.trim();
    const quoted = /^(?:'([A-Za-z_][A-Za-z0-9_]*)'|\"([A-Za-z_][A-Za-z0-9_]*)\")$/.exec(raw);
    return quoted?.[1] ?? quoted?.[2];
}

function extractPythonReceiverTypeBindings(
    root: Node,
    sourceMap: Utf8SourceMap,
): ReceiverTypeBinding[] {
    const bindings: ReceiverTypeBinding[] = [];
    for (const node of root.descendantsOfType(['typed_parameter', 'typed_default_parameter'])) {
        const nameNode = node.childForFieldName('name')
            ?? node.namedChildren.find((child) => child.type === 'identifier');
        const typeName = simplePythonAnnotationTypeName(node.childForFieldName('type'));
        if (nameNode?.type !== 'identifier' || !typeName) {
            continue;
        }
        const localName = nameNode.text.trim();
        if (!localName || !typeName) {
            continue;
        }
        bindings.push({
            localName,
            typeName,
            kind: 'parameter_annotation',
            span: nodeSpan(node, sourceMap),
        });
    }
    for (const assignment of root.descendantsOfType('assignment')) {
        const target = assignment.childForFieldName('left');
        const value = assignment.childForFieldName('right');
        const typeName = value ? directPythonConstructorType(value) : undefined;
        const statementBlock = nearestPythonStatementBlock(assignment);
        const containingFunction = enclosingPythonFunction(assignment);
        if (!target || !typeName || !statementBlock || !containingFunction) continue;

        if (target.type === 'identifier') {
            const localName = target.text.trim();
            if (!localName) continue;
            bindings.push({
                localName,
                typeName,
                kind: 'local_constructor',
                span: nodeSpan(assignment, sourceMap),
                statementBlockSpan: nodeSpan(statementBlock, sourceMap),
            });
            continue;
        }

        if (target.type !== 'attribute') continue;
        const object = target.childForFieldName('object');
        const attribute = target.childForFieldName('attribute');
        const localName = target.text.trim();
        const functionName = containingFunction.childForFieldName('name')?.text.trim();
        const functionBody = containingFunction.childForFieldName('body');
        if (
            object?.type !== 'identifier'
            || object.text.trim() !== 'self'
            || attribute?.type !== 'identifier'
            || !localName
            || functionName !== '__init__'
            || statementBlock.id !== functionBody?.id
            || !enclosingPythonClass(containingFunction)
        ) {
            continue;
        }
        bindings.push({
            localName,
            typeName,
            kind: 'self_field_constructor',
            span: nodeSpan(assignment, sourceMap),
        });
    }
    return bindings;
}

function pythonFlowValueKind(node: Node): {
    valueKind: 'constructor' | 'call' | 'member' | 'identifier' | 'unknown';
    constructorTypeName?: string;
    calleeName?: string;
} {
    const constructorTypeName = directPythonConstructorType(node);
    if (constructorTypeName) {
        return { valueKind: 'constructor', constructorTypeName };
    }
    if (node.type === 'call') {
        return {
            valueKind: 'call',
            ...(callableName(node) ? { calleeName: callableName(node) } : {}),
        };
    }
    if (node.type === 'attribute') return { valueKind: 'member' };
    if (node.type === 'identifier') return { valueKind: 'identifier' };
    return { valueKind: 'unknown' };
}

function pythonFlowBlockSpan(node: Node, root: Node, sourceMap: Utf8SourceMap): SourceSpan {
    return nodeSpan(nearestPythonStatementBlock(node) ?? root, sourceMap);
}

function pythonParameterName(node: Node): string | undefined {
    if (node.type === 'identifier') return node.text.trim() || undefined;
    const nameNode = node.childForFieldName('name')
        ?? node.namedChildren.find((child) => child.type === 'identifier');
    return nameNode?.type === 'identifier' ? nameNode.text.trim() || undefined : undefined;
}

const PYTHON_NESTED_SCOPE_EXPRESSION_TYPES = new Set([
    'lambda',
    'list_comprehension',
    'set_comprehension',
    'dictionary_comprehension',
    'generator_expression',
]);

function collectPythonTargetIdentifiers(node: Node | null | undefined, out: Array<{ name: string; node: Node }>): void {
    if (!node) return;
    if (node.type === 'identifier') {
        const name = node.text.trim();
        if (name) out.push({ name, node });
        return;
    }
    if (
        node.type === 'pattern_list'
        || node.type === 'tuple_pattern'
        || node.type === 'list_pattern'
        || node.type === 'parenthesized_expression'
        || node.type === 'list_splat_pattern'
        || node.type === 'dictionary_splat_pattern'
        || node.type === 'as_pattern_target'
    ) {
        for (const child of node.namedChildren) {
            collectPythonTargetIdentifiers(child, out);
        }
    }
}

function collectPythonScopeNonImportBindings(
    node: Node,
    scopeNodeId: number,
    out: Array<{ name: string; node: Node }>,
): void {
    if (node.id !== scopeNodeId && (node.type === 'function_definition' || node.type === 'class_definition')) {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text.trim();
        if (name && nameNode) out.push({ name, node: nameNode });
        return;
    }
    if (PYTHON_NESTED_SCOPE_EXPRESSION_TYPES.has(node.type)) {
        return;
    }
    if (node.type === 'assignment') {
        collectPythonTargetIdentifiers(node.childForFieldName('left'), out);
        const right = node.childForFieldName('right');
        if (right) collectPythonScopeNonImportBindings(right, scopeNodeId, out);
        return;
    }
    if (node.type === 'augmented_assignment') {
        collectPythonTargetIdentifiers(node.childForFieldName('left'), out);
        const right = node.childForFieldName('right');
        if (right) collectPythonScopeNonImportBindings(right, scopeNodeId, out);
        return;
    }
    if (node.type === 'named_expression') {
        collectPythonTargetIdentifiers(node.childForFieldName('name'), out);
        const value = node.childForFieldName('value');
        if (value) collectPythonScopeNonImportBindings(value, scopeNodeId, out);
        return;
    }
    if (node.type === 'for_statement') {
        collectPythonTargetIdentifiers(node.childForFieldName('left'), out);
    } else if (node.type === 'with_statement') {
        for (const clause of node.namedChildren) {
            if (clause.type !== 'with_clause') continue;
            for (const item of clause.namedChildren) {
                if (item.type !== 'with_item') continue;
                for (const child of item.namedChildren) {
                    if (child.type === 'as_pattern') {
                        collectPythonTargetIdentifiers(child.childForFieldName('alias'), out);
                    }
                }
            }
        }
    } else if (node.type === 'except_clause') {
        for (const child of node.namedChildren) {
            if (child.type === 'as_pattern') {
                collectPythonTargetIdentifiers(child.childForFieldName('alias'), out);
            }
        }
    } else if (node.type === 'delete_statement') {
        for (const child of node.namedChildren) {
            collectPythonTargetIdentifiers(child, out);
        }
        return;
    }
    for (const child of node.namedChildren) {
        collectPythonScopeNonImportBindings(child, scopeNodeId, out);
    }
}

function collectPythonScopeImportNodes(
    node: Node,
    scopeNodeId: number,
    out: Node[],
): void {
    if (node.id !== scopeNodeId && (node.type === 'function_definition' || node.type === 'class_definition')) {
        return;
    }
    if (PYTHON_NESTED_SCOPE_EXPRESSION_TYPES.has(node.type)) {
        return;
    }
    if (node.type === 'import_from_statement' || node.type === 'import_statement') {
        out.push(node);
        return;
    }
    for (const child of node.namedChildren) {
        collectPythonScopeImportNodes(child, scopeNodeId, out);
    }
}

function pythonImportBoundIdentifiers(importNode: Node): Array<{ name: string; node: Node }> {
    const out: Array<{ name: string; node: Node }> = [];
    if (importNode.type === 'import_from_statement') {
        for (const imported of importNode.childrenForFieldName('name')) {
            if (imported.type === 'aliased_import') {
                const aliasNode = imported.childForFieldName('alias');
                const alias = aliasNode?.text.trim();
                if (alias && aliasNode) out.push({ name: alias, node: aliasNode });
            } else {
                const name = imported.text.trim();
                if (name) out.push({ name, node: imported });
            }
        }
        return out;
    }
    if (importNode.type === 'import_statement') {
        for (const child of importNode.namedChildren) {
            if (child.type === 'aliased_import') {
                const aliasNode = child.childForFieldName('alias');
                const alias = aliasNode?.text.trim();
                if (alias && aliasNode) out.push({ name: alias, node: aliasNode });
            } else if (child.type === 'dotted_name') {
                const firstIdentifier = child.namedChildren[0] ?? child;
                const name = firstIdentifier.text.trim();
                if (name) out.push({ name, node: firstIdentifier });
            }
        }
    }
    return out;
}

function collectPythonGlobalRebinds(
    root: Node,
    sourceMap: Utf8SourceMap,
): { facts: PythonFlowFact[]; globalReboundNames: Set<string> } {
    const facts: PythonFlowFact[] = [];
    const globalReboundNames = new Set<string>();
    const rootSpan = nodeSpan(root, sourceMap);
    const scopes = [
        ...root.descendantsOfType('function_definition'),
        ...root.descendantsOfType('class_definition'),
    ];
    for (const scopeNode of scopes) {
        const declaredGlobals = new Set<string>();
        for (const globalStmt of scopeNode.descendantsOfType('global_statement')) {
            const nearestScope = enclosingPythonFunction(globalStmt) ?? enclosingPythonClass(globalStmt);
            // Global inside a class body has nearestScope === classNode unless inside a method inside classNode.
            let ownerScope: Node | undefined = globalStmt.parent ?? undefined;
            while (ownerScope && ownerScope.type !== 'function_definition' && ownerScope.type !== 'class_definition') {
                ownerScope = ownerScope.parent ?? undefined;
            }
            if ((ownerScope?.id ?? nearestScope?.id) !== scopeNode.id) continue;
            for (const child of globalStmt.namedChildren) {
                if (child.type === 'identifier') {
                    const name = child.text.trim();
                    if (name) declaredGlobals.add(name);
                }
            }
        }
        if (declaredGlobals.size === 0) continue;
        const body = scopeNode.childForFieldName('body') ?? scopeNode;
        const bindings: Array<{ name: string; node: Node }> = [];
        collectPythonScopeNonImportBindings(body, scopeNode.id, bindings);
        const importNodes: Node[] = [];
        collectPythonScopeImportNodes(body, scopeNode.id, importNodes);
        for (const importNode of importNodes) {
            bindings.push(...pythonImportBoundIdentifiers(importNode));
        }
        const seenSite = new Set<string>();
        for (const { name, node } of bindings) {
            if (!declaredGlobals.has(name)) continue;
            const span = nodeSpan(node, sourceMap);
            const key = `${name}:${span.startByte}:${span.endByte}`;
            if (seenSite.has(key)) continue;
            seenSite.add(key);
            globalReboundNames.add(name);
            facts.push({
                kind: 'assignment_origin',
                targetText: name,
                valueText: 'global',
                valueKind: 'unknown',
                globalRebind: true,
                span,
                contextSpan: rootSpan,
            });
        }
    }
    return { facts, globalReboundNames };
}

interface PythonOverloadResolutionContext {
    overloadLocalNames: ReadonlySet<string>;
    typingModuleAliases: ReadonlySet<string>;
}

function collectPythonOverloadContext(
    root: Node,
    globalReboundNames: ReadonlySet<string>,
): PythonOverloadResolutionContext {
    const importTargetsByLocalName = new Map<string, Set<string>>();
    const addImportTarget = (localName: string, target: string): void => {
        if (!localName) return;
        const set = importTargetsByLocalName.get(localName);
        if (set) {
            set.add(target);
        } else {
            importTargetsByLocalName.set(localName, new Set([target]));
        }
    };
    const moduleImportNodes: Node[] = [];
    collectPythonScopeImportNodes(root, root.id, moduleImportNodes);
    for (const node of moduleImportNodes) {
        if (node.type === 'import_from_statement') {
            const moduleName = node.childForFieldName('module_name')?.text.trim() ?? '';
            for (const imported of node.childrenForFieldName('name')) {
                const importedNameNode = imported.type === 'aliased_import'
                    ? imported.childForFieldName('name')
                    : imported;
                const aliasNode = imported.type === 'aliased_import'
                    ? imported.childForFieldName('alias')
                    : undefined;
                const importedName = importedNameNode?.text.trim() ?? '';
                const localName = aliasNode?.text.trim() || importedName;
                if (!importedName || !localName) continue;
                const isTypingOverload = (moduleName === 'typing' || moduleName === 'typing_extensions')
                    && importedName === 'overload';
                addImportTarget(localName, isTypingOverload ? 'typing.overload' : `other:${moduleName}:${importedName}`);
            }
            continue;
        }
        if (node.type === 'import_statement') {
            for (const child of node.namedChildren) {
                if (child.type === 'aliased_import') {
                    const moduleName = child.childForFieldName('name')?.text.trim() ?? '';
                    const alias = child.childForFieldName('alias')?.text.trim() ?? '';
                    if (!moduleName || !alias) continue;
                    const isTypingModule = moduleName === 'typing' || moduleName === 'typing_extensions';
                    addImportTarget(alias, isTypingModule ? 'typing_module' : `other:${moduleName}`);
                } else if (child.type === 'dotted_name') {
                    const moduleSpecifier = child.text.trim();
                    const rootName = moduleSpecifier.split('.')[0]?.trim() ?? '';
                    if (!moduleSpecifier || !rootName) continue;
                    const isTypingModule = rootName === 'typing' || rootName === 'typing_extensions';
                    addImportTarget(rootName, isTypingModule ? 'typing_module' : `other:${moduleSpecifier}`);
                }
            }
        }
    }

    const moduleBindings: Array<{ name: string; node: Node }> = [];
    collectPythonScopeNonImportBindings(root, root.id, moduleBindings);
    const moduleNonImportNames = new Set(moduleBindings.map((item) => item.name));

    const overloadLocalNames = new Set<string>();
    const typingModuleAliases = new Set<string>();
    for (const [localName, targets] of importTargetsByLocalName.entries()) {
        if (moduleNonImportNames.has(localName) || globalReboundNames.has(localName)) continue;
        if (targets.size === 1 && targets.has('typing.overload')) {
            overloadLocalNames.add(localName);
        } else if (targets.size === 1 && targets.has('typing_module')) {
            typingModuleAliases.add(localName);
        }
    }
    return { overloadLocalNames, typingModuleAliases };
}

function enclosingPythonBoundNames(decoratedDefinition: Node): Set<string> {
    const names = new Set<string>();
    let current = decoratedDefinition.parent;
    while (current) {
        if (current.type === 'function_definition' || current.type === 'class_definition') {
            if (current.type === 'function_definition') {
                const params = current.childForFieldName('parameters');
                if (params) {
                    for (const param of params.namedChildren) {
                        const paramName = pythonParameterName(param);
                        if (paramName) names.add(paramName);
                    }
                }
            }
            const body = current.childForFieldName('body') ?? current;
            const localBindings: Array<{ name: string; node: Node }> = [];
            collectPythonScopeNonImportBindings(body, current.id, localBindings);
            for (const binding of localBindings) names.add(binding.name);
            const importNodes: Node[] = [];
            collectPythonScopeImportNodes(body, current.id, importNodes);
            for (const importNode of importNodes) {
                for (const binding of pythonImportBoundIdentifiers(importNode)) {
                    names.add(binding.name);
                }
            }
        }
        current = current.parent;
    }
    return names;
}

function isPythonOverloadDecorator(
    decorator: Node,
    overloadContext: PythonOverloadResolutionContext,
    enclosingShadowedNames: ReadonlySet<string>,
): boolean {
    let expr = decorator.namedChildren[0];
    while (expr?.type === 'parenthesized_expression') {
        expr = expr.namedChildren[0];
    }
    if (!expr) return false;
    if (expr.type === 'identifier') {
        const name = expr.text.trim();
        return overloadContext.overloadLocalNames.has(name) && !enclosingShadowedNames.has(name);
    }
    if (expr.type === 'attribute') {
        const object = expr.childForFieldName('object');
        const attribute = expr.childForFieldName('attribute');
        if (object?.type !== 'identifier' || attribute?.type !== 'identifier') return false;
        const alias = object.text.trim();
        return attribute.text.trim() === 'overload'
            && overloadContext.typingModuleAliases.has(alias)
            && !enclosingShadowedNames.has(alias);
    }
    return false;
}

function pythonCallableSignature(
    functionNode: Node,
    sourceMap: Utf8SourceMap,
    overloadContext: PythonOverloadResolutionContext,
): PythonFlowFact | undefined {
    const callableName = functionNode.childForFieldName('name')?.text.trim();
    const parameters = functionNode.childForFieldName('parameters');
    if (!callableName || !parameters) return undefined;
    const parameterNames: string[] = [];
    let positionalExact = true;
    for (const parameter of parameters.namedChildren) {
        if (parameter.type === 'positional_separator'
            || parameter.type === 'keyword_separator'
            || parameter.type === 'list_splat'
            || parameter.type === 'dictionary_splat') {
            positionalExact = false;
            continue;
        }
        const parameterName = pythonParameterName(parameter);
        if (!parameterName) {
            positionalExact = false;
            continue;
        }
        parameterNames.push(parameterName);
    }
    const decoratedDefinition = functionNode.parent?.type === 'decorated_definition'
        ? functionNode.parent
        : undefined;
    const decorators = decoratedDefinition?.namedChildren.filter((child) => child.type === 'decorator') ?? [];
    const enclosingShadowedNames = decoratedDefinition && decorators.length > 0
        ? enclosingPythonBoundNames(decoratedDefinition)
        : new Set<string>();
    const overload = decorators.some((decorator) => (
        isPythonOverloadDecorator(decorator, overloadContext, enclosingShadowedNames)
    ));
    const decorated = overload || decorators.some((decorator) => {
        const name = decorator.text.trim().replace(/^@/, '').trim();
        return name !== 'classmethod' && name !== 'staticmethod';
    });
    return {
        kind: 'callable_signature',
        callableName,
        parameterNames,
        positionalExact,
        decorated,
        ...(overload ? { overload: true } : {}),
        span: nodeSpan(decoratedDefinition ?? functionNode, sourceMap),
        contextSpan: nodeSpan(functionNode, sourceMap),
    };
}

function extractPythonFlowFacts(
    root: Node,
    sourceMap: Utf8SourceMap,
): PythonFlowFact[] {
    const { facts: globalRebindFacts, globalReboundNames } = collectPythonGlobalRebinds(root, sourceMap);
    const overloadContext = collectPythonOverloadContext(root, globalReboundNames);
    const facts: PythonFlowFact[] = [];
    for (const functionNode of root.descendantsOfType('function_definition')) {
        const signature = pythonCallableSignature(functionNode, sourceMap, overloadContext);
        if (signature) facts.push(signature);
    }
    facts.push(...globalRebindFacts);
    for (const assignment of root.descendantsOfType('assignment')) {
        const target = assignment.childForFieldName('left');
        const value = assignment.childForFieldName('right');
        const targetText = target?.text.trim();
        const valueText = value?.text.trim();
        if (!targetText || !valueText) continue;
        const valueEvidence = value ? pythonFlowValueKind(value) : { valueKind: 'unknown' as const };
        facts.push({
            kind: 'assignment_origin',
            targetText,
            valueText,
            ...valueEvidence,
            span: nodeSpan(assignment, sourceMap),
            contextSpan: pythonFlowBlockSpan(assignment, root, sourceMap),
        });
    }

    for (const call of root.descendantsOfType('call')) {
        const calleeText = call.childForFieldName('function')?.text.trim();
        const argumentsNode = call.childForFieldName('arguments')
            ?? call.namedChildren.find((child) => child.type === 'argument_list');
        if (!calleeText || !argumentsNode) continue;
        let argumentIndex = 0;
        for (const argument of argumentsNode.namedChildren) {
            if (argument.type === 'keyword_argument') {
                const argumentName = argument.childForFieldName('name')?.text.trim();
                const valueText = argument.childForFieldName('value')?.text.trim();
                if (argumentName && valueText) {
                    facts.push({
                        kind: 'call_argument',
                        calleeText,
                        argumentName,
                        valueText,
                        span: nodeSpan(call, sourceMap),
                        contextSpan: pythonFlowBlockSpan(call, root, sourceMap),
                    });
                }
            } else if (argument.type !== 'list_splat' && argument.type !== 'dictionary_splat') {
                const valueText = argument.text.trim();
                if (valueText) {
                    facts.push({
                        kind: 'call_argument',
                        calleeText,
                        argumentIndex,
                        valueText,
                        span: nodeSpan(call, sourceMap),
                        contextSpan: pythonFlowBlockSpan(call, root, sourceMap),
                    });
                }
            }
            argumentIndex += 1;
        }
    }

    for (const classNode of root.descendantsOfType('class_definition')) {
        const className = classNode.childForFieldName('name')?.text.trim();
        const superclasses = classNode.childForFieldName('superclasses');
        const baseNames = (superclasses?.namedChildren ?? [])
            .map((base) => base.text.trim())
            .filter(Boolean);
        if (!className || baseNames.length === 0) continue;
        facts.push({
            kind: 'class_bases',
            className,
            baseNames,
            span: nodeSpan(classNode, sourceMap),
            contextSpan: nodeSpan(root, sourceMap),
        });
    }
    return facts;
}

export async function analyzeWithTreeSitter(
    input: LanguageAnalysisInput,
    assetRoot?: string,
): Promise<{
    complete: true;
    symbols: readonly ExtractedSymbol[];
    moduleBindings: readonly ModuleBinding[];
    callSites: readonly CallSite[];
    receiverTypeBindings: readonly ReceiverTypeBinding[];
    pythonFlowFacts: readonly PythonFlowFact[];
} | {
    complete: false;
    reason: 'syntax_error' | 'parser_unavailable' | 'analysis_failure';
    symbols: readonly ExtractedSymbol[];
    moduleBindings: readonly [];
    callSites: readonly [];
    receiverTypeBindings: readonly [];
    pythonFlowFacts: readonly [];
}> {
    let language: Language;
    try {
        language = await loadLanguage(input.language, assetRoot);
    } catch {
        return {
            complete: false,
            reason: 'parser_unavailable',
            symbols: [],
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        };
    }
    let parser!: Parser;
    try {
        parser = new Parser();
        parser.setLanguage(language);
    } catch {
        parser?.delete();
        return {
            complete: false,
            reason: 'parser_unavailable',
            symbols: [],
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        };
    }
    const parseStartedAt = input.perfTiming ? performance.now() : 0;
    let tree: ReturnType<Parser['parse']>;
    try {
        tree = parser.parse(input.content);
    } catch {
        parser.delete();
        return {
            complete: false,
            reason: 'analysis_failure',
            symbols: [],
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        };
    } finally {
        if (input.perfTiming) {
            input.perfTiming.parseMs += performance.now() - parseStartedAt;
            input.perfTiming.parseCount++;
        }
    }
    if (!tree) {
        parser.delete();
        return {
            complete: false,
            reason: 'analysis_failure',
            symbols: [],
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        };
    }
    const traversalStartedAt = input.perfTiming ? performance.now() : 0;
    try {
        try {
            const sourceMap = new Utf8SourceMap(input.content);
            const symbols = extractSymbols(tree.rootNode, input.language, sourceMap);
            if (tree.rootNode.hasError) {
                return {
                    complete: false,
                    reason: 'syntax_error',
                    symbols,
                    moduleBindings: [],
                    callSites: [],
                    receiverTypeBindings: [],
                    pythonFlowFacts: [],
                };
            }
            return {
                complete: true,
                symbols,
                moduleBindings: input.language === 'python'
                    ? extractPythonModuleBindings(tree.rootNode, symbols, sourceMap)
                    : [],
                callSites: extractCallSites(tree.rootNode, sourceMap, input.language),
                receiverTypeBindings: input.language === 'python'
                    ? extractPythonReceiverTypeBindings(tree.rootNode, sourceMap)
                    : [],
                pythonFlowFacts: input.language === 'python'
                    ? extractPythonFlowFacts(tree.rootNode, sourceMap)
                    : [],
            };
        } catch {
            return {
                complete: false,
                reason: 'analysis_failure',
                symbols: [],
                moduleBindings: [],
                callSites: [],
                receiverTypeBindings: [],
                pythonFlowFacts: [],
            };
        }
    } finally {
        if (input.perfTiming) {
            input.perfTiming.traversalMs += performance.now() - traversalStartedAt;
            input.perfTiming.traversalCount++;
        }
        tree.delete();
        parser.delete();
    }
}
