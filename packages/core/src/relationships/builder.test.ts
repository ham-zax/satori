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
import { createLanguageAnalysisService } from '../language-analysis';
import { getLanguageIdFromFilename } from '../language';

async function analyzeFiles(
    sources: Map<string, string> | Record<string, string>,
) {
    const analyzer = createLanguageAnalysisService();
    const entries = sources instanceof Map ? [...sources.entries()] : Object.entries(sources);
    return new Map(await Promise.all(entries.map(async ([relativePath, content]) => [
        relativePath,
        await analyzer.analyze({
            content,
            language: getLanguageIdFromFilename(relativePath, 'text'),
            relativePath,
        }),
    ] as const)));
}

function createSymbol(input: {
    file: string;
    kind: SymbolKind;
    name: string;
    qualifiedName: string;
    label: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    language?: string;
    parentQualifiedNamePath?: string[];
    startByte?: number;
    endByte?: number;
}): SymbolRecord {
    const parentQualifiedNamePath = input.parentQualifiedNamePath || [];
    const language = input.language || 'typescript';
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language,
        kind: input.kind,
        qualifiedName: input.qualifiedName,
        parentQualifiedNamePath,
    });
    const span = {
        startLine: input.startLine,
        endLine: input.endLine,
        ...(input.startByte === undefined ? {} : { startByte: input.startByte }),
        ...(input.endByte === undefined ? {} : { endByte: input.endByte }),
    };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: 'test-extractor-v1',
        }),
        language,
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

test('buildCallRelationshipsForRegistry creates deterministic CALLS records from owned symbols', async () => {
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
        analysisByFile: await analyzeFiles(new Map([
            ['src/auth.ts', 'export function validateToken(token: string) { return true; }\nexport function login(token: string) {\n  return validateToken(token);\n}\n'],
            ['src/routes.ts', 'import { login } from "./auth";\nexport function route(token: string) {\n  return login(token);\n}\n'],
        ])),
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

test('buildCallRelationshipsForRegistry assigns same-line calls by byte containment', async () => {
    const content = [
        'function targetA() {}',
        'function targetB() {}',
        'function first() { targetA(); } function second() { targetB(); }',
    ].join('\n');
    const file = 'src/same-line.ts';
    const fileHash = 'hash-same-line';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const symbol = (name: string, startLine: number, startByte: number, endByte: number) => createSymbol({
        file,
        kind: 'function',
        name,
        qualifiedName: name,
        label: `function ${name}`,
        startLine,
        endLine: startLine,
        startByte,
        endByte,
        fileHash,
    });
    const firstStart = content.indexOf('function first');
    const secondStart = content.indexOf('function second');
    const symbols = [
        symbol('targetA', 1, content.indexOf('function targetA'), content.indexOf('function targetA') + 21),
        symbol('targetB', 2, content.indexOf('function targetB'), content.indexOf('function targetB') + 21),
        symbol('first', 3, firstStart, secondStart - 1),
        symbol('second', 3, secondStart, content.length),
    ];
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: symbols.length + 1 }],
        },
        symbols: [fileOwner, ...symbols],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({ [file]: content }),
    });
    const nameById = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry.name]));

    assert.deepEqual(records.map((record) => [
        nameById.get(record.sourceInstanceId ?? '') ?? '',
        nameById.get(record.targetInstanceId ?? '') ?? '',
    ]).sort((left, right) => left[0].localeCompare(right[0])), [
        ['first', 'targetA'],
        ['second', 'targetB'],
    ]);
});

test('buildCallRelationshipsForRegistry skips definitions, unresolved calls, and non-source owners', async () => {
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
        analysisByFile: await analyzeFiles({
            'src/auth.ts': 'export function login() {\n  missingCall();\n}\n',
        }),
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry does not emit duplicate container-owned class calls', async () => {
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
        analysisByFile: await analyzeFiles({
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
        }),
    });

    assert.deepEqual(records.map((record) => record.sourceInstanceId), [login.symbolInstanceId]);
    assert.deepEqual(records.map((record) => record.targetInstanceId), [normalize.symbolInstanceId]);
});

