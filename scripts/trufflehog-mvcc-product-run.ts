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
const TARGET_REPO = process.env.SATORI_TASK7_REPO || '/home/hamza/repo/trufflehog';
const POTION_ASSETS = path.join(MCP_ROOT, 'assets', 'potion', 'linux-x64');
const POLL_INTERVAL_MS = 100;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
const TASK7_DEBUG = process.env.SATORI_TASK7_DEBUG !== '0';
const KEEP_FAILED_STATE = process.env.SATORI_TASK7_KEEP_STATE_ON_FAILURE === '1';

type JsonRecord = Record<string, unknown>;

type OperationIdentity = {
    id: string;
    action: string;
    generation: number;
    phase: string;
};

type PublicationIdentity = {
    collectionName: string;
    markerRunId: string;
};

type StatusTraceEntry = {
    observedAt: string;
    status: unknown;
    reason: unknown;
    operation?: OperationIdentity;
    publication?: PublicationIdentity;
};

function asRecord(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : undefined;
}

function formatError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function debug(label: string, value?: unknown): void {
    if (!TASK7_DEBUG) return;
    if (value === undefined) {
        console.error(`[TASK7-DEBUG] ${label}`);
        return;
    }
    console.error(`[TASK7-DEBUG] ${label}:\n${JSON.stringify(value, null, 2)}`);
}

function parseFirstText(result: Awaited<ReturnType<CliMcpSession['callTool']>>): JsonRecord {
    const content = result.content as Array<{ type?: string; text?: string }>;
    const text = content.find((part) => part.type === 'text')?.text;
    if (!text) throw new Error('Satori tool response did not contain text.');
    if (result.isError === true) throw new Error(`Satori tool failed: ${text}`);
    return JSON.parse(text) as JsonRecord;
}

function readOperation(response: JsonRecord): OperationIdentity | undefined {
    const operation = asRecord(response.operation);
    if (!operation) return undefined;
    if (
        typeof operation.id !== 'string'
        || typeof operation.action !== 'string'
        || typeof operation.generation !== 'number'
        || typeof operation.phase !== 'string'
    ) return undefined;
    return {
        id: operation.id,
        action: operation.action,
        generation: operation.generation,
        phase: operation.phase,
    };
}

function readPublication(response: JsonRecord): PublicationIdentity | undefined {
    const publication = asRecord(response.publication);
    if (
        !publication
        || typeof publication.collectionName !== 'string'
        || publication.collectionName.length === 0
        || typeof publication.markerRunId !== 'string'
        || publication.markerRunId.length === 0
    ) return undefined;
    return {
        collectionName: publication.collectionName,
        markerRunId: publication.markerRunId,
    };
}

function requirePublication(response: JsonRecord, label: string): PublicationIdentity {
    const publication = readPublication(response);
    if (!publication) {
        debug(`${label} response missing publication`, response);
        throw new Error(`${label} did not expose a proven publication identity.`);
    }
    return publication;
}

function git(args: string[], cwd = SATORI_ROOT): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function assertCleanWorktree(repoPath: string, label: string): void {
    const dirty = git(['status', '--porcelain', '--untracked-files=all'], repoPath);
    if (dirty.length > 0) {
        throw new Error(`${label} must be clean before Task 7 qualification. Dirty paths:\n${dirty}`);
    }
}

function buildExactHead(): string {
    assertCleanWorktree(SATORI_ROOT, 'Satori worktree');
    const head = git(['rev-parse', 'HEAD']);
    execFileSync('pnpm', ['run', 'build'], {
        cwd: SATORI_ROOT,
        stdio: 'inherit',
        env: process.env,
    });
    assertCleanWorktree(SATORI_ROOT, 'Satori worktree after build');
    if (!fs.existsSync(RUNTIME_ENTRY)) {
        throw new Error(`Built MCP runtime is missing: ${RUNTIME_ENTRY}`);
    }
    const headAfterBuild = git(['rev-parse', 'HEAD']);
    if (headAfterBuild !== head) {
        throw new Error(`Satori HEAD moved during build (${head} -> ${headAfterBuild}).`);
    }
    return head;
}

function chooseTrackedGoFile(repoPath: string): string {
    const output = execFileSync('git', ['-C', repoPath, 'ls-files', '-z', '--', '*.go']);
    const files = output.toString('utf8').split('\0').filter(Boolean);
    const candidate = files.find((relativePath) => {
        const base = path.basename(relativePath);
        return !base.endsWith('_test.go') && !relativePath.includes('/vendor/');
    }) ?? files[0];
    if (!candidate) throw new Error('Target repository has no tracked Go file to mutate for Task 7.');
    return path.join(repoPath, candidate);
}

