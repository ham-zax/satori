import path from 'node:path';
import { createRequire } from 'node:module';

import { Language, Parser, type Node } from 'web-tree-sitter';

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
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
    parserInitialization ??= Parser.init();
    await parserInitialization;
    const cacheKey = `${assetRoot ?? '<default>'}:${language}`;
    let loaded = languages.get(cacheKey);
    if (!loaded) {
        loaded = Language.load(languageAssetPath(language, assetRoot));
        languages.set(cacheKey, loaded);
    }
    return loaded;
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

function extractSymbols(root: Node, language: string): ExtractedSymbol[] {
    const declarations = SYMBOL_NODES[language] ?? {};
    const symbols: ExtractedSymbol[] = [];
    const visit = (
        node: Node,
        parents: readonly string[],
        insideRustImpl = false,
        parentNode?: Node,
    ): void => {
        let kind: ExtractedSymbolKind | undefined = declarations[node.type];
        if (language === 'go') kind = goSymbolKind(node, kind);
        if (language === 'python' && node.type === 'function_definition' && parents.length > 0) {
            kind = 'method';
        }
        if (language === 'rust' && node.type === 'function_item' && insideRustImpl) {
            kind = 'method';
        }
        if (language === 'cpp' && node.type === 'function_definition' && parents.length > 0) {
            kind = 'method';
        }
        const name = kind ? nameForNode(node) : undefined;
        const implOwner = language === 'rust' ? rustImplOwner(node) : undefined;
        const receiverOwner = language === 'go' ? goReceiverOwner(node) : undefined;
        const symbolParents = receiverOwner ? [...parents, receiverOwner] : parents;
        const nextParents = implOwner
            ? [...parents, implOwner]
            : name && (
                kind === 'class'
                || kind === 'interface'
                || kind === 'trait'
                || kind === 'struct'
                || kind === 'module'
            )
                ? [...parents, name]
                : parents;
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
                ),
            });
        }
        for (const child of node.namedChildren) {
            visit(
                child,
                nextParents,
                insideRustImpl || (language === 'rust' && node.type === 'impl_item'),
                node,
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
]);

function callableName(node: Node): string | undefined {
    const callable = node.childForFieldName('function') ?? node.childForFieldName('name');
    if (!callable) return undefined;
    const leaf = callable.descendantsOfType([
        'identifier',
        'field_identifier',
        'property_identifier',
        'type_identifier',
    ]).at(-1) ?? callable;
    return leaf.text.trim() || undefined;
}

function nodeSpan(node: Node) {
    return {
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startByte: node.startIndex,
        endByte: node.endIndex,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
    };
}

function extractCallSites(root: Node): CallSite[] {
    const calls: CallSite[] = [];
    const visit = (node: Node): void => {
        if (CALL_NODE_TYPES.has(node.type)) {
            const name = callableName(node);
            if (name) calls.push({ calleeName: name, span: nodeSpan(node) });
        }
        for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return calls;
}

function extractPythonModuleBindings(root: Node, symbols: readonly ExtractedSymbol[]): ModuleBinding[] {
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
            bindings.push({
                kind: 'import',
                moduleSpecifier: moduleName,
                typeOnly: false,
                span: nodeSpan(node),
            });
        }
    }
    return bindings;
}

export async function analyzeWithTreeSitter(
    input: LanguageAnalysisInput,
    assetRoot?: string,
): Promise<{
    complete: boolean;
    symbols: readonly ExtractedSymbol[];
    moduleBindings: readonly ModuleBinding[];
    callSites: readonly CallSite[];
}> {
    const language = await loadLanguage(input.language, assetRoot);
    const parser = new Parser();
    try {
        parser.setLanguage(language);
        const tree = parser.parse(input.content);
        if (!tree) return { complete: false, symbols: [], moduleBindings: [], callSites: [] };
        try {
            if (tree.rootNode.hasError) {
                return { complete: false, symbols: [], moduleBindings: [], callSites: [] };
            }
            const symbols = extractSymbols(tree.rootNode, input.language);
            return {
                complete: true,
                symbols,
                moduleBindings: input.language === 'python'
                    ? extractPythonModuleBindings(tree.rootNode, symbols)
                    : [],
                callSites: extractCallSites(tree.rootNode),
            };
        } finally {
            tree.delete();
        }
    } finally {
        parser.delete();
    }
}
