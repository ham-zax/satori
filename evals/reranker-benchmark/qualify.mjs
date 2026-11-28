#!/usr/bin/env node
// Offline reranker qualification gate evaluator.
// Reuses evals/real-repo-quality/score.mjs without modifying oracle semantics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SHOOTOUT_QUALIFICATION_SCHEMA_VERSION,
  checkRunComparability,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
  isSha256,
  sha256CanonicalJson,
  validateManifest,
  validateRun,
} from './contracts.mjs';
import { normalizeHit, scoreQuery } from '../real-repo-quality/score.mjs';

export const DEFAULT_PROMOTION_GATES = Object.freeze({
  // Fair beat-baseline accuracy gates (shipped LateOn itself fails the earlier
  // aspirational 39/45 cloud-API bar). Absolute floors remain optional overrides.
  minHitAt1Delta: 0,
  minStrictHitAt1Delta: 1,
  maxHitAt5Drop: 1,
  minMrrDelta: 0,
  maxProtectedLosses: 3,
  requireNetStrictWinGain: true,
  minHitAt1: null,
  minStrictHitAt1: null,
  minHitAt5: null,
  minMrrAt10: null,
  maxWarmNovelP50Ms: 800,
  maxInferenceRssBytes: 500_000_000,
  maxHeadAbsError: 1e-4,
  maxUnrelatedQueryCosine: 0.95,
  minAlignedTokenCosMean: 0.85,
  minScoreSpread: 0.05,
});

export const RANK_BASES = Object.freeze([
  'owner_collapsed',
  'raw_candidate',
  'actual_returned',
]);

function defaultClassifyPathCategory(filePath) {
  if (!filePath) return 'neutral';
  if (/(^|\/)(test|tests|__tests__|__fixtures__|fixtures)\/|\.(test|spec)\.[^/]+$/i.test(filePath)) {
    return 'tests';
  }
  return 'srcRuntime';
}

export function scoreRankedHits(queryCase, rawHits, options = {}) {
  const rankBasis = options.rankBasis ?? 'actual_returned';
  if (!RANK_BASES.includes(rankBasis)) {
    throw new Error(`Unsupported rankBasis '${rankBasis}'.`);
  }
  const limit = options.limit ?? 10;
  const classify = options.classifyPathCategory ?? defaultClassifyPathCategory;
  const seenOwners = new Set();
  const normalized = [];

  for (const raw of rawHits) {
    const hit = normalizeHit({ rank: normalized.length + 1, raw }, classify);
    if (rankBasis === 'owner_collapsed') {
      const ownerId = raw?.ownerSymbolInstanceId ?? raw?.owner?.symbolInstanceId ?? raw?.target?.symbolId ?? null;
      const ownerKey = ownerId
        ? `${hit.path ?? ''}\0${ownerId}`
        : hit.granularity === 'file'
          ? `file\0${hit.path ?? ''}`
          : null;
      if (ownerKey && seenOwners.has(ownerKey)) continue;
      if (ownerKey) seenOwners.add(ownerKey);
    }
    normalized.push(hit);
    if (normalized.length >= limit) break;
  }

  return {
    rankBasis,
    ...scoreQuery(queryCase, normalized),
    evaluatedHits: normalized.length,
  };
}

export function normalizeHistoricalRecord(record) {
  if (!isPlainObject(record)) {
    throw new Error('Historical record must be an object.');
  }
  const score = isPlainObject(record.score)
    ? {
        rank: record.score.rank ?? null,
        strictRank: record.score.strictRank ?? null,
        granularity: record.score.granularity ?? null,
        matched: record.score.matched ?? null,
      }
    : { rank: null, strictRank: null, granularity: null, matched: null };

  const rankBasis = record.rankBasis ?? 'actual_returned';
  return {
    id: record.id,
    repo: record.repo ?? null,
    query: record.query ?? null,
    rankBasis,
    score,
    rerankApplied: record.rerankApplied === true,
    orderAuthority: record.orderAuthority ?? null,
    freshnessMode: record.freshnessMode ?? null,
    warmCleanMs: isFiniteNumber(record.warmCleanMs) ? record.warmCleanMs : null,
    instrumentedFullDebugMs: isFiniteNumber(record.instrumentedFullDebugMs)
      ? record.instrumentedFullDebugMs
      : isFiniteNumber(record.elapsedMs)
        ? record.elapsedMs
        : null,
    failed: record.failed === true
      || record.freshnessMode === 'served_previous_generation'
      || record.freshnessMode === 'unknown',
  };
}