test('buildCallRelationshipsForRegistry skips ambiguous same-name targets until receiver resolution exists', async () => {
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
        analysisByFile: await analyzeFiles({ 'src/auth.ts': content }),
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry is case-sensitive and refuses receiver-unproven member calls', async () => {
    const content = [
        'function Process() {}',
        'class Cache { save() {} }',
        'function run(database: { save(): void }) {',
        '  process();',
        '  database.save();',
        '}',
    ].join('\n');
    const file = 'src/case.ts';
    const fileHash = 'hash-case';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const symbols = [
        createSymbol({ file, kind: 'function', name: 'Process', qualifiedName: 'Process', label: 'function Process', startLine: 1, endLine: 1, fileHash }),
        createSymbol({ file, kind: 'method', name: 'save', qualifiedName: 'Cache.save', label: 'method save', startLine: 2, endLine: 2, fileHash, parentQualifiedNamePath: ['Cache'] }),
        createSymbol({ file, kind: 'function', name: 'run', qualifiedName: 'run', label: 'function run', startLine: 3, endLine: 6, fileHash }),
    ];
    const registry = buildSymbolRegistry({
        manifest: { ...manifest(), files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: symbols.length + 1 }] },
        symbols: [fileOwner, ...symbols],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({ [file]: content }),
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry constrains targets by call kind', () => {
    const file = 'src/targets.ts';
    const fileHash = 'hash-target-kinds';
    const content = 'function run() {}\n';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const symbol = (kind: SymbolKind, name: string, line: number) => createSymbol({
        file,
        kind,
        name,
        qualifiedName: name,
        label: `${kind} ${name}`,
        startLine: line,
        endLine: line,
        fileHash,
    });
    const run = symbol('function', 'run', 1);
    const helper = symbol('function', 'helper', 2);
    const service = symbol('class', 'Service', 3);
    const classCalledDirectly = symbol('class', 'DirectClass', 4);
    const propertyCalledDirectly = symbol('property', 'directProperty', 5);
    const functionConstructed = symbol('function', 'factory', 6);
    const symbols = [fileOwner, run, helper, service, classCalledDirectly, propertyCalledDirectly, functionConstructed];
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: symbols.length }],
        },
        symbols,
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: new Map([[
            file,
            {
                moduleBindings: [],
                callSites: [
                    { calleeName: 'helper', kind: 'direct', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'Service', kind: 'constructor', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'DirectClass', kind: 'direct', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'directProperty', kind: 'direct', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'factory', kind: 'constructor', span: { startLine: 1, endLine: 1 } },
                ],
            },
        ]]),
    });
    const targetNameById = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry.name]));

    assert.deepEqual(
        records.map((record) => targetNameById.get(record.targetInstanceId ?? '')).sort(),
        ['Service', 'helper'],
    );
});

test('buildCallRelationshipsForRegistry treats components and hooks as callable owners', async () => {
    const file = 'src/widget.tsx';
    const fileHash = 'hash-widget';
    const content = 'function target() {}\nfunction Widget() { target(); }\nfunction useThing() { target(); }\n';
    const fileOwner = createSynthesizedFileSymbol({ relativePath: file, language: 'tsx', content, fileHash, extractorVersion: 'test-extractor-v1' });
    const target = createSymbol({ file, kind: 'function', name: 'target', qualifiedName: 'target', label: 'function target', startLine: 1, endLine: 1, fileHash, language: 'tsx' });
    const widget = createSymbol({ file, kind: 'component', name: 'Widget', qualifiedName: 'Widget', label: 'component Widget', startLine: 2, endLine: 2, fileHash, language: 'tsx' });
    const hook = createSymbol({ file, kind: 'hook', name: 'useThing', qualifiedName: 'useThing', label: 'hook useThing', startLine: 3, endLine: 3, fileHash, language: 'tsx' });
    const registry = buildSymbolRegistry({
        manifest: { ...manifest(), files: [{ path: file, hash: fileHash, language: 'tsx', symbolCount: 4 }] },
        symbols: [fileOwner, target, widget, hook],
    });

    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile: await analyzeFiles({ [file]: content }) });

    assert.deepEqual(new Set(records.map((record) => record.sourceInstanceId)), new Set([
        widget.symbolInstanceId,
        hook.symbolInstanceId,
    ]));
});

