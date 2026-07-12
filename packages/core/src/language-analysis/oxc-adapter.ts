import { parseSync, type Program } from 'oxc-parser';

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import { Utf8SourceMap } from './source-map';
import type { CallSite, LanguageAnalysisInput, ModuleBinding } from './types';

type AstNode = {
    type: string;
    start: number;
    end: number;
    [key: string]: unknown;
};

export type OxcEvidence = {
    readonly complete: true;
    readonly symbols: readonly ExtractedSymbol[];
    readonly moduleBindings: readonly ModuleBinding[];
    readonly callSites: readonly CallSite[];
} | {
    readonly complete: false;
    readonly reason: 'syntax_error';
    readonly symbols: readonly [];
    readonly moduleBindings: readonly [];
    readonly callSites: readonly [];
};

function isAstNode(value: unknown): value is AstNode {
    return Boolean(
        value
        && typeof value === 'object'
        && typeof (value as Partial<AstNode>).type === 'string'
        && typeof (value as Partial<AstNode>).start === 'number'
        && typeof (value as Partial<AstNode>).end === 'number',
    );
}

function nodeName(node: AstNode): string | undefined {
    const id = node.id;
    if (isAstNode(id) && id.type === 'Identifier' && typeof id.name === 'string') {
        return id.name;
    }
    return undefined;
}

function isFunctionValue(value: unknown): boolean {
    return isAstNode(value) && (
        value.type === 'ArrowFunctionExpression'
        || value.type === 'FunctionExpression'
    );
}

function symbolKind(
    node: AstNode,
    parent: AstNode | undefined,
    insideCallable: boolean,
): ExtractedSymbolKind | undefined {
    switch (node.type) {
        case 'FunctionDeclaration': return 'function';
        case 'ClassDeclaration': return 'class';
        case 'TSInterfaceDeclaration': return 'interface';
        case 'TSTypeAliasDeclaration': return 'type';
        case 'TSEnumDeclaration': return 'enum';
        case 'MethodDefinition': return node.kind === 'constructor' ? 'constructor' : 'method';
        case 'PropertyDefinition': return isFunctionValue(node.value) ? 'method' : 'variable';
        case 'VariableDeclarator':
            if (parent?.type !== 'VariableDeclaration' || insideCallable) return undefined;
            return isFunctionValue(node.init) ? 'function' : 'variable';
        default: return undefined;
    }
}

function symbolName(node: AstNode): string | undefined {
    if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
        const key = node.key;
        if (isAstNode(key) && typeof key.name === 'string') return key.name;
        if (isAstNode(key) && typeof key.value === 'string') return key.value;
    }
    return nodeName(node);
}

function labelFor(kind: ExtractedSymbolKind, name: string): string {
    return `${kind} ${name}`;
}

function calleeName(node: AstNode): string | undefined {
    const callee = node.callee;
    if (!isAstNode(callee)) return undefined;
    if (callee.type === 'Identifier' && typeof callee.name === 'string') return callee.name;
    if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        const property = callee.property;
        if (isAstNode(property) && typeof property.name === 'string') return property.name;
        if (isAstNode(property) && typeof property.value === 'string') return property.value;
    }
    return undefined;
}

function callSiteEvidence(node: AstNode): Pick<CallSite, 'kind' | 'receiverText' | 'qualifiedCallee'> {
    if (node.type === 'NewExpression') {
        return { kind: 'constructor' };
    }
    const callee = node.callee;
    if (!isAstNode(callee) || (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')) {
        return { kind: 'direct' };
    }
    const receiver = callee.object;
    const receiverText = isAstNode(receiver) && typeof receiver.name === 'string'
        ? receiver.name
        : undefined;
    return {
        kind: 'member',
        ...(receiverText ? { receiverText } : {}),
    };
}

function childNodes(node: AstNode): AstNode[] {
    const children: AstNode[] = [];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'parent') continue;
        if (isAstNode(value)) {
            children.push(value);
        } else if (Array.isArray(value)) {
            for (const entry of value) {
                if (isAstNode(entry)) children.push(entry);
            }
        }
    }
    return children;
}