export function summarizeQualityCases(cases, rankBasis = 'actual_returned') {
  if (!RANK_BASES.includes(rankBasis)) {
    throw new Error(`Unsupported rankBasis '${rankBasis}'.`);
  }
  const n = cases.length;
  const rankOf = (c, strict) => {
    if (c.failed === true) return null;
    if (c.ranksByBasis && isPlainObject(c.ranksByBasis[rankBasis])) {
      return strict ? c.ranksByBasis[rankBasis].strictRank : c.ranksByBasis[rankBasis].rank;
    }
    return strict ? (c.score?.strictRank ?? null) : (c.score?.rank ?? null);
  };
  const hitAt = (strict, k) => cases.filter((c) => {
    const r = rankOf(c, strict);
    return Number.isInteger(r) && r >= 1 && r <= k;
  }).length;
  const mrrAt10 = (strict) => (n === 0
    ? 0
    : cases.reduce((sum, c) => {
        const r = rankOf(c, strict);
        return sum + (Number.isInteger(r) && r >= 1 && r <= 10 ? 1 / r : 0);
      }, 0) / n);

  return {
    rankBasis,
    queries: n,
    failedCases: cases.filter((c) => c.failed === true).length,
    staleCases: cases.filter((c) => c.freshnessMode === 'served_previous_generation').length,
    hitAt1: hitAt(false, 1),
    strictHitAt1: hitAt(true, 1),
    hitAt3: hitAt(false, 3),
    strictHitAt3: hitAt(true, 3),
    hitAt5: hitAt(false, 5),
    strictHitAt5: hitAt(true, 5),
    hitAt10: hitAt(false, 10),
    strictHitAt10: hitAt(true, 10),
    mrrAt10: mrrAt10(false),
    strictMrrAt10: mrrAt10(true),
  };
}

export function verifyTokenizerReceipt(receipt, expectedModel) {
  const errors = [];
  if (!isPlainObject(receipt)) {
    return { passed: false, errors: ['Missing tokenizer qualification receipt.'] };
  }
  if (!isSha256(receipt.tokenizerSha256)) {
    errors.push('Tokenizer receipt missing valid tokenizerSha256.');
  } else if (expectedModel) {
    const expectedTok = expectedModel.artifacts?.find((a) => a.path.endsWith('tokenizer.json'))?.sha256;
    if (expectedTok && receipt.tokenizerSha256 !== expectedTok) {
      errors.push('Tokenizer receipt digest does not match pinned manifest tokenizer.json.');
    }
  }
  if (receipt.allIdsExact !== true) {
    errors.push('Tokenizer receipt did not achieve exact token ID parity.');
  }
  if (receipt.allMasksExact !== true) {
    errors.push('Tokenizer receipt did not achieve exact attention_mask parity.');
  }
  if (!Number.isSafeInteger(receipt.samples) || receipt.samples < 1) {
    errors.push('Tokenizer receipt must verify at least one pair sample.');
  }
  if (expectedModel?.tokenizer?.template === '[CLS] A [SEP] B [SEP]') {
    if (receipt.terminalSepPreservedOnTruncation !== true) {
      errors.push('Pair tokenizer receipt must prove terminal [SEP] is preserved on truncated pairs.');
    }
    if (receipt.separatorCountPerPair !== 2) {
      errors.push('Pair tokenizer receipt must verify both [SEP] separators per pair.');
    }
  }
  if (Array.isArray(receipt.sampleRows)) {
    for (const [idx, row] of receipt.sampleRows.entries()) {
      if (row?.sameIds !== true || row?.sameMask !== true) {
        errors.push(`Tokenizer sampleRows[${idx}] failed exact ID/mask parity.`);
      }
      if (expectedModel?.tokenizer?.template === '[CLS] A [SEP] B [SEP]') {
        if (row?.endsWithSep !== true || row?.sepCount !== 2) {
          errors.push(`Tokenizer sampleRows[${idx}] dropped required [SEP] separator.`);
        }
      }
    }
  }
  return { passed: errors.length === 0, errors };
}

