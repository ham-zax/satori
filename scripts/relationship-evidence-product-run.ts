import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectCliMcpSession, type CliMcpSession } from '../packages/cli/src/client.js';

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
        include: ['src/**/*.ts'],
    }, null, 2));
    writeFile(root, 'src/workers.ts', `
export interface WorkerLike {
    request(): string;
}

export class PrimaryWorker implements WorkerLike {
    request(): string { return 'primary'; }
}

export class BackupWorker implements WorkerLike {
    request(): string { return 'backup'; }
}

export function invoke(worker: WorkerLike): string {
    return worker.request();
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
    const workersPath = path.join(root, 'src/workers.ts');
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
    console.log('persisted claim -> query -> call_graph -> architecture -> impact');
    console.log('='.repeat(80));

    const repoRoot = createFixtureRepository();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-relationship-evidence-state-'));
    let session: CliMcpSession | undefined;

    try {
        session = await connect(repoRoot, stateRoot);
        const publicationId = await establishPublication(session, repoRoot);

        const invoke = await outlineSymbol(session, repoRoot, 'src/workers.ts', 'invoke');
        const backup = await outlineSymbol(session, repoRoot, 'src/workers.ts', 'BackupWorker.request');

        const inbound = await callGraph(session, backup.codebaseRoot, backup.target, 'callers', publicationId);
        assert.equal(asRecords(inbound.edges).some((edge) => edge.srcSymbolId === invoke.target.symbolId), false);
        const candidateReference = asRecords(inbound.exactReferences).find((reference) => (
            reference.relationship === 'caller'
            && reference.matchKind === 'candidate_target'
            && reference.decision === 'ambiguous'
            && reference.construct === 'typed_member_call'
            && reference.sourceSymbolId === invoke.target.symbolId
            && reference.targetSymbolId === backup.target.symbolId
        ));
        assert.ok(candidateReference, `Missing ambiguous candidate reference: ${JSON.stringify(inbound)}`);
        const inboundCoverage = asRecord(inbound.inboundCoverageEvidence);
        assert.equal(inboundCoverage?.reason, 'non_authoritative_resolution_evidence');
        assert.equal(inboundCoverage?.ambiguousReferenceCount, 1);

        const outbound = await callGraph(session, invoke.codebaseRoot, invoke.target, 'callees', publicationId);
        assert.equal(asRecords(outbound.edges).length, 0);
        assert.ok(asRecords(outbound.exactReferences).some((reference) => (
            reference.relationship === 'callee'
            && reference.matchKind === 'source_call'
            && reference.decision === 'ambiguous'
            && reference.construct === 'typed_member_call'
        )));
        requireTypedMemberCoverage(outbound);

        const architecture = parseFirstText(await session.callTool('architecture_overview', {
            path: repoRoot,
            scope: 'runtime',
            limit: 20,
        }));
        assert.equal(architecture.status, 'ok', JSON.stringify(architecture));
        const relationshipEvidence = asRecord(architecture.relationshipEvidence);
        assert.ok((relationshipEvidence?.ambiguousClaimCount as number) >= 1);
        const architectureCoverage = asRecords(relationshipEvidence?.constructCoverage)
            .find((row) => row.construct === 'typed_member_call');
        assert.equal(architectureCoverage?.status, 'partial');

        const impact = parseFirstText(await session.callTool('detect_changes', {
            path: repoRoot,
            baseRef: 'HEAD',
            depth: 1,
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

        console.log('PASS persisted ambiguous typed-member evidence remained non-authoritative');
        console.log('PASS exactReferences exposed the candidate call site without fabricating an edge');
        console.log('PASS constructCoverage exposed the exact ambiguous gap');
        console.log('PASS architecture_overview aggregated claim/construct coverage');
        console.log('PASS detect_changes separated uncertain references from confirmed impact');
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
