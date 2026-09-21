import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { analyzeWithOxc } from '../packages/core/src/language-analysis/oxc-adapter';
import { TypeScriptSemanticProjectAnalyzer } from '../packages/core/src/relationships/typescript-semantic-analyzer';
import type { ResolutionClaim } from '../packages/core/src/relationships/resolution';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../packages/core/src/symbols/contracts';
import {
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    type SymbolRecord,
    type SymbolRegistry,
} from '../packages/core/src/symbols/registry';
import {
    inferResolutionStrategy,
    neutralEvidenceFromResolutionClaim,
} from './semantic-qualification-adapter-helpers.mjs';

interface CanonicalTarget {
    readonly file: string;
    readonly qualifiedName: string;
}

interface ProductionCaseSpec {
    readonly caseId: string;
    readonly callFile: string;
    readonly callLine: number;
    readonly callee: string;
    readonly sourceQualifiedName: string;
    readonly targets: Readonly<Record<string, CanonicalTarget>>;
    readonly files: Readonly<Record<string, string>>;
    readonly mutate?: (root: string) => void;
    readonly changedFiles?: readonly string[];
    readonly expectedAffected?: readonly string[];
    readonly forbiddenAffected?: readonly string[];
    readonly assertTransition?: (before: ResolutionClaim | undefined, after: ResolutionClaim) => void;
}

function tsconfig(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            ...extra,
        },
        include: ['src/**/*.ts'],
    }, null, 2);
}

const productionCases: Readonly<Record<string, ProductionCaseSpec>> = {
    'typescript.path_alias_config_change': {
        caseId: 'typescript.path_alias_config_change',
        callFile: 'src/caller.ts',
        callLine: 4,
        callee: 'service.work',
        sourceQualifiedName: 'run',
        targets: {
            'target.primary': { file: 'src/b.ts', qualifiedName: 'Service.work' },
            'target.decoy': { file: 'src/a.ts', qualifiedName: 'Service.work' },
        },
        files: {
            'tsconfig.json': tsconfig({
                baseUrl: '.',
                paths: { '@svc': ['src/a.ts'] },
            }),
            'src/a.ts': "export class Service { work(): string { return 'a'; } }\n",
            'src/b.ts': "export class Service { work(): string { return 'b'; } }\n",
            'src/caller.ts': [
                "import { Service } from '@svc';",
                'export function run(): string {',
                '    const service = new Service();',
                '    return service.work();',
                '}',
                '',
            ].join('\n'),
        },
        mutate(root) {
            fs.writeFileSync(path.join(root, 'tsconfig.json'), tsconfig({
                baseUrl: '.',
                paths: { '@svc': ['src/b.ts'] },
            }));
        },
        changedFiles: ['tsconfig.json'],
        expectedAffected: ['src/a.ts', 'src/b.ts', 'src/caller.ts'],
    },
    'typescript.project_boundary': {
        caseId: 'typescript.project_boundary',
        callFile: 'a/src/caller.ts',
        callLine: 4,
        callee: 'service.work',
        sourceQualifiedName: 'run',
        targets: {
            'target.primary': { file: 'a/src/service.ts', qualifiedName: 'Service.work' },
            'target.decoy': { file: 'b/src/service.ts', qualifiedName: 'Service.work' },
        },
        files: {
            'a/tsconfig.json': tsconfig(),
            'a/src/service.ts': "export class Service { work(): string { return 'a'; } }\n",
            'a/src/caller.ts': [
                "import { Service } from './service';",
                'export function run(): string {',
                '    const service = new Service();',
                '    return service.work();',
                '}',
                '',
            ].join('\n'),
            'b/tsconfig.json': tsconfig(),
            'b/src/service.ts': "export class Service { work(): string { return 'b'; } }\n",
        },
    },
    'typescript.incremental_dependent': {
        caseId: 'typescript.incremental_dependent',
        callFile: 'src/caller.ts',
        callLine: 4,
        callee: 'service.work',
        sourceQualifiedName: 'run',
        targets: {
            'target.primary': { file: 'src/service.ts', qualifiedName: 'Service.work' },
        },
        files: {
            'tsconfig.json': tsconfig(),
            'src/service.ts': 'export class Service { work(): number { return 1; } }\n',
            'src/caller.ts': [
                "import { Service } from './service';",
                'export function run(): number {',
                '    const service = new Service();',
                '    return service.work();',
                '}',
                '',
            ].join('\n'),
            'src/unrelated.ts': 'export function untouched(): number { return 7; }\n',
        },
        mutate(root) {
            fs.writeFileSync(
                path.join(root, 'src/service.ts'),
                'export class Service { work(): number { return 2; } }\n',
            );
        },
        changedFiles: ['src/service.ts'],
        expectedAffected: ['src/caller.ts', 'src/service.ts'],
        forbiddenAffected: ['src/unrelated.ts'],
        assertTransition(before, after) {
            if (!before?.targetInstanceId || !after.targetInstanceId || before.targetInstanceId === after.targetInstanceId) {
                throw new Error('Incremental dependency qualification did not refresh the unchanged caller target instance.');
            }
        },
    },
};

