import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHOOTOUT_CORPUS_SCHEMA_VERSION,
  SHOOTOUT_MANIFEST_SCHEMA_VERSION,
  SHOOTOUT_RUN_SCHEMA_VERSION,
  checkRunComparability,
  computePersistentVectorCacheKey,
  serializeCanonicalJson,
  validateCorpus,
  validateExperimentalPacket,
  validateManifest,
  validateRun,
  verifyPublicationEligibilityWitness,
} from './contracts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'models.json'), 'utf8'));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/qualification-v1.json'), 'utf8'));

function makeCacheHeader(overrides = {}) {
  const packet = Buffer.from('symbol: handleWebhook\nkind: function\nbody: return true;\n', 'utf8');
  const header = {
    modelSha256: 'ac5a92a685512b163c3c591438f518379309d2a98c4818a9c6e2986f789dc8ef',
    tokenizerSha256: 'a388b94942e98e5c661c6c23f919842285738bfd123a0d148dea0c56287505d0',
    encoderConfigSha256: 'fa4fef89820dcdc33c5504c62c1d5efc19603cfbfebf02368a70d51a4dbe6651',
    prefixes: { query: '[Q] ', document: '[D] ' },
    casing: 'lowercase_before_tokenize',
    masks: { skipTokenIds: [2, 3, 4], attentionMask: 'nonzero' },
    maxTokenCap: 512,
    truncationPolicy: 'right',
    normalization: 'l2_per_token',
    packetVersion: 'shootout_chunk_packet_1',
    packetByteLength: packet.length,
    codec: 'stq8_symmetric_int8_v1',
    dimensions: 48,
    runtimeQualificationDigest: 'dae58a14374660311a3047eaddd393585780c82ab9302d6d40dfd8c25fa09ce3',
    ...overrides,
  };
  return { header, packet };
}

test('pinned models.json satisfies satori_offline_shootout_manifest_v1 and forbids activation', () => {
  const check = validateManifest(MODELS_MANIFEST);
  assert.equal(check.valid, true, check.errors.join('; '));
  assert.equal(MODELS_MANIFEST.schemaVersion, SHOOTOUT_MANIFEST_SCHEMA_VERSION);
  assert.equal(MODELS_MANIFEST.activationAllowed, false);

  const tampered = structuredClone(MODELS_MANIFEST);
  tampered.activationAllowed = true;
  assert.equal(validateManifest(tampered).valid, false);
});

test('validateManifest rejects wrong schema version, bad SHA-256, and non-finite numbers', () => {
  const wrongVer = structuredClone(MODELS_MANIFEST);
  wrongVer.schemaVersion = 'satori_offline_shootout_manifest_v999';
  assert.equal(validateManifest(wrongVer).valid, false);

  const badSha = structuredClone(MODELS_MANIFEST);
  badSha.models['lateon-code-edge-fp32'].artifacts[0].sha256 = 'not-a-sha';
  assert.equal(validateManifest(badSha).valid, false);

  const nonFinite = structuredClone(MODELS_MANIFEST);
  nonFinite.models['ettin-reranker-17m-v1-avx2-full-head'].head.layerNormEpsilon = Number.NaN;
  assert.equal(validateManifest(nonFinite).valid, false);
});

test('serializeCanonicalJson is key-order invariant and rejects non-finite numbers', () => {
  assert.equal(serializeCanonicalJson({ b: 1, a: 2 }), serializeCanonicalJson({ a: 2, b: 1 }));
  assert.throws(() => serializeCanonicalJson({ x: Number.POSITIVE_INFINITY }), /non-finite/i);
  assert.throws(() => serializeCanonicalJson({ x: Number.NaN }), /non-finite/i);
});

