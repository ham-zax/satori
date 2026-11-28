import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateQualification,
  normalizeHistoricalRecord,
  scoreRankedHits,
  summarizeQualityCases,
  verifyHeadReferenceReceipt,
  verifyNumericalHealthReceipt,
  verifyTokenizerReceipt,
} from './qualify.mjs';
import { normalizeHit, scoreQuery } from '../real-repo-quality/score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS_MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'models.json'), 'utf8'));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/qualification-v1.json'), 'utf8'));

function makePassingEvaluationInput() {
  const base = structuredClone(FIXTURE.defaultEvaluation.baselineRun);
  const cand = structuredClone(FIXTURE.defaultEvaluation.candidateRun);
  // Make candidate preserve all baseline strict@1 wins and gain th4
  cand.qualityCases = [
    { id: 'ts14', requestId: 'req-c-1', publicationId: 'pub-1', freshnessMode: 'verified', failed: false, score: { rank: 1, strictRank: 1 } },
    { id: 'cl4', requestId: 'req-c-2', publicationId: 'pub-1', freshnessMode: 'verified', failed: false, score: { rank: 1, strictRank: 1 } },
    { id: 'th4', requestId: 'req-c-3', publicationId: 'pub-2', freshnessMode: 'verified', failed: false, score: { rank: 1, strictRank: 1 } },
  ];
  const manifest = structuredClone(MODELS_MANIFEST);
  manifest.models['ettin-reranker-17m-v1-avx2-full-head'].platformQualifications['linux-x64-avx2'].status = 'qualified';
  return {
    manifest,
    modelId: 'ettin-reranker-17m-v1-avx2-full-head',
    targetPlatform: 'linux-x64-avx2',
    baselineRun: base,
    candidateRun: cand,
    receipts: structuredClone(FIXTURE.defaultEvaluation.receipts),
    gates: structuredClone(FIXTURE.defaultEvaluation.gates),
  };
}

test('scoreRankedHits reuses real-repo-quality oracle semantics for constants, types, and file fallback', () => {
  const queryCase = {
    id: 'synth-1',
    acceptable: [
      { pathRegex: '^src/policy\\.ts$', symbolRegex: '^(MAX_RETRIES|PolicyConfig|applyPolicy)$' },
    ],
  };
  const rawHits = [
    { target: { file: 'src/policy.ts' }, symbolKind: 'file', displayLabel: 'file src/policy.ts' },
    { target: { file: 'src/policy.ts' }, symbolKind: 'constant', displayLabel: 'constant MAX_RETRIES' },
  ];

  const actual = scoreRankedHits(queryCase, rawHits, { rankBasis: 'actual_returned' });
  const direct = scoreQuery(
    queryCase,
    rawHits.map((raw, idx) => normalizeHit({ rank: idx + 1, raw }, () => 'srcRuntime')),
  );
  assert.equal(actual.rank, direct.rank);
  assert.equal(actual.strictRank, direct.strictRank);
  assert.equal(actual.rank, 1);
  assert.equal(actual.strictRank, 2);
});

test('scoreRankedHits preserves distinction between owner_collapsed and raw_candidate ranks', () => {
  const queryCase = {
    id: 'synth-owner-collapse',
    acceptable: [{ pathRegex: '^src/target\\.ts$', symbolRegex: '^targetFn$' }],
  };
  const rawHits = [
    { target: { file: 'src/other.ts', symbolId: 'sym_other' }, symbolKind: 'function', displayLabel: 'function helperA' },
    { target: { file: 'src/other.ts', symbolId: 'sym_other' }, symbolKind: 'function', displayLabel: 'function helperA' },
    { target: { file: 'src/target.ts', symbolId: 'sym_target' }, symbolKind: 'function', displayLabel: 'function targetFn' },
  ];
  const rawBasis = scoreRankedHits(queryCase, rawHits, { rankBasis: 'raw_candidate' });
  const collapsedBasis = scoreRankedHits(queryCase, rawHits, { rankBasis: 'owner_collapsed' });
  assert.equal(rawBasis.strictRank, 3);
  assert.equal(collapsedBasis.strictRank, 2);
});