function sha256(source: string): string {
    return crypto.createHash('sha256').update(source).digest('hex');
}

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
    for (const [relativePath, source] of Object.entries(files)) {
        const absolute = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, source);
    }
}

function sourceFiles(spec: ProductionCaseSpec): string[] {
    return Object.keys(spec.files)
        .filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file))
        .sort();
}

function buildRegistry(root: string, spec: ProductionCaseSpec): SymbolRegistry {
    const symbols: SymbolRecord[] = [];
    const files: Array<{
        path: string;
        hash: string;
        language: string;
        symbolCount: number;
        definitionStatus: 'definitions_present' | 'structural_unavailable';
    }> = [];
    for (const relativePath of sourceFiles(spec)) {
        const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
        const analysis = analyzeWithOxc({
            content: source,
            language: 'typescript',
            relativePath,
        });
        const fileHash = sha256(source);
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath,
            language: 'typescript',
            content: source,
            fileHash,
            extractorVersion: 'typescript-production-qualification-v1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path: relativePath,
            hash: fileHash,
            language: 'typescript',
            symbolCount: fileSymbols.length,
            definitionStatus: analysis.complete ? 'definitions_present' : 'structural_unavailable',
        });
    }
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root.replace(/\\/g, '/'),
            rootFingerprint: 'typescript-production-qualification-root',
            indexPolicyHash: 'typescript-production-qualification-policy',
            languageRouterVersion: 'typescript-production-qualification-router',
            extractorVersion: 'typescript-production-qualification-v1',
            relationshipVersion: 'typescript-production-qualification-v1',
            builtAt: '2026-09-21T00:00:00.000Z',
            files,
        },
        symbols,
    });
}

function claimFor(
    claimsByFile: ReadonlyMap<string, readonly ResolutionClaim[]>,
    spec: ProductionCaseSpec,
): ResolutionClaim {
    const claim = (claimsByFile.get(spec.callFile) ?? []).find((candidate) => (
        candidate.callSpan.startLine === spec.callLine
        && candidate.proofSteps[0]?.subject === spec.callee
    ));
    if (!claim) {
        throw new Error(`No production TypeScript claim for ${spec.caseId}`);
    }
    return claim;
}

function canonicalTarget(
    ref: string,
    target: CanonicalTarget,
    registry: SymbolRegistry,
) {
    const matches = registry.symbols.filter((symbol) => (
        symbol.file === target.file && symbol.qualifiedName === target.qualifiedName
    ));
    if (matches.length !== 1) {
        throw new Error(`Expected one canonical target ${ref} for ${target.file}::${target.qualifiedName}, saw ${matches.length}`);
    }
    const symbol = matches[0];
    return {
        ref,
        label: symbol.qualifiedName,
        file: symbol.file,
        span: { ...symbol.span },
    };
}

