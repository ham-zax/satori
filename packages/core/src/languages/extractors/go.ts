import type { ExtractedSymbol, SymbolExtractor } from '../types';
import {
    childForFieldName,
    extractTypeName,
    hasSyntaxError,
    nodeChildren,
    nodeName,
    parseTree,
    symbolFromNode,
} from './tree-sitter-symbols';

const Go = require('tree-sitter-go');

function receiverTypeName(content: string, methodNode: Parameters<typeof nodeName>[1]): string | null {
    const receiver = nodeChildren(methodNode).find((child) => child.type === 'parameter_list');
    const declaration = receiver ? nodeChildren(receiver).find((child) => child.type === 'parameter_declaration') : null;
    const typeNode = declaration ? childForFieldName(declaration, 'type') : null;
    return extractTypeName(content, typeNode);
}

export const goSymbolExtractor: SymbolExtractor = {
    languageId: 'go',
    extractorVersion: 'go-symbol-extractor-v1',
    extract(input): readonly ExtractedSymbol[] {
        const tree = parseTree(input.content, Go);
        if (!tree || hasSyntaxError(tree.rootNode)) {
            return [];
        }

        const symbols: ExtractedSymbol[] = [];
        for (const node of nodeChildren(tree.rootNode)) {
            if (node.type === 'type_declaration') {
                for (const spec of nodeChildren(node).filter((child) => child.type === 'type_spec')) {
                    const name = nodeName(input.content, spec);
                    if (!name) {
                        continue;
                    }
                    const typeNode = childForFieldName(spec, 'type');
                    const kind = typeNode?.type === 'interface_type' ? 'interface' : 'type';
                    symbols.push(symbolFromNode({
                        content: input.content,
                        node: spec,
                        kind,
                        name,
                        label: `${kind} ${name}`,
                    }));
                }
                continue;
            }

            if (node.type === 'function_declaration') {
                const name = nodeName(input.content, node);
                if (!name) {
                    continue;
                }
                symbols.push(symbolFromNode({
                    content: input.content,
                    node,
                    kind: 'function',
                    name,
                    label: `function ${name}`,
                }));
                continue;
            }

            if (node.type === 'method_declaration') {
                const name = nodeName(input.content, node);
                if (!name) {
                    continue;
                }
                const receiver = receiverTypeName(input.content, node);
                const parentQualifiedNamePath = receiver ? [`type ${receiver}`] : undefined;
                symbols.push(symbolFromNode({
                    content: input.content,
                    node,
                    kind: 'method',
                    name,
                    label: `method ${name}`,
                    ...(parentQualifiedNamePath ? { parentQualifiedNamePath } : {}),
                }));
            }
        }

        return symbols;
    },
};
