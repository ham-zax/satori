import ts from 'typescript';

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import { Utf8SourceMap } from './source-map';

/**
 * Oxc rejects Flow-annotated JavaScript outright and recovers no AST. This
 * extracts the declarations the TypeScript parser can still recover from such
 * a file (it tolerates syntax errors and shares most annotation syntax with
 * Flow). Only symbols come back: relationship evidence from a partial parse
 * would be unproven, so callers report the result as recovered, not complete.
 */
export function recoverFlowSymbols(source: string, relativePath: string): ExtractedSymbol[] {
    const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false,
        ts.ScriptKind.TSX,
    );
    const sourceMap = new Utf8SourceMap(source);
    const symbols: ExtractedSymbol[] = [];

    const isFunctionValue = (node: ts.Node | undefined): boolean => (
        node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    );
    const memberName = (name: ts.PropertyName | undefined): string | undefined => (
        name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))
            ? name.text
            : undefined
    );

    const visit = (node: ts.Node, parent: ts.Node | undefined, parents: readonly string[], insideCallable: boolean): void => {
        let kind: ExtractedSymbolKind | undefined;
        let name: string | undefined;
        if (ts.isFunctionDeclaration(node)) {
            kind = 'function';
            name = node.name?.text;
        } else if (ts.isClassDeclaration(node)) {
            kind = 'class';
            name = node.name?.text;
        } else if (ts.isInterfaceDeclaration(node)) {
            kind = 'interface';
            name = node.name.text;
        } else if (ts.isTypeAliasDeclaration(node)) {
            kind = 'type';
            name = node.name.text;
        } else if (ts.isConstructorDeclaration(node)) {
            kind = 'constructor';
            name = 'constructor';
        } else if (ts.isMethodDeclaration(node)) {
            kind = 'method';
            name = memberName(node.name);
        } else if (ts.isPropertyDeclaration(node)) {
            kind = isFunctionValue(node.initializer) ? 'method' : 'variable';
            name = memberName(node.name);
        } else if (
            ts.isVariableDeclaration(node)
            && ts.isIdentifier(node.name)
            && parent !== undefined
            && ts.isVariableDeclarationList(parent)
            && (!insideCallable || isFunctionValue(node.initializer))
        ) {
            kind = isFunctionValue(node.initializer) ? 'function' : 'variable';
            name = node.name.text;
        }

        if (kind && name) {
            symbols.push({
                kind,
                name,
                label: `${kind} ${name}`,
                qualifiedName: [...parents, name].join('.'),
                parentQualifiedNamePath: parents,
                span: sourceMap.spanFromUtf16(node.getStart(sourceFile), node.end),
            });
        }

        const nextParents = name && (kind === 'class' || kind === 'interface') ? [...parents, name] : parents;
        const nextInsideCallable = insideCallable
            || ts.isFunctionDeclaration(node)
            || ts.isFunctionExpression(node)
            || ts.isArrowFunction(node)
            || ts.isMethodDeclaration(node)
            || ts.isConstructorDeclaration(node);
        ts.forEachChild(node, (child) => visit(child, node, nextParents, nextInsideCallable));
    };
    visit(sourceFile, undefined, [], false);
    return symbols;
}