function observationFor(
    spec: ProductionCaseSpec,
    claim: ResolutionClaim,
    registry: SymbolRegistry,
    affected: readonly string[],
) {
    const source = claim.sourceInstanceId
        ? registry.symbolsByInstanceId.get(claim.sourceInstanceId)
        : undefined;
    if (!source || source.qualifiedName !== spec.sourceQualifiedName) {
        throw new Error(`Unexpected source identity for ${spec.caseId}`);
    }

    let target;
    if (claim.targetInstanceId) {
        const targetSymbol = registry.symbolsByInstanceId.get(claim.targetInstanceId);
        if (!targetSymbol) throw new Error(`Missing target symbol for ${spec.caseId}`);
        const match = Object.entries(spec.targets).find(([, canonical]) => (
            canonical.file === targetSymbol.file
            && canonical.qualifiedName === targetSymbol.qualifiedName
        ));
        if (!match) {
            throw new Error(`Unmapped production target ${targetSymbol.file}::${targetSymbol.qualifiedName} for ${spec.caseId}`);
        }
        target = canonicalTarget(match[0], match[1], registry);
    }

    const evidence = neutralEvidenceFromResolutionClaim(claim, { target });
    evidence.push({
        kind: 'provider_specific',
        subject: `affected_source_files=${affected.join(',')}`,
    });

    const unresolvedEvidence = claim.decision === 'resolved'
        ? []
        : evidence.filter((atom) => (
            atom?.kind === 'candidate_set'
            || atom?.kind === 'ambiguity'
            || atom?.kind === 'unresolved_dependency'
        ));

    return {
        decision: claim.decision,
        relationshipType: claim.relationshipType,
        callSite: {
            file: spec.callFile,
            span: { ...claim.callSpan },
            text: spec.callee,
        },
        source: {
            ref: 'caller',
            label: source.qualifiedName,
            file: source.file,
            span: { ...source.span },
        },
        ...(target ? { target } : {}),
        alternatives: [],
        mechanism: {
            authority: claim.resolutionAuthority,
            strategy: inferResolutionStrategy(claim),
            detail: `Production TypeScript project evidence; affected owners: ${affected.join(', ')}.`,
        },
        evidence,
        unresolvedEvidence,
    };
}

export const TYPESCRIPT_PRODUCTION_QUALIFICATION_CASE_IDS = Object.freeze(
    Object.keys(productionCases),
);

export async function runTypeScriptProductionQualificationCase(caseId: string) {
    const spec = productionCases[caseId];
    if (!spec) throw new Error(`Unknown production TypeScript qualification case: ${caseId}`);

    const started = performance.now();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-production-qualification-'));
    const analyzer = new TypeScriptSemanticProjectAnalyzer(4);
    try {
        writeFiles(tempRoot, spec.files);
        const beforeRegistry = buildRegistry(tempRoot, spec);
        const beforeEvidence = await analyzer.analyze({
            rootPath: tempRoot,
            language: 'typescript',
            registry: beforeRegistry,
        });
        const beforeClaim = claimFor(beforeEvidence.claimsByFile, spec);

        let registry = beforeRegistry;
        let evidence = beforeEvidence;
        if (spec.mutate) {
            spec.mutate(tempRoot);
            registry = buildRegistry(tempRoot, spec);
            evidence = await analyzer.analyze({
                rootPath: tempRoot,
                language: 'typescript',
                registry,
                previousRegistry: beforeRegistry,
                changedFiles: new Set(spec.changedFiles ?? []),
            });
        }
        const claim = claimFor(evidence.claimsByFile, spec);
        spec.assertTransition?.(beforeClaim, claim);

        const affected = [...(evidence.affectedSourceFiles ?? [])].sort();
        for (const expected of spec.expectedAffected ?? []) {
            if (!affected.includes(expected)) {
                throw new Error(`${spec.caseId} did not invalidate required relationship owner '${expected}': ${affected.join(',')}`);
            }
        }
        for (const forbidden of spec.forbiddenAffected ?? []) {
            if (affected.includes(forbidden)) {
                throw new Error(`${spec.caseId} over-invalidated unrelated relationship owner '${forbidden}': ${affected.join(',')}`);
            }
        }

        return {
            observation: observationFor(spec, claim, registry, affected),
            measurement: {
                wallMs: performance.now() - started,
                inputBytes: Object.values(spec.files).reduce((total, source) => total + Buffer.byteLength(source), 0),
                outputBytes: Buffer.byteLength(JSON.stringify(claim)),
            },
        };
    } finally {
        await analyzer.dispose();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}