function oxcLanguage(language: string, relativePath: string): 'js' | 'jsx' | 'ts' | 'tsx' | 'dts' {
    if (relativePath.endsWith('.d.ts')) return 'dts';
    if (language === 'tsx' || relativePath.endsWith('.tsx')) return 'tsx';
    if (language === 'jsx' || relativePath.endsWith('.jsx')) return 'jsx';
    if (language === 'typescript' || language === 'ts') return 'ts';
    return 'js';
}

export function analyzeWithOxc(input: LanguageAnalysisInput): OxcEvidence {
    const parsed = parseSync(input.relativePath, input.content, {
        lang: oxcLanguage(input.language, input.relativePath),
        sourceType: 'unambiguous',
    });
    if (parsed.errors.some((error) => error.severity === 'Error')) {
        return { complete: false, reason: 'syntax_error', symbols: [], moduleBindings: [], callSites: [] };
    }

    const sourceMap = new Utf8SourceMap(input.content);
    const symbols: ExtractedSymbol[] = [];
    const callSites: CallSite[] = [];
    const visit = (
        node: AstNode,
        parent?: AstNode,
        parents: readonly string[] = [],
        insideCallable = false,
    ): void => {
        const kind = symbolKind(node, parent, insideCallable);
        const name = kind ? symbolName(node) : undefined;
        const nextParents = name && (kind === 'class' || kind === 'interface')
            ? [...parents, name]
            : parents;
        if (kind && name) {
            const span = sourceMap.spanFromUtf16(node.start, node.end);
            symbols.push({
                kind,
                name,
                label: labelFor(kind, name),
                qualifiedName: [...parents, name].join('.'),
                parentQualifiedNamePath: parents,
                span,
            });
        }
        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
            const name = calleeName(node);
            if (name) {
                callSites.push({
                    calleeName: name,
                    ...callSiteEvidence(node),
                    span: sourceMap.spanFromUtf16(node.start, node.end),
                });
            }
        }
        const childInsideCallable = insideCallable || (
            node.type === 'FunctionDeclaration'
            || node.type === 'FunctionExpression'
            || node.type === 'ArrowFunctionExpression'
            || node.type === 'MethodDefinition'
            || (node.type === 'PropertyDefinition' && isFunctionValue(node.value))
        );
        for (const child of childNodes(node)) visit(child, node, nextParents, childInsideCallable);
    };
    visit(parsed.program as Program & AstNode);

    const moduleBindings: ModuleBinding[] = [];
    for (const item of parsed.module.staticImports) {
        const span = sourceMap.spanFromUtf16(item.start, item.end);
        if (item.entries.length === 0) {
            moduleBindings.push({ kind: 'import', moduleSpecifier: item.moduleRequest.value, typeOnly: false, span });
        }
        for (const entry of item.entries) {
            moduleBindings.push({
                kind: 'import',
                moduleSpecifier: item.moduleRequest.value,
                importedName: entry.importName.name ?? undefined,
                localName: entry.localName.value,
                typeOnly: entry.isType,
                span,
            });
        }
    }
    for (const item of parsed.module.staticExports) {
        const span = sourceMap.spanFromUtf16(item.start, item.end);
        for (const entry of item.entries) {
            moduleBindings.push({
                kind: entry.moduleRequest ? 'reexport' : 'export',
                moduleSpecifier: entry.moduleRequest?.value,
                importedName: entry.importName.name ?? undefined,
                exportedName: entry.exportName.name ?? undefined,
                localName: entry.localName.name ?? undefined,
                typeOnly: entry.isType,
                span,
            });
        }
    }

    return { complete: true, symbols, moduleBindings, callSites };
}
