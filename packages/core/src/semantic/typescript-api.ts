// Native TypeScript 7 modules are ESM. Satori's synchronous CommonJS API uses
// Node 22.13's require(ESM), matching the package's minimum Node version.
export type * from 'typescript/ast' with { 'resolution-mode': 'import' };
export type * from 'typescript/sync' with { 'resolution-mode': 'import' };
export { version } from 'typescript';

const ast = require('typescript/ast') as typeof import('typescript/ast', { with: { 'resolution-mode': 'import' } });
const sync = require('typescript/sync') as typeof import('typescript/sync', { with: { 'resolution-mode': 'import' } });
const nativeFS = require('typescript/fs') as typeof import('typescript/fs', { with: { 'resolution-mode': 'import' } });
export const {
    isConstructorDeclaration,
    isIdentifier,
    isStringLiteral,
    isNumericLiteral,
    isClassLikeDeclaration,
    isArrowFunction,
    isFunctionExpression,
    isFunctionDeclaration,
    isMethodDeclaration,
    isGetAccessorDeclaration,
    isSetAccessorDeclaration,
    isVariableDeclaration,
    isPropertyDeclaration,
    isFunctionLikeDeclaration,
    isSourceFile,
    isPropertyAccessExpression,
    isElementAccessExpression,
    isStringLiteralLikeNode,
    isNewExpression,
    isClassDeclaration,
    isParenthesizedExpression,
    isAsExpression,
    isTypeAssertion,
    isNonNullExpression,
    isSatisfiesExpression,
    isConditionalExpression,
    isVariableDeclarationList,
    isPrivateIdentifier,
    isCallExpression,
    isBinaryExpression,
    isPrefixUnaryExpression,
    isPostfixUnaryExpression,
    isForInStatement,
    isForOfStatement,
    getTokenAtPosition,
    isExternalModule,
    isModuleDeclaration,
    isInterfaceDeclaration,
    isTypeAliasDeclaration,
} = ast;
export const SyntaxKind = ast.SyntaxKind;
export const ScriptKind = ast.ScriptKind;
export const ScriptTarget = ast.ScriptTarget;
export const NodeFlags = ast.NodeFlags;
export const API = sync.API;
export const ModuleKind = sync.ModuleKind;
export const ModuleResolutionKind = sync.ModuleResolutionKind;
export const JsxEmit = sync.JsxEmit;
export const SymbolFlags = sync.SymbolFlags;
export const TypeFlags = sync.TypeFlags;
export const { serverFS, createFileSystemLayer } = nativeFS;
