import type { Program } from 'oxc-parser' with { "resolution-mode": "require" };

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import { Utf8SourceMap } from './source-map';
import type { CallSite, LanguageAnalysisInput, ModuleBinding, ReceiverTypeBinding, SourceSpan } from './types';

const { parseSync } = require('oxc-parser') as typeof import('oxc-parser', { with: { "resolution-mode": "require" } });


type AstNode = {
    type: string;
    start: number;
    end: number;
    [key: string]: unknown;
};

export type OxcEvidence = {
    readonly complete: true;
    readonly symbols: readonly ExtractedSymbol[];
    readonly earlyExitSpans?: readonly SourceSpan[];
    readonly moduleBindings: readonly ModuleBinding[];
    readonly callSites: readonly CallSite[];
    readonly receiverTypeBindings: readonly ReceiverTypeBinding[];
    readonly pythonFlowFacts: readonly [];
} | {
    readonly complete: false;
    readonly reason: 'syntax_error';
    /**
     * JavaScript that Oxc rejected. Flow annotations only get Oxc's "Flow is not
     * supported" error under an @flow pragma; without one they surface as generic
     * syntax errors, so every JavaScript rejection may still hold typed declarations.
     */
    readonly typedJavaScriptRecoverable?: true;
    readonly symbols: readonly [];
    readonly earlyExitSpans?: never;
    readonly moduleBindings: readonly [];
    readonly callSites: readonly [];
    readonly receiverTypeBindings: readonly [];
    readonly pythonFlowFacts: readonly [];
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

function expressionName(value: unknown): string | undefined {
    if (!isAstNode(value)) return undefined;
    if (value.type === 'Identifier' && typeof value.name === 'string') return value.name;
    if (value.type !== 'MemberExpression') return undefined;
    const owner = expressionName(value.object);
    const property = value.property;
    if (!owner || !isAstNode(property)) return undefined;
    if (!value.computed && property.type === 'Identifier' && typeof property.name === 'string') {
        return `${owner}.${property.name}`;
    }
    if (value.computed && property.type === 'Literal' && typeof property.value === 'string') {
        return `${owner}.${property.value}`;
    }
    return undefined;
}

function callbackName(node: AstNode, parent: AstNode | undefined): string | undefined {
    if (!isFunctionValue(node) || parent?.type !== 'CallExpression' || !Array.isArray(parent.arguments)) return undefined;
    const index = parent.arguments.indexOf(node);
    const callee = expressionName(parent.callee);
    if (index < 0 || !callee) return undefined;
    const discriminator = parent.arguments.find((argument) => (
        isAstNode(argument) && argument.type === 'Literal' && typeof argument.value === 'string'
    )) as AstNode | undefined;
    const args = discriminator ? JSON.stringify(discriminator.value) : '';
    const suffix = parent.arguments.filter(isFunctionValue).length > 1 ? ` ${index + 1}` : '';
    return `${callee}(${args}) callback${suffix}`;
}

function symbolKind(
    node: AstNode,
    parent: AstNode | undefined,
    insideCallable: boolean,
): ExtractedSymbolKind | undefined {
    switch (node.type) {
        case 'FunctionDeclaration': return 'function';
        case 'TSDeclareFunction': return 'function';
        case 'ClassDeclaration': return 'class';
        case 'TSInterfaceDeclaration': return 'interface';
        case 'TSTypeAliasDeclaration': return 'type';
        case 'TSEnumDeclaration': return 'enum';
        case 'TSModuleDeclaration':
            return nodeName(node) ? 'namespace' : undefined;
        case 'MethodDefinition': return node.kind === 'constructor' ? 'constructor' : 'method';
        case 'TSMethodSignature':
        case 'TSAbstractMethodDefinition':
            return 'method';
        case 'PropertyDefinition': return isFunctionValue(node.value) ? 'method' : 'variable';
        case 'VariableDeclarator':
            if (parent?.type !== 'VariableDeclaration' || (insideCallable && !isFunctionValue(node.init))) return undefined;
            return isFunctionValue(node.init) ? 'function' : 'variable';
        case 'AssignmentExpression':
            return node.operator === '=' && isFunctionValue(node.right) ? 'function' : undefined;
        default: return undefined;
    }
}

function symbolName(node: AstNode): string | undefined {
    if (node.type === 'AssignmentExpression') return expressionName(node.left);
    if (
        node.type === 'Property'
        || node.type === 'MethodDefinition'
        || node.type === 'PropertyDefinition'
        || node.type === 'TSMethodSignature'
        || node.type === 'TSAbstractMethodDefinition'
    ) {
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

function callSiteEvidence(node: AstNode, source: string): Pick<CallSite, 'kind' | 'receiverText' | 'qualifiedCallee'> {
    if (node.type === 'NewExpression') {
        return { kind: 'constructor' };
    }
    const callee = node.callee;
    if (!isAstNode(callee) || (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')) {
        return { kind: 'direct' };
    }
    const receiver = callee.object;
    const receiverText = isAstNode(receiver) && Number.isInteger(receiver.start) && Number.isInteger(receiver.end)
        ? source.slice(receiver.start, receiver.end).trim()
        : undefined;
    const qualifiedCallee = Number.isInteger(callee.start) && Number.isInteger(callee.end)
        ? source.slice(callee.start, callee.end).trim()
        : undefined;
    return {
        kind: 'member',
        ...(receiverText ? { receiverText } : {}),
        ...(qualifiedCallee ? { qualifiedCallee } : {}),
    };
}

function simpleTypeReferenceName(value: unknown): string | undefined {
    if (!isAstNode(value)) return undefined;
    if (value.type === 'TSTypeAnnotation' || value.type === 'TSParenthesizedType') {
        return simpleTypeReferenceName(value.typeAnnotation);
    }
    if (value.type === 'TSUnionType') {
        const members = Array.isArray(value.types)
            ? value.types.filter(isAstNode)
            : [];
        const meaningful = members.filter((member) => (
            member.type !== 'TSUndefinedKeyword'
            && member.type !== 'TSNullKeyword'
        ));
        return meaningful.length === 1
            ? simpleTypeReferenceName(meaningful[0])
            : undefined;
    }
    if (value.type !== 'TSTypeReference') return undefined;
    const typeName = value.typeName;
    return isAstNode(typeName)
        && typeName.type === 'Identifier'
        && typeof typeName.name === 'string'
        ? typeName.name
        : undefined;
}

function variableAnnotationBinding(
    node: AstNode,
    sourceMap: Utf8SourceMap,
): ReceiverTypeBinding | undefined {
    if (node.type !== 'VariableDeclarator') return undefined;
    const id = node.id;
    if (!isAstNode(id) || id.type !== 'Identifier' || typeof id.name !== 'string') return undefined;
    const typeName = simpleTypeReferenceName(id.typeAnnotation);
    if (!typeName) return undefined;
    return {
        localName: id.name,
        typeName,
        kind: 'local_annotation',
        span: sourceMap.spanFromUtf16(node.start, node.end),
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
    // JSX is valid in JavaScript repositories that do not use the .jsx suffix.
    return 'jsx';
}

function earlyExitContextStart(node: AstNode, parent?: AstNode): number | undefined {
    if (node.type !== 'IfStatement' || node.alternate || !isAstNode(node.consequent)) return undefined;
    const consequent = node.consequent;
    const terminal = consequent.type === 'BlockStatement' && Array.isArray(consequent.body)
        ? consequent.body.at(-1) : consequent;
    if (!isAstNode(terminal) || !['ReturnStatement', 'ThrowStatement'].includes(terminal.type)) return undefined;
    if (!isAstNode(node.test) || node.test.type !== 'Identifier') return node.start;
    const statements = parent?.type === 'SwitchCase' ? parent.consequent : parent?.body;
    if (!Array.isArray(statements)) return node.start;
    const preceding = statements[statements.indexOf(node) - 1];
    if (!isAstNode(preceding) || preceding.type !== 'VariableDeclaration'
        || preceding.kind !== 'const' || !Array.isArray(preceding.declarations) || preceding.declarations.length !== 1) return node.start;
    const declaration = preceding.declarations[0];
    // Adjacency and a direct identifier test establish the source context.
    // Never infer dependencies by recursively collecting names from expressions.
    return isAstNode(declaration) && isAstNode(declaration.id)
        && declaration.id.type === 'Identifier' && declaration.id.name === node.test.name
        ? preceding.start : node.start;
}

export function analyzeWithOxc(input: LanguageAnalysisInput): OxcEvidence {
    const lang = oxcLanguage(input.language, input.relativePath);
    const parseStartedAt = input.perfTiming ? performance.now() : 0;
    let parsed: ReturnType<typeof parseSync>;
    try {
        parsed = parseSync(input.relativePath, input.content, {
            lang,
            sourceType: 'unambiguous',
        });
    } finally {
        if (input.perfTiming) {
            input.perfTiming.parseMs += performance.now() - parseStartedAt;
            input.perfTiming.parseCount++;
        }
    }
    if (parsed.errors.some((error) => error.severity === 'Error')) {
        return {
            complete: false,
            reason: 'syntax_error',
            ...(lang === 'js' || lang === 'jsx' ? { typedJavaScriptRecoverable: true as const } : {}),
            symbols: [],
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        };
    }

    const traversalStartedAt = input.perfTiming ? performance.now() : 0;
    try {
        const sourceMap = new Utf8SourceMap(input.content);
        const symbols: ExtractedSymbol[] = [];
        const earlyExitSpans: SourceSpan[] | undefined = input.includeEarlyExitSpans ? [] : undefined;
        const callSites: CallSite[] = [];
        const receiverTypeBindings: ReceiverTypeBinding[] = [];
        // Only declarations directly in the program (including exports) own object callers.
        const moduleDeclarations = childNodes(parsed.program as Program & AstNode)
            .flatMap((node) => node.type === 'ExportNamedDeclaration' ? childNodes(node) : [node])
            .filter((node) => node.type === 'VariableDeclaration');
        const visit = (
            node: AstNode,
            parent?: AstNode,
            parents: readonly string[] = [],
            insideCallable = false,
            insideRegistrationCallback = false,
            directObject?: { literal: AstNode; owner: string },
        ): void => {
            if (earlyExitSpans) {
                const start = earlyExitContextStart(node, parent);
                if (start !== undefined) earlyExitSpans.push(sourceMap.spanFromUtf16(start, node.end));
            }
            const callback = !insideCallable || insideRegistrationCallback ? callbackName(node, parent) : undefined;
            const objectProperty = node.type === 'Property' && node.kind === 'init' && parent === directObject?.literal
                && isFunctionValue(node.value)
                && (!node.computed || (isAstNode(node.key) && node.key.type === 'Literal' && typeof node.key.value === 'string'));
            const kind = objectProperty ? 'method' : callback ? 'function' : symbolKind(node, parent, insideCallable);
            const name = callback ?? (kind ? symbolName(node) : undefined);
            const symbolParents = objectProperty && directObject ? [...parents, directObject.owner] : parents;
            const nextParents = name && (callback || kind === 'class' || kind === 'interface' || kind === 'namespace')
                ? [...parents, name]
                : parents;
            if (kind && name) {
                const span = sourceMap.spanFromUtf16(node.start, node.end);
                symbols.push({
                    kind,
                    name,
                    label: labelFor(kind, name),
                    qualifiedName: [...symbolParents, name].join('.'),
                    parentQualifiedNamePath: symbolParents,
                    span,
                });
            }
            const annotationBinding = variableAnnotationBinding(node, sourceMap);
            if (annotationBinding) receiverTypeBindings.push(annotationBinding);
            if (node.type === 'CallExpression' || node.type === 'NewExpression') {
                const name = calleeName(node);
                if (name) {
                    callSites.push({
                        calleeName: name,
                        ...(Array.isArray(node.arguments) && node.arguments.every(isAstNode)
                            ? { args: node.arguments.map(argument => input.content.slice(argument.start, argument.end)) } : {}),
                        ...callSiteEvidence(node, input.content),
                        span: sourceMap.spanFromUtf16(node.start, node.end),
                    });
                }
            }
            const childInsideCallable = insideCallable || (
                node.type === 'FunctionDeclaration'
                || node.type === 'FunctionExpression'
                || node.type === 'ArrowFunctionExpression'
                || node.type === 'MethodDefinition'
                || node.type === 'TSAbstractMethodDefinition'
                || (node.type === 'PropertyDefinition' && isFunctionValue(node.value))
            );
            const childRegistrationCallback = isFunctionValue(node) || node.type === 'FunctionDeclaration'
                || node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition'
                ? Boolean(callback)
                : insideRegistrationCallback;
            const boundObject = node.type === 'VariableDeclarator' && parent && moduleDeclarations.includes(parent)
                && nodeName(node) && isAstNode(node.init) && node.init.type === 'ObjectExpression'
                ? { literal: node.init, owner: nodeName(node)! } : undefined;
            for (const child of childNodes(node)) {
                // Ownership crosses only the binding-to-literal and literal-to-property edges.
                const childObject = boundObject?.literal === child ? boundObject
                    : directObject?.literal === node && child.type === 'Property' ? directObject : undefined;
                visit(child, node, nextParents, childInsideCallable, childRegistrationCallback, childObject);
            }
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

        return { complete: true, symbols, moduleBindings, callSites, receiverTypeBindings, pythonFlowFacts: [],
            ...(earlyExitSpans ? { earlyExitSpans } : {}) };
    } finally {
        if (input.perfTiming) {
            input.perfTiming.traversalMs += performance.now() - traversalStartedAt;
            input.perfTiming.traversalCount++;
        }
    }
}
