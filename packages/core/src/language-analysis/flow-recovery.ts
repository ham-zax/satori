import { createRequire } from 'node:module';

import type * as ts from '../semantic/typescript-api';

import type { ExtractedSymbol, ExtractedSymbolKind } from '../languages';
import { Utf8SourceMap } from './source-map';

type TypeScriptModule = typeof import('../semantic/typescript-api', { with: { 'resolution-mode': 'require' } });

const localRequire = createRequire(__filename);

/**
 * Flow recovery uses the native parser only when the primary parser fails.
 * Keep the module lazy so other language-analysis requests need no process.
 */
let typescriptModule: TypeScriptModule | undefined;

function loadTypeScript(): TypeScriptModule {
    typescriptModule ??= localRequire('../semantic/typescript-api') as TypeScriptModule;
    return typescriptModule;
}

/** A retained parse and the lease that releases its native-side memory. */
type RetainedFlowSourceFile = {
    readonly sourceFile: ts.SourceFile;
    dispose(): void;
};

type CreateSourceFileOptions = Parameters<
    InstanceType<TypeScriptModule['API']>['createSourceFile']
>[2];

/**
 * Narrow lifecycle surface of the native TypeScript client. Tests inject this
 * seam to observe parser lifetime without spawning a compiler process.
 */
export type FlowRecoveryApi = {
    createSourceFile(
        fileName: string,
        sourceText: string,
        options?: CreateSourceFileOptions,
    ): RetainedFlowSourceFile;
    close(): void;
};

export type FlowRecoveryParserOptions = {
    readonly createApi?: () => FlowRecoveryApi;
};

export type FlowRecoveryParser = {
    recover(source: string, relativePath: string): ExtractedSymbol[];
    close(): void;
};

const DEFAULT_IDLE_CLOSE_MS = 30_000;

/**
 * Oxc rejects Flow-annotated JavaScript outright and recovers no AST. This
 * extracts the declarations the TypeScript parser can still recover from such
 * a file (it tolerates syntax errors and shares most annotation syntax with
 * Flow). Only symbols come back: relationship evidence from a partial parse
 * would be unproven, so callers report the result as recovered, not complete.
 */
function extractFlowSymbols(
    typescript: TypeScriptModule,
    sourceFile: ts.SourceFile,
    source: string,
): ExtractedSymbol[] {
    const sourceMap = new Utf8SourceMap(source);
    const symbols: ExtractedSymbol[] = [];

    const isFunctionValue = (node: ts.Node | undefined): boolean => (
        node !== undefined && (typescript.isArrowFunction(node) || typescript.isFunctionExpression(node))
    );
    const memberName = (name: ts.PropertyName | undefined): string | undefined => (
        name && (typescript.isIdentifier(name) || typescript.isStringLiteral(name) || typescript.isPrivateIdentifier(name))
            ? name.text
            : undefined
    );

    const expressionName = (node: ts.Expression): string | undefined => {
        if (typescript.isIdentifier(node)) return node.text;
        if (typescript.isPropertyAccessExpression(node)) {
            const owner = expressionName(node.expression);
            return owner ? `${owner}.${node.name.text}` : undefined;
        }
        if (typescript.isElementAccessExpression(node) && typescript.isStringLiteral(node.argumentExpression)) {
            const owner = expressionName(node.expression);
            return owner ? `${owner}.${node.argumentExpression.text}` : undefined;
        }
        return undefined;
    };
    const callbackName = (node: ts.Node, parent: ts.Node | undefined): string | undefined => {
        if (!isFunctionValue(node) || !parent || !typescript.isCallExpression(parent)) return undefined;
        const index = parent.arguments.indexOf(node as ts.Expression);
        const callee = expressionName(parent.expression);
        if (index < 0 || !callee) return undefined;
        const discriminator = parent.arguments.find(typescript.isStringLiteral);
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
        } else if (typescript.isFunctionDeclaration(node)) {
            kind = 'function';
            name = node.name?.text;
        } else if (typescript.isClassDeclaration(node)) {
            kind = 'class';
            name = node.name?.text;
        } else if (typescript.isInterfaceDeclaration(node)) {
            kind = 'interface';
            name = node.name.text;
        } else if (typescript.isTypeAliasDeclaration(node)) {
            kind = 'type';
            name = node.name.text;
        } else if (typescript.isConstructorDeclaration(node)) {
            kind = 'constructor';
            name = 'constructor';
        } else if (typescript.isMethodDeclaration(node)) {
            kind = 'method';
            name = memberName(node.name);
        } else if (typescript.isPropertyDeclaration(node)) {
            kind = isFunctionValue(node.initializer) ? 'method' : 'variable';
            name = memberName(node.name);
        } else if (
            typescript.isVariableDeclaration(node)
            && typescript.isIdentifier(node.name)
            && parent !== undefined
            && typescript.isVariableDeclarationList(parent)
            && (!insideCallable || isFunctionValue(node.initializer))
        ) {
            kind = isFunctionValue(node.initializer) ? 'function' : 'variable';
            name = node.name.text;
        } else if (typescript.isBinaryExpression(node) && node.operatorToken.kind === typescript.SyntaxKind.EqualsToken && isFunctionValue(node.right)) {
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
            || typescript.isFunctionDeclaration(node)
            || typescript.isFunctionExpression(node)
            || typescript.isArrowFunction(node)
            || typescript.isMethodDeclaration(node)
            || typescript.isConstructorDeclaration(node);
        const nextRegistrationCallback = isFunctionValue(node) || typescript.isFunctionDeclaration(node)
            || typescript.isMethodDeclaration(node) || typescript.isConstructorDeclaration(node)
            ? Boolean(callback)
            : insideRegistrationCallback;
        node.forEachChild((child) => visit(child, node, nextParents, nextInsideCallable, nextRegistrationCallback));
    };
    visit(sourceFile, undefined, [], false, false);
    return symbols;
}