test('buildRelationshipsForRegistry creates conservative IMPORTS and EXPORTS file-owner records', async () => {
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
        analysisByFile: await analyzeFiles(new Map([
            ['src/auth.ts', authContent],
            ['src/routes.ts', routesContent],
        ])),
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

test('buildRelationshipsForRegistry creates Python IMPORTS and top-level EXPORTS for relative module calls', async () => {
    const telemetryContent = [
        'def build_entry_telemetry():',
        '    return None',
    ].join('\n');
    const phasesContent = [
        'from .telemetry import build_entry_telemetry',
        '',
        'def _attach_entry_telemetry():',
        '    return build_entry_telemetry()',
    ].join('\n');
    const telemetryFile = createSynthesizedFileSymbol({
        relativePath: 'src/telemetry.py',
        language: 'python',
        content: telemetryContent,
        fileHash: 'hash-telemetry',
        extractorVersion: 'test-extractor-v1',
    });
    const phasesFile = createSynthesizedFileSymbol({
        relativePath: 'src/phases.py',
        language: 'python',
        content: phasesContent,
        fileHash: 'hash-phases',
        extractorVersion: 'test-extractor-v1',
    });
    const buildEntryTelemetry = createSymbol({
        file: 'src/telemetry.py',
        kind: 'function',
        name: 'build_entry_telemetry',
        qualifiedName: 'build_entry_telemetry',
        label: 'function build_entry_telemetry()',
        startLine: 1,
        endLine: 2,
        fileHash: 'hash-telemetry',
        language: 'python',
    });
    const attachEntryTelemetry = createSymbol({
        file: 'src/phases.py',
        kind: 'function',
        name: '_attach_entry_telemetry',
        qualifiedName: '_attach_entry_telemetry',
        label: 'function _attach_entry_telemetry()',
        startLine: 3,
        endLine: 4,
        fileHash: 'hash-phases',
        language: 'python',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/repo',
            rootFingerprint: 'root-fingerprint',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router-v1',
            extractorVersion: 'test-extractor-v1',
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: [
                { path: 'src/phases.py', hash: 'hash-phases', language: 'python', symbolCount: 2 },
                { path: 'src/telemetry.py', hash: 'hash-telemetry', language: 'python', symbolCount: 2 },
            ],
        },
        symbols: [phasesFile, attachEntryTelemetry, telemetryFile, buildEntryTelemetry],
    });

    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles(new Map([
            ['src/phases.py', phasesContent],
            ['src/telemetry.py', telemetryContent],
        ])),
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
            type: 'IMPORTS',
            source: phasesFile.symbolInstanceId,
            target: telemetryFile.symbolInstanceId,
            targetPath: 'src/telemetry.py',
            file: 'src/phases.py',
            line: 1,
            confidence: 'high',
        },
        {
            type: 'EXPORTS',
            source: phasesFile.symbolInstanceId,
            target: attachEntryTelemetry.symbolInstanceId,
            targetPath: undefined,
            file: 'src/phases.py',
            line: 3,
            confidence: 'high',
        },
        {
            type: 'CALLS',
            source: attachEntryTelemetry.symbolInstanceId,
            target: buildEntryTelemetry.symbolInstanceId,
            targetPath: undefined,
            file: 'src/phases.py',
            line: 4,
            confidence: 'low',
        },
        {
            type: 'EXPORTS',
            source: telemetryFile.symbolInstanceId,
            target: buildEntryTelemetry.symbolInstanceId,
            targetPath: undefined,
            file: 'src/telemetry.py',
            line: 1,
            confidence: 'high',
        },
    ]);
});

test('buildRelationshipsForRegistry skips unresolved package imports and ambiguous local exports', async () => {
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
        analysisByFile: await analyzeFiles({ 'src/routes.ts': content }),
    });

    assert.deepEqual(records, []);
});

test('buildRelationshipsForRegistry resolves NodeNext source extensions and rejects root traversal', async () => {
    const files = [
        { path: 'src/a.ts', hash: 'hash-a', language: 'typescript', content: 'import "./b.js"; import "../../outside";' },
        { path: 'src/b.ts', hash: 'hash-b', language: 'typescript', content: 'export const value = 1;' },
        { path: 'outside.ts', hash: 'hash-outside', language: 'typescript', content: 'export const value = 2;' },
        { path: 'src/pkg/a.py', hash: 'hash-py', language: 'python', content: 'from ...outside import value' },
        { path: 'outside.py', hash: 'hash-outside-py', language: 'python', content: 'value = 1' },
    ];
    const owners = files.map((file) => createSynthesizedFileSymbol({
        relativePath: file.path,
        language: file.language,
        content: file.content,
        fileHash: file.hash,
        extractorVersion: 'test-extractor-v1',
    }));
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: files.map((file) => ({
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbolCount: 1,
            })),
        },
        symbols: owners,
    });
    const analyzed = await analyzeFiles(Object.fromEntries(files.map((file) => [file.path, file.content])));

    const records = buildRelationshipsForRegistry({ registry, analysisByFile: analyzed });

    assert.deepEqual(records.filter((record) => record.type === 'IMPORTS').map((record) => record.targetPath), [
        'src/b.ts',
    ]);
});
