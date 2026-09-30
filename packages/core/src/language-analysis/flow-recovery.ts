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

    const expressionName = (node: ts.Expression): string | undefined => {
        if (ts.isIdentifier(node)) return node.text;
        if (ts.isPropertyAccessExpression(node)) {
            const owner = expressionName(node.expression);
            return owner ? `${owner}.${node.name.text}` : undefined;
        }
        if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
            const owner = expressionName(node.expression);
            return owner ? `${owner}.${node.argumentExpression.text}` : undefined;
        }
        return undefined;
    };
    const callbackName = (node: ts.Node, parent: ts.Node | undefined): string | undefined => {
        if (!isFunctionValue(node) || !parent || !ts.isCallExpression(parent)) return undefined;
        const index = parent.arguments.indexOf(node as ts.Expression);
        const callee = expressionName(parent.expression);
        if (index < 0 || !callee) return undefined;
        const discriminator = parent.arguments.find(ts.isStringLiteral);
        const args = discriminator ? JSON.stringify(discriminator.text) : '';
        const suffix = parent.arguments.filter(isFunctionValue).length > 1 ? ` ${index + 1}` : '';
        return `${callee}(${args}) callback${suffix}`;
    };

    const visit = (node: ts.Node, parent: ts.Node | undefined, parents: readonly string[], insideCallable: boolean, insideRegistrationCallback: boolean): void => {
        let kind: ExtractedSymbolKind | undefined;
        let name: string | undefined;
        const callback = !insideCallable || insideRegistrationCallback ? callbackName(node, parent) : undefined;
        if (callback) {
            kind = 'function';
            name = callback;
        } else if (ts.isFunctionDeclaration(node)) {
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
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isFunctionValue(node.right)) {
            kind = 'function';
            name = expressionName(node.left);
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

        const nextParents = name && (callback || kind === 'class' || kind === 'interface') ? [...parents, name] : parents;
        const nextInsideCallable = insideCallable
            || ts.isFunctionDeclaration(node)
            || ts.isFunctionExpression(node)
            || ts.isArrowFunction(node)
            || ts.isMethodDeclaration(node)
            || ts.isConstructorDeclaration(node);
        const nextRegistrationCallback = isFunctionValue(node) || ts.isFunctionDeclaration(node)
            || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
            ? Boolean(callback)
            : insideRegistrationCallback;
        ts.forEachChild(node, (child) => visit(child, node, nextParents, nextInsideCallable, nextRegistrationCallback));
    };
    visit(sourceFile, undefined, [], false, false);
    return symbols;
}
