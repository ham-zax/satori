import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Read-only graph-foundation experiment. Production modules and managed
// publication state are never modified; task artifacts stay under --artifacts-dir.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = fileURLToPath(import.meta.url);
const tracePath = path.join(path.dirname(scriptPath), 'fixtures/s1-normalization-trace.json');
const traceBytes = await fs.readFile(tracePath);
const trace = JSON.parse(traceBytes);
const fixturePath = path.join(path.dirname(scriptPath), 'fixtures/s1-normalization-result.json');
const workerId = process.env.CLAIVE_WORKER_ID ?? null;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');
const load = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const countBy = (values, key) => {
    const out = {};
    for (const value of values) {
        const name = key(value);
        out[name] = (out[name] ?? 0) + 1;
    }
    return out;
};

const targets = {
    execute: {
        file: 'packages/mcp/src/tools/search_codebase.ts',
        name: 'execute',
        parentHint: 'searchCodebaseTool',
    },
    handleSearchCode: {
        file: 'packages/mcp/src/core/handlers.ts',
        name: 'handleSearchCode',
        parentHint: 'ToolHandlers',
    },
    attempt: {
        file: 'packages/mcp/src/core/search-request-coordinator.ts',
        name: 'attempt',
        parentHint: 'SearchRequestCoordinator',
    },
};

const ownedSourcePaths = [
    'packages/core/src/language-analysis/service.ts',
    'packages/core/src/symbols/registry.ts',
    'packages/core/src/symbols/contracts.ts',
    'packages/core/src/symbols/sidecar-writes.ts',
    'packages/core/src/symbols/sidecar-reads.ts',
    'packages/core/src/relationships/builder.ts',
    'packages/core/src/relationships/resolution.ts',
    'packages/core/src/relationships/typescript-semantic-analyzer.ts',
    'packages/core/src/core/indexing-pipeline.ts',
    'packages/mcp/src/core/search-rerank-structural-context.ts',
    'packages/mcp/src/core/search-rerank-projection.ts',
    'packages/mcp/src/tools/search_codebase.ts',
    'packages/mcp/src/core/handlers.ts',
    'packages/mcp/src/core/search-request-coordinator.ts',
];

function parseArgs(argv) {
    assert.equal(argv.length, 4, 'Use --out ABS --artifacts-dir ABS');
    assert.equal(argv[0], '--out');
    assert.equal(argv[2], '--artifacts-dir');
    assert(path.isAbsolute(argv[1]) && path.isAbsolute(argv[3]));
    return { out: argv[1], artifactsDir: argv[3] };
}

async function readHashes(paths) {
    const entries = await Promise.all(paths.map(async (relative) => [relative, sha256(await fs.readFile(path.join(repo, relative)))]));
    return Object.fromEntries(entries);
}

function relativeInsideRoot(absolute) {
    if (!path.isAbsolute(absolute)) return absolute.replace(/\\/g, '/');
    const relative = path.relative(repo, absolute).replace(/\\/g, '/');
    return relative.startsWith('..') ? absolute : relative;
}

function findTarget(registry, spec, failures) {
    const matches = registry.symbols.filter((symbol) => (
        symbol.file === spec.file
        && symbol.name === spec.name
        && symbol.kind !== 'file'
        && (!spec.parentHint || (
            symbol.qualifiedName === `${spec.parentHint}.${spec.name}`
            || symbol.parentQualifiedNamePath.includes(spec.parentHint)
            || symbol.parentKey?.startsWith(`${spec.parentHint}:`)
        ))
    ));
    if (matches.length !== 1) {
        failures.push({
            kind: 'symbol_identity',
            target: `${spec.file}#${spec.name}`,
            detail: matches.length === 0 ? 'not found' : 'ambiguous',
            candidates: matches.map((symbol) => ({
                symbolKey: symbol.symbolKey,
                symbolInstanceId: symbol.symbolInstanceId,
                qualifiedName: symbol.qualifiedName,
                kind: symbol.kind,
                file: symbol.file,
                parentKey: symbol.parentKey,
            })),
        });
        return undefined;
    }
    const symbol = matches[0];
    return {
        symbolInstanceId: symbol.symbolInstanceId,
        symbolKey: symbol.symbolKey,
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        label: symbol.label,
        kind: symbol.kind,
        file: symbol.file,
        span: symbol.span,
        parentKey: symbol.parentKey ?? null,
        parentQualifiedNamePath: symbol.parentQualifiedNamePath,
        fileHash: symbol.fileHash,
    };
}

function admittedCall(record, isProofBackedAuthoritativeCall) {
    return record.type === 'CALLS'
        && (record.confidence === 'high' || isProofBackedAuthoritativeCall(record));
}