test('normalizeHistoricalRecord preserves historical quality scores while flagging stale reads', () => {
  const [ts5, th3] = FIXTURE.historicalSampleRecords.map(normalizeHistoricalRecord);
  assert.equal(ts5.score.rank, 2);
  assert.equal(ts5.score.strictRank, 2);
  assert.equal(ts5.failed, false);
  assert.equal(th3.score.rank, 2);
  assert.equal(th3.score.strictRank, 2);
  assert.equal(th3.failed, true);

  const summary = summarizeQualityCases([ts5, th3], 'actual_returned');
  assert.equal(summary.staleCases, 1);
  assert.equal(summary.failedCases, 1);
});

test('tokenizer receipt verification detects dropped terminal [SEP] and mismatched hashes', () => {
  const model = MODELS_MANIFEST.models['ettin-reranker-17m-v1-avx2-full-head'];
  const validReceipt = structuredClone(FIXTURE.pinnedRealReceipts.ettin17TokenizerValidation);
  assert.equal(verifyTokenizerReceipt(validReceipt, model).passed, true);

  const droppedSep = structuredClone(validReceipt);
  droppedSep.terminalSepPreservedOnTruncation = false;
  assert.equal(verifyTokenizerReceipt(droppedSep, model).passed, false);

  const badRowSep = structuredClone(validReceipt);
  badRowSep.sampleRows[1].endsWithSep = false;
  assert.equal(verifyTokenizerReceipt(badRowSep, model).passed, false);

  const badTokHash = structuredClone(validReceipt);
  badTokHash.tokenizerSha256 = 'f'.repeat(64);
  assert.equal(verifyTokenizerReceipt(badTokHash, model).passed, false);
});

test('head reference verification rejects missing head, wrong GELU, wrong LayerNorm epsilon, and mislabeled full_model scope', () => {
  const model = MODELS_MANIFEST.models['ettin-reranker-17m-v1-avx2-full-head'];
  const validHead = structuredClone(FIXTURE.pinnedRealReceipts.ettin17HeadValidation);
  assert.equal(verifyHeadReferenceReceipt(validHead, model).passed, true);

  const missingHead = structuredClone(validHead);
  missingHead.headPresent = false;
  assert.equal(verifyHeadReferenceReceipt(missingHead, model).passed, false);

  const wrongGelu = structuredClone(validHead);
  wrongGelu.gelu = 'tanh_approx';
  assert.equal(verifyHeadReferenceReceipt(wrongGelu, model).passed, false);

  const wrongEps = structuredClone(validHead);
  wrongEps.layerNormEpsilon = 1e-6;
  assert.equal(verifyHeadReferenceReceipt(wrongEps, model).passed, false);

  const mislabeledScope = structuredClone(validHead);
  mislabeledScope.scope = 'full_model';
  assert.equal(verifyHeadReferenceReceipt(mislabeledScope, model).passed, false);
});

test('numerical health gate catches upstream INT8 AVX2 collapse even when shapes, hashes, and finiteness pass', () => {
  const upstreamModel = MODELS_MANIFEST.models['lateon-code-edge-int8-upstream'];
  const collapseReceipt = FIXTURE.pinnedRealReceipts.upstreamEdgeInt8Collapse;
  assert.equal(collapseReceipt.allOutputsFinite, true);
  assert.equal(collapseReceipt.shapesValid, true);
  const verdict = verifyNumericalHealthReceipt(collapseReceipt, upstreamModel);
  assert.equal(verdict.passed, false);
  assert.match(verdict.errors.join(' '), /collapse|degraded|spread/i);

  const repairedModel = MODELS_MANIFEST.models['lateon-code-edge-int8-u8u8'];
  const repairedReceipt = FIXTURE.pinnedRealReceipts.repairedEdgeU8U8Health;
  assert.equal(verifyNumericalHealthReceipt(repairedReceipt, repairedModel).passed, true);
});

