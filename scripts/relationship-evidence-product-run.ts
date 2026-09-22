import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectCliMcpSession, type CliMcpSession } from '../packages/cli/src/client.js';
import { runSearchQualityEvaluation } from '../evals/search-quality/search-quality-evaluation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SATORI_ROOT = path.resolve(__dirname, '..');
const MCP_ROOT = path.join(SATORI_ROOT, 'packages', 'mcp');
const RUNTIME_ENTRY = path.join(MCP_ROOT, 'dist', 'index.js');
const POTION_ASSETS = path.join(MCP_ROOT, 'assets', 'potion', 'linux-x64');
const POLL_INTERVAL_MS = 100;
const OPERATION_TIMEOUT_MS = 5 * 60_000;

type JsonRecord = Record<string, unknown>;

type SymbolRef = {
    readonly file: string;
    readonly symbolId: string;
    readonly span: {
        readonly startLine: number;
        readonly endLine: number;
    };
};

function asRecord(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : undefined;
}

function asRecords(value: unknown): JsonRecord[] {
    return Array.isArray(value)
        ? value.map(asRecord).filter((record): record is JsonRecord => Boolean(record))
        : [];
}

function parseFirstText(result: Awaited<ReturnType<CliMcpSession['callTool']>>): JsonRecord {
    const content = result.content as Array<{ type?: string; text?: string }>;
    const text = content.find((part) => part.type === 'text')?.text;
    if (!text) throw new Error('Satori tool response did not contain text.');
    if (result.isError === true) throw new Error(`Satori tool failed: ${text}`);
    return JSON.parse(text) as JsonRecord;
}

function requireString(record: JsonRecord, key: string, label: string): string {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} is missing required string '${key}'.`);
    }
    return value;
}

function requireSpan(record: JsonRecord, label: string): SymbolRef['span'] {
    const span = asRecord(record.span);
    if (!span || typeof span.startLine !== 'number' || typeof span.endLine !== 'number') {
        throw new Error(`${label} is missing a valid span.`);
    }
    return { startLine: span.startLine, endLine: span.endLine };
}

function writeFile(root: string, relativePath: string, source: string): void {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
}

function git(root: string, ...args: string[]): string {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function createFixtureRepository(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-relationship-evidence-repo-'));
    writeFile(root, 'tsconfig.json', JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
        },
        include: ['**/*.ts'],
    }, null, 2));
    writeFile(root, 'packages/app/src/workers.ts', `
export interface WorkerLike {
    request(): string;
}

export class PrimaryWorker implements WorkerLike {
    private readonly primaryBrand = true;
    request(): string { return 'primary'; }
}

export class BackupWorker implements WorkerLike {
    private readonly backupBrand = true;
    request(): string { return 'backup'; }
}

export class DecisionWorkerClient {
    constructor(private readonly worker: PrimaryWorker) {}

    run(): string {
        return this.worker.request();
    }
}

export function invoke(worker: WorkerLike): string {
    return worker.request();
}

export function callBackup(worker: BackupWorker): string {
    return worker.request();
}

export function callBackupTransitively(): string {
    return callBackup(new BackupWorker());
}

export function unresolvedObservation(registry: any): unknown {
    return registry.missingRequest();
}
`);
    writeFile(root, 'packages/app/src/textual-target.ts', `
export function textualTarget(): string {
    return 'target';
}

export function dynamicLookup(registry: any): unknown {
    const method = 'textualTarget';
    return registry[method]();
}
`);
    writeFile(root, 'packages/app/src/textual-caller.ts', `
export function externalDynamicLookup(registry: any): unknown {
    const method = 'textualTarget';
    return registry[method]();
}
`);
    writeFile(root, 'packages/excluded/src/textual.ts', `
export function excludedLookup(registry: any): unknown {
    const method = 'textualTarget';
    return registry[method]();
}
`);
    writeFile(root, 'packages/alpha/src/cycle.ts', `
