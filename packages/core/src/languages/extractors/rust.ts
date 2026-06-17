import type { ExtractedSymbol, ExtractedSymbolKind, SymbolExtractor } from '../types';
import {
    childForFieldName,
    extractTypeName,
    hasSyntaxError,
    nodeChildren,
    nodeName,
    parseTree,
    symbolFromNode,
} from './tree-sitter-symbols';

const Rust = require('tree-sitter-rust');

type CallableContext = 'function' | 'method';

function childDeclarationList(node: Parameters<typeof nodeName>[1]) {
    return nodeChildren(node).find((child) => child.type === 'declaration_list') || null;
}

function pushNamedSymbol(input: {
    symbols: ExtractedSymbol[];
    content: string;
    node: Parameters<typeof nodeName>[1];
    kind: ExtractedSymbolKind;
    labelPrefix: string;
    parentQualifiedNamePath?: readonly string[];
}): string | null {
    const name = nodeName(input.content, input.node);
    if (!name) {
        return null;
    }
    input.symbols.push(symbolFromNode({
        content: input.content,
        node: input.node,
        kind: input.kind,
        name,
        label: `${input.labelPrefix} ${name}`,
        ...(input.parentQualifiedNamePath ? { parentQualifiedNamePath: input.parentQualifiedNamePath } : {}),
    }));
    return name;
}

export const rustSymbolExtractor: SymbolExtractor = {
    languageId: 'rust',
    extractorVersion: 'rust-symbol-extractor-v1',
    extract(input): readonly ExtractedSymbol[] {
        const tree = parseTree(input.content, Rust);
        if (!tree || hasSyntaxError(tree.rootNode)) {
            return [];
        }

        const symbols: ExtractedSymbol[] = [];
        const walk = (
            node: Parameters<typeof nodeName>[1],
            parentQualifiedNamePath: readonly string[] = [],
            callableContext: CallableContext = 'function',
        ): void => {
            if (node.type === 'struct_item') {
                pushNamedSymbol({
                    symbols,
                    content: input.content,
                    node,
                    kind: 'type',
                    labelPrefix: 'type',
                    parentQualifiedNamePath,
                });
                return;
            }

            if (node.type === 'enum_item') {
                pushNamedSymbol({
                    symbols,
                    content: input.content,
                    node,
                    kind: 'enum',
                    labelPrefix: 'enum',
                    parentQualifiedNamePath,
                });
                return;
            }

            if (node.type === 'trait_item') {
                const name = pushNamedSymbol({
                    symbols,
                    content: input.content,
                    node,
                    kind: 'trait',
                    labelPrefix: 'trait',
                    parentQualifiedNamePath,
                });
                const declarationList = childDeclarationList(node);
                if (name && declarationList) {
                    for (const child of nodeChildren(declarationList)) {
                        walk(child, [...parentQualifiedNamePath, `trait ${name}`], 'method');
                    }
                }
                return;
            }

            if (node.type === 'mod_item') {
                const name = pushNamedSymbol({
                    symbols,
                    content: input.content,
                    node,
                    kind: 'module',
                    labelPrefix: 'module',
                    parentQualifiedNamePath,
                });
                const declarationList = childDeclarationList(node);
                if (name && declarationList) {
                    for (const child of nodeChildren(declarationList)) {
                        walk(child, [...parentQualifiedNamePath, `module ${name}`], 'function');
                    }
                }
                return;
            }

            if (node.type === 'impl_item') {
                const receiver = extractTypeName(input.content, childForFieldName(node, 'type'));
                const declarationList = childDeclarationList(node);
                if (receiver && declarationList) {
                    for (const child of nodeChildren(declarationList)) {
                        walk(child, [...parentQualifiedNamePath, `type ${receiver}`], 'method');
                    }
                }
                return;
            }

            if (node.type === 'function_item' || node.type === 'function_signature_item') {
                pushNamedSymbol({
                    symbols,
                    content: input.content,
                    node,
                    kind: callableContext === 'method' ? 'method' : 'function',
                    labelPrefix: callableContext === 'method' ? 'method' : 'function',
                    parentQualifiedNamePath,
                });
                return;
            }

            for (const child of nodeChildren(node)) {
                walk(child, parentQualifiedNamePath, callableContext);
            }
        };

        for (const child of nodeChildren(tree.rootNode)) {
            walk(child);
        }
        return symbols;
    },
};