test('evaluateQualification passes only when all gates pass, and rejects protected-win swaps, partial arms, omitted RSS, and cross-platform transfer', () => {
  const passing = makePassingEvaluationInput();
  const okReport = evaluateQualification(passing);
  assert.equal(okReport.promotionEligible, true, okReport.failures.join('; '));
  assert.equal(okReport.decision, 'go');

  // Hold aggregate Hit@1 constant (2/3 -> 2/3) while swapping a protected strict@1 win -> must fail
  // even under default beat-baseline gates (requireNetStrictWinGain + minStrictHitAt1Delta).
  const swapInput = makePassingEvaluationInput();
  swapInput.gates = {};
  swapInput.candidateRun.qualityCases[0].score = { rank: 2, strictRank: 2 };
  const swapReport = evaluateQualification(swapInput);
  assert.equal(swapReport.promotionEligible, false);
  assert.deepEqual(swapReport.protectedLosses, ['ts14']);

  // Beat-baseline with 1 minor protected loss outweighed by 2 strict gains -> must pass default gates
  const netGainInput = makePassingEvaluationInput();
  netGainInput.gates = {};
  netGainInput.baselineRun.expectedCaseCount = 4;
  netGainInput.candidateRun.expectedCaseCount = 4;
  netGainInput.baselineRun.qualityCases.push(
    { id: 'cl1', requestId: 'req-b-4', publicationId: 'pub-2', freshnessMode: 'verified', failed: false, score: { rank: 2, strictRank: 2 } },
  );
  netGainInput.candidateRun.qualityCases = [
    { id: 'ts14', requestId: 'req-c-1', publicationId: 'pub-1', freshnessMode: 'verified', failed: false, score: { rank: 2, strictRank: 2 } },
    { id: 'cl4', requestId: 'req-c-2', publicationId: 'pub-1', freshnessMode: 'verified', failed: false, score: { rank: 1, strictRank: 1 } },
    { id: 'th4', requestId: 'req-c-3', publicationId: 'pub-2', freshnessMode: 'verified', failed: false, score: { rank: 1, strictRank: 1 } },
    { id: 'cl1', requestId: 'req-c-4', publicationId: 'pub-2', freshnessMode: 'verified', failed: false, score: { rank: 1, strictRank: 1 } },
  ];
  const netGainReport = evaluateQualification(netGainInput);
  assert.equal(netGainReport.promotionEligible, true, netGainReport.failures.join('; '));
  assert.equal(netGainReport.decision, 'go');
  assert.equal(netGainReport.gateResults.accuracy.deltas.strictHitAt1, 1);

  // Partial arm (2/3 queries) -> must fail completeness
  const partialInput = makePassingEvaluationInput();
  partialInput.candidateRun.qualityCases = partialInput.candidateRun.qualityCases.slice(0, 2);
  const partialReport = evaluateQualification(partialInput);
  assert.equal(partialReport.promotionEligible, false);
  assert.equal(partialReport.gateResults.completeness.passed, false);

  // Omitted required RSS -> must fail memory
  const noRssInput = makePassingEvaluationInput();
  delete noRssInput.candidateRun.memory.wholeServicePeakRssBytes;
  const noRssReport = evaluateQualification(noRssInput);
  assert.equal(noRssReport.promotionEligible, false);
  assert.equal(noRssReport.gateResults.memory.passed, false);

  // x86 run attempting to certify linux-arm64 -> must fail platform
  const armTransferInput = makePassingEvaluationInput();
  armTransferInput.targetPlatform = 'linux-arm64';
  const armReport = evaluateQualification(armTransferInput);
  assert.equal(armReport.promotionEligible, false);
  assert.equal(armReport.gateResults.platform.passed, false);
});