test('validateCorpus validates required witnesses and candidate provenance', () => {
  const corpus = {
    schemaVersion: SHOOTOUT_CORPUS_SCHEMA_VERSION,
    casesSha256: '1'.repeat(64),
    oracleSha256: '2'.repeat(64),
    captureId: 'cap-2026-11-27',
    captureScriptSha256: '3'.repeat(64),
    repositories: {
      tessera: { commit: '2efa2ee', publicationId: 'pub-tessera-1' },
    },
    queries: [
      {
        id: 'ts1',
        repo: 'tessera',
        publicationId: 'pub-tessera-1',
        candidates: [
          {
            candidateId: 'cand-1',
            firstStageScore: 0.42,
            firstStageRank: 1,
            symbolKind: 'function',
            sourceSha256: '4'.repeat(64),
            projectionSha256: '5'.repeat(64),
            sourceSpan: { startLine: 10, endLine: 40 },
            verifiedEdges: [],
          },
        ],
        rawScores: [{ candidateId: 'cand-1', score: 12.3 }],
        finalOrder: ['cand-1'],
      },
    ],
  };
  assert.equal(validateCorpus(corpus).valid, true);

  const missingSpan = structuredClone(corpus);
  delete missingSpan.queries[0].candidates[0].sourceSpan;
  assert.equal(validateCorpus(missingSpan).valid, false);
});

test('validateRun enforces schema, freshness failure marking, and novel-query cache scope', () => {
  const run = structuredClone(FIXTURE.defaultEvaluation.candidateRun);
  assert.equal(run.schemaVersion, SHOOTOUT_RUN_SCHEMA_VERSION);
  assert.equal(validateRun(run).valid, true);

  const relabeledRevisit = structuredClone(run);
  relabeledRevisit.cacheState = 'revisit_cached';
  relabeledRevisit.timingScope.novelQueryClaim = true;
  assert.equal(validateRun(relabeledRevisit).valid, false);

  const hiddenStale = structuredClone(run);
  hiddenStale.qualityCases[0].freshnessMode = 'served_previous_generation';
  hiddenStale.qualityCases[0].failed = false;
  assert.equal(validateRun(hiddenStale).valid, false);

  const missingFreshness = structuredClone(run);
  missingFreshness.qualityCases[0].freshnessMode = 'unknown';
  missingFreshness.qualityCases[0].failed = false;
  assert.equal(validateRun(missingFreshness).valid, false);
});

test('validateExperimentalPacket blocks query text, ranking position, and query priority leakage', () => {
  const ok = validateExperimentalPacket({
    version: 'shootout_chunk_packet_1',
    packetBytes: 'file: src/clock.ts\nsymbol: compareHlc\nbody: return a - b;',
    queryText: 'where does tessera compare hybrid logical clocks',
    metadata: { ownerId: 'sym_1' },
  });
  assert.equal(ok.valid, true);

  const leaksQuery = validateExperimentalPacket({
    version: 'shootout_chunk_packet_1',
    packetBytes: 'query: where does tessera compare hybrid logical clocks\nbody: x',
    queryText: 'where does tessera compare hybrid logical clocks',
  });
  assert.equal(leaksQuery.valid, false);

  const leaksRank = validateExperimentalPacket({
    version: 'shootout_symbol_packet_1',
    packetBytes: 'firstStageRank: 1\nbody: return a - b;',
    queryText: 'unrelated query',
  });
  assert.equal(leaksRank.valid, false);

  const leaksMetadata = validateExperimentalPacket({
    version: 'shootout_symbol_packet_1',
    packetBytes: 'body: return a - b;',
    metadata: { rankingPosition: 1 },
  });
  assert.equal(leaksMetadata.valid, false);
});