/**
 * One native client serves every Flow recovery for one owner (service or
 * worker). The client is created on the first recovery, stays alive between
 * files, and closes after an idle period. An in-flight recovery always
 * disposes the source-file lease it created.
 */
export function createFlowRecoveryParser(options: FlowRecoveryParserOptions = {}): FlowRecoveryParser {
    let api: FlowRecoveryApi | undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    const clearIdleTimer = (): void => {
        if (idleTimer === undefined) return;
        clearTimeout(idleTimer);
        idleTimer = undefined;
    };

    const close = (): void => {
        clearIdleTimer();
        const current = api;
        api = undefined;
        current?.close();
    };

    const scheduleIdleClose = (): void => {
        clearIdleTimer();
        idleTimer = setTimeout(close, DEFAULT_IDLE_CLOSE_MS);
        idleTimer.unref();
    };

    const createApi = (): FlowRecoveryApi => {
        if (options.createApi) return options.createApi();
        const typescript = loadTypeScript();
        return new typescript.API({ runExternalCode: false });
    };

    const recover = (source: string, relativePath: string): ExtractedSymbol[] => {
        clearIdleTimer();
        const typescript = loadTypeScript();
        if (api === undefined) api = createApi();
        const client = api;
        const parse = (): ExtractedSymbol[] => {
            const retained = client.createSourceFile(relativePath, source, { scriptKind: typescript.ScriptKind.TSX });
            try {
                return extractFlowSymbols(typescript, retained.sourceFile, source);
            } finally {
                retained.dispose();
            }
        };
        let symbols: ExtractedSymbol[];
        try {
            symbols = parse();
        } catch (error) {
            // A failed request can leave the native client unusable; recreate it on the next call.
            close();
            throw error;
        }
        scheduleIdleClose();
        return symbols;
    };

    return { recover, close };
}

/**
 * One-shot Flow recovery for isolated callers. It closes the native client
 * before returning; the shared service keeps a parser instead.
 */
export function recoverFlowSymbols(source: string, relativePath: string): ExtractedSymbol[] {
    const parser = createFlowRecoveryParser();
    try {
        return parser.recover(source, relativePath);
    } finally {
        parser.close();
    }
}
