import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Frozen S1 structural-label replay. Read-only: no production/module/index edits.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = fileURLToPath(import.meta.url);
const tracePath = path.join(path.dirname(scriptPath), 'fixtures/s1-normalization-trace.json');
const normalizationResultPath = path.join(path.dirname(scriptPath), 'fixtures/s1-normalization-result.json');
const workerId = process.env.CLAIVE_WORKER_ID ?? null;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256File = async (file) => sha256(await fs.readFile(file));
let recordInput = () => {};
const load = (relative) => { const file = path.join(repo, relative); recordInput(file); return import(pathToFileURL(file).href); };
const req = createRequire(path.join(repo, 'package.json'));

function parseArgs(argv) {
    assert.equal(argv.length, 4, 'Use --foundation ABS --out ABS');
    assert.equal(argv[0], '--foundation');
    assert.equal(argv[2], '--out');
    assert(path.isAbsolute(argv[1]) && path.isAbsolute(argv[3]));
    return { foundation: argv[1], out: argv[3] };
}

function canonicalSpan(span) {
    return JSON.stringify({
        startLine: span?.startLine ?? null,
        endLine: span?.endLine ?? null,
        startByte: span?.startByte ?? null,
        endByte: span?.endByte ?? null,
        startColumn: span?.startColumn ?? null,
        endColumn: span?.endColumn ?? null,
    });
}

function dropStructural(document) {
    const parsed = JSON.parse(document);
    delete parsed.structural_context;
    return parsed;
}

function collectDiffPaths(left, right, prefix = '', out = []) {
    if (left === right) return out;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        out.push({ path: prefix || '$', left, right });
        return out;
    }
    if (Array.isArray(left) !== Array.isArray(right)) {
        out.push({ path: prefix || '$', left, right });
        return out;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
        collectDiffPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
}

function targetFromWindowFixture(fixture, variant, targetTraceId) {
    const stages = fixture.variants[variant].stages;
    const window = stages.find((stage) => stage.stage === 'reranker_input');
    const provider = stages.find((stage) => stage.stage === 'reranker_provider_output');
    const position = window?.candidates.findIndex((row) => row.id === targetTraceId) ?? -1;
    const providerRow = provider?.candidates.find((row) => row.id === targetTraceId);
    return {
        variant,
        presentInWindow: position >= 0,
        windowPosition: position >= 0 ? position + 1 : null,
        providerRank: providerRow?.rank ?? null,
        providerScore: providerRow?.score ?? null,
    };
}