export function verifyHeadReferenceReceipt(receipt, expectedModel, maxAbsError = DEFAULT_PROMOTION_GATES.maxHeadAbsError) {
  const errors = [];
  if (!isPlainObject(receipt)) {
    return { passed: false, errors: ['Missing head reference qualification receipt.'] };
  }
  const headKind = expectedModel?.head?.kind;
  if (headKind === 'cls_dense_gelu_layernorm_linear') {
    if (receipt.headPresent !== true) {
      errors.push('Cross-encoder head is missing from the qualified graph.');
    }
    if (receipt.gelu !== expectedModel.head.gelu) {
      errors.push(`Head GELU mismatch: expected '${expectedModel.head.gelu}', got '${receipt.gelu}'.`);
    }
    if (receipt.layerNormEpsilon !== expectedModel.head.layerNormEpsilon) {
      errors.push(
        `Head LayerNorm epsilon mismatch: expected ${expectedModel.head.layerNormEpsilon}, got ${receipt.layerNormEpsilon}.`,
      );
    }
    if (receipt.scope === 'full_model' && receipt.inputSource === 'quantized_backbone_cls') {
      errors.push('Head-only parity over quantized backbone CLS vectors must not be labeled full_model parity.');
    }
    if (!['head_only', 'full_model'].includes(receipt.scope)) {
      errors.push(`Unsupported head receipt scope '${receipt.scope}'.`);
    }
    if (!isSha256(receipt.modelSha256)) {
      errors.push('Head receipt missing valid modelSha256.');
    } else {
      const expectedOnnx = expectedModel.artifacts?.find((a) => a.path.endsWith('.onnx'))?.sha256;
      if (expectedOnnx && receipt.modelSha256 !== expectedOnnx) {
        errors.push('Head receipt modelSha256 does not match pinned manifest ONNX artifact.');
      }
    }
    if (!isFiniteNumber(receipt.maxAbsoluteError) || receipt.maxAbsoluteError > maxAbsError) {
      errors.push(
        `Head maxAbsoluteError (${receipt.maxAbsoluteError}) exceeds threshold (${maxAbsError}).`,
      );
    }
    if (Array.isArray(receipt.referenceRows) && receipt.referenceRows.length > 0) {
      for (const [idx, row] of receipt.referenceRows.entries()) {
        if (!isFiniteNumber(row?.onnx) || !isFiniteNumber(row?.reference)) {
          errors.push(`Head referenceRows[${idx}] contains non-finite values.`);
          continue;
        }
        const diff = Math.abs(row.onnx - row.reference);
        if (diff > maxAbsError) {
          errors.push(`Head referenceRows[${idx}] error ${diff} exceeds threshold ${maxAbsError}.`);
        }
      }
    } else {
      errors.push('Head receipt must include independent referenceRows.');
    }
  }
  return { passed: errors.length === 0, errors };
}

