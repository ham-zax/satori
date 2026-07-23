import path from 'node:path';
import { createRequire } from 'node:module';

import { Language, Parser, type Node } from 'web-tree-sitter';

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import { Utf8SourceMap } from './source-map';
import type { CallSite, LanguageAnalysisInput, ModuleBinding } from './types';

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
    },
    java: {
        class_declaration: 'class',
        interface_declaration: 'interface',
        enum_declaration: 'enum',
        method_declaration: 'method',
        constructor_declaration: 'constructor',
    },
    csharp: {
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
        function_definition: 'function',
    },
    scala: {
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
    if (node.type === 'function_definition') {
        const declarator = node.childForFieldName('declarator');
        const identifier = declarator?.descendantsOfType(['identifier', 'field_identifier'])[0];
        if (identifier?.text.trim()) return identifier.text.trim();
    }
    return undefined;
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
        if (language === 'python' && node.type === 'function_definition' && semanticContainer === 'class') {
            kind = 'method';
        }
        if (language === 'scala' && node.type === 'function_definition' && semanticContainer === 'class') {
            kind = 'method';
        }
        if (language === 'rust' && node.type === 'function_item' && insideRustImpl) {
            kind = 'method';
        }
        const cppQualified = language === 'cpp' ? cppQualifiedCallable(node) : undefined;
        if (language === 'cpp' && node.type === 'function_definition' && (parents.length > 0 || cppQualified)) {
            kind = 'method';
        }
        const name = kind ? cppQualified?.name ?? nameForNode(node) : undefined;
        const implOwner = language === 'rust' ? rustImplOwner(node) : undefined;
        const receiverOwner = language === 'go' ? goReceiverOwner(node) : undefined;
        const symbolParents = cppQualified?.parents ?? (receiverOwner ? [...parents, receiverOwner] : parents);
        const nextParents = implOwner
            ? [...parents, implOwner]
            : name && (
                kind === 'class'
                || kind === 'interface'
                || kind === 'trait'
                || kind === 'struct'
                || kind === 'enum'
                || kind === 'module'
            )
                ? [...parents, name]
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
                    language === 'python'
                    && parentNode?.type === 'decorated_definition'
                        ? parentNode
                        : node,
                    sourceMap,
                ),
            });
        }
        for (const child of node.namedChildren) {
            visit(
                child,
                nextParents,
                insideRustImpl || (language === 'rust' && node.type === 'impl_item'),
                node,
                nextSemanticContainer,
            );
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

function extractCallSites(root: Node, sourceMap: Utf8SourceMap): CallSite[] {
    const calls: CallSite[] = [];
    const visit = (node: Node): void => {
        if (CALL_NODE_TYPES.has(node.type)) {
            const name = callableName(node);
            if (name) calls.push({
                calleeName: name,
                ...callSiteEvidence(node),
                span: nodeSpan(node, sourceMap),
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
        .filter((symbol) => symbol.parentQualifiedNamePath?.length === 0)
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
        for (const moduleName of node.descendantsOfType('dotted_name')) {
            const moduleSpecifier = moduleName.text.trim();
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

export async function analyzeWithTreeSitter(
    input: LanguageAnalysisInput,
    assetRoot?: string,
): Promise<{
    complete: true;
    symbols: readonly ExtractedSymbol[];
    moduleBindings: readonly ModuleBinding[];
    callSites: readonly CallSite[];
} | {
    complete: false;
    reason: 'syntax_error' | 'parser_unavailable' | 'analysis_failure';
    symbols: readonly [];
    moduleBindings: readonly [];
    callSites: readonly [];
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
                callSites: extractCallSites(tree.rootNode, sourceMap),
            };
        } catch {
            return {
                complete: false,
                reason: 'analysis_failure',
                symbols: [],
                moduleBindings: [],
                callSites: [],
            };
        }
    } finally {
        tree.delete();
        parser.delete();
    }
}
