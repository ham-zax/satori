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
    if (!declaredName) return undefined;
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

function cppCallableTerminal(node: Node): { name: string; parents?: string[] } | undefined {
    const terminal = node.childForFieldName('declarator');
    if (!terminal) return undefined;
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

function cppQualifiedCallable(node: Node): { name: string; parents: string[] } | undefined {
    if (node.type !== 'function_definition') return undefined;
    const qualified = node
        .childForFieldName('declarator')
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

function pythonModuleBindingName(node: Node): string | undefined {
    if (
        node.type !== 'assignment'
        || node.parent?.type !== 'expression_statement'
        || node.parent.parent?.type !== 'module'
    ) {
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
        const pythonModuleBinding = language === 'python'
            ? pythonModuleBindingName(node)
            : undefined;
        if (pythonModuleBinding) {
            kind = 'variable';
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
        const cppNamespace = language === 'cpp' ? cppNamespaceIdentity(node) : undefined;
        const csharpNamespace = language === 'csharp' ? csharpNamespaceIdentity(node) : undefined;
        const scalaPackage = language === 'scala' ? scalaPackageIdentity(node) : undefined;
        const scalaBinding = language === 'scala' ? scalaBindingName(node) : undefined;
        const cppQualified = language === 'cpp' ? cppQualifiedCallable(node) : undefined;
        if (
            language === 'cpp'
            && node.type === 'function_definition'
            && (semanticContainer === 'class' || cppQualified)
        ) {
            kind = 'method';
        }
        const name = kind
            ? pythonModuleBinding
                ?? cppNamespace?.name
                ?? csharpNamespace?.name
                ?? scalaPackage?.name
                ?? scalaBinding
                ?? cppDeclaration?.name
                ?? cppQualified?.name
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
                : cppQualified?.parents
                    ? [...parents, ...cppQualified.parents]
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
        if (kind && name) {
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
                    typeOnly: false,
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
                    typeOnly: false,
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
                typeOnly: false,
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

function extractPythonReceiverTypeBindings(
    root: Node,
    sourceMap: Utf8SourceMap,
): ReceiverTypeBinding[] {
    const bindings: ReceiverTypeBinding[] = [];
    for (const node of root.descendantsOfType(['typed_parameter', 'typed_default_parameter'])) {
        const nameNode = node.childForFieldName('name')
            ?? node.namedChildren.find((child) => child.type === 'identifier');
        const typeNode = node.childForFieldName('type');
        const simpleTypeNode = typeNode?.type === 'identifier'
            ? typeNode
            : typeNode?.type === 'type'
                && typeNode.namedChildren.length === 1
                && typeNode.namedChildren[0]?.type === 'identifier'
                ? typeNode.namedChildren[0]
                : undefined;
        if (nameNode?.type !== 'identifier' || !simpleTypeNode) {
            continue;
        }
        const localName = nameNode.text.trim();
        const typeName = simpleTypeNode.text.trim();
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

function pythonContextSpan(node: Node, root: Node, sourceMap: Utf8SourceMap): SourceSpan {
    return nodeSpan(enclosingPythonFunction(node) ?? root, sourceMap);
}

function extractPythonFlowFacts(
    root: Node,
    sourceMap: Utf8SourceMap,
): PythonFlowFact[] {
    const facts: PythonFlowFact[] = [];
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
            contextSpan: pythonContextSpan(assignment, root, sourceMap),
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
                        contextSpan: pythonContextSpan(call, root, sourceMap),
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
                        contextSpan: pythonContextSpan(call, root, sourceMap),
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
    symbols: readonly [];
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
    try {
        try {
            if (tree.rootNode.hasError) {
                return {
                    complete: false,
                    reason: 'syntax_error',
                    symbols: [],
                    moduleBindings: [],
                    callSites: [],
                    receiverTypeBindings: [],
                    pythonFlowFacts: [],
                };
            }
            const sourceMap = new Utf8SourceMap(input.content);
            const symbols = extractSymbols(tree.rootNode, input.language, sourceMap);
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
        tree.delete();
        parser.delete();
    }
}