async function connect(stateRoot: string): Promise<CliMcpSession> {
    const helperPath = path.join(POTION_ASSETS, 'satori-potion');
    const modelPath = path.join(POTION_ASSETS, 'model');
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
            SATORI_TASK7_DEBUG: TASK7_DEBUG ? '1' : '0',
            POTION_HELPER_PATH: helperPath,
            POTION_MODEL_PATH: modelPath,
            POTION_REQUEST_TIMEOUT_MS: '15000',
            SATORI_SESSION_ROOTS_JSON: JSON.stringify([TARGET_REPO]),
        },
        startupTimeoutMs: 30_000,
        callTimeoutMs: OPERATION_TIMEOUT_MS,
        writeStderr: (chunk) => process.stderr.write(chunk),
    });
}

async function readStatus(session: CliMcpSession): Promise<JsonRecord> {
    return parseFirstText(await session.callTool('manage_index', {
        action: 'status',
        path: TARGET_REPO,
    }));
}

function statusTraceEntry(status: JsonRecord): StatusTraceEntry {
    return {
        observedAt: new Date().toISOString(),
        status: status.status,
        reason: status.reason,
        ...(readOperation(status) ? { operation: readOperation(status) } : {}),
        ...(readPublication(status) ? { publication: readPublication(status) } : {}),
    };
}