export function verifyNumericalHealthReceipt(receipt, expectedModel, gates = DEFAULT_PROMOTION_GATES) {
  const errors = [];
  if (!isPlainObject(receipt)) {
    return { passed: false, errors: ['Missing numerical health receipt.'] };
  }
  if (!isNonEmptyString(receipt.platform) || !isNonEmptyString(receipt.runtimeProvider)) {
    errors.push('Numerical health receipt must bind exact platform and runtimeProvider.');
  }
  if (!isSha256(receipt.modelSha256)) {
    errors.push('Numerical health receipt missing valid modelSha256.');
  } else if (expectedModel) {
    const expectedOnnx = expectedModel.artifacts?.find((a) => a.path.endsWith('.onnx'))?.sha256;
    if (expectedOnnx && receipt.modelSha256 !== expectedOnnx) {
      errors.push('Numerical health receipt modelSha256 does not match manifest.');
    }
  }
  if (receipt.allOutputsFinite !== true || receipt.shapesValid !== true) {
    errors.push('Model outputs failed shape or finiteness checks.');
  }
  if (
    isFiniteNumber(receipt.unrelatedQueryCosineMax)
    && receipt.unrelatedQueryCosineMax > gates.maxUnrelatedQueryCosine
  ) {
    errors.push(
      `Numerical collapse detected: unrelatedQueryCosineMax=${receipt.unrelatedQueryCosineMax} > ${gates.maxUnrelatedQueryCosine}.`,
    );
  }
  if (
    isFiniteNumber(receipt.alignedTokenCosMean)
    && receipt.alignedTokenCosMean < gates.minAlignedTokenCosMean
  ) {
    errors.push(
      `Quantized embedding geometry degraded: alignedTokenCosMean=${receipt.alignedTokenCosMean} < ${gates.minAlignedTokenCosMean}.`,
    );
  }
  if (
    isFiniteNumber(receipt.scoreSpread)
    && receipt.scoreSpread < gates.minScoreSpread
  ) {
    errors.push(
      `Degenerate score spread detected: scoreSpread=${receipt.scoreSpread} < ${gates.minScoreSpread}.`,
    );
  }
  return { passed: errors.length === 0, errors };
}

