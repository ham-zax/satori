import Parser from 'tree-sitter';
import type { ExtractedSymbol, ExtractedSymbolKind } from '../types';

type SyntaxNode = Parser.SyntaxNode;

export type TreeSitterLanguage = unknown;

export function parseTree(content: string, language: TreeSitterLanguage): Parser.Tree | null {
    try {
        const parser = new Parser();
        parser.setLanguage(language);
        return parser.parse(content);
    } catch {
        return null;
    }
}

export function nodeChildren(node: SyntaxNode): SyntaxNode[] {
    return (node.namedChildren && node.namedChildren.length > 0 ? node.namedChildren : node.children) as SyntaxNode[];
}

export function hasSyntaxError(node: SyntaxNode): boolean {
    if (node.type === 'ERROR' || node.type === 'MISSING' || (node as unknown as { isMissing?: boolean }).isMissing === true) {
        return true;
    }
    return nodeChildren(node).some((child) => hasSyntaxError(child));
}

export function childForFieldName(node: SyntaxNode, fieldName: string): SyntaxNode | null {
    return node.childForFieldName(fieldName) as SyntaxNode | null;
}

export function nodeText(content: string, node: SyntaxNode): string {
    return content.slice(node.startIndex, node.endIndex);
}

export function nodeName(content: string, node: SyntaxNode): string | null {
    const name = childForFieldName(node, 'name');
    if (!name) {
        return null;
    }
    return nodeText(content, name).trim() || null;
}

export function findFirstDescendantByType(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
    if (types.has(node.type)) {
        return node;
    }
    for (const child of nodeChildren(node)) {
        const found = findFirstDescendantByType(child, types);
        if (found) {
            return found;
        }
    }
    return null;
}

export function extractTypeName(content: string, node: SyntaxNode | null): string | null {
    if (!node) {
        return null;
    }
    const directName = childForFieldName(node, 'name');
    if (directName) {
        return nodeText(content, directName).trim() || null;
    }
    const directType = childForFieldName(node, 'type');
    if (directType && directType !== node) {
        const resolvedType = extractTypeName(content, directType);
        if (resolvedType) {
            return resolvedType;
        }
    }
    const identifier = findFirstDescendantByType(node, new Set([
        'type_identifier',
        'identifier',
        'field_identifier',
        'package_identifier',
        'scoped_type_identifier',
    ]));
    return identifier ? nodeText(content, identifier).trim() || null : null;
}

function labelName(label: string): string {
    return label.replace(/^(class|enum|function|interface|method|module|trait|type)\s+/, '').trim();
}

function qualifiedNameFor(name: string, parentQualifiedNamePath: readonly string[] = []): string {
    return [...parentQualifiedNamePath.map(labelName), name]
        .filter((segment) => segment.length > 0)
        .join('.');
}

export function symbolFromNode(input: {
    content: string;
    node: SyntaxNode;
    kind: ExtractedSymbolKind;
    name: string;
    label: string;
    parentQualifiedNamePath?: readonly string[];
}): ExtractedSymbol {
    return {
        kind: input.kind,
        name: input.name,
        label: input.label,
        qualifiedName: qualifiedNameFor(input.name, input.parentQualifiedNamePath),
        ...(input.parentQualifiedNamePath ? { parentQualifiedNamePath: input.parentQualifiedNamePath } : {}),
        span: {
            startLine: input.node.startPosition.row + 1,
            endLine: input.node.endPosition.row + 1,
            startByte: input.node.startIndex,
            endByte: input.node.endIndex,
            startColumn: input.node.startPosition.column,
            endColumn: input.node.endPosition.column,
        },
    };
}