async function waitForOperationPhase(
    session: CliMcpSession,
    predicate: (operation: OperationIdentity) => boolean,
    description: string,
): Promise<{ status: JsonRecord; operation: OperationIdentity }> {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    const history: StatusTraceEntry[] = [];
    let lastSignature = '';

    while (Date.now() < deadline) {
        const status = await readStatus(session);
        const trace = statusTraceEntry(status);
        const signature = JSON.stringify({
            status: trace.status,
            reason: trace.reason,
            operation: trace.operation,
            publication: trace.publication,
        });
        if (signature !== lastSignature) {
            history.push(trace);
            if (history.length > 20) history.shift();
            if (TASK7_DEBUG) {
                console.error(`[TASK7-TRACE] ${description}: ${signature}`);
            }
            lastSignature = signature;
        }

        const operation = trace.operation;
        if (operation) {
            if (operation.phase === 'failed' || operation.phase === 'blocked') {
                debug(`${description} terminal failure status`, status);
                throw new Error(`Index operation ${operation.id} ${operation.phase}: ${JSON.stringify(status)}`);
            }
            if (predicate(operation)) return { status, operation };
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(
        `Timed out waiting for ${description}. Recent status transitions:\n${JSON.stringify(history, null, 2)}`,
    );
}

async function establishPublicationN(session: CliMcpSession): Promise<PublicationIdentity> {
    const initial = await readStatus(session);
    debug('Initial isolated-state status', initial);
    const initialStatus = initial.status;
    if (initialStatus !== 'not_indexed' && initialStatus !== 'requires_reindex') {
        throw new Error(`Isolated Task 7 state unexpectedly returned status=${String(initialStatus)}.`);
    }

    const action = initialStatus === 'requires_reindex' ? 'reindex' : 'create';
    const start = parseFirstText(await session.callTool('manage_index', {
        action,
        path: TARGET_REPO,
    }));
    debug(`${action} start response`, start);
    const startedOperation = readOperation(start);

    const completed = await waitForOperationPhase(
        session,
        (operation) => (
            operation.phase === 'completed'
            && (!startedOperation || operation.id === startedOperation.id)
        ),
        `${action} completion`,
    );
    debug('Publication N completed status', completed.status);
    return requirePublication(completed.status, 'Publication N');
}

async function main(): Promise<void> {
    console.log('='.repeat(80));
    console.log('TASK 7: REAL STALE-WHILE-SYNC PRODUCT CHARACTERIZATION');
    console.log(`Target repository: ${TARGET_REPO}`);
    console.log(`Task-7 diagnostics: ${TASK7_DEBUG ? 'enabled' : 'disabled'}`);
    console.log('='.repeat(80));

    if (!fs.existsSync(TARGET_REPO)) throw new Error(`Target repository does not exist: ${TARGET_REPO}`);
    assertCleanWorktree(TARGET_REPO, 'Target repository');
    const qualifiedHead = buildExactHead();
    console.log(`Exact Satori HEAD: ${qualifiedHead}`);

    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-task7-mvcc-'));
    const mutationPath = chooseTrackedGoFile(TARGET_REPO);
    const originalBytes = fs.readFileSync(mutationPath);
    let session: CliMcpSession | undefined;
    let failure: unknown;

    try {
        session = await connect(stateRoot);

        console.log('\n[1/5] Establishing immutable publication N in isolated Satori state...');
        const publicationN = await establishPublicationN(session);
        console.log(`Publication N: ${publicationN.collectionName} / ${publicationN.markerRunId}`);

        console.log('\n[2/5] Creating one real tracked Go-source delta...');
        const markerTs = Date.now();
        const mutationIdentifier = `satoriTask7Mvcc_${qualifiedHead.slice(0, 12)}_${markerTs}`;
        const relativeMutationPath = path.relative(TARGET_REPO, mutationPath);
        const marker = `\n// satori-task7-mvcc-${qualifiedHead.slice(0, 12)}-${markerTs}\nvar ${mutationIdentifier} = true\n`;
        fs.writeFileSync(mutationPath, Buffer.concat([originalBytes, Buffer.from(marker, 'utf8')]));
        console.log(`Mutated tracked source: ${relativeMutationPath} (mutation identifier: ${mutationIdentifier})`);

        console.log('[3/5] Starting real sync and requiring observation of its writing phase...');
        const syncRequest = session.callTool('manage_index', {
            action: 'sync',
            path: TARGET_REPO,
        });

        const writing = await waitForOperationPhase(
            session,
            (operation) => operation.action === 'sync' && operation.phase === 'writing',
            'the real sync to enter writing',
        );
        const syncOperation = writing.operation;
        console.log(`Observed sync writing: id=${syncOperation.id}, generation=${syncOperation.generation}`);
        debug('Status at observed writing phase', writing.status);

        const searchQueries = [
            'where is detector verification handled',
            'git log scanner credentials',
            'chunk parser token',
            'entropy calculation secret',
            'trufflehog output formatter',
        ];

        console.log('[4/5] Firing five parallel searches while that exact sync is writing...');
        const searchResults = await Promise.all(searchQueries.map(async (query, index) => {
            const startedAt = performance.now();
            try {
                const response = parseFirstText(await session!.callTool('search_codebase', {
                    path: TARGET_REPO,
                    query,
                    limit: 5,
                }));
                const elapsedMs = performance.now() - startedAt;
                debug(`Search #${index + 1} response (${elapsedMs.toFixed(1)}ms)`, response);
                return { index, query, response, elapsedMs };
            } catch (error) {
                console.error(
                    `[TASK7-FAIL] Search #${index + 1} transport/tool failure for ${JSON.stringify(query)} `
                    + `after ${(performance.now() - startedAt).toFixed(1)}ms: ${formatError(error)}`,
                );
                throw error;
            }
        }));

        for (const result of searchResults) {
            if (result.response.status !== 'ok') {
                debug(`Search #${result.index + 1} non-ok envelope`, result.response);
                throw new Error(`Search #${result.index + 1} returned status=${String(result.response.status)}.`);
            }
            const freshness = asRecord(result.response.freshness);
            const pendingOperation = asRecord(freshness?.pendingOperation);
            if (freshness?.state !== 'sync_in_progress') {
                debug(`Search #${result.index + 1} unexpected freshness`, freshness);
                throw new Error(`Search #${result.index + 1} did not report sync_in_progress freshness.`);
            }
            if (
                freshness.servedCollection !== publicationN.collectionName
                || freshness.servedRunId !== publicationN.markerRunId
            ) {
                throw new Error(
                    `Search #${result.index + 1} was not pinned to publication N: ${JSON.stringify(freshness)}`,
                );
            }
            if (
                pendingOperation?.action !== 'sync'
                || pendingOperation.generation !== syncOperation.generation
            ) {
                throw new Error(
                    `Search #${result.index + 1} did not identify the active sync generation: ${JSON.stringify(freshness)}`,
                );
            }
            const resultCount = Array.isArray(result.response.results) ? result.response.results.length : 0;
            if (resultCount === 0) {
                debug(`Search #${result.index + 1} empty result envelope`, result.response);
                throw new Error(
                    `Search #${result.index + 1} returned zero results while serving publication N; ` 
                    + 'a stale read must return useful published-generation retrieval.',
                );
            }
            console.log(
                `  Search #${result.index + 1}: ok, ${result.elapsedMs.toFixed(1)}ms, `
                + `${resultCount} results, served N`,
            );
        }

        const syncStartResponse = parseFirstText(await syncRequest);
        debug('Sync tool response', syncStartResponse);
        const syncStartOperation = readOperation(syncStartResponse);
        if (
            syncStartOperation
            && (
                syncStartOperation.id !== syncOperation.id
                || syncStartOperation.generation !== syncOperation.generation
            )
        ) {
            throw new Error(
                `Sync tool response identity disagreed with observed writing operation: `
                + `${JSON.stringify(syncStartOperation)} vs ${JSON.stringify(syncOperation)}`,
            );
        }

        const completed = await waitForOperationPhase(
            session,
            (operation) => (
                operation.id === syncOperation.id
                && operation.generation === syncOperation.generation
                && operation.phase === 'completed'
            ),
            `sync ${syncOperation.id} completion`,
        );
        debug('Completed sync status', completed.status);
        const publicationN1 = requirePublication(completed.status, 'Publication N+1');
        if (publicationN1.markerRunId === publicationN.markerRunId) {
            throw new Error('Sync completed without activating a distinct publication markerRunId.');
        }
        console.log(`Publication N+1: ${publicationN1.collectionName} / ${publicationN1.markerRunId}`);

        console.log('[5/5] Verifying a post-activation search reads publication N+1...');
        const postSearch = parseFirstText(await session.callTool('search_codebase', {
            path: TARGET_REPO,
            query: mutationIdentifier,
            limit: 5,
        }));
        debug('Post-activation search response', postSearch);
        if (postSearch.status !== 'ok') {
            throw new Error(`Post-activation search returned status=${String(postSearch.status)}.`);
        }
        const postResults = Array.isArray(postSearch.results)
            ? postSearch.results as Array<{ target?: { file?: string }; preview?: string }>
            : [];
        const mutationHits = postResults.filter(
            (result) => (
                result?.target?.file === relativeMutationPath
                && typeof result.preview === 'string'
                && result.preview.includes(mutationIdentifier)
            ),
        );
        if (mutationHits.length === 0) {
            debug('Post-activation search did not return the N+1 mutation', postSearch);
            throw new Error(
                'Post-activation search did not prove it read publication N+1: '
                + 'no result contained the unique N+1 mutation identifier.',
            );
        }
        const postStatus = await readStatus(session);
        debug('Post-activation manage_index status', postStatus);
        const postPublication = requirePublication(postStatus, 'Post-activation publication');
        if (
            postPublication.collectionName !== publicationN1.collectionName
            || postPublication.markerRunId !== publicationN1.markerRunId
        ) {
            throw new Error('Active publication changed unexpectedly during the post-activation search.');
        }

        console.log('\n' + '='.repeat(80));
        console.log('TASK 7 PRODUCT CHARACTERIZATION PASSED');
        console.log(`Exact head: ${qualifiedHead}`);
        console.log(' - real tracked source delta forced a non-noop sync');
        console.log(` - exact sync generation ${syncOperation.generation} was observed in writing`);
        console.log(' - 5/5 parallel searches returned status=ok with non-empty results during writing');
        console.log(' - every search identified the same immutable publication N and pending sync');
        console.log(' - the exact sync completed and activated a distinct publication N+1');
        console.log(' - the post-activation search proved N+1 by returning the unique mutation identifier from the mutated file');
        console.log('='.repeat(80));
    } catch (error) {
        failure = error;
        console.error(`[TASK7-FAIL] ${formatError(error)}`);
        if (session) {
            try {
                debug('Final manage_index status after failure', await readStatus(session));
            } catch (statusError) {
                console.error(`[TASK7-FAIL] Could not read final status: ${formatError(statusError)}`);
            }
        }
        throw error;
    } finally {
        if (session) await session.close();
        fs.writeFileSync(mutationPath, originalBytes);
        assertCleanWorktree(TARGET_REPO, 'Target repository after restoration');
        if (failure && KEEP_FAILED_STATE) {
            console.error(`[TASK7-DEBUG] Preserving failed isolated state root: ${stateRoot}`);
        } else {
            fs.rmSync(stateRoot, { recursive: true, force: true });
        }
    }
}

main().catch((error) => {
    console.error('Task 7 Product Characterization Failed:', error);
    process.exit(1);
});