export function evaluateQualification({
  manifest,
  modelId,
  targetPlatform,
  baselineRun,
  candidateRun,
  receipts = {},
  gates: gateOverrides = {},
  heldOutFolds = [],
  limitations = [],
}) {
  const gates = { ...DEFAULT_PROMOTION_GATES, ...gateOverrides };
  const gateResults = {};
  const allFailures = [];

  const manifestValidation = validateManifest(manifest);
  const modelEntry = manifestValidation.valid ? manifest.models?.[modelId] : null;
  if (!manifestValidation.valid) {
    allFailures.push(...manifestValidation.errors.map((e) => `manifest: ${e}`));
  }
  if (!modelEntry) {
    allFailures.push(`manifest: modelId '${modelId}' not found in manifest.`);
  }

  const baseValidation = validateRun(baselineRun);
  const candValidation = validateRun(candidateRun);
  if (!baseValidation.valid) {
    allFailures.push(...baseValidation.errors.map((e) => `baselineRun: ${e}`));
  }
  if (!candValidation.valid) {
    allFailures.push(...candValidation.errors.map((e) => `candidateRun: ${e}`));
  }

  // 1. Comparability gate
  const comparability = checkRunComparability(baselineRun, candidateRun, { claimModelOnlySpeedup: true });
  gateResults.comparability = {
    passed: comparability.comparable,
    errors: comparability.errors,
  };

  // 2. Completeness gate (reject partial arms, stale skips, failed cases)
  const completenessErrors = [];
  const expectedCount = candidateRun?.expectedCaseCount ?? baselineRun?.expectedCaseCount ?? 45;
  const candCases = Array.isArray(candidateRun?.qualityCases) ? candidateRun.qualityCases : [];
  const baseCases = Array.isArray(baselineRun?.qualityCases) ? baselineRun.qualityCases : [];
  if (candCases.length < expectedCount) {
    completenessErrors.push(
      `Partial candidate arm rejected: ${candCases.length}/${expectedCount} quality cases.`,
    );
  }
  if (baseCases.length < expectedCount) {
    completenessErrors.push(
      `Partial baseline arm rejected: ${baseCases.length}/${expectedCount} quality cases.`,
    );
  }
  const candSummary = summarizeQualityCases(candCases, 'actual_returned');
  const baseSummary = summarizeQualityCases(baseCases, 'actual_returned');
  if (candSummary.failedCases > 0 || candSummary.staleCases > 0) {
    completenessErrors.push(
      `Candidate run has ${candSummary.failedCases} failed cases and ${candSummary.staleCases} stale-generation reads.`,
    );
  }
  if (candidateRun?.processLifecycle?.remainingPids?.length > 0) {
    completenessErrors.push(
      `Candidate run leaked child processes: ${candidateRun.processLifecycle.remainingPids.join(', ')}.`,
    );
  }
  gateResults.completeness = {
    passed: completenessErrors.length === 0,
    errors: completenessErrors,
  };

  // 3. Numerical & artifact qualification gate
  const numericalErrors = [];
  const tokCheck = verifyTokenizerReceipt(receipts.tokenizer, modelEntry);
  if (!tokCheck.passed) numericalErrors.push(...tokCheck.errors);
  if (modelEntry?.head?.kind === 'cls_dense_gelu_layernorm_linear') {
    const headCheck = verifyHeadReferenceReceipt(receipts.head, modelEntry, gates.maxHeadAbsError);
    if (!headCheck.passed) numericalErrors.push(...headCheck.errors);
  }
  const healthCheck = verifyNumericalHealthReceipt(receipts.numericalHealth, modelEntry, gates);
  if (!healthCheck.passed) numericalErrors.push(...healthCheck.errors);
  if (receipts.numericalHealth?.platform && targetPlatform && receipts.numericalHealth.platform !== targetPlatform) {
    numericalErrors.push(
      `Numerical health receipt platform '${receipts.numericalHealth.platform}' does not match targetPlatform '${targetPlatform}'.`,
    );
  }
  gateResults.numerical = {
    passed: numericalErrors.length === 0,
    errors: numericalErrors,
  };

  // 4. Accuracy & protected-win gate
  const accuracyErrors = [];
  const baseById = new Map(baseCases.map((c) => [c.id, c]));
  const protectedLosses = [];
  const strictGains = [];
  for (const candCase of candCases) {
    const baseCase = baseById.get(candCase.id);
    const baseStrict = baseCase?.failed ? null : (baseCase?.score?.strictRank ?? null);
    const candStrict = candCase?.failed ? null : (candCase?.score?.strictRank ?? null);
    if (baseStrict === 1 && candStrict !== 1) {
      protectedLosses.push(candCase.id);
    } else if (baseStrict !== 1 && candStrict === 1) {
      strictGains.push(candCase.id);
    }
  }
  const hitAt1Delta = candSummary.hitAt1 - baseSummary.hitAt1;
  const strictHitAt1Delta = candSummary.strictHitAt1 - baseSummary.strictHitAt1;
  const hitAt5Drop = baseSummary.hitAt5 - candSummary.hitAt5;
  const mrrDelta = candSummary.mrrAt10 - baseSummary.mrrAt10;

  if (isFiniteNumber(gates.minHitAt1Delta) && hitAt1Delta < gates.minHitAt1Delta) {
    accuracyErrors.push(
      `Hit@1 delta ${hitAt1Delta} (${candSummary.hitAt1} vs baseline ${baseSummary.hitAt1}) < required ${gates.minHitAt1Delta}.`,
    );
  }
  if (isFiniteNumber(gates.minStrictHitAt1Delta) && strictHitAt1Delta < gates.minStrictHitAt1Delta) {
    accuracyErrors.push(
      `Strict Hit@1 delta ${strictHitAt1Delta} (${candSummary.strictHitAt1} vs baseline ${baseSummary.strictHitAt1}) < required ${gates.minStrictHitAt1Delta}.`,
    );
  }
  if (isFiniteNumber(gates.maxHitAt5Drop) && hitAt5Drop > gates.maxHitAt5Drop) {
    accuracyErrors.push(
      `Hit@5 dropped by ${hitAt5Drop} (${candSummary.hitAt5} vs baseline ${baseSummary.hitAt5}); max allowed drop is ${gates.maxHitAt5Drop}.`,
    );
  }
  if (isFiniteNumber(gates.minMrrDelta) && mrrDelta + 1e-9 < gates.minMrrDelta) {
    accuracyErrors.push(
      `MRR@10 delta ${mrrDelta.toFixed(6)} (${candSummary.mrrAt10.toFixed(6)} vs baseline ${baseSummary.mrrAt10.toFixed(6)}) < required ${gates.minMrrDelta}.`,
    );
  }
  if (isFiniteNumber(gates.minHitAt1) && candSummary.hitAt1 < gates.minHitAt1) {
    accuracyErrors.push(`Hit@1 ${candSummary.hitAt1}/${candSummary.queries} < required ${gates.minHitAt1}.`);
  }
  if (isFiniteNumber(gates.minStrictHitAt1) && candSummary.strictHitAt1 < gates.minStrictHitAt1) {
    accuracyErrors.push(`Strict Hit@1 ${candSummary.strictHitAt1}/${candSummary.queries} < required ${gates.minStrictHitAt1}.`);
  }
  if (isFiniteNumber(gates.minHitAt5) && candSummary.hitAt5 < gates.minHitAt5) {
    accuracyErrors.push(`Hit@5 ${candSummary.hitAt5}/${candSummary.queries} < required ${gates.minHitAt5}.`);
  }
  if (isFiniteNumber(gates.minMrrAt10) && candSummary.mrrAt10 < gates.minMrrAt10) {
    accuracyErrors.push(`MRR@10 ${candSummary.mrrAt10.toFixed(6)} < required ${gates.minMrrAt10}.`);
  }
  if (isFiniteNumber(gates.maxProtectedLosses) && protectedLosses.length > gates.maxProtectedLosses) {
    accuracyErrors.push(
      `Lost ${protectedLosses.length} protected strict@1 wins (${protectedLosses.join(', ')}); max allowed is ${gates.maxProtectedLosses}.`,
    );
  }
  if (
    gates.requireNetStrictWinGain === true
    && protectedLosses.length > 0
    && strictGains.length <= protectedLosses.length
  ) {
    accuracyErrors.push(
      `Protected strict@1 losses (${protectedLosses.length}: ${protectedLosses.join(', ')}) were not outweighed by strict@1 gains (${strictGains.length}: ${strictGains.join(', ')}).`,
    );
  }
  gateResults.accuracy = {
    passed: accuracyErrors.length === 0,
    errors: accuracyErrors,
    deltas: {
      hitAt1: hitAt1Delta,
      strictHitAt1: strictHitAt1Delta,
      hitAt5: candSummary.hitAt5 - baseSummary.hitAt5,
      mrrAt10: mrrDelta,
    },
    baseline: baseSummary,
    candidate: candSummary,
  };

  // 5. Latency gate
  const latencyErrors = [];
  const warmNovelP50Ms = candidateRun?.latency?.warmNovelP50Ms;
  if (!isFiniteNumber(warmNovelP50Ms)) {
    latencyErrors.push('Candidate run missing required latency.warmNovelP50Ms.');
  } else if (warmNovelP50Ms > gates.maxWarmNovelP50Ms) {
    latencyErrors.push(`Warm novel-query p50 ${warmNovelP50Ms} ms > budget ${gates.maxWarmNovelP50Ms} ms.`);
  }
  if (candidateRun?.cacheState === 'revisit_cached') {
    latencyErrors.push('Latency measured on revisit_cached cannot satisfy novel-query latency gate.');
  }
  gateResults.latency = {
    passed: latencyErrors.length === 0,
    errors: latencyErrors,
    observedWarmNovelP50Ms: isFiniteNumber(warmNovelP50Ms) ? warmNovelP50Ms : null,
  };

  // 6. Memory gate (requires explicit inference-host RSS AND whole-service RSS)
  const memoryErrors = [];
  const infRss = candidateRun?.memory?.inferenceHostPeakRssBytes;
  const treeRss = candidateRun?.memory?.wholeServicePeakRssBytes;
  if (!isFiniteNumber(infRss) || infRss <= 0) {
    memoryErrors.push('Candidate run omitted required memory.inferenceHostPeakRssBytes.');
  } else if (infRss > gates.maxInferenceRssBytes) {
    memoryErrors.push(
      `Inference host peak RSS ${infRss} B > budget ${gates.maxInferenceRssBytes} B.`,
    );
  }
  if (!isFiniteNumber(treeRss) || treeRss <= 0) {
    memoryErrors.push('Candidate run omitted required memory.wholeServicePeakRssBytes.');
  }
  gateResults.memory = {
    passed: memoryErrors.length === 0,
    errors: memoryErrors,
    inferenceHostPeakRssBytes: isFiniteNumber(infRss) ? infRss : null,
    wholeServicePeakRssBytes: isFiniteNumber(treeRss) ? treeRss : null,
  };

  // 7. Platform gate (explicit platform qualification; x86 never transfers to ARM64)
  const platformErrors = [];
  if (!isNonEmptyString(targetPlatform)) {
    platformErrors.push('targetPlatform is required.');
  } else {
    const platEntry = modelEntry?.platformQualifications?.[targetPlatform];
    if (!platEntry) {
      platformErrors.push(`Model '${modelId}' has no qualification entry for platform '${targetPlatform}'.`);
    } else if (platEntry.status === 'rejected' || platEntry.status === 'unqualified') {
      platformErrors.push(`Platform '${targetPlatform}' status is '${platEntry.status}': ${platEntry.reason}`);
    }
    const runPlatform = `${candidateRun?.host?.platform}-${candidateRun?.host?.arch}`;
    if (isNonEmptyString(candidateRun?.host?.arch) && !targetPlatform.startsWith(runPlatform)) {
      platformErrors.push(
        `Run host '${runPlatform}' cannot certify targetPlatform '${targetPlatform}'.`,
      );
    }
  }
  gateResults.platform = {
    passed: platformErrors.length === 0,
    errors: platformErrors,
  };

  for (const [gateName, result] of Object.entries(gateResults)) {
    if (!result.passed) {
      allFailures.push(...result.errors.map((e) => `${gateName}: ${e}`));
    }
  }

  const promotionEligible =
    manifestValidation.valid
    && baseValidation.valid
    && candValidation.valid
    && Object.values(gateResults).every((g) => g.passed);

  return {
    schemaVersion: SHOOTOUT_QUALIFICATION_SCHEMA_VERSION,
    modelId,
    targetPlatform,
    inputEvidenceHashes: {
      manifestSha256: manifestValidation.valid ? sha256CanonicalJson(manifest) : null,
      baselineRunSha256: baseValidation.valid ? sha256CanonicalJson(baselineRun) : null,
      candidateRunSha256: candValidation.valid ? sha256CanonicalJson(candidateRun) : null,
    },
    gateResults,
    protectedLosses,
    strictGains,
    heldOutFolds,
    limitations,
    promotionEligible,
    decision: promotionEligible ? 'go' : 'no_go',
    failures: allFailures,
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const argv = process.argv.slice(2);
  const opt = (flag, fallback) => {
    const idx = argv.indexOf(`--${flag}`);
    return idx >= 0 ? argv[idx + 1] : fallback;
  };
  const manifestPath = path.resolve(opt('manifest', path.join(here, 'models.json')));
  const fixturePath = path.resolve(opt('input', path.join(here, 'fixtures/qualification-v1.json')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const report = evaluateQualification({
    manifest,
    modelId: opt('model', fixture.defaultEvaluation.modelId),
    targetPlatform: opt('platform', fixture.defaultEvaluation.targetPlatform),
    baselineRun: fixture.defaultEvaluation.baselineRun,
    candidateRun: fixture.defaultEvaluation.candidateRun,
    receipts: fixture.defaultEvaluation.receipts,
    gates: fixture.defaultEvaluation.gates,
    limitations: fixture.defaultEvaluation.limitations,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (argv.includes('--require-go') && !report.promotionEligible) {
    process.exitCode = 1;
  }
}
