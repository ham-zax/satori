import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    createSynthesizedFileSymbol,
} from '../symbols';
import { buildCallRelationshipsForRegistry, buildRelationshipsForRegistry } from './builder';
import type { SymbolKind, SymbolRecord, SymbolRegistryManifest } from '../symbols';

function createSymbol(input: {
    file: string;
    kind: SymbolKind;
    name: string;
    qualifiedName: string;
    label: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    parentQualifiedNamePath?: string[];
}): SymbolRecord {
    const parentQualifiedNamePath = input.parentQualifiedNamePath || [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language: 'typescript',
        kind: input.kind,
        qualifiedName: input.qualifiedName,
        parentQualifiedNamePath,
    });
    const span = { startLine: input.startLine, endLine: input.endLine };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: 'test-extractor-v1',
        }),
        language: 'typescript',
        kind: input.kind,
        name: input.name,
        qualifiedName: input.qualifiedName,
        label: input.label,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'test-extractor-v1',
    };
}

function manifest(): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fingerprint',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'test-extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: [
            { path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 3 },
            { path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 2 },
        ],
    };
}

test('buildCallRelationshipsForRegistry creates deterministic CALLS records from owned symbols', () => {
    const authFile = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: 'export function validateToken(token: string) { return true; }\nexport function login(token: string) {\n  return validateToken(token);\n}\n',
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const routesFile = createSynthesizedFileSymbol({
        relativePath: 'src/routes.ts',
        language: 'typescript',
        content: 'import { login } from "./auth";\nexport function route(token: string) {\n  return login(token);\n}\n',
        fileHash: 'hash-routes',
        extractorVersion: 'test-extractor-v1',
    });
    const validateToken = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'validateToken',
        qualifiedName: 'validateToken',
        label: 'function validateToken(token: string)',
        startLine: 1,
        endLine: 1,
        fileHash: 'hash-auth',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'login',
        qualifiedName: 'login',
        label: 'function login(token: string)',
        startLine: 2,
        endLine: 4,
        fileHash: 'hash-auth',
    });
    const route = createSymbol({
        file: 'src/routes.ts',
        kind: 'function',
        name: 'route',
        qualifiedName: 'route',
        label: 'function route(token: string)',
        startLine: 2,
        endLine: 4,
        fileHash: 'hash-routes',
    });
    const registry = buildSymbolRegistry({
        manifest: manifest(),
        symbols: [routesFile, route, authFile, validateToken, login],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        contentByFile: new Map([
            ['src/auth.ts', 'export function validateToken(token: string) { return true; }\nexport function login(token: string) {\n  return validateToken(token);\n}\n'],
            ['src/routes.ts', 'import { login } from "./auth";\nexport function route(token: string) {\n  return login(token);\n}\n'],
        ]),
    });

    assert.deepEqual(records.map((record) => ({
        source: record.sourceInstanceId,
        target: record.targetInstanceId,
        file: record.file,
        line: record.span?.startLine,
        confidence: record.confidence,
    })), [
        {
            source: login.symbolInstanceId,
            target: validateToken.symbolInstanceId,
            file: 'src/auth.ts',
            line: 3,
            confidence: 'high',
        },
        {
            source: route.symbolInstanceId,
            target: login.symbolInstanceId,
            file: 'src/routes.ts',
            line: 3,
            confidence: 'low',
        },
    ]);
});

test('buildCallRelationshipsForRegistry skips definitions, unresolved calls, and non-source owners', () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: 'export function login() {\n  missingCall();\n}\n',
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'login',
        qualifiedName: 'login',
        label: 'function login()',
        startLine: 1,
        endLine: 3,
        fileHash: 'hash-auth',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2 }],
        },
        symbols: [fileOwner, login],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        contentByFile: {
            'src/auth.ts': 'export function login() {\n  missingCall();\n}\n',
        },
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry does not emit duplicate container-owned class calls', () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: [
            'export function normalize(input: string) {',
            '  return input.trim();',
            '}',
            '',
            'export class AuthService {',
            '  async login(input: string) {',
            '    return normalize(input);',
            '  }',
            '}',
        ].join('\n'),
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const normalize = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'normalize',
        qualifiedName: 'normalize',
        label: 'function normalize(input: string)',
        startLine: 1,
        endLine: 3,
        fileHash: 'hash-auth',
    });
    const authService = createSymbol({
        file: 'src/auth.ts',
        kind: 'class',
        name: 'AuthService',
        qualifiedName: 'AuthService',
        label: 'class AuthService',
        startLine: 5,
        endLine: 9,
        fileHash: 'hash-auth',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        label: 'async login(input: string)',
        startLine: 6,
        endLine: 8,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 4 }],
        },
        symbols: [fileOwner, normalize, authService, login],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        contentByFile: {
            'src/auth.ts': [
                'export function normalize(input: string) {',
                '  return input.trim();',
                '}',
                '',
                'export class AuthService {',
                '  async login(input: string) {',
                '    return normalize(input);',
                '  }',
                '}',
            ].join('\n'),
        },
    });

    assert.deepEqual(records.map((record) => record.sourceInstanceId), [login.symbolInstanceId]);
    assert.deepEqual(records.map((record) => record.targetInstanceId), [normalize.symbolInstanceId]);
});