function claimForRecord(claims, record) {
    return claims.filter((claim) => (
        claim.relationshipType === 'CALLS'
        && (claim.sourceInstanceId === record.sourceInstanceId || !claim.sourceInstanceId)
        && claim.targetInstanceId === record.targetInstanceId
        && claim.callSpan.startByte === record.span?.startByte
        && claim.callSpan.endByte === record.span?.endByte
    ));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    assert.equal(path.extname(args.out), '.json');
    await assert.rejects(fs.access(args.out), { code: 'ENOENT' }, `Refusing to overwrite ${args.out}`);
    await assert.rejects(fs.access(args.artifactsDir), { code: 'ENOENT' }, `Artifact dir must be fresh: ${args.artifactsDir}`);
    await fs.mkdir(args.artifactsDir, { recursive: true });

    const canonicalRoot = await fs.realpath(repo);
    const fixtureBytes = await fs.readFile(fixturePath);
    const fixture = JSON.parse(fixtureBytes);
    const retainedNavigationRoot = fixture.publication.navigationRoot;
    const retainedManifestPath = path.join(retainedNavigationRoot, 'manifest.json');
    const retainedManifestBytes = await fs.readFile(retainedManifestPath);
    const retainedManifest = JSON.parse(retainedManifestBytes);
    const publicationId = `s1-graph-foundation-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const navigationRoot = path.join(args.artifactsDir, 'generations', publicationId, 'navigation');
    const preOwnedHashes = await readHashes(ownedSourcePaths);
    const startedAt = new Date().toISOString();

    const result = {
        schemaVersion: 1,
        experiment: 's1-graph-foundation',
        status: 'running',
        workerId,
        model: process.env.PI_MODEL ?? null,
        startedAt,
        completedAt: null,
        repo: {
            root: canonicalRoot,
            head: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            statusPorcelain: execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
        },
        inputs: {
            fixture: { path: fixturePath, sha256: sha256(fixtureBytes) },
            trace: { path: tracePath, sha256: sha256(traceBytes) },
            retainedPublication: {
                publicationId: fixture.publication.id,
                navigationRoot: retainedNavigationRoot,
                fixtureManifestHash: fixture.publication.manifestHash,
                manifestJsonSha256: sha256(retainedManifestBytes),
                manifestHash: retainedManifest.manifestHash ?? null,
            },
            script: { path: scriptPath, sha256: sha256(await fs.readFile(scriptPath)) },
            sourceSHA256Before: preOwnedHashes,
        },
        publication: {
            artifactPublicationId: publicationId,
            navigationRoot,
            kind: 'artifact-roundtrip-only',
            note: 'Not a sealed/vector publication and no current.json pointer is created or changed.',
        },
        phase1: null,
        phase2: null,
        phase3: null,
        phase4: null,
        phase5: null,
        failures: [],
        caveats: [
            'Artifact round-trip proves sidecar write/read plus current production extraction and semantic resolution only; it is not a full sealed/vector search publication.',
            'Registry manifest provenance reuses the retained publication indexPolicyHash and languageRouterVersion because both are production-produced policy/router identity, not source facts.',
            'The source-file set unions all retained TypeScript files with the frozen admitted rerank descriptor paths; each uses its retained actual language.',
            'Retained v21 symbol records and relationships are never mixed with the current extraction.',
            'React/FlatBuffers are out of scope for this phase; this measures the real Satori call path only.',
            'A missing edge is reported as a measured foundation failure, never repaired by a fallback.',
        ],
    };

    let languageService;
    let analyzer;
    let outputWritten = false;
    try {
        const serviceModule = await load('packages/core/src/language-analysis/service.ts');
        const registryModule = await load('packages/core/src/symbols/registry.ts');
        const contractsModule = await load('packages/core/src/symbols/contracts.ts');
        const analyzerModule = await load('packages/core/src/relationships/typescript-semantic-analyzer.ts');
        const builderModule = await load('packages/core/src/relationships/builder.ts');
        const resolutionModule = await load('packages/core/src/relationships/resolution.ts');
        const sidecarReads = await load('packages/core/src/symbols/sidecar-reads.ts');
        const sidecarWrites = await load('packages/core/src/symbols/sidecar-writes.ts');
        const rerankModule = await load('packages/mcp/src/core/search-rerank-structural-context.ts');
        const isProofBackedAuthoritativeCall = resolutionModule.isProofBackedAuthoritativeCall;
        const extractorVersion = requireCoreExport('SYMBOL_EXTRACTOR_VERSION');
        const relationshipVersion = requireCoreExport('RELATIONSHIP_BUILDER_VERSION');

        languageService = serviceModule.createLanguageAnalysisService();

        // Phase 1: current production extraction over the retained TS file set.
        const retainedTsFiles = retainedManifest.files.filter((file) => file.language === 'typescript');
        const window = trace.variants.admitted.stages.filter((stage) => stage.stage === 'reranker_input');
        assert.equal(window.length, 1);
        assert.equal(window[0].candidates.length, 64);
        const requiredPaths = new Set(window[0].candidates.map(({ id }) => {
            assert(trace.candidateDescriptors[id], `Missing descriptor: ${id}`);
            return trace.candidateDescriptors[id].relativePath;
        }));
        const selectedPaths = new Set([...retainedTsFiles.map((file) => file.path), ...requiredPaths]);
        const selectedFiles = retainedManifest.files.filter((file) => selectedPaths.has(file.path));
        assert.equal(selectedFiles.length, selectedPaths.size, 'Required replay path missing from retained manifest');
        const symbols = [];
        const analysisByFile = new Map();
        const manifestFiles = [];
        const analyzedSources = [];
        const phase1Failures = [];
        for (const file of selectedFiles) {
            const absolute = path.join(canonicalRoot, file.path);
            let content;
            try {
                content = await fs.readFile(absolute, 'utf8');
            } catch (error) {
                phase1Failures.push({
                    path: file.path,
                    kind: 'missing_current_source',
                    retainedHash: file.hash,
                    detail: error.code ?? String(error),
                });
                continue;
            }
            const currentHash = sha256(content);
            let analysis;
            try {
                analysis = await languageService.analyze({ content, language: file.language, relativePath: file.path });
            } catch (error) {
                phase1Failures.push({
                    path: file.path,
                    kind: 'analysis_failure',
                    retainedHash: file.hash,
                    currentHash,
                    detail: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            const fileSymbols = registryModule.buildSymbolRecordsForFile({
                relativePath: file.path,
                language: file.language,
                content,
                fileHash: currentHash,
                extractorVersion,
                chunks: analysis.chunks,
                extractedSymbols: analysis.symbols,
            });
            symbols.push(...fileSymbols);
            analysisByFile.set(file.path, {
                moduleBindings: analysis.moduleBindings,
                callSites: analysis.callSites,
                receiverTypeBindings: analysis.receiverTypeBindings,
                pythonFlowFacts: analysis.pythonFlowFacts ?? [],
            });
            const hasDefinitions = fileSymbols.some((symbol) => symbol.kind !== 'file');
            manifestFiles.push({
                path: file.path,
                hash: currentHash,
                language: file.language,
                symbolCount: fileSymbols.length,
                definitionStatus: hasDefinitions
                    ? 'definitions_present'
                    : analysis.structuralStatus !== 'complete'
                        ? 'structural_unavailable'
                        : 'definition_free',
                structuralStatus: analysis.structuralStatus,
                ...(analysis.structuralReason ? { structuralReason: analysis.structuralReason } : {}),
            });
            analyzedSources.push({
                path: file.path,
                retainedHash: file.hash,
                currentHash,
                retainedChanged: file.hash !== currentHash,
                symbolCount: fileSymbols.length,
                structuralStatus: analysis.structuralStatus,
                structuralReason: analysis.structuralReason ?? null,
            });
        }

        const currentPaths = new Set(analyzedSources.map((source) => source.path));
        const changedPaths = analyzedSources.filter((source) => source.retainedChanged).map((source) => source.path);
        const missingPaths = phase1Failures.filter((failure) => failure.kind === 'missing_current_source').map((failure) => failure.path);
        result.phase1 = {
            retainedTsFileCount: retainedTsFiles.length,
            selectedFileCount: selectedFiles.length,
            nonTsReplayPaths: selectedFiles.filter((file) => file.language !== 'typescript').map((file) => ({ path: file.path, language: file.language })),
            analyzedFileCount: analyzedSources.length,
            missingFileCount: missingPaths.length,
            changedByteCount: changedPaths.length,
            symbolCount: symbols.length,
            parseFailures: phase1Failures.filter((failure) => failure.kind === 'analysis_failure'),
            missingPaths,
            changedPaths,
            structuralStatusCounts: countBy(analyzedSources, (source) => source.structuralStatus),
            structuralReasonCounts: countBy(
                analyzedSources.filter((source) => source.structuralReason),
                (source) => source.structuralReason,
            ),
            extractorVersion,
            retainedExtractorVersion: retainedManifest.extractorVersion,
            currentVsRetainedExtractorChanged: retainedManifest.extractorVersion !== extractorVersion,
            sources: analyzedSources,
        };
        if (analyzedSources.length === 0) {
            throw new Error('No retained TypeScript source could be re-extracted; foundation cannot be measured.');
        }

        // Phase 2: fresh task registry and actual production semantic resolution.
        const manifest = {
            schemaVersion: requireCoreExport('SYMBOL_REGISTRY_SCHEMA_VERSION'),
            normalizedRootPath: canonicalRoot,
            rootFingerprint: md5(canonicalRoot),
            indexPolicyHash: retainedManifest.indexPolicyHash,
            languageRouterVersion: retainedManifest.languageRouterVersion,
            extractorVersion,
            relationshipVersion,
            builtAt: new Date().toISOString(),
            files: manifestFiles,
        };
        const registry = registryModule.buildSymbolRegistry({ manifest, symbols });
        const registryManifestHash = registryModule.computeSymbolRegistryManifestHash(registry.manifest);
        result.phase2 = {
            registrySymbolCount: registry.symbols.length,
            registryFileCount: registry.manifest.files.length,
            manifestHash: registryManifestHash,
            manifestProvenance: {
                rootFingerprintOwner: 'production md5(canonicalRoot)',
                indexPolicyHashSource: 'retained production manifest',
                languageRouterVersionSource: 'retained production manifest',
                extractorVersionSource: 'current production SYMBOL_EXTRACTOR_VERSION',
                relationshipVersionSource: 'current production RELATIONSHIP_BUILDER_VERSION',
            },
            retainedRelationshipVersion: retainedManifest.relationshipVersion,
            currentVsRetainedRelationshipChanged: retainedManifest.relationshipVersion !== relationshipVersion,
        };

        const disposed = { languageService: false, analyzer: false };
        try {
            analyzer = new analyzerModule.TypeScriptSemanticProjectAnalyzer();
            const controlPathsBefore = await analyzer.getSourceControlFiles({ rootPath: canonicalRoot, language: 'typescript', sourceFiles: retainedTsFiles.map((file) => file.path) });
            const controlHashesBefore = {};
            for (const file of controlPathsBefore) {
                try { controlHashesBefore[relativeInsideRoot(file)] = sha256(await fs.readFile(file)); }
                catch (error) { if (error.code !== 'ENOENT') throw error; controlHashesBefore[relativeInsideRoot(file)] = 'absent'; }
            }
            result.inputs.sourceControlHashesBefore = controlHashesBefore;
            const evidence = await analyzer.analyze({
                rootPath: canonicalRoot,
                language: 'typescript',
                registry,
            });
            const claimsByFile = evidence.claimsByFile instanceof Map
                ? evidence.claimsByFile
                : new Map(Object.entries(evidence.claimsByFile ?? {}));
            const allClaims = [];
            for (const claims of claimsByFile.values()) allClaims.push(...claims);
            const sourceControlFiles = [...(evidence.sourceControlFiles ?? [])].sort();
            const sourceControlHashes = {};
            for (const controlFile of sourceControlFiles) {
                const absolute = path.isAbsolute(controlFile) ? controlFile : path.join(canonicalRoot, controlFile);
                try {
                    sourceControlHashes[relativeInsideRoot(absolute)] = sha256(await fs.readFile(absolute));
                } catch (error) {
                    sourceControlHashes[relativeInsideRoot(absolute)] = `unreadable:${error.code ?? 'error'}`;
                }
            }
            result.phase2.semantic = {
                providerId: evidence.providerId,
                providerVersion: evidence.providerVersion,
                environmentConfigId: evidence.environmentConfigId,
                coverage: evidence.coverage ?? null,
                sourceControlFiles: sourceControlFiles.map(relativeInsideRoot),
                sourceControlHashes,
                affectedSourceFileCount: evidence.affectedSourceFiles?.size ?? null,
                claimFileCount: claimsByFile.size,
                claimCount: allClaims.length,
                claimDecisionCounts: countBy(allClaims, (claim) => claim.decision),
                claimAuthorityCounts: countBy(allClaims, (claim) => claim.resolutionAuthority),
            };

            const records = await builderModule.buildRelationshipsForRegistryAsync({
                registry,
                analysisByFile,
                resolutionEvidenceByLanguage: new Map([['typescript', evidence]]),
            });
            const calls = records.filter((record) => record.type === 'CALLS');
            result.phase2.relationshipCount = records.length;
            result.phase2.callRecordCount = calls.length;
            result.phase2.callAuthorityCounts = countBy(calls, (record) => record.resolutionAuthority ?? 'none');
            result.phase2.callConfidenceCounts = countBy(calls, (record) => record.confidence);
            result.phase2.proofBackedCallCount = calls.filter((record) => isProofBackedAuthoritativeCall(record)).length;

            // Phase 3: task-owned artifact round-trip, no managed pointer.
            const registryWrite = await sidecarWrites.writeSymbolRegistrySidecar({ registry, navigationRoot });
            const relationshipWrite = await sidecarWrites.writeRelationshipSidecar({
                normalizedRootPath: canonicalRoot,
                symbolRegistryManifestHash: registryWrite.manifestHash,
                relationshipVersion,
                builtAt: registry.manifest.builtAt,
                records,
                analysisByFile,
                providerCoverage: evidence.coverage ? [evidence.coverage] : [],
                files: registry.manifest.files,
                navigationRoot,
            });
            const registryRead = await sidecarReads.readSymbolRegistrySidecar({
                normalizedRootPath: canonicalRoot,
                publicationId,
                navigationRoot,
            });
            const relationshipRead = await sidecarReads.readRelationshipSidecar({
                normalizedRootPath: canonicalRoot,
                expectedSymbolRegistryManifestHash: registryWrite.manifestHash,
                publicationId,
                navigationRoot,
            });
            assert.equal(registryRead.status, 'ok', `Registry round-trip failed: ${registryRead.reason}`);
            assert.equal(relationshipRead.status, 'ok', `Relationship round-trip failed: ${relationshipRead.reason}`);
            assert.equal(registryRead.manifestHash, registryWrite.manifestHash);
            assert.equal(registryRead.registry.symbols.length, registry.symbols.length);
            assert.equal(relationshipRead.manifestHash, relationshipWrite.manifestHash);
            assert.equal(relationshipRead.records.length, records.length);
            const readClaimCount = [...relationshipRead.analysisByFile.values()]
                .reduce((total, entry) => total + (entry.resolutionClaims?.length ?? 0), 0);
            const roundTripRecord = relationshipRead.records.find((record) => isProofBackedAuthoritativeCall(record));
            assert(roundTripRecord, 'Read-back relationships lost every proof-backed call record.');
            result.phase3 = {
                registryWrite: { manifestHash: registryWrite.manifestHash, fileShardCount: registryWrite.fileShardCount, symbolCount: registryWrite.symbolCount },
                relationshipWrite: { manifestHash: relationshipWrite.manifestHash, fileShardCount: relationshipWrite.fileShardCount, relationshipCount: relationshipWrite.relationshipCount },
                registryRead: {
                    status: registryRead.status,
                    manifestHash: registryRead.manifestHash,
                    symbolCount: registryRead.registry.symbols.length,
                    warningCount: registryRead.warnings.length,
                },
                relationshipRead: {
                    status: relationshipRead.status,
                    manifestHash: relationshipRead.manifestHash,
                    recordCount: relationshipRead.records.length,
                    analysisFileCount: relationshipRead.analysisByFile.size,
                    claimCount: readClaimCount,
                    warningCount: relationshipRead.warnings.length,
                },
                proofBackedRecordSurvived: {
                    sourceInstanceId: roundTripRecord.sourceInstanceId ?? null,
                    targetInstanceId: roundTripRecord.targetInstanceId ?? null,
                    resolutionAuthority: roundTripRecord.resolutionAuthority ?? null,
                },
                currentJsonPointerCreatedOrChanged: false,
            };

            // Phase 4: exact two-edge proof from the bytes read back from the
            // task-owned sidecar, not from the in-memory build inputs.
            const readRegistry = registryRead.registry;
            const readRecords = relationshipRead.records;
            const readClaimsByFile = new Map([...relationshipRead.analysisByFile.entries()].map(
                ([file, evidence]) => [file, evidence.resolutionClaims ?? []],
            ));
            const originalExecute = findTarget(registry, targets.execute, []);
            const originalHandle = findTarget(registry, targets.handleSearchCode, []);
            const originalAttempt = findTarget(registry, targets.attempt, []);
            const execute = findTarget(readRegistry, targets.execute, result.failures);
            const handle = findTarget(readRegistry, targets.handleSearchCode, result.failures);
            const attempt = findTarget(readRegistry, targets.attempt, result.failures);
            const edgeSpecs = [
                { label: 'execute->handleSearchCode', source: execute, target: handle },
                { label: 'handleSearchCode->attempt', source: handle, target: attempt },
            ];
            const edges = [];
            for (const spec of edgeSpecs) {
                if (!spec.source || !spec.target) {
                    edges.push({ label: spec.label, status: 'missing_symbol_identity' });
                    continue;
                }
                const matching = readRecords.filter((record) => (
                    record.type === 'CALLS'
                    && record.sourceInstanceId === spec.source.symbolInstanceId
                    && record.targetInstanceId === spec.target.symbolInstanceId
                ));
                const proofBacked = matching.filter((record) => isProofBackedAuthoritativeCall(record));
                const sourceClaims = readClaimsByFile.get(spec.source.file) ?? [];
                const owningClaims = sourceClaims.filter((claim) => (
                    claim.sourceInstanceId === spec.source.symbolInstanceId
                    || (claim.callSpan.startByte >= spec.source.span.startByte
                        && claim.callSpan.endByte <= spec.source.span.endByte)
                ));
                const sourceCallObservations = owningClaims.filter((claim) => (
                    claim.observation.calleeName === spec.target.name
                    || claim.targetInstanceId === spec.target.symbolInstanceId
                    || claim.observation.candidates.some((candidate) => candidate.symbolInstanceId === spec.target.symbolInstanceId)
                ));
                edges.push({
                    label: spec.label,
                    status: proofBacked.length > 0 ? 'admitted' : 'not_proven',
                    source: spec.source,
                    target: spec.target,
                    sourceIdentitySurvivedReadBack: spec.source.symbolInstanceId === (
                        spec.label.startsWith('execute') ? originalExecute?.symbolInstanceId : originalHandle?.symbolInstanceId
                    ),
                    targetIdentitySurvivedReadBack: spec.target.symbolInstanceId === (
                        spec.label.startsWith('execute') ? originalHandle?.symbolInstanceId : originalAttempt?.symbolInstanceId
                    ),
                    callRecordCount: matching.length,
                    proofBackedRecordCount: proofBacked.length,
                    records: matching.map((record) => ({
                        sourceKey: record.sourceKey,
                        sourceInstanceId: record.sourceInstanceId ?? null,
                        targetKey: record.targetKey ?? null,
                        targetInstanceId: record.targetInstanceId ?? null,
                        targetPath: record.targetPath ?? null,
                        file: record.file,
                        span: record.span ?? null,
                        confidence: record.confidence,
                        strategy: record.strategy ?? null,
                        resolutionAuthority: record.resolutionAuthority ?? null,
                        proofBacked: isProofBackedAuthoritativeCall(record),
                        args: record.args ?? [],
                    })),
                    underlyingClaims: matching.flatMap((record) => claimForRecord(sourceClaims, record)),
                    sourceCallObservations: sourceCallObservations.map((claim) => ({
                        decision: claim.decision,
                        resolutionAuthority: claim.resolutionAuthority,
                        callSpan: claim.callSpan,
                        targetInstanceId: claim.targetInstanceId ?? null,
                        observation: claim.observation,
                        proofSteps: claim.proofSteps,
                    })),
                    sourceCallObservationCount: sourceCallObservations.length,
                    sourceFileClaimCount: sourceClaims.length,
                    sourceFileClaimDecisions: countBy(sourceClaims, (claim) => claim.decision),
                });
            }
            result.phase4 = {
                inspectedRegistry: 'sidecar-read-back',
                targetSymbols: { execute, handleSearchCode: handle, attempt },
                edges,
                foundationProven: edges.length === 2 && edges.every((edge) => edge.status === 'admitted'),
            };
            if (!result.phase4.foundationProven) {
                result.failures.push({
                    kind: 'foundation_not_proven',
                    detail: 'One or both required CALLS edges lack an admitted proof-backed record.',
                    edges: edges.map((edge) => ({
                        label: edge.label,
                        status: edge.status,
                        callRecordCount: edge.callRecordCount ?? null,
                        proofBackedRecordCount: edge.proofBackedRecordCount ?? null,
                        claims: edge.underlyingClaims?.map((claim) => ({
                            decision: claim.decision,
                            resolutionAuthority: claim.resolutionAuthority,
                            calleeName: claim.observation.calleeName,
                            construct: claim.observation.construct,
                            candidates: claim.observation.candidates,
                        })) ?? [],
                    })),
                });
            }

            if (result.phase4.foundationProven) {
                // Phase 5: full fanout and production rerank context from the read-back artifact.
                const outgoing = readRecords.filter((record) => (
                    admittedCall(record, isProofBackedAuthoritativeCall)
                    && record.sourceInstanceId === execute.symbolInstanceId
                ));
                const targetIds = [...new Set(outgoing.map((record) => record.targetInstanceId).filter(Boolean))];
                const exitClaims = (readClaimsByFile.get(execute.file) ?? []).filter((claim) => (
                    claim.sourceInstanceId === execute.symbolInstanceId
                    || (claim.callSpan.startByte >= execute.span.startByte && claim.callSpan.endByte <= execute.span.endByte)
                ));
                const executeCallSites = (analysisByFile.get(execute.file)?.callSites ?? []).filter((callSite) => (
                    callSite.span.startByte >= execute.span.startByte
                    && callSite.span.endByte <= execute.span.endByte
                ));
                const prepared = rerankModule.prepareSearchRerankStructuralRelationships(readRecords);
                const contextFor = (symbol) => {
                    const candidate = {
                        relativePath: symbol.file,
                        ownerSymbolInstanceId: symbol.symbolInstanceId,
                    };
                    const incoming = prepared.incomingCallsByTargetInstanceId.get(symbol.symbolInstanceId) ?? [];
                    const outgoingRecords = prepared.outgoingCallsBySourceInstanceId.get(symbol.symbolInstanceId) ?? [];
                    const context = rerankModule.buildSearchRerankStructuralContext({
                        candidate,
                        registry: readRegistry,
                        preparedRelationships: prepared,
                    });
                    return {
                        available: {
                            directCallerRecords: incoming.length,
                            directCalleeRecords: outgoingRecords.length,
                            supportingTestRecords: (prepared.testsByTargetInstanceId.get(symbol.symbolInstanceId) ?? []).length,
                        },
                        serialized: context,
                        cap: rerankModule.SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY,
                    };
                };
                result.phase5 = {
                    inspectedRegistry: 'sidecar-read-back',
                    executeOutgoing: {
                        admittedRecordCount: outgoing.length,
                        distinctTargetCount: targetIds.length,
                        repeatedTargetCallSiteCount: outgoing.length - targetIds.length,
                        targetInstanceIds: targetIds,
                        records: outgoing.map((record) => {
                            const target = record.targetInstanceId ? readRegistry.symbolsByInstanceId.get(record.targetInstanceId) : undefined;
                            return {
                                targetInstanceId: record.targetInstanceId ?? null,
                                targetQualifiedName: target?.qualifiedName ?? null,
                                targetFile: target?.file ?? record.targetPath ?? null,
                                span: record.span ?? null,
                                confidence: record.confidence,
                                resolutionAuthority: record.resolutionAuthority ?? null,
                                strategy: record.strategy ?? null,
                                args: record.args ?? [],
                            };
                        }),
                        fileCallSiteCount: analysisByFile.get(execute.file)?.callSites?.length ?? 0,
                        sourceCallSiteCountInsideOwnerSpan: executeCallSites.length,
                        claimCount: exitClaims.length,
                        claimDecisionCounts: countBy(exitClaims, (claim) => claim.decision),
                        claimAuthorityCounts: countBy(exitClaims, (claim) => claim.resolutionAuthority),
                        unresolvedCount: exitClaims.filter((claim) => claim.decision === 'unresolved').length,
                        ambiguousCount: exitClaims.filter((claim) => claim.decision === 'ambiguous').length,
                        unsupportedCount: exitClaims.filter((claim) => claim.resolutionAuthority === 'unsupported').length,
                    },
                    rerankContext: {
                        execute: contextFor(execute),
                        handleSearchCode: contextFor(handle),
                    },
                    parentVariables: {
                        execute: { parentKey: execute.parentKey, parentQualifiedNamePath: execute.parentQualifiedNamePath },
                        handleSearchCode: { parentKey: handle.parentKey, parentQualifiedNamePath: handle.parentQualifiedNamePath },
                        attempt: { parentKey: attempt.parentKey, parentQualifiedNamePath: attempt.parentQualifiedNamePath },
                    },
                };
            } else {
                result.phase5 = { skipped: true, reason: 'foundation not proven; no fanout claim is made' };
            }
        } finally {
            if (analyzer) {
                await analyzer.dispose();
                disposed.analyzer = true;
            }
            await languageService.dispose?.();
            disposed.languageService = true;
            result.phase2.disposal = disposed;
        }

        result.status = result.phase4?.foundationProven ? 'ok' : 'failed-foundation';
        if (!result.phase4) result.status = 'failed-foundation';
    } catch (error) {
        result.status = 'error';
        result.error = {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : null,
        };
        try {
            await analyzer?.dispose();
        } catch (disposeError) {
            result.error.analyzerDisposeError = String(disposeError);
        }
        try {
            await languageService?.dispose?.();
        } catch (disposeError) {
            result.error.languageServiceDisposeError = String(disposeError);
        }
    } finally {
        result.completedAt = new Date().toISOString();
        try {
            result.inputs.sourceSHA256After = await readHashes(ownedSourcePaths);
            result.inputs.sourceFilesUnchanged = Object.entries(result.inputs.sourceSHA256Before).every(
                ([relative, hash]) => result.inputs.sourceSHA256After[relative] === hash,
            );
        } catch (hashError) {
            result.inputs.sourceRecheckError = String(hashError);
        }
        if (result.phase1?.sources) {
            const changed = [];
            const missing = [];
            const unreadable = [];
            for (const source of result.phase1.sources) {
                try {
                    const current = sha256(await fs.readFile(path.join(canonicalRoot, source.path)));
                    if (current !== source.currentHash) changed.push({ path: source.path, observed: source.currentHash, rechecked: current });
                } catch (error) {
                    if (error.code === 'ENOENT') missing.push(source.path);
                    else unreadable.push({ path: source.path, detail: error.code ?? String(error) });
                }
            }
            result.inputs.extractedSourceRecheck = {
                checkedFileCount: result.phase1.sources.length,
                changed,
                missing,
                unreadable,
                unchanged: changed.length === 0 && missing.length === 0 && unreadable.length === 0,
            };
            result.inputs.allExtractedSourcesUnchanged = result.inputs.extractedSourceRecheck.unchanged;
        }
        if (result.phase2?.semantic?.sourceControlHashes) {
            const changed = [];
            const unreadable = [];
            for (const [relative, observed] of Object.entries(result.phase2.semantic.sourceControlHashes)) {
                if (observed.startsWith('unreadable:')) continue;
                try {
                    const current = sha256(await fs.readFile(path.join(canonicalRoot, relative)));
                    if (current !== observed) changed.push({ path: relative, observed, rechecked: current });
                } catch (error) {
                    unreadable.push({ path: relative, detail: error.code ?? String(error) });
                }
            }
            result.inputs.sourceControlRecheck = {
                checkedFileCount: Object.keys(result.phase2.semantic.sourceControlHashes).length,
                changed,
                unreadable,
                unchanged: changed.length === 0 && unreadable.length === 0,
            };
            result.inputs.allSourceControlsUnchanged = result.inputs.sourceControlRecheck.unchanged;
        }
        result.inputs.traceSHA256After = sha256(await fs.readFile(tracePath));
        result.inputs.traceUnchanged = result.inputs.trace.sha256 === result.inputs.traceSHA256After;
        result.inputs.fixtureUnchanged = result.inputs.fixture.sha256 === sha256(await fs.readFile(fixturePath));
        result.inputs.manifestUnchanged = result.inputs.retainedPublication.manifestJsonSha256 === sha256(await fs.readFile(retainedManifestPath));
        if (result.inputs.sourceControlHashesBefore) {
            result.inputs.sourceControlHashesAfter = {};
            for (const [file, before] of Object.entries(result.inputs.sourceControlHashesBefore)) {
                let after;
                try { after = sha256(await fs.readFile(path.join(canonicalRoot, file))); }
                catch (error) { after = error.code === 'ENOENT' ? 'absent' : `unreadable:${error.code}`; }
                result.inputs.sourceControlHashesAfter[file] = after;
                if (before !== after) result.failures.push({ kind: 'control_changed', file, before, after });
            }
        }
        result.inputs.scriptSHA256After = await fs.readFile(scriptPath).then(sha256);
        result.inputs.scriptUnchanged = result.inputs.script.sha256 === result.inputs.scriptSHA256After;
        if (Object.entries(result.inputs).some(([key, value]) => /Unchanged$/.test(key) && value !== true)
            || result.phase1?.changedByteCount || result.phase1?.missingFileCount || result.phase1?.parseFailures.length || result.failures.length) {
            result.status = result.status === 'ok' ? 'failed-input-validation' : result.status;
        }
        await fs.mkdir(path.dirname(args.out), { recursive: true });
        await fs.writeFile(args.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        outputWritten = true;
        const summary = {
            status: result.status,
            output: args.out,
            phase1: result.phase1 && {
                files: result.phase1.analyzedFileCount,
                symbols: result.phase1.symbolCount,
                changed: result.phase1.changedByteCount,
                missing: result.phase1.missingFileCount,
            },
            phase2: result.phase2 && {
                coverage: result.phase2.semantic?.coverage?.status ?? null,
                calls: result.phase2.callRecordCount ?? null,
                proofBackedCalls: result.phase2.proofBackedCallCount ?? null,
            },
            phase3: result.phase3 && {
                registry: result.phase3.registryRead.symbolCount,
                relationships: result.phase3.relationshipRead.recordCount,
                claims: result.phase3.relationshipRead.claimCount,
            },
            phase4: result.phase4 && {
                proven: result.phase4.foundationProven,
                edges: result.phase4.edges.map((edge) => ({
                    label: edge.label,
                    status: edge.status,
                    proofBacked: edge.proofBackedRecordCount ?? null,
                })),
            },
            phase5: result.phase5?.skipped ? null : result.phase5 && {
                fanout: result.phase5.executeOutgoing.admittedRecordCount,
                targets: result.phase5.executeOutgoing.distinctTargetCount,
                rerankCallees: result.phase5.rerankContext.execute.serialized.directCallees.length,
            },
            failures: result.failures.length,
            sourceFilesUnchanged: result.inputs.sourceFilesUnchanged,
            allExtractedSourcesUnchanged: result.inputs.allExtractedSourcesUnchanged ?? null,
            allSourceControlsUnchanged: result.inputs.allSourceControlsUnchanged ?? null,
            scriptUnchanged: result.inputs.scriptUnchanged,
        };
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
    if (!outputWritten) process.exitCode = 1;
    if (result.status !== 'ok') process.exitCode = 1;
}

let coreIndex;
function requireCoreExport(name) {
    if (!coreIndex) {
        throw new Error('Core index not loaded before export lookup.');
    }
    const value = coreIndex[name];
    if (value === undefined) throw new Error(`Production export '${name}' is unavailable.`);
    return value;
}

coreIndex = await load('packages/core/src/index.ts');
await main();