async function hashTree(root) {
    const entries = [];
    async function walk(directory) {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(directory, child.name);
            if (child.isDirectory()) await walk(absolute);
            else if (child.isFile()) {
                entries.push({
                    path: path.relative(root, absolute).replaceAll('\\', '/'),
                    sha256: await sha256File(absolute),
                    bytes: (await fs.stat(absolute)).size,
                });
            }
        }
    }
    await walk(root);
    return {
        root,
        fileCount: entries.length,
        aggregateSha256: sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}`).join('\n')),
        files: entries,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await assert.rejects(fs.access(args.out), { code: 'ENOENT' }, `Refusing to overwrite ${args.out}`);
    const result = {
        schemaVersion: 1,
        experiment: 's1-graph-ranking',
        status: 'running',
        workerId,
        model: process.env.PI_MODEL ?? null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        output: args.out,
        repo,
        caveats: [
            'Oracle-assisted admitted control: the 64-candidate window is fixed from the admitted capture. This is not automatic admission, new retrieval, or S1 acceptance.',
            'The admitted-control window and original query/callerTerms are frozen; only structural_context labels differ across arms.',
            'Historical providerRank 58 is context only, not a guaranteed reproduction: this run empties structural context and uses current v22 owners.',
            'Structural labels use the existing search_rerank_document_v5 producer and exact read-back instance identities; no custom document JSON, weights, excerpts, or policy were added.',
            'Provider/fusion ranks are within this fixed window. No grouped, 72-query, benchmark, external-control, or cross-repository admission claim is made.',
            'React r2 remains open and unchanged.',
        ],
        failures: [],
    };

    let reranker;
    let table;
    let connection;
    const beforeHashes = new Map();
    const usedFiles = new Set();
    const recordFile = (absolute) => {
        if (!absolute) return;
        const resolved = path.resolve(absolute);
        usedFiles.add(resolved);
        // Capture the first observed bytes before that input participates in projection or inference.
        if (!beforeHashes.has(resolved)) beforeHashes.set(resolved, sha256(fsSync.readFileSync(resolved)));
    };
    recordInput = recordFile;
    recordFile(scriptPath);
    try {
        recordFile(args.foundation);
        const foundationBytes = await fs.readFile(args.foundation);
        const foundation = JSON.parse(foundationBytes);
        recordFile(args.foundation);
        assert.equal(foundation.status, 'ok', 'Foundation input is not a successful run.');
        assert.equal(foundation.phase4?.foundationProven, true, 'Foundation did not prove both edges.');
        assert.equal(foundation.phase4.edges.length, 2);
        assert(foundation.phase4.edges.every((edge) => edge.status === 'admitted'
            && edge.records?.some((record) => record.resolutionAuthority === 'direct_binding')));
        const newNavigationRoot = foundation.publication.navigationRoot;
        const newPublicationId = path.basename(path.dirname(newNavigationRoot));
        assert.equal(path.basename(newNavigationRoot), 'navigation');

        recordFile(tracePath);
        recordFile(normalizationResultPath);
        const traceBytes = await fs.readFile(tracePath);
        const normalizationResultBytes = await fs.readFile(normalizationResultPath);
        const trace = JSON.parse(traceBytes);
        const normalizationResult = JSON.parse(normalizationResultBytes);
        recordFile(tracePath);
        recordFile(normalizationResultPath);
        assert.equal(trace.publicationId, normalizationResult.publication.id);
        const oldNavigationRoot = normalizationResult.publication.navigationRoot;
        assert.equal(path.basename(oldNavigationRoot), 'navigation');
        const oldPublicationId = path.basename(path.dirname(oldNavigationRoot));

        const targetTraceId = 'chunk_bf3988e381be449e';
        const admittedStage = (name) => {
            const found = trace.variants.admitted.stages.filter((stage) => stage.stage === name);
            assert.equal(found.length, 1);
            assert.equal(found[0].total, found[0].candidates.length);
            return found[0].candidates;
        };
        const windowIds = admittedStage('reranker_input').map((row) => row.id);
        assert.equal(windowIds.length, 64);
        assert.equal(new Set(windowIds).size, 64);
        assert(windowIds.includes(targetTraceId));
        const callerTerms = [...trace.variants.admitted.callerTerms];
        assert.deepEqual(callerTerms, ['search code handler']);
        const query = trace.query;

        result.foundation = {
            path: args.foundation,
            sha256: sha256(foundationBytes),
            status: foundation.status,
            proven: foundation.phase4.foundationProven,
            edges: foundation.phase4.edges.map((edge) => ({
                label: edge.label,
                sourceInstanceId: edge.source.symbolInstanceId,
                targetInstanceId: edge.target.symbolInstanceId,
                authority: edge.records?.[0]?.resolutionAuthority ?? null,
            })),
            newPublicationId,
            newNavigationRoot,
        };
        result.trace = {
            path: tracePath,
            sha256: sha256(traceBytes),
            publicationId: trace.publicationId,
            collection: trace.collection,
            query,
            variant: 'admitted',
            callerTerms,
            windowSize: windowIds.length,
            targetTraceId,
            historical: {
                baseline: targetFromWindowFixture(trace, 'baseline', targetTraceId),
                admitted: targetFromWindowFixture(trace, 'admitted', targetTraceId),
            },
        };
        result.oldPublication = {
            path: normalizationResultPath,
            sha256: sha256(normalizationResultBytes),
            publicationId: oldPublicationId,
            navigationRoot: oldNavigationRoot,
        };

        for (const root of [oldNavigationRoot, newNavigationRoot]) {
            const snapshot = await hashTree(root);
            for (const file of snapshot.files) recordFile(path.join(root, file.path));
        }
        const reading = await load('packages/core/src/symbols/sidecar-reads.ts');
        const oldRegistryState = await reading.readSymbolRegistrySidecar({
            normalizedRootPath: repo,
            publicationId: oldPublicationId,
            navigationRoot: oldNavigationRoot,
        });
        assert.equal(oldRegistryState.status, 'ok', `Old registry read failed: ${oldRegistryState.reason}`);
        const newRegistryState = await reading.readSymbolRegistrySidecar({
            normalizedRootPath: repo,
            publicationId: newPublicationId,
            navigationRoot: newNavigationRoot,
        });
        assert.equal(newRegistryState.status, 'ok', `Task registry read failed: ${newRegistryState.reason}`);
        const newRelationshipState = await reading.readRelationshipSidecar({
            normalizedRootPath: repo,
            expectedSymbolRegistryManifestHash: newRegistryState.manifestHash,
            publicationId: newPublicationId,
            navigationRoot: newNavigationRoot,
        });
        assert.equal(newRelationshipState.status, 'ok', `Task relationship read failed: ${newRelationshipState.reason}`);
        assert.equal(newRelationshipState.manifestHash, foundation.phase3.relationshipRead.manifestHash);
        assert.equal(newRegistryState.manifestHash, foundation.phase3.registryRead.manifestHash);
        const oldRegistry = oldRegistryState.registry;
        const newRegistry = newRegistryState.registry;
        const relationships = newRelationshipState.records;
        result.registries = {
            old: { manifestHash: oldRegistryState.manifestHash, symbols: oldRegistry.symbols.length },
            new: { manifestHash: newRegistryState.manifestHash, symbols: newRegistry.symbols.length },
            relationships: {
                manifestHash: newRelationshipState.manifestHash,
                records: relationships.length,
                proofBackedCalls: relationships.filter((record) => record.type === 'CALLS'
                    && (record.resolutionAuthority === 'direct_binding' || record.resolutionAuthority === 'origin_flow')).length,
            },
        };
        for (const file of [
            path.join(oldNavigationRoot, 'manifest.json'),
            path.join(newNavigationRoot, 'manifest.json'),
            path.join(newNavigationRoot, 'relationships', 'manifest.json'),
        ]) recordFile(file);
        result.artifacts = {
            oldNavigationAggregate: await hashTree(path.join(oldNavigationRoot, 'symbols')),
            newSymbolsAggregate: await hashTree(path.join(newNavigationRoot, 'symbols')),
            newRelationshipsAggregate: await hashTree(path.join(newNavigationRoot, 'relationships')),
        };

        const { readCurrentSourceEvidence } = await load('packages/mcp/src/core/current-source-symbols.ts');
        const { searchCandidateIdentity, resolveCanonicalOwner, projectPublicationBoundSearchRerankDocument } =
            await load('packages/mcp/src/core/search-rerank-projection.ts');
        const { prepareSearchRerankStructuralRelationships } = await load('packages/mcp/src/core/search-rerank-structural-context.ts');
        const { buildSearchRerankQuery } = await load('packages/mcp/src/core/search-rerank-query.ts');
        const planning = await load('packages/mcp/src/core/search-query-planning.ts');
        const { resolveSearchAnswerFocus } = await load('packages/mcp/src/core/search-answer-focus.ts');
        const { fuseDefinitionDiscovery } = await load('packages/mcp/src/core/search-definition-discovery.ts');
        const { validateNativeRerankResults } = await load('packages/mcp/src/core/search-native-rerank.ts');
        const { selectRerankInputWithinUtf8Budget } = await load('packages/mcp/src/core/search-rerank-policy.ts');
        const { SEARCH_RERANK_INPUT_MAX_UTF8_BYTES } = await load('packages/mcp/src/core/search-constants.ts');
        const { SEARCH_RERANK_DOCUMENT_POLICY } = await load('packages/mcp/src/core/search-rerank-document.ts');
        const { loadSearchRerankRequestContract, resolveSearchRerankRequestIdentity } =
            await load('packages/mcp/src/core/search-rerank-request-contract.ts');
        const { LateOnReranker, loadLateOnRuntimeProfile, LATEON_RUNTIME_PROFILE_IDS } =
            await load('packages/mcp/src/server/lateon-reranker.ts');
        const { resolveHostLateOnExecutionPlan, planLateOnExecution } =
            await load('packages/mcp/src/server/lateon-execution-plan.ts');

        const parsedOperators = planning.parseSearchOperators(query);
        const queryPlan = planning.buildSearchQueryPlan(query, true, parsedOperators);
        const answerFocusResolution = resolveSearchAnswerFocus(queryPlan);
        const rerankQuery = buildSearchRerankQuery({ semanticQuery: query, answerFocus: answerFocusResolution.focus, callerTerms });
        const fusionQuery = [query, ...callerTerms].join(' ');

        const persistedIds = windowIds.filter((id) => /^chunk_[a-f0-9]+$/.test(id));
        const coreRequire = createRequire(path.join(repo, 'packages/core/package.json'));
        const lance = coreRequire('@lancedb/lancedb');
        const vectorRoot = path.join(os.homedir(), '.satori/vector/lancedb');
        connection = await lance.connect(vectorRoot);
        table = await connection.openTable(trace.collection);
        const rows = await table.query()
            .where(`id IN (${persistedIds.map((id) => `'${id}'`).join(',')})`)
            .select(['id', 'content', 'relativePath', 'startLine', 'endLine', 'metadataJson', 'contentHash'])
            .toArray();
        const rowById = new Map(rows.map((row) => [row.id, row]));
        assert.equal(rowById.size, rows.length, 'Duplicate persisted Lance rows');
        assert.equal(rows.length, persistedIds.length, 'Persisted Lance row count mismatch');
        for (const id of persistedIds) {
            const row = rowById.get(id);
            const descriptor = trace.candidateDescriptors[id];
            assert(row, `Persisted Lance row missing for ${id}`);
            assert(descriptor, `Missing trace descriptor for ${id}`);
            assert.equal(row.relativePath, descriptor.relativePath, `Lance path drift: ${id}`);
            assert.equal(row.startLine, descriptor.startLine, `Lance start drift: ${id}`);
            assert.equal(row.endLine, descriptor.endLine, `Lance end drift: ${id}`);
        }
        result.vector = { root: vectorRoot, persistedRequested: persistedIds.length, persistedReturned: rows.length, sourceDerivedCount: windowIds.length - persistedIds.length };

        const sourceCache = new Map();
        const candidates = [];
        const mappings = [];
        for (let originalIndex = 0; originalIndex < windowIds.length; originalIndex += 1) {
            const traceId = windowIds[originalIndex];
            const descriptor = trace.candidateDescriptors[traceId];
            assert(descriptor, `Missing trace descriptor for ${traceId}`);
            const row = rowById.get(traceId);
            const persisted = /^chunk_[a-f0-9]+$/.test(traceId);
            assert(!persisted || row, `Persisted Lance row missing for ${traceId}`);
            const metadata = row ? JSON.parse(row.metadataJson) : {};
            const origin = persisted ? 'lance' : 'captured-descriptor-source';
            const ownerTuple = JSON.parse(descriptor.ownerId);
            assert.equal(ownerTuple[1], descriptor.relativePath);
            assert(['symbol', 'file'].includes(ownerTuple[0]));
            assert.equal(ownerTuple.length, ownerTuple[0] === 'symbol' ? 3 : 2);
            const oldOwner = ownerTuple[0] === 'symbol'
                ? oldRegistry.symbolsByInstanceId.get(ownerTuple[2])
                : oldRegistry.symbolsByFile.get(descriptor.relativePath)?.find((symbol) => symbol.kind === 'file');
            assert(oldOwner, `Old owner missing: ${traceId}`);
            assert.equal(oldOwner.file, descriptor.relativePath, `Old owner path drift: ${traceId}`);

            // The captured descriptor owner is authoritative. Lance metadata may name a
            // different owner because production owner resolution can repair chunking.
            const lanceOwnerDiffers = persisted ? (metadata.ownerSymbolInstanceId !== oldOwner.symbolInstanceId
                || metadata.ownerSymbolKey !== oldOwner.symbolKey) : null;
            const oldManifestFile = oldRegistry.manifest.files.find((file) => file.path === descriptor.relativePath);
            const newManifestFile = newRegistry.manifest.files.find((file) => file.path === descriptor.relativePath);
            const sourcePath = path.join(repo, descriptor.relativePath);
            recordFile(sourcePath);
            if (!oldManifestFile) {
                result.failures.push({ kind: 'old_manifest_file_missing', traceId, file: descriptor.relativePath });
                continue;
            }
            const currentHash = await sha256File(sourcePath);
            if (!newManifestFile) {
                result.failures.push({
                    kind: 'new_manifest_file_missing',
                    traceId,
                    file: descriptor.relativePath,
                    oldOwnerInstanceId: oldOwner.symbolInstanceId,
                    oldOwnerSymbolKey: oldOwner.symbolKey,
                    oldManifestHash: oldManifestFile.hash,
                    currentHash,
                    oldFileHashMatchesCurrent: oldManifestFile.hash === currentHash,
                    oldOwnerHashMatchesCurrent: oldOwner.fileHash === currentHash,
                    lanceOwnerDiffers,
                });
                continue;
            }
            assert.equal(oldManifestFile.hash, newManifestFile.hash, `Registry file hash drift: ${descriptor.relativePath}`);
            assert.equal(currentHash, oldManifestFile.hash, `Current source hash differs from old registry: ${descriptor.relativePath}`);
            assert.equal(oldOwner.fileHash, oldManifestFile.hash, `Old owner hash drift: ${traceId}`);
            if (!sourceCache.has(descriptor.relativePath)) {
                const evidence = await readCurrentSourceEvidence(repo, descriptor.relativePath);
                assert(evidence, `Current source unavailable: ${descriptor.relativePath}`);
                sourceCache.set(descriptor.relativePath, evidence);
            }
            const sourceEvidence = sourceCache.get(descriptor.relativePath);
            assert.equal(sourceEvidence.observedHash, currentHash, `Source evidence hash drift: ${traceId}`);
            let content = row?.content;
            if (!persisted) {
                const lines = sourceEvidence.source.split(/\r?\n/);
                assert(Number.isInteger(descriptor.startLine) && Number.isInteger(descriptor.endLine)
                    && descriptor.startLine >= 1 && descriptor.endLine >= descriptor.startLine
                    && descriptor.endLine <= lines.length, `Invalid captured span: ${traceId}`);
                content = lines.slice(descriptor.startLine - 1, descriptor.endLine).join('\n');
                const aligned = descriptor.startLine === oldOwner.span.startLine
                    && descriptor.endLine === oldOwner.span.endLine;
                if (aligned) {
                    metadata.startByte = oldOwner.span.startByte;
                    metadata.endByte = oldOwner.span.endByte;
                }
            }

            const rebased = newRegistry.symbols.filter((symbol) => (
                symbol.symbolKey === oldOwner.symbolKey
                && symbol.file === oldOwner.file
                && symbol.fileHash === oldOwner.fileHash
                && canonicalSpan(symbol.span) === canonicalSpan(oldOwner.span)
            ));
            if (rebased.length !== 1) {
                result.failures.push({
                    kind: 'owner_rebase_failed',
                    traceId,
                    detail: rebased.length === 0 ? 'absent' : 'ambiguous',
                    oldOwner: {
                        symbolKey: oldOwner.symbolKey,
                        instanceId: oldOwner.symbolInstanceId,
                        name: oldOwner.name,
                        kind: oldOwner.kind,
                        file: oldOwner.file,
                        span: oldOwner.span,
                    },
                    candidates: rebased.map((symbol) => ({
                        symbolKey: symbol.symbolKey,
                        instanceId: symbol.symbolInstanceId,
                        name: symbol.name,
                        kind: symbol.kind,
                        span: symbol.span,
                    })),
                });
                continue;
            }
            const newOwner = rebased[0];
            assert.equal(newOwner.fileHash, currentHash, `New owner hash drift: ${traceId}`);
            assert.equal(newOwner.kind, oldOwner.kind, `Owner kind drift: ${traceId}`);
            assert.equal(newOwner.name, oldOwner.name, `Owner name drift: ${traceId}`);

            const candidate = {
                relativePath: descriptor.relativePath,
                ownerSymbolInstanceId: newOwner.symbolInstanceId,
                ownerSymbolKey: newOwner.symbolKey,
                symbolKind: newOwner.kind,
                symbolLabel: newOwner.label,
                language: newOwner.language,
                startLine: descriptor.startLine,
                endLine: descriptor.endLine,
                ...(Number.isSafeInteger(metadata.startByte) ? { startByte: metadata.startByte } : {}),
                ...(Number.isSafeInteger(metadata.endByte) ? { endByte: metadata.endByte } : {}),
            };
            candidates.push({
                originalIndex,
                traceId,
                result: candidate,
                origin,
                content,
                contentSha256: sha256(content),
                storedContentHash: row?.contentHash ?? null,
                metadata: { ...metadata, ...candidate },
                metadataSha256: row ? sha256(row.metadataJson) : null,
                oldOwner,
                newOwner,
            });
            mappings.push({
                originalIndex,
                traceId,
                origin,
                contentSha256: sha256(content),
                storedContentHash: row?.contentHash ?? null,
                sourceHash: sourceEvidence.observedHash,
                startByte: candidate.startByte ?? null,
                endByte: candidate.endByte ?? null,
                relativePath: descriptor.relativePath,
                span: { startLine: descriptor.startLine, endLine: descriptor.endLine },
                oldOwnerInstanceId: oldOwner.symbolInstanceId,
                newOwnerInstanceId: newOwner.symbolInstanceId,
                stableSymbolKey: newOwner.symbolKey,
                ownerKind: newOwner.kind,
                ownerName: newOwner.name,
                exactSpanRetained: canonicalSpan(oldOwner.span) === canonicalSpan(newOwner.span),
                capturedOwnerFileHash: oldOwner.fileHash,
                currentFileHash: currentHash,
                ...(persisted ? {
                    lanceOwnerSymbolInstanceId: metadata.ownerSymbolInstanceId ?? null,
                    lanceOwnerSymbolKey: metadata.ownerSymbolKey ?? null,
                    metadataOwnerKeyMatchesCapturedOwner: metadata.ownerSymbolKey === oldOwner.symbolKey,
                    traceOwnerDiffersFromLance: lanceOwnerDiffers,
                    metadataRetargetedToNewOwner: metadata.ownerSymbolInstanceId !== newOwner.symbolInstanceId,
                } : {}),
            });
        }
        if (result.failures.length > 0 || candidates.length !== 64) {
            throw new Error(`Owner rebase failed for ${result.failures.length} candidate(s); arm stopped.`);
        }
        result.window = { size: candidates.length, ids: windowIds, candidates: mappings };

        const targetNewId = foundation.phase4.targetSymbols.handleSearchCode.symbolInstanceId;
        const targetCandidates = candidates.filter((candidate) => candidate.newOwner.symbolInstanceId === targetNewId);
        assert.equal(targetCandidates.length, 1, 'Expected exactly one target candidate in the frozen window.');
        const target = targetCandidates[0];
        assert.equal(target.traceId, targetTraceId);
        assert.equal(target.oldOwner.symbolInstanceId, 'syminst_7f5c7474f60b3f5212f5f28660888d3d');
        assert.equal(target.newOwner.qualifiedName, 'ToolHandlers.handleSearchCode');
        result.target = {
            traceId: target.traceId,
            originalIndex: target.originalIndex,
            oldOwnerInstanceId: target.oldOwner.symbolInstanceId,
            newOwnerInstanceId: target.newOwner.symbolInstanceId,
            qualifiedName: target.newOwner.qualifiedName,
            file: target.newOwner.file,
            span: target.newOwner.span,
        };

        const sourceEvidenceByFile = sourceCache;
        const readSourceEvidence = async (_root, relativeFile) => sourceEvidenceByFile.get(relativeFile);
        for (const [file, evidence] of sourceCache) {
            const newFile = newRegistry.manifest.files.find((entry) => entry.path === file);
            assert.equal(evidence.observedHash, newFile?.hash, `Source/new registry drift: ${file}`);
        }
        for (const file of [
            scriptPath,
            tracePath,
            normalizationResultPath,
            args.foundation,
            path.join(repo, 'packages/mcp/src/core/search-rerank-projection.ts'),
            path.join(repo, 'packages/mcp/src/core/search-rerank-document.ts'),
            path.join(repo, 'packages/mcp/src/core/search-rerank-query.ts'),
            path.join(repo, 'packages/mcp/src/core/search-rerank-structural-context.ts'),
            path.join(repo, 'packages/mcp/src/core/search-rerank-request-contract.ts'),
            path.join(repo, 'packages/mcp/src/core/search-answer-focus.ts'),
            path.join(repo, 'packages/mcp/src/core/search-definition-discovery.ts'),
            path.join(repo, 'packages/mcp/src/core/search-native-rerank.ts'),
            path.join(repo, 'packages/mcp/src/core/search-rerank-policy.ts'),
            path.join(repo, 'packages/mcp/src/core/search-constants.ts'),
            path.join(repo, 'packages/mcp/src/core/current-source-symbols.ts'),
            path.join(repo, 'packages/core/src/symbols/sidecar-reads.ts'),
            path.join(repo, 'packages/mcp/src/server/lateon-reranker.ts'),
            path.join(repo, 'packages/mcp/src/server/lateon-execution-plan.ts'),
            path.join(repo, 'packages/mcp/src/server/lateon-reranker-protocol.ts'),
            path.join(repo, 'packages/mcp/tsconfig.json'),
            path.join(repo, 'packages/mcp/dist/server/lateon-reranker.js'),
        ]) recordFile(file);
        const preparedRelationships = prepareSearchRerankStructuralRelationships(relationships);

        async function projectArm(name, useGraph) {
            const packets = [];
            for (const candidate of candidates) {
                const graph = useGraph(candidate) ? preparedRelationships : undefined;
                const projection = await projectPublicationBoundSearchRerankDocument({
                    candidateId: candidate.traceId,
                    codebaseRoot: repo,
                    semanticQuery: query,
                    result: candidate.result,
                    registry: newRegistry,
                    ...(graph ? { preparedStructuralRelationships: graph } : { relationships: [] }),
                    readSourceEvidence,
                });
                assert(projection.ok, `Projection failed: ${candidate.traceId} ${projection.reason}`);
                assert(projection.document.length > 0);
                assert(projection.utf8Bytes === Buffer.byteLength(projection.document, 'utf8'));
                assert(projection.utf8Bytes <= SEARCH_RERANK_DOCUMENT_POLICY.maximumUtf8Bytes);
                const parsed = JSON.parse(projection.document);
                const nonStructural = dropStructural(projection.document);
                packets.push({
                    traceId: candidate.traceId,
                    originalIndex: candidate.originalIndex,
                    ownerSymbolInstanceId: candidate.newOwner.symbolInstanceId,
                    document: projection.document,
                    sha256: projection.sha256,
                    utf8Bytes: projection.utf8Bytes,
                    structuralContext: parsed.structural_context,
                    nonStructural,
                    nonStructuralSha256: sha256(JSON.stringify(nonStructural)),
                    projectionIdentity: projection.projectionIdentity,
                    structuralContextStatus: projection.structuralContextStatus,
                });
            }
            return packets;
        }

        const armEmpty = await projectArm('empty_context', () => false);
        const armTarget = await projectArm('target_context_only', (candidate) => candidate.traceId === targetTraceId);
        const armAll = await projectArm('all_context', () => true);

        for (let index = 0; index < candidates.length; index += 1) {
            const empty = armEmpty[index];
            const targetArm = armTarget[index];
            const all = armAll[index];
            if (empty.traceId !== targetTraceId) {
                if (targetArm.document !== empty.document) {
                    throw new Error(`Non-target packet changed under target_context_only: ${empty.traceId}`);
                }
            }
            if (all.structuralContext.direct_callers.length === 0
                && all.structuralContext.direct_callees.length === 0
                && all.structuralContext.supporting_tests.length === 0) {
                if (all.document !== empty.document) {
                    throw new Error(`Empty-structure packet changed under all_context: ${empty.traceId}`);
                }
            }
        }
        const targetEmpty = armEmpty[target.originalIndex];
        const targetOnly = armTarget[target.originalIndex];
        const targetNonStructuralDifferences = collectDiffPaths(targetEmpty.nonStructural, targetOnly.nonStructural);
        const allNonStructuralDifferences = candidates.map((candidate, index) => ({
            traceId: candidate.traceId,
            differences: collectDiffPaths(armEmpty[index].nonStructural, armAll[index].nonStructural),
        })).filter((entry) => entry.differences.length > 0);

        result.documents = {
            policy: {
                id: SEARCH_RERANK_DOCUMENT_POLICY.id,
                maximumUtf8Bytes: SEARCH_RERANK_DOCUMENT_POLICY.maximumUtf8Bytes,
                structuralContextBudget: SEARCH_RERANK_DOCUMENT_POLICY.structuralContextBudget,
                fieldSetDecision: SEARCH_RERANK_DOCUMENT_POLICY.fieldSetDecision,
            },
            arms: {
                empty_context: armEmpty.map((packet) => ({
                    traceId: packet.traceId,
                    originalIndex: packet.originalIndex,
                    ownerSymbolInstanceId: packet.ownerSymbolInstanceId,
                    document: packet.document,
                    sha256: packet.sha256,
                    utf8Bytes: packet.utf8Bytes,
                    structuralContext: packet.structuralContext,
                    nonStructuralSha256: packet.nonStructuralSha256,
                    sourceExcerptSha256: sha256(packet.nonStructural.query_relevant_source_excerpt ?? ''),
                })),
                target_context_only: armTarget.map((packet) => ({
                    traceId: packet.traceId,
                    originalIndex: packet.originalIndex,
                    ownerSymbolInstanceId: packet.ownerSymbolInstanceId,
                    document: packet.document,
                    sha256: packet.sha256,
                    utf8Bytes: packet.utf8Bytes,
                    structuralContext: packet.structuralContext,
                    nonStructuralSha256: packet.nonStructuralSha256,
                    sourceExcerptSha256: sha256(packet.nonStructural.query_relevant_source_excerpt ?? ''),
                })),
                all_context: armAll.map((packet) => ({
                    traceId: packet.traceId,
                    originalIndex: packet.originalIndex,
                    ownerSymbolInstanceId: packet.ownerSymbolInstanceId,
                    document: packet.document,
                    sha256: packet.sha256,
                    utf8Bytes: packet.utf8Bytes,
                    structuralContext: packet.structuralContext,
                    nonStructuralSha256: packet.nonStructuralSha256,
                    sourceExcerptSha256: sha256(packet.nonStructural.query_relevant_source_excerpt ?? ''),
                })),
            },
            determinism: {
                emptyDocumentHashesRepeatable: true,
            },
            isolation: {
                targetNonStructuralDifferences,
                targetOnlyNonStructuralDifferenceCount: targetNonStructuralDifferences.length,
                allContextNonStructuralDifferenceCandidates: allNonStructuralDifferences,
                allContextNonStructuralDifferenceCount: allNonStructuralDifferences.length,
            },
            totalInputBytes: {
                empty_context: armEmpty.reduce((sum, packet) => sum + packet.utf8Bytes, 0),
                target_context_only: armTarget.reduce((sum, packet) => sum + packet.utf8Bytes, 0),
                all_context: armAll.reduce((sum, packet) => sum + packet.utf8Bytes, 0),
                maximum: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
            },
        };
        const budgetSelections = {};
        for (const [name, packets] of [['empty_context', armEmpty], ['target_context_only', armTarget], ['all_context', armAll]]) {
            const selection = selectRerankInputWithinUtf8Budget({
                candidates: packets.map((packet) => packet.traceId),
                documents: packets.map((packet) => packet.document),
                maxInputBytes: SEARCH_RERANK_INPUT_MAX_UTF8_BYTES,
            });
            assert.equal(selection.omittedCandidateCount, 0, `Input byte budget omitted candidates: ${name}`);
            budgetSelections[name] = {
                inputBytes: selection.inputBytes,
                selectedCount: selection.candidates.length,
                omittedCandidateCount: selection.omittedCandidateCount,
            };
        }
        result.documents.totalInputBytes.budgetSelections = budgetSelections;

        for (const file of [
            'packages/mcp/assets/lateon/runtime-profile-v6-d128.json',
            'packages/mcp/assets/lateon/rerank-request-contract-v1.json',
            'packages/mcp/dist/server/lateon-reranker-worker.js',
            'packages/mcp/dist/server/lateon-reranker-encoder.js',
            'packages/mcp/dist/server/lateon-reranker-protocol.js',
            'packages/mcp/src/server/lateon-reranker-worker.ts',
            'packages/mcp/src/server/lateon-reranker-encoder.ts',
        ]) recordFile(path.join(repo, file));
        const profile = loadLateOnRuntimeProfile(LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
        const modelDirectory = path.join(os.homedir(), '.satori/models/lateon/LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25');
        const workerPath = path.join(repo, 'packages/mcp/dist/server/lateon-reranker-worker.js');
        const hostPlan = resolveHostLateOnExecutionPlan();
        const profilePath = path.join(repo, 'packages/mcp/assets/lateon/runtime-profile-v6-d128.json');
        const contract = loadSearchRerankRequestContract();
        const contractPath = path.join(repo, 'packages/mcp/assets/lateon/rerank-request-contract-v1.json');
        const distWorkerPath = workerPath;
        const distEncoderPath = path.join(repo, 'packages/mcp/dist/server/lateon-reranker-encoder.js');
        const sourceWorkerPath = path.join(repo, 'packages/mcp/src/server/lateon-reranker-worker.ts');
        const sourceEncoderPath = path.join(repo, 'packages/mcp/src/server/lateon-reranker-encoder.ts');
        const ts = req('typescript');
        const runtimePackagePath = path.join(repo, 'packages/mcp/package.json');
        recordFile(runtimePackagePath);
        const runtimePackage = JSON.parse(fsSync.readFileSync(runtimePackagePath, 'utf8'));
        assert.equal(runtimePackage.type, 'module', 'NodeNext worker verification requires the actual MCP ESM package format');
        const transpileCheck = (sourcePath, distPath) => {
            recordFile(sourcePath);
            recordFile(distPath);
            const source = req('node:fs').readFileSync(sourcePath, 'utf8');
            const transpiled = ts.transpileModule(source, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2020,
                    module: ts.ModuleKind.NodeNext,
                    moduleResolution: ts.ModuleResolutionKind.NodeNext,
                    strict: true,
                    esModuleInterop: true,
                    skipLibCheck: true,
                    sourceMap: true,
                },
                // transpileModule does not discover package.json. .mts supplies the
                // ESM format that NodeNext obtains from this package's type: module.
                fileName: path.basename(sourcePath).replace(/\.ts$/, '.mts'),
            }).outputText;
            const dist = req('node:fs').readFileSync(distPath, 'utf8');
            const normalize = (text) => text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n').trimEnd();
            return {
                sourcePath,
                distPath,
                impliedModuleFormat: 'ESM from packages/mcp/package.json type: module',
                sourceSha256: sha256(source),
                distSha256: sha256(dist),
                transpiledDistSha256: sha256(normalize(transpiled)),
                matches: normalize(transpiled) === normalize(dist),
            };
        };
        const workerConsistency = transpileCheck(sourceWorkerPath, distWorkerPath);
        const encoderConsistency = transpileCheck(sourceEncoderPath, distEncoderPath);
        assert(workerConsistency.matches, 'LateOn dist worker does not match current worker source.');
        assert(encoderConsistency.matches, 'LateOn dist encoder does not match current encoder source.');
        const profileSha256 = await sha256File(profilePath);
        const modelArtifacts = [];
        for (const artifact of profile.artifacts) {
            const file = path.join(modelDirectory, artifact.path);
            recordFile(file);
            const observed = await sha256File(file);
            assert.equal(observed, artifact.sha256, `Model artifact mismatch: ${artifact.path}`);
            modelArtifacts.push({ path: artifact.path, sha256: observed, expected: artifact.sha256 });
            recordFile(file);
        }
        for (const file of [profilePath, contractPath, distWorkerPath, distEncoderPath, sourceWorkerPath, sourceEncoderPath,
            path.join(repo, 'packages/mcp/dist/server/lateon-reranker-protocol.js')]) recordFile(file);
        result.reranker = {
            profile: {
                id: profile.profileId,
                path: profilePath,
                sha256: profileSha256,
                schemaVersion: profile.schemaVersion,
                identity: profile.identity,
                execution: profile.execution,
                inference: profile.inference,
            },
            requestContract: {
                path: contractPath,
                sha256: await sha256File(contractPath),
                contractSha256: contract.contractSha256,
                schemaVersion: contract.schemaVersion ?? null,
            },
            query: {
                original: query,
                rerankQuery,
                rerankQuerySha256: sha256(rerankQuery),
                answerFocus: answerFocusResolution.focus,
                answerFocusReasons: answerFocusResolution.reasons,
                callerTerms,
                fusionQuery,
                fusionQuerySha256: sha256(fusionQuery),
            },
            worker: {
                path: distWorkerPath,
                sourcePath: sourceWorkerPath,
                sourceVsDist: workerConsistency,
                encoderSourceVsDist: encoderConsistency,
                protocolDistPath: path.join(repo, 'packages/mcp/dist/server/lateon-reranker-protocol.js'),
            },
            modelDirectory,
            modelArtifacts,
            host: {
                logicalCpus: os.availableParallelism(),
                availableMemoryBytes: process.availableMemory(),
                plan: hostPlan,
                sourceDefaultPlan: planLateOnExecution({
                    logicalCpus: os.availableParallelism(),
                    availableMemoryBytes: process.availableMemory(),
                }),
            },
            maximumDocuments: profile.inference.candidateDepth,
        };

        reranker = new LateOnReranker({
            modelDirectory,
            profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
            workerPath,
        });
        result.reranker.identity = resolveSearchRerankRequestIdentity(reranker);
        result.reranker.profileId = reranker.getProfileId?.() ?? profile.profileId;
        result.reranker.documentProjectionVersion = reranker.getDocumentProjectionVersion?.() ?? null;
        result.reranker.queryProjectionVersion = reranker.getQueryProjectionVersion?.() ?? null;
        result.reranker.maximumDocuments = reranker.getMaxDocuments?.() ?? null;

        const metadataFor = (candidate) => {
            const owner = resolveCanonicalOwner(candidate.result, newRegistry);
            if (owner?.file === candidate.result.relativePath) return owner;
            if (candidate.result.symbolKind !== 'file') return undefined;
            return newRegistry.symbolsByFile.get(candidate.result.relativePath)?.find((symbol) => symbol.kind === 'file');
        };
        const metadataMissing = candidates.filter((candidate) => !metadataFor(candidate)).map((candidate) => candidate.traceId);
        result.fusionMetadata = {
            resolved: candidates.length - metadataMissing.length,
            missingTraceIds: metadataMissing,
        };

        async function runArm(name, packets) {
            process.stdout.write(`Starting ${name} (${packets.length} documents)\n`);
            const diagnostics = [];
            const provider = await reranker.rerank(rerankQuery, packets.map((packet) => packet.document), {
                identities: packets.map((packet) => packet.traceId),
                onExecutionDiagnostics: (value) => diagnostics.push(value),
            });
            const validated = validateNativeRerankResults({
                candidateIds: packets.map((packet) => packet.traceId),
                results: provider,
            });
            const providerOrder = validated.map((item, position) => {
                const candidate = candidates[item.originalIndex];
                assert.equal(candidate.traceId, item.candidateId);
                return {
                    position: position + 1,
                    providerRank: item.providerRank,
                    traceId: item.candidateId,
                    originalIndex: item.originalIndex,
                    ownerSymbolInstanceId: candidate.newOwner.symbolInstanceId,
                    relevanceScore: item.relevanceScore,
                };
            });
            const targetProvider = providerOrder.find((row) => row.traceId === targetTraceId);
            const fusion = fuseDefinitionDiscovery({
                items: validated,
                query: fusionQuery,
                metadata: (originalIndex) => metadataFor(candidates[originalIndex]),
            });
            const fusionOrder = fusion.items.map((item, position) => {
                const candidate = candidates[item.originalIndex];
                return {
                    position: position + 1,
                    traceId: item.candidateId,
                    originalIndex: item.originalIndex,
                    providerRank: item.providerRank,
                    ownerSymbolInstanceId: candidate.newOwner.symbolInstanceId,
                };
            });
            const targetFusion = fusionOrder.find((row) => row.traceId === targetTraceId);
            return {
                name,
                provider: {
                    diagnostics,
                    rawResultCount: provider.length,
                    order: providerOrder,
                    target: targetProvider ? {
                        providerRank: targetProvider.providerRank,
                        position: targetProvider.position,
                        relevanceScore: targetProvider.relevanceScore,
                    } : null,
                },
                fusion: {
                    applied: fusion.applied,
                    targetRank: targetFusion?.position ?? null,
                    order: fusionOrder,
                },
                documentSetSha256: sha256(packets.map((packet) => packet.sha256).join('\n')),
                documentOrder: packets.map((packet) => packet.traceId),
            };
        }

        const arms = {};
        arms.empty_context = await runArm('empty_context', armEmpty);
        arms.target_context_only = await runArm('target_context_only', armTarget);
        arms.all_context = await runArm('all_context', armAll);
        const repeatPackets = await projectArm('empty_context_repeat', () => false);
        const repeatDocumentsIdentical = repeatPackets.every((packet, index) => packet.document === armEmpty[index].document && packet.sha256 === armEmpty[index].sha256);
        const emptyRepeat = await runArm('empty_context_repeat', repeatPackets);
        arms.empty_context_repeat = emptyRepeat;
        const emptyScoreSignature = (arm) => JSON.stringify(arm.provider.order.map((row) => ({
            traceId: row.traceId,
            originalIndex: row.originalIndex,
            relevanceScore: row.relevanceScore,
        })));
        const deterministic = emptyScoreSignature(arms.empty_context) === emptyScoreSignature(emptyRepeat);
        result.documents.determinism = {
            emptyDocumentHashesRepeatable: repeatDocumentsIdentical,
            emptyProviderScoreSignatureRepeatable: deterministic,
            emptyFusionOrderRepeatable: JSON.stringify(arms.empty_context.fusion.order) === JSON.stringify(emptyRepeat.fusion.order),
            repeatTargetProviderRank: emptyRepeat.provider.target?.providerRank ?? null,
            repeatTargetFusionRank: emptyRepeat.fusion.targetRank,
        };
        if (!deterministic || !repeatDocumentsIdentical) result.failures.push({ kind: 'empty_context_not_deterministic' });
        result.arms = arms;
        result.comparison = {
            fixedWindow: { size: 64, ids: windowIds },
            empty_context: {
                targetProviderRank: arms.empty_context.provider.target?.providerRank ?? null,
                targetFusionRank: arms.empty_context.fusion.targetRank,
            },
            target_context_only: {
                targetProviderRank: arms.target_context_only.provider.target?.providerRank ?? null,
                targetFusionRank: arms.target_context_only.fusion.targetRank,
                deltaProviderRank: null,
                deltaFusionRank: null,
            },
            all_context: {
                targetProviderRank: arms.all_context.provider.target?.providerRank ?? null,
                targetFusionRank: arms.all_context.fusion.targetRank,
                deltaProviderRank: null,
                deltaFusionRank: null,
            },
            historical: result.trace.historical,
        };
        const delta = (from, to) => from === null || to === null ? null : to - from;
        result.comparison.target_context_only.deltaProviderRank = delta(
            result.comparison.empty_context.targetProviderRank,
            result.comparison.target_context_only.targetProviderRank,
        );
        result.comparison.target_context_only.deltaFusionRank = delta(
            result.comparison.empty_context.targetFusionRank,
            result.comparison.target_context_only.targetFusionRank,
        );
        result.comparison.all_context.deltaProviderRank = delta(
            result.comparison.empty_context.targetProviderRank,
            result.comparison.all_context.targetProviderRank,
        );
        result.comparison.all_context.deltaFusionRank = delta(
            result.comparison.empty_context.targetFusionRank,
            result.comparison.all_context.targetFusionRank,
        );

        // beforeHashes was captured when each input was first read; recheck now.
        result.inputHashes = {
            fileCount: beforeHashes.size,
            before: Object.fromEntries([...beforeHashes].map(([file, hash]) => [path.relative(repo, file) || file, hash])),
        };
        result.status = 'ok';
    } catch (error) {
        result.status = 'error';
        result.error = {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : null,
        };
    } finally {
        try {
            await reranker?.close();
            result.rerankerClosed = true;
        } catch (error) {
            result.status = 'error';
            result.rerankerCloseError = String(error);
        }
        try {
            table?.close();
            connection?.close();
        } catch (error) {
            result.status = 'error';
            result.vectorCloseError = String(error);
        }
        if (beforeHashes.size > 0) {
            result.inputHashes ??= {
                fileCount: beforeHashes.size,
                before: Object.fromEntries([...beforeHashes].map(([file, hash]) => [path.relative(repo, file) || file, hash])),
            };
            const afterHashes = {};
            const mismatches = [];
            const missing = [];
            for (const [file, hash] of beforeHashes) {
                try {
                    const after = await sha256File(file);
                    afterHashes[path.relative(repo, file) || file] = after;
                    if (after !== hash) mismatches.push({ path: path.relative(repo, file) || file, before: hash, after });
                } catch {
                    missing.push(path.relative(repo, file) || file);
                }
            }
            result.inputHashes.after = afterHashes;
            result.inputHashes.rechecked = {
                fileCount: beforeHashes.size,
                mismatches,
                missing,
                unchanged: mismatches.length === 0 && missing.length === 0,
            };
            if (mismatches.length > 0 || missing.length > 0) {
                result.status = 'error';
                result.failures.push({ kind: 'input_hash_mismatch', mismatches, missing });
            }
        }
        if (result.status === 'ok' && result.documents?.isolation?.targetOnlyNonStructuralDifferenceCount > 0) {
            result.failures.push({
                kind: 'target_structural_budget_changed_non_structural_fields',
                detail: 'Target context is not pure label isolation under the existing byte allocator.',
                differences: result.documents.isolation.targetNonStructuralDifferences,
            });
        }
        if (result.status === 'ok' && result.failures.some((failure) => failure.kind === 'empty_context_not_deterministic')) result.status = 'error';
        result.completedAt = new Date().toISOString();
        await fs.mkdir(path.dirname(args.out), { recursive: true });
        try {
            await fs.writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
        } catch (error) {
            result.status = 'error';
            result.writeError = String(error);
        }
        const summary = {
            status: result.status,
            output: args.out,
            target: result.target?.qualifiedName ?? null,
            providerRanks: result.comparison ? {
                empty: result.comparison.empty_context.targetProviderRank,
                targetOnly: result.comparison.target_context_only.targetProviderRank,
                all: result.comparison.all_context.targetProviderRank,
                emptyRepeat: result.arms?.empty_context_repeat?.provider?.target?.providerRank ?? null,
            } : null,
            fusionRanks: result.comparison ? {
                empty: result.comparison.empty_context.targetFusionRank,
                targetOnly: result.comparison.target_context_only.targetFusionRank,
                all: result.comparison.all_context.targetFusionRank,
            } : null,
            documents: result.documents ? {
                targetOnlyNonStructuralDifferences: result.documents.isolation.targetOnlyNonStructuralDifferenceCount,
                allContextNonStructuralDifferences: result.documents.isolation.allContextNonStructuralDifferenceCount,
            } : null,
            deterministic: result.documents?.determinism?.emptyProviderScoreSignatureRepeatable ?? null,
            failures: result.failures.length,
            error: result.error?.message ?? null,
            inputHashesUnchanged: result.inputHashes?.rechecked?.unchanged ?? null,
        };
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
    if (result.status !== 'ok') process.exitCode = 1;
}

await main();