test('buildCallRelationshipsForRegistry skips ambiguous same-name targets until receiver resolution exists', () => {
    const content = [
        'export class AuthService {',
        '  login(input: string) {',
        '    return audit(input);',
        '  }',
        '  audit(input: string) {',
        '    return input;',
        '  }',
        '}',
        '',
        'export class UserService {',
        '  audit(input: string) {',
        '    return input;',
        '  }',
        '}',
    ].join('\n');
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content,
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const authService = createSymbol({
        file: 'src/auth.ts',
        kind: 'class',
        name: 'AuthService',
        qualifiedName: 'AuthService',
        label: 'class AuthService',
        startLine: 1,
        endLine: 8,
        fileHash: 'hash-auth',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        label: 'login(input: string)',
        startLine: 2,
        endLine: 4,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const authAudit = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'audit',
        qualifiedName: 'AuthService.audit',
        label: 'audit(input: string)',
        startLine: 5,
        endLine: 7,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const userService = createSymbol({
        file: 'src/auth.ts',
        kind: 'class',
        name: 'UserService',
        qualifiedName: 'UserService',
        label: 'class UserService',
        startLine: 10,
        endLine: 14,
        fileHash: 'hash-auth',
    });
    const userAudit = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'audit',
        qualifiedName: 'UserService.audit',
        label: 'audit(input: string)',
        startLine: 11,
        endLine: 13,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class UserService'],
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 6 }],
        },
        symbols: [fileOwner, authService, login, authAudit, userService, userAudit],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        contentByFile: { 'src/auth.ts': content },
    });

    assert.deepEqual(records, []);
});

test('buildRelationshipsForRegistry creates conservative IMPORTS and EXPORTS file-owner records', () => {
    const authContent = [
        'export function login(token: string) {',
        '  return token;',
        '}',
    ].join('\n');
    const routesContent = [
        'import { login } from "./auth";',
        'export { login } from "./auth";',
        'export function route(token: string) {',
        '  return login(token);',
        '}',
    ].join('\n');
    const authFile = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: authContent,
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const routesFile = createSynthesizedFileSymbol({
        relativePath: 'src/routes.ts',
        language: 'typescript',
        content: routesContent,
        fileHash: 'hash-routes',
        extractorVersion: 'test-extractor-v1',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'login',
        qualifiedName: 'login',
        label: 'function login(token: string)',
        startLine: 1,
        endLine: 3,
        fileHash: 'hash-auth',
    });
    const route = createSymbol({
        file: 'src/routes.ts',
        kind: 'function',
        name: 'route',
        qualifiedName: 'route',
        label: 'function route(token: string)',
        startLine: 3,
        endLine: 5,
        fileHash: 'hash-routes',
    });
    const registry = buildSymbolRegistry({
        manifest: manifest(),
        symbols: [authFile, login, routesFile, route],
    });

    const records = buildRelationshipsForRegistry({
        registry,
        contentByFile: new Map([
            ['src/auth.ts', authContent],
            ['src/routes.ts', routesContent],
        ]),
    });

    assert.deepEqual(records.map((record) => ({
        type: record.type,
        source: record.sourceInstanceId,
        target: record.targetInstanceId,
        targetPath: record.targetPath,
        file: record.file,
        line: record.span?.startLine,
        confidence: record.confidence,
    })), [
        {
            type: 'EXPORTS',
            source: authFile.symbolInstanceId,
            target: login.symbolInstanceId,
            targetPath: undefined,
            file: 'src/auth.ts',
            line: 1,
            confidence: 'high',
        },
        {
            type: 'IMPORTS',
            source: routesFile.symbolInstanceId,
            target: authFile.symbolInstanceId,
            targetPath: 'src/auth.ts',
            file: 'src/routes.ts',
            line: 1,
            confidence: 'high',
        },
        {
            type: 'EXPORTS',
            source: routesFile.symbolInstanceId,
            target: authFile.symbolInstanceId,
            targetPath: 'src/auth.ts',
            file: 'src/routes.ts',
            line: 2,
            confidence: 'high',
        },
        {
            type: 'EXPORTS',
            source: routesFile.symbolInstanceId,
            target: route.symbolInstanceId,
            targetPath: undefined,
            file: 'src/routes.ts',
            line: 3,
            confidence: 'high',
        },
        {
            type: 'CALLS',
            source: route.symbolInstanceId,
            target: login.symbolInstanceId,
            targetPath: undefined,
            file: 'src/routes.ts',
            line: 4,
            confidence: 'low',
        },
    ]);
});

test('buildRelationshipsForRegistry skips unresolved package imports and ambiguous local exports', () => {
    const content = [
        'import express from "express";',
        'export { missing } from "./missing";',
        'export const known = true;',
    ].join('\n');
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/routes.ts',
        language: 'typescript',
        content,
        fileHash: 'hash-routes',
        extractorVersion: 'test-extractor-v1',
    });
    const knownOne = createSymbol({
        file: 'src/routes.ts',
        kind: 'property',
        name: 'known',
        qualifiedName: 'known',
        label: 'const known',
        startLine: 3,
        endLine: 3,
        fileHash: 'hash-routes',
    });
    const knownTwo = createSymbol({
        file: 'src/routes.ts',
        kind: 'function',
        name: 'known',
        qualifiedName: 'known',
        label: 'function known()',
        startLine: 3,
        endLine: 3,
        fileHash: 'hash-routes',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 3 }],
        },
        symbols: [fileOwner, knownOne, knownTwo],
    });

    const records = buildRelationshipsForRegistry({
        registry,
        contentByFile: { 'src/routes.ts': content },
    });

    assert.deepEqual(records, []);
});