import { betaCycle } from '../../beta/src/cycle.js';

export function alphaCycle(): string {
    return betaCycle();
}
`);
    writeFile(root, 'packages/beta/src/cycle.ts', `
import { alphaCycle } from '../../alpha/src/cycle.js';

export function betaCycle(): string {
    return alphaCycle();
}
`);
    writeFile(root, 'packages/entry/src/start.ts', `
import { alphaCycle } from '../../alpha/src/cycle.js';

export function startArchitecture(): string {
    return alphaCycle();
}
`);
    writeFile(root, 'packages/excluded/src/architecture.ts', `
import { alphaCycle } from '../../alpha/src/cycle.js';

export function excludedArchitecture(): string {
    return alphaCycle();
}
`);
    writeFile(root, 'tools/outside.ts', `
export function outsidePackages(): string {
    return 'outside';
}
`);

    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'satori-fixture@example.invalid');
    git(root, 'config', 'user.name', 'Satori Fixture');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture baseline');

    // Keep HEAD at the baseline while indexing the current tracked worktree.
    // detect_changes can therefore compare HEAD -> current source while the
    // Publication remains fresh for the modified bytes.
    const workersPath = path.join(root, 'packages/app/src/workers.ts');
    fs.writeFileSync(
        workersPath,
        fs.readFileSync(workersPath, 'utf8').replace(
            "request(): string { return 'backup'; }",
            "request(): string { return 'backup-v2'; }",
        ),
    );
    return root;
}

async function connect(repoRoot: string, stateRoot: string): Promise<CliMcpSession> {
    if (!fs.existsSync(RUNTIME_ENTRY)) {
        throw new Error(`Built MCP runtime is missing: ${RUNTIME_ENTRY}. Run pnpm run build:mcp first.`);
    }
    const childEnv = { ...process.env };
    delete childEnv.SATORI_LATEON_PROFILE;
    delete childEnv.SATORI_LATEON_ACTIVATION_POLICY;
    delete childEnv.SATORI_LATEON_MODEL_PATH;

    return connectCliMcpSession({
        command: process.execPath,
        args: [RUNTIME_ENTRY],
        env: {
            ...childEnv,
            EMBEDDING_PROVIDER: 'Potion',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: path.join(stateRoot, 'lancedb'),
            SATORI_STATE_ROOT: stateRoot,
            SATORI_RUNTIME_PROFILE: 'offline',
            SATORI_RERANKER_PROVIDER: 'none',
            POTION_HELPER_PATH: path.join(POTION_ASSETS, 'satori-potion'),
            POTION_MODEL_PATH: path.join(POTION_ASSETS, 'model'),
            POTION_REQUEST_TIMEOUT_MS: '15000',
            SATORI_SESSION_ROOTS_JSON: JSON.stringify([repoRoot]),
        },
        startupTimeoutMs: 30_000,
        callTimeoutMs: OPERATION_TIMEOUT_MS,
        writeStderr: (chunk) => process.stderr.write(chunk),
    });
}

async function status(session: CliMcpSession, root: string): Promise<JsonRecord> {
    return parseFirstText(await session.callTool('manage_index', { action: 'status', path: root }));
}

async function establishPublication(session: CliMcpSession, root: string): Promise<string> {
    const initial = await status(session, root);
    assert.equal(initial.status, 'not_indexed');
    parseFirstText(await session.callTool('manage_index', { action: 'create', path: root }));

    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const current = await status(session, root);
        const operation = asRecord(current.operation);
        if (operation?.phase === 'failed' || operation?.phase === 'blocked') {
            throw new Error(`Fixture indexing ${String(operation.phase)}: ${JSON.stringify(current)}`);
        }
        if (operation?.phase === 'completed') {
            const publication = asRecord(current.publication);
            return requireString(publication ?? {}, 'publicationId', 'Publication');
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for the relationship-evidence fixture Publication.');
}

async function outlineSymbol(
    session: CliMcpSession,
    root: string,
    file: string,
    qualifiedName: string,
): Promise<{ codebaseRoot: string; target: SymbolRef }> {
    const response = parseFirstText(await session.callTool('file_outline', {
        path: root,
        file,
        limitSymbols: 100,
    }));
    assert.equal(response.status, 'ok', JSON.stringify(response));
    const outline = asRecord(response.outline);
    const matches = asRecords(outline?.symbols).filter((symbol) => symbol.qualifiedName === qualifiedName);
    assert.equal(matches.length, 1, `Expected one canonical ${qualifiedName}; saw ${matches.length}.`);
    const target = matches[0];
    return {
        codebaseRoot: requireString(response, 'path', `file_outline ${qualifiedName}`),
        target: {
            file: requireString(target, 'file', `${qualifiedName} target`),
            symbolId: requireString(target, 'symbolId', `${qualifiedName} target`),
            span: requireSpan(target, `${qualifiedName} target`),
        },
    };
}

async function callGraph(
    session: CliMcpSession,
    root: string,
    target: SymbolRef,
    direction: 'callers' | 'callees',
    publicationId: string,
): Promise<JsonRecord> {
    const response = parseFirstText(await session.callTool('call_graph', {
        path: root,
        symbolRef: target,
        direction,
        depth: 1,
        limit: 20,
    }));
    assert.equal(response.status, 'ok', JSON.stringify(response));
    assert.equal(response.supported, true);
    assert.equal(asRecord(response.navigationAuthority)?.publicationId, publicationId);
    return response;
}

function requireTypedMemberCoverage(response: JsonRecord): JsonRecord {
    const coverage = asRecords(response.constructCoverage).find((row) => row.construct === 'typed_member_call');
    assert.ok(coverage, `Missing typed_member_call coverage: ${JSON.stringify(response.constructCoverage)}`);
    assert.equal(coverage.status, 'partial');
    assert.equal(coverage.ambiguousCount, 1);
    assert.ok(asRecords(coverage.gapSpans).some((gap) => gap.decision === 'ambiguous'));
    return coverage;
}

async function main(): Promise<void> {
    console.log('='.repeat(80));
    console.log('RELATIONSHIP EVIDENCE END-TO-END PRODUCT WITNESS');
    console.log('CALLS -> claims -> exact source -> file calibration -> architecture -> impact -> behavioral retrieval');
    console.log('='.repeat(80));

    const repoRoot = createFixtureRepository();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-relationship-evidence-state-'));
    let session: CliMcpSession | undefined;

    try {
        session = await connect(repoRoot, stateRoot);
        const publicationId = await establishPublication(session, repoRoot);

        const workersFile = 'packages/app/src/workers.ts';
        const textualTargetFile = 'packages/app/src/textual-target.ts';
        const textualCallerFile = 'packages/app/src/textual-caller.ts';
        const invoke = await outlineSymbol(session, repoRoot, workersFile, 'invoke');
        const backup = await outlineSymbol(session, repoRoot, workersFile, 'BackupWorker.request');
        const primary = await outlineSymbol(session, repoRoot, workersFile, 'PrimaryWorker.request');
        const clientRun = await outlineSymbol(session, repoRoot, workersFile, 'DecisionWorkerClient.run');
        const directBackup = await outlineSymbol(session, repoRoot, workersFile, 'callBackup');
        const transitiveBackup = await outlineSymbol(session, repoRoot, workersFile, 'callBackupTransitively');
        const unresolved = await outlineSymbol(session, repoRoot, workersFile, 'unresolvedObservation');
        const textualTarget = await outlineSymbol(session, repoRoot, textualTargetFile, 'textualTarget');
        const dynamicLookup = await outlineSymbol(session, repoRoot, textualTargetFile, 'dynamicLookup');

        // A — compiler-proven this.field.request() is an admitted CALLS edge.
        const provenInbound = await callGraph(session, primary.codebaseRoot, primary.target, 'callers', publicationId);
        assert.ok(asRecords(provenInbound.edges).some((edge) => (
            edge.srcSymbolId === clientRun.target.symbolId
            && edge.dstSymbolId === primary.target.symbolId
        )), `Missing proven DecisionWorkerClient.run -> PrimaryWorker.request edge: ${JSON.stringify(provenInbound)}`);

        // B — ambiguous interface dispatch stays claim/reference evidence and never
        // fabricates invoke -> BackupWorker.request even though a different concrete
        // caller of BackupWorker.request is legitimately admitted.
        const inbound = await callGraph(session, backup.codebaseRoot, backup.target, 'callers', publicationId);
        assert.equal(asRecords(inbound.edges).some((edge) => edge.srcSymbolId === invoke.target.symbolId), false);
        assert.ok(asRecords(inbound.edges).some((edge) => edge.srcSymbolId === directBackup.target.symbolId));
        const candidateReference = asRecords(inbound.exactReferences).find((reference) => (
            reference.relationship === 'caller'
            && reference.matchKind === 'candidate_target'
            && reference.decision === 'ambiguous'
            && reference.construct === 'typed_member_call'
            && reference.sourceSymbolId === invoke.target.symbolId
            && reference.targetSymbolId === backup.target.symbolId
        ));
        assert.ok(candidateReference, `Missing ambiguous candidate reference: ${JSON.stringify(inbound)}`);

        const outbound = await callGraph(session, invoke.codebaseRoot, invoke.target, 'callees', publicationId);
        assert.equal(asRecords(outbound.edges).length, 0);
        assert.ok(asRecords(outbound.exactReferences).some((reference) => (
            reference.relationship === 'callee'
            && reference.matchKind === 'source_call'
            && reference.decision === 'ambiguous'
            && reference.construct === 'typed_member_call'
        )));
        requireTypedMemberCoverage(outbound);

        // C — unresolved calls remain visible without an edge.
        const unresolvedGraph = await callGraph(session, unresolved.codebaseRoot, unresolved.target, 'callees', publicationId);
        assert.equal(asRecords(unresolvedGraph.edges).length, 0);
        assert.ok(asRecords(unresolvedGraph.exactReferences).some((reference) => (
            reference.relationship === 'callee'
            && reference.decision === 'unresolved'
            && reference.sourceSymbolId === unresolved.target.symbolId
        )), `Missing unresolved source-call evidence: ${JSON.stringify(unresolvedGraph)}`);

        // D — no semantic claim identifies textualTarget from the computed lookup,
        // but the exact published-source floor recovers the occurrence without CALLS.
        const textualInbound = await callGraph(
            session,
            textualTarget.codebaseRoot,
            textualTarget.target,
            'callers',
            publicationId,
        );
        assert.equal(asRecords(textualInbound.edges).length, 0);
        assert.equal(asRecords(textualInbound.exactReferences).some((reference) => (
            reference.sourceSymbolId === dynamicLookup.target.symbolId
        )), false);
        const observational = asRecords(textualInbound.sourceReferences).find((reference) => (
            reference.sourceSymbolId === dynamicLookup.target.symbolId
            && reference.evidenceClass === 'published_source_text'
        ));
        assert.ok(observational, `Missing no-claim exact source fallback: ${JSON.stringify(textualInbound)}`);
        assert.equal(asRecord(textualInbound.sourceReferenceCoverage)?.status, 'complete');
        assert.equal(asRecord(textualInbound.inboundCoverageEvidence)?.sourceReferenceCoverage, 'complete');

        // E — the first-class public tool is ranking-independent and obeys explicit
        // subtree/include/exclude scope while returning exact spans/owners.
        const exact = parseFirstText(await session.callTool('find_references', {
            path: repoRoot,
            symbolRef: textualTarget.target,
            subtree: 'packages',
            includePaths: ['packages/app', 'packages/excluded'],
            excludePaths: ['packages/excluded'],
            limit: 100,
        }));
        assert.equal(exact.status, 'ok', JSON.stringify(exact));
        assert.equal(exact.rankingIndependent, true);
        assert.equal(asRecord(exact.coverage)?.status, 'complete');
        assert.ok(asRecords(exact.references).some((reference) => (
            reference.file === 'packages/app/src/textual-target.ts'
            && asRecord(reference.owningSymbol)?.symbolId === dynamicLookup.target.symbolId
            && typeof asRecord(reference.span)?.startColumn === 'number'
        )));
        assert.equal(asRecords(exact.references).some((reference) => (
            String(reference.file).startsWith('packages/excluded/')
        )), false);

        // F — file-level calibration is discoverable without selecting a symbol.
        const calibration = parseFirstText(await session.callTool('file_outline', {
            path: repoRoot,
            file: workersFile,
            detail: 'relationship_coverage',
            limitSymbols: 100,
        }));
        assert.equal(calibration.status, 'ok', JSON.stringify(calibration));
        const fileEvidence = asRecord(calibration.relationshipEvidence);
        assert.ok((fileEvidence?.resolvedClaimCount as number) >= 1);
        assert.ok((fileEvidence?.ambiguousClaimCount as number) >= 1);
        assert.ok((fileEvidence?.unresolvedClaimCount as number) >= 1);
        assert.ok(asRecords(fileEvidence?.constructCoverage).some((row) => (
            row.construct === 'typed_member_call'
        )));

        // G — architecture preserves construct coverage and applies one path scope
        // consistently while reporting structural entries and area-level cycles.
        const architecture = parseFirstText(await session.callTool('architecture_overview', {
            path: repoRoot,
            scope: 'all',
            subtree: 'packages',
            excludePaths: ['packages/excluded'],
            limit: 20,
        }));
        assert.equal(architecture.status, 'ok', JSON.stringify(architecture));
        const relationshipEvidence = asRecord(architecture.relationshipEvidence);
        assert.ok((relationshipEvidence?.ambiguousClaimCount as number) >= 1);
        const architectureCoverage = asRecords(relationshipEvidence?.constructCoverage)
            .find((row) => row.construct === 'typed_member_call');
        assert.ok(architectureCoverage);
        const architectureScope = asRecord(architecture.pathScope);
        assert.equal(architectureScope?.subtree, 'packages');
        assert.deepEqual(architectureScope?.excludePaths, ['packages/excluded']);
        assert.equal(asRecords(architecture.areas).some((area) => String(area.area).includes('excluded')), false);
        assert.ok(asRecords(architecture.entryCandidates).some((entry) => (
            entry.label === 'function startArchitecture()'
            || String(entry.label).includes('startArchitecture')
        )));
        assert.ok(asRecords(architecture.cycles).some((cycle) => {
            const areas = Array.isArray(cycle.areas) ? cycle.areas : [];
            return areas.includes('packages/alpha') && areas.includes('packages/beta');
        }), `Missing alpha/beta area cycle: ${JSON.stringify(architecture.cycles)}`);

        // H — proof-backed direct/transitive impact carries real CALLS paths while the
        // ambiguous invoke reference remains uncertain and never joins impacted.
        const impact = parseFirstText(await session.callTool('detect_changes', {
            path: repoRoot,
            baseRef: 'HEAD',
            depth: 3,
            limit: 50,
        }));
        assert.equal(impact.status, 'ok', JSON.stringify(impact));
        assert.ok(asRecords(impact.uncertainCallReferences).some((reference) => (
            reference.seedSymbolId === backup.target.symbolId
            && reference.sourceSymbolId === invoke.target.symbolId
            && reference.decision === 'ambiguous'
            && reference.construct === 'typed_member_call'
        )));
        assert.equal(asRecords(impact.impacted).some((symbol) => symbol.symbolId === invoke.target.symbolId), false);
        const directImpact = asRecords(impact.impacted).find((symbol) => (
            symbol.symbolId === directBackup.target.symbolId
        ));
        const transitiveImpact = asRecords(impact.impacted).find((symbol) => (
            symbol.symbolId === transitiveBackup.target.symbolId
        ));
        assert.equal(directImpact?.impactClass, 'direct');
        assert.equal(directImpact?.distance, 1);
        assert.equal(transitiveImpact?.impactClass, 'transitive');
        assert.equal(transitiveImpact?.distance, 2);
        assert.equal(asRecords(transitiveImpact?.causalPath).length, 2);
        assert.ok(asRecords(impact.areaImpact).some((area) => (
            area.area === 'packages/app'
            && (area.directCount as number) >= 1
            && (area.transitiveCount as number) >= 1
        )));
        assert.equal(asRecord(impact.completeness)?.exhaustive, false);

        // I — behavioral retrieval is a separate benchmark lane, not semantic
        // qualification. The durable inferPhase-equivalent owner case must be
        // recovered inside the ordinary top-3 product budget.
        const behavioral = await runSearchQualityEvaluation(SATORI_ROOT);
        const behavioralRows = behavioral.results.filter((row) => (
            row.workloadId === 'behavioral_owner_infer_phase'
        ));
        assert.equal(behavioralRows.length, behavioral.limits.length);
        assert.equal(behavioralRows
            .filter((row) => row.limit >= 3)
            .every((row) => row.ownerRank !== null && row.ownerRank <= 3), true);

        // J — after Publication, a changed caller cannot be scanned as if it still
        // belonged to that Publication generation. The old target identity remains
        // canonical, but the changed caller is skipped and completeness is partial.
        const textualCallerPath = path.join(repoRoot, textualCallerFile);
        const publishedCallerSource = fs.readFileSync(textualCallerPath, 'utf8');
        fs.writeFileSync(
            textualCallerPath,
            publishedCallerSource.replace('textualTarget', 'textualTargetChanged'),
        );
        const staleCallerExact = parseFirstText(await session.callTool('find_references', {
            path: repoRoot,
            symbolRef: textualTarget.target,
            includePaths: [textualTargetFile, textualCallerFile],
            limit: 100,
        }));
        assert.equal(staleCallerExact.status, 'ok', JSON.stringify(staleCallerExact));
        assert.equal(staleCallerExact.publicationId, publicationId);
        const staleCallerCoverage = asRecord(staleCallerExact.coverage);
        assert.equal(staleCallerCoverage?.status, 'partial');
        assert.equal(staleCallerCoverage?.eligibleFileCount, 2);
        assert.equal(staleCallerCoverage?.inspectedFileCount, 1);
        assert.equal(staleCallerCoverage?.skippedFileCount, 1);
        assert.ok(asRecords(staleCallerCoverage?.reasons).some((reason) => (
            reason.code === 'source_changed' && reason.file === textualCallerFile
        )), `Missing stale-caller source_changed reason: ${JSON.stringify(staleCallerExact)}`);
        assert.equal(asRecords(staleCallerExact.references).some((reference) => (
            reference.file === textualCallerFile
        )), false);
        assert.notEqual(staleCallerCoverage?.status, 'complete');

        // K — call_graph uses the same generation-bound scanner. A stale caller
        // therefore makes source-reference coverage partial and never contributes
        // observational evidence from its post-Publication bytes.
        const staleCallerGraph = await callGraph(
            session,
            textualTarget.codebaseRoot,
            textualTarget.target,
            'callers',
            publicationId,
        );
        const staleGraphCoverage = asRecord(staleCallerGraph.sourceReferenceCoverage);
        assert.equal(staleGraphCoverage?.status, 'partial');
        assert.ok(asRecords(staleGraphCoverage?.reasons).some((reason) => (
            reason.code === 'source_changed' && reason.file === textualCallerFile
        )), `Missing call_graph source_changed reason: ${JSON.stringify(staleCallerGraph)}`);
        assert.equal(asRecords(staleCallerGraph.sourceReferences).some((reference) => (
            asRecord(reference.site)?.file === textualCallerFile
        )), false);
        assert.equal(asRecord(staleCallerGraph.inboundCoverageEvidence)?.sourceReferenceCoverage, 'partial');
        assert.ok(Array.isArray(staleCallerGraph.warnings)
            && staleCallerGraph.warnings.includes('CALL_GRAPH_SOURCE_REFERENCE_COVERAGE_PARTIAL'));

        // Restore the caller to its exact published bytes so only the target differs
        // in the next generation-identity case.
        fs.writeFileSync(textualCallerPath, publishedCallerSource);

        // L — renaming the target after Publication cannot mix the old canonical
        // symbol identity with post-Publication target bytes and report complete.
        const textualTargetPath = path.join(repoRoot, textualTargetFile);
        const publishedTargetSource = fs.readFileSync(textualTargetPath, 'utf8');
        fs.writeFileSync(
            textualTargetPath,
            publishedTargetSource.replace('export function textualTarget', 'export function renamedTextualTarget'),
        );
        const staleTargetExact = parseFirstText(await session.callTool('find_references', {
            path: repoRoot,
            symbolRef: textualTarget.target,
            includePaths: [textualTargetFile, textualCallerFile],
            limit: 100,
        }));
        assert.equal(staleTargetExact.status, 'ok', JSON.stringify(staleTargetExact));
        assert.equal(staleTargetExact.publicationId, publicationId);
        assert.equal(asRecord(staleTargetExact.target)?.symbolId, textualTarget.target.symbolId);
        const staleTargetCoverage = asRecord(staleTargetExact.coverage);
        assert.equal(staleTargetCoverage?.status, 'partial');
        assert.equal(staleTargetCoverage?.eligibleFileCount, 2);
        assert.equal(staleTargetCoverage?.inspectedFileCount, 1);
        assert.equal(staleTargetCoverage?.skippedFileCount, 1);
        assert.ok(asRecords(staleTargetCoverage?.reasons).some((reason) => (
            reason.code === 'source_changed' && reason.file === textualTargetFile
        )), `Missing stale-target source_changed reason: ${JSON.stringify(staleTargetExact)}`);
        assert.equal(asRecords(staleTargetExact.references).some((reference) => (
            reference.file === textualTargetFile
        )), false);
        assert.notEqual(staleTargetCoverage?.status, 'complete');

        console.log('PASS A proven this.field typed member became authoritative CALLS');
        console.log('PASS B ambiguous typed member stayed non-authoritative');
        console.log('PASS C unresolved observation stayed visible without CALLS');
        console.log('PASS D no-claim target recovered through exact published-source occurrences');
        console.log('PASS E find_references obeyed subtree/include/exclude with complete coverage');
        console.log('PASS F file_outline exposed per-file construct calibration');
        console.log('PASS G architecture scope, entry candidates, cycles, and construct coverage passed');
        console.log('PASS H impact distinguished proof-backed paths from uncertain references');
        console.log('PASS I behavioral retrieval replay recovered the durable inferPhase-equivalent owner');
        console.log('PASS J stale caller was excluded from Publication-coherent find_references coverage');
        console.log('PASS K call_graph source fallback reported partial coverage for stale source');
        console.log('PASS L stale target could not combine old identity with current bytes as complete');
        console.log('='.repeat(80));
        console.log('RELATIONSHIP EVIDENCE PRODUCT WITNESS PASSED');
        console.log('='.repeat(80));
    } finally {
        if (session) await session.close();
        fs.rmSync(stateRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error('Relationship evidence product witness failed:', error);
    process.exit(1);
});