test('persistent vector cache key mutates whenever any model, tokenizer, cap, prefix, casing, mask, codec, packet version, or byte changes', () => {
  const { header, packet } = makeCacheHeader();
  const baseKey = computePersistentVectorCacheKey(header, packet);
  assert.match(baseKey, /^[a-f0-9]{64}$/);

  const mutations = [
    ['modelSha256', { modelSha256: 'a'.repeat(64) }],
    ['tokenizerSha256', { tokenizerSha256: 'b'.repeat(64) }],
    ['encoderConfigSha256', { encoderConfigSha256: 'c'.repeat(64) }],
    ['prefixes', { prefixes: { query: '[Q2] ', document: '[D] ' } }],
    ['casing', { casing: 'preserve_case' }],
    ['masks', { masks: { skipTokenIds: [2, 3], attentionMask: 'nonzero' } }],
    ['maxTokenCap', { maxTokenCap: 768 }],
    ['truncationPolicy', { truncationPolicy: 'longest_first' }],
    ['normalization', { normalization: 'none' }],
    ['packetVersion', { packetVersion: 'shootout_symbol_packet_1' }],
    ['codec', { codec: 'float32_raw_v1' }],
    ['dimensions', { dimensions: 128 }],
    ['runtimeQualificationDigest', { runtimeQualificationDigest: 'd'.repeat(64) }],
  ];

  for (const [fieldName, override] of mutations) {
    const mutatedKey = computePersistentVectorCacheKey({ ...header, ...override }, packet);
    assert.notEqual(mutatedKey, baseKey, `Mutating ${fieldName} must change the cache key.`);
  }

  const alteredPacket = Buffer.from('symbol: handleWebhook\nkind: function\nbody: return false;\n', 'utf8');
  const alteredKey = computePersistentVectorCacheKey(
    { ...header, packetByteLength: alteredPacket.length },
    alteredPacket,
  );
  assert.notEqual(alteredKey, baseKey, 'Mutating packet bytes must change the cache key.');

  assert.throws(
    () => computePersistentVectorCacheKey({ ...header, packetByteLength: packet.length + 1 }, packet),
    /packetByteLength/i,
  );
});

test('publication eligibility witness fails when publication, source hash, owner, span, or edge digest mutates', () => {
  const witness = {
    publicationId: 'pub-1',
    sourceSha256: 'a'.repeat(64),
    ownerId: 'sym_handleWebhook',
    sourceSpan: { startLine: 12, endLine: 44 },
    incidentEdgeDigest: 'b'.repeat(64),
  };
  assert.equal(verifyPublicationEligibilityWitness(witness, structuredClone(witness)).eligible, true);

  for (const [field, value] of [
    ['publicationId', 'pub-2'],
    ['sourceSha256', 'c'.repeat(64)],
    ['ownerId', 'sym_other'],
    ['sourceSpan', { startLine: 12, endLine: 45 }],
    ['incidentEdgeDigest', 'd'.repeat(64)],
  ]) {
    const mutated = { ...witness, [field]: value };
    const verdict = verifyPublicationEligibilityWitness(witness, mutated);
    assert.equal(verdict.eligible, false, `Mutating ${field} must fail eligibility.`);
  }
});

test('checkRunComparability rejects mismatched freshness/debug modes and revisit-cached relabeling', () => {
  const base = structuredClone(FIXTURE.defaultEvaluation.baselineRun);
  const cand = structuredClone(FIXTURE.defaultEvaluation.candidateRun);
  assert.equal(checkRunComparability(base, cand).comparable, true);

  const mismatchedWatcher = structuredClone(cand);
  mismatchedWatcher.freshnessMode = 'conservative_scan';
  assert.equal(checkRunComparability(base, mismatchedWatcher).comparable, false);

  const mismatchedDebug = structuredClone(cand);
  mismatchedDebug.debugMode = 'none';
  assert.equal(checkRunComparability(base, mismatchedDebug).comparable, false);

  const revisitRelabel = structuredClone(cand);
  revisitRelabel.cacheState = 'revisit_cached';
  revisitRelabel.timingScope.novelQueryClaim = true;
  assert.equal(checkRunComparability(base, revisitRelabel).comparable, false);

  const crossArch = structuredClone(cand);
  crossArch.host.arch = 'arm64';
  assert.equal(checkRunComparability(base, crossArch).comparable, false);
});
