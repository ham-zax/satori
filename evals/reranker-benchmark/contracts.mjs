// Pure evaluation-only schema validation, comparability checks, and research-cache
// fingerprinting for the Satori offline reranker benchmark. Zero production imports.
import crypto from 'node:crypto';

export const SHOOTOUT_MANIFEST_SCHEMA_VERSION = 'satori_offline_shootout_manifest_v1';
export const SHOOTOUT_CORPUS_SCHEMA_VERSION = 'satori_offline_shootout_corpus_v1';
export const SHOOTOUT_RUN_SCHEMA_VERSION = 'satori_offline_shootout_run_v1';
export const SHOOTOUT_QUALIFICATION_SCHEMA_VERSION = 'satori_offline_shootout_qualification_v1';

export const EXPERIMENTAL_PACKET_VERSIONS = Object.freeze([
  'shootout_symbol_packet_1',
  'shootout_chunk_packet_1',
]);

export const FRESHNESS_MODES = Object.freeze([
  'production_watcher',
  'conservative_scan',
]);

export const RUNTIME_MODES = Object.freeze([
  'local',
  'installed',
]);

export const CACHE_STATES = Object.freeze([
  'initially_empty_novel_query',
  'cross_query_session_cache',
  'revisit_cached',
  'no_document_cache',
]);

export const MEASUREMENT_TAGS = Object.freeze([
  'measured',
  'extrapolated',
  'not_applicable',
]);

export const PLATFORM_QUALIFICATION_STATUSES = Object.freeze([
  'baseline_retained',
  'qualified',
  'experimental_unqualified',
  'rejected',
  'unqualified',
]);

const SHA256_RE = /^[a-f0-9]{64}$/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function assertAllFiniteNumbers(value, pathLabel) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number at ${pathLabel}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertAllFiniteNumbers(value[i], `${pathLabel}[${i}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      assertAllFiniteNumbers(nested, `${pathLabel}.${key}`);
    }
  }
}

export function serializeCanonicalJson(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Canonical JSON rejects non-finite numbers.');
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const entry = value[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serializeCanonicalJson(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`Canonical JSON does not support type '${type}'.`);
}

export function sha256Utf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256CanonicalJson(value) {
  return sha256Utf8(serializeCanonicalJson(value));
}

function pushIf(errors, condition, message) {
  if (condition) errors.push(message);
}

export function validateManifest(manifest) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ['Manifest must be a JSON object.'] };
  }
  try {
    assertAllFiniteNumbers(manifest, 'manifest');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  pushIf(
    errors,
    manifest.schemaVersion !== SHOOTOUT_MANIFEST_SCHEMA_VERSION,
    `Manifest schemaVersion must equal '${SHOOTOUT_MANIFEST_SCHEMA_VERSION}'.`,
  );
  pushIf(
    errors,
    manifest.evaluationOnly !== true || manifest.activationAllowed !== false,
    'Evaluation manifest must set evaluationOnly=true and activationAllowed=false.',
  );
  if (!isPlainObject(manifest.models) || Object.keys(manifest.models).length === 0) {
    errors.push('Manifest must declare a non-empty models map.');
    return { valid: errors.length === 0, errors };
  }

  for (const [modelId, entry] of Object.entries(manifest.models)) {
    const prefix = `models.${modelId}`;
    if (!isPlainObject(entry)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    pushIf(errors, !isNonEmptyString(entry.repository), `${prefix}.repository is required.`);
    pushIf(errors, !isNonEmptyString(entry.revision), `${prefix}.revision is required.`);
    pushIf(errors, !isNonEmptyString(entry.license), `${prefix}.license is required.`);
    pushIf(errors, !isPositiveInteger(entry.parameterCount), `${prefix}.parameterCount must be a positive integer.`);

    if (!Array.isArray(entry.artifacts) || entry.artifacts.length === 0) {
      errors.push(`${prefix}.artifacts must be a non-empty array.`);
    } else {
      for (const [index, artifact] of entry.artifacts.entries()) {
        const ap = `${prefix}.artifacts[${index}]`;
        pushIf(errors, !isNonEmptyString(artifact?.path), `${ap}.path is required.`);
        pushIf(errors, !isPositiveInteger(artifact?.bytes), `${ap}.bytes must be a positive integer.`);
        pushIf(errors, !isSha256(artifact?.sha256), `${ap}.sha256 must be a 64-hex SHA-256.`);
      }
    }

    if (entry.derivation !== null && entry.derivation !== undefined) {
      const dp = `${prefix}.derivation`;
      pushIf(errors, !isPlainObject(entry.derivation), `${dp} must be an object or null.`);
      if (isPlainObject(entry.derivation)) {
        pushIf(errors, !isNonEmptyString(entry.derivation.recipe), `${dp}.recipe is required.`);
        pushIf(errors, !isSha256(entry.derivation.parentSha256), `${dp}.parentSha256 must be SHA-256.`);
        pushIf(errors, !isSha256(entry.derivation.outputSha256), `${dp}.outputSha256 must be SHA-256.`);
      }
    }

    if (!isPlainObject(entry.tokenizer)) {
      errors.push(`${prefix}.tokenizer is required.`);
    } else {
      pushIf(errors, !isNonEmptyString(entry.tokenizer.template), `${prefix}.tokenizer.template is required.`);
      pushIf(errors, !isNonEmptyString(entry.tokenizer.truncation), `${prefix}.tokenizer.truncation is required.`);
      pushIf(errors, !isNonEmptyString(entry.tokenizer.casing), `${prefix}.tokenizer.casing is required.`);
    }

    if (!isPlainObject(entry.encoder)) {
      errors.push(`${prefix}.encoder is required.`);
    } else {
      pushIf(errors, !Array.isArray(entry.encoder.inputNames) || entry.encoder.inputNames.length === 0, `${prefix}.encoder.inputNames must be non-empty.`);
      pushIf(errors, !isNonEmptyString(entry.encoder.outputName), `${prefix}.encoder.outputName is required.`);
      pushIf(errors, !isPositiveInteger(entry.encoder.dimensions), `${prefix}.encoder.dimensions must be a positive integer.`);
      pushIf(errors, !isPositiveInteger(entry.encoder.maxTokenCap), `${prefix}.encoder.maxTokenCap must be a positive integer.`);
      pushIf(errors, !isPlainObject(entry.encoder.prefixes), `${prefix}.encoder.prefixes must be an object.`);
      pushIf(errors, !isNonEmptyString(entry.encoder.normalization), `${prefix}.encoder.normalization is required.`);
      pushIf(errors, !isNonEmptyString(entry.encoder.maskPolicy), `${prefix}.encoder.maskPolicy is required.`);
    }

    if (!isPlainObject(entry.head)) {
      errors.push(`${prefix}.head is required.`);
    } else {
      pushIf(errors, !isNonEmptyString(entry.head.kind), `${prefix}.head.kind is required.`);
      pushIf(errors, !isNonEmptyString(entry.head.output), `${prefix}.head.output is required.`);
    }

    if (!isPlainObject(entry.platformQualifications) || Object.keys(entry.platformQualifications).length === 0) {
      errors.push(`${prefix}.platformQualifications must list at least one platform entry.`);
    } else {
      for (const [platform, qual] of Object.entries(entry.platformQualifications)) {
        const qp = `${prefix}.platformQualifications.${platform}`;
        pushIf(errors, !isPlainObject(qual), `${qp} must be an object.`);
        if (isPlainObject(qual)) {
          pushIf(
            errors,
            !PLATFORM_QUALIFICATION_STATUSES.includes(qual.status),
            `${qp}.status must be one of ${PLATFORM_QUALIFICATION_STATUSES.join(', ')}.`,
          );
          pushIf(errors, !isNonEmptyString(qual.runtimeProvider), `${qp}.runtimeProvider is required.`);
          pushIf(errors, !isNonEmptyString(qual.reason), `${qp}.reason is required.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateCorpus(corpus) {
  const errors = [];
  if (!isPlainObject(corpus)) {
    return { valid: false, errors: ['Corpus must be a JSON object.'] };
  }
  try {
    assertAllFiniteNumbers(corpus, 'corpus');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  pushIf(
    errors,
    corpus.schemaVersion !== SHOOTOUT_CORPUS_SCHEMA_VERSION,
    `Corpus schemaVersion must equal '${SHOOTOUT_CORPUS_SCHEMA_VERSION}'.`,
  );
  pushIf(errors, !isSha256(corpus.casesSha256), 'corpus.casesSha256 must be a SHA-256 digest.');
  pushIf(errors, !isSha256(corpus.oracleSha256), 'corpus.oracleSha256 must be a SHA-256 digest.');
  pushIf(errors, !isNonEmptyString(corpus.captureId), 'corpus.captureId is required.');
  pushIf(errors, !isSha256(corpus.captureScriptSha256), 'corpus.captureScriptSha256 must be a SHA-256 digest.');
  pushIf(errors, !isPlainObject(corpus.repositories) || Object.keys(corpus.repositories).length === 0, 'corpus.repositories must be non-empty.');
  if (isPlainObject(corpus.repositories)) {
    for (const [repoName, witness] of Object.entries(corpus.repositories)) {
      pushIf(errors, !isNonEmptyString(witness?.commit), `corpus.repositories.${repoName}.commit is required.`);
      pushIf(errors, !isNonEmptyString(witness?.publicationId), `corpus.repositories.${repoName}.publicationId is required.`);
    }
  }
  if (!Array.isArray(corpus.queries) || corpus.queries.length === 0) {
    errors.push('corpus.queries must be a non-empty array.');
  } else {
    for (const [index, q] of corpus.queries.entries()) {
      const qp = `corpus.queries[${index}]`;
      pushIf(errors, !isNonEmptyString(q?.id), `${qp}.id is required.`);
      pushIf(errors, !isNonEmptyString(q?.repo), `${qp}.repo is required.`);
      pushIf(errors, !isNonEmptyString(q?.publicationId), `${qp}.publicationId is required.`);
      pushIf(errors, !Array.isArray(q?.candidates) || q.candidates.length === 0, `${qp}.candidates must be non-empty.`);
      if (Array.isArray(q?.candidates)) {
        for (const [cIdx, cand] of q.candidates.entries()) {
          const cp = `${qp}.candidates[${cIdx}]`;
          pushIf(errors, !isNonEmptyString(cand?.candidateId), `${cp}.candidateId is required.`);
          pushIf(errors, !isFiniteNumber(cand?.firstStageScore), `${cp}.firstStageScore must be finite.`);
          pushIf(errors, !isPositiveInteger(cand?.firstStageRank), `${cp}.firstStageRank must be a positive integer.`);
          pushIf(errors, !isNonEmptyString(cand?.symbolKind), `${cp}.symbolKind is required.`);
          pushIf(errors, !isSha256(cand?.sourceSha256), `${cp}.sourceSha256 must be SHA-256.`);
          pushIf(errors, !isSha256(cand?.projectionSha256), `${cp}.projectionSha256 must be SHA-256.`);
          pushIf(errors, !isPlainObject(cand?.sourceSpan), `${cp}.sourceSpan must be an object.`);
          pushIf(errors, !Array.isArray(cand?.verifiedEdges), `${cp}.verifiedEdges must be an array.`);
        }
      }
      pushIf(errors, !Array.isArray(q?.rawScores), `${qp}.rawScores must be an array.`);
      pushIf(errors, !Array.isArray(q?.finalOrder), `${qp}.finalOrder must be an array.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRun(run) {
  const errors = [];
  if (!isPlainObject(run)) {
    return { valid: false, errors: ['Run must be a JSON object.'] };
  }
  try {
    assertAllFiniteNumbers(run, 'run');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  pushIf(
    errors,
    run.schemaVersion !== SHOOTOUT_RUN_SCHEMA_VERSION,
    `Run schemaVersion must equal '${SHOOTOUT_RUN_SCHEMA_VERSION}'.`,
  );
  pushIf(errors, !isSha256(run.manifestSha256), 'run.manifestSha256 must be SHA-256.');
  pushIf(errors, !isSha256(run.corpusSha256), 'run.corpusSha256 must be SHA-256.');
  pushIf(errors, !isSha256(run.configSha256), 'run.configSha256 must be SHA-256.');
  pushIf(errors, !isNonEmptyString(run.command), 'run.command is required.');
  pushIf(errors, !isPlainObject(run.host) || !isNonEmptyString(run.host.platform) || !isNonEmptyString(run.host.arch), 'run.host.platform and run.host.arch are required.');
  pushIf(
    errors,
    !FRESHNESS_MODES.includes(run.freshnessMode),
    `run.freshnessMode must be one of ${FRESHNESS_MODES.join(', ')}.`,
  );
  pushIf(
    errors,
    !RUNTIME_MODES.includes(run.runtimeMode),
    `run.runtimeMode must be one of ${RUNTIME_MODES.join(', ')}.`,
  );
  pushIf(errors, !isNonEmptyString(run.debugMode), 'run.debugMode is required.');
  pushIf(
    errors,
    !CACHE_STATES.includes(run.cacheState),
    `run.cacheState must be one of ${CACHE_STATES.join(', ')}.`,
  );
  if (!isPositiveInteger(run.expectedCaseCount)) {
    errors.push('run.expectedCaseCount must be a positive integer.');
  }
  if (!Array.isArray(run.qualityCases) || run.qualityCases.length === 0) {
    errors.push('run.qualityCases must be a non-empty array.');
  } else {
    const seenIds = new Set();
    for (const [idx, qc] of run.qualityCases.entries()) {
      const qcp = `run.qualityCases[${idx}]`;
      pushIf(errors, !isNonEmptyString(qc?.id), `${qcp}.id is required.`);
      if (isNonEmptyString(qc?.id)) {
        pushIf(errors, seenIds.has(qc.id), `${qcp}.id '${qc.id}' is duplicated in qualityCases.`);
        seenIds.add(qc.id);
      }
      pushIf(errors, !isNonEmptyString(qc?.requestId), `${qcp}.requestId is required for same-request provenance.`);
      pushIf(errors, !isNonEmptyString(qc?.publicationId), `${qcp}.publicationId is required.`);
      pushIf(errors, !isNonEmptyString(qc?.freshnessMode), `${qcp}.freshnessMode is required from the same request.`);
      if (qc?.freshnessMode === 'unknown' || qc?.freshnessMode === 'served_previous_generation') {
        pushIf(errors, qc.failed !== true, `${qcp} with freshnessMode='${qc.freshnessMode}' must be recorded with failed=true.`);
      }
    }
  }

  if (!isPlainObject(run.timingScope)) {
    errors.push('run.timingScope is required.');
  } else {
    pushIf(errors, !isNonEmptyString(run.timingScope.label), 'run.timingScope.label is required.');
    pushIf(
      errors,
      run.timingScope.novelQueryClaim === true && run.cacheState === 'revisit_cached',
      'Cannot claim novel-query latency when run.cacheState is revisit_cached.',
    );
  }

  if (!isPlainObject(run.memory)) {
    errors.push('run.memory is required.');
  } else {
    pushIf(errors, !isNonEmptyString(run.memory.rssScope), 'run.memory.rssScope is required.');
    pushIf(errors, !isNonEmptyString(run.memory.rssMethod), 'run.memory.rssMethod is required.');
  }

  if (run.indexCost !== undefined) {
    pushIf(
      errors,
      !isPlainObject(run.indexCost) || !MEASUREMENT_TAGS.includes(run.indexCost.measurementTag),
      `run.indexCost.measurementTag must be one of ${MEASUREMENT_TAGS.join(', ')}.`,
    );
  }

  if (!isPlainObject(run.processLifecycle)) {
    errors.push('run.processLifecycle is required.');
  } else {
    pushIf(errors, !Array.isArray(run.processLifecycle.ownedPids), 'run.processLifecycle.ownedPids must be an array.');
    pushIf(errors, !Array.isArray(run.processLifecycle.exitedPids), 'run.processLifecycle.exitedPids must be an array.');
    pushIf(errors, !Array.isArray(run.processLifecycle.remainingPids), 'run.processLifecycle.remainingPids must be an array.');
  }

  return { valid: errors.length === 0, errors };
}

export function validateExperimentalPacket({ version, packetBytes, queryText, metadata }) {
  const errors = [];
  pushIf(
    errors,
    !EXPERIMENTAL_PACKET_VERSIONS.includes(version),
    `Unsupported experimental packet version '${version}'.`,
  );
  const buffer = Buffer.isBuffer(packetBytes)
    ? packetBytes
    : typeof packetBytes === 'string'
      ? Buffer.from(packetBytes, 'utf8')
      : null;
  if (!buffer || buffer.length === 0) {
    errors.push('packetBytes must be a non-empty Buffer or UTF-8 string.');
    return { valid: false, errors };
  }
  const text = buffer.toString('utf8');
  if (isNonEmptyString(queryText) && queryText.trim().length >= 8) {
    if (text.includes(queryText.trim())) {
      errors.push('Experimental packet must not embed query text.');
    }
  }
  if (isPlainObject(metadata)) {
    for (const forbidden of ['query', 'rerankQuery', 'firstStageRank', 'rankingPosition', 'queryPriority']) {
      if (forbidden in metadata) {
        errors.push(`Experimental packet metadata must not contain '${forbidden}'.`);
      }
    }
  }
  if (/^\s*(firstStageRank|rankingPosition|queryPriority)\s*[:=]/im.test(text)) {
    errors.push('Experimental packet bytes must not include ranking position or query-specific priority headers.');
  }
  return { valid: errors.length === 0, errors };
}

const REQUIRED_CACHE_HEADER_FIELDS = Object.freeze([
  'modelSha256',
  'tokenizerSha256',
  'encoderConfigSha256',
  'prefixes',
  'casing',
  'masks',
  'maxTokenCap',
  'truncationPolicy',
  'normalization',
  'packetVersion',
  'packetByteLength',
  'codec',
  'dimensions',
  'runtimeQualificationDigest',
]);

export function computePersistentVectorCacheKey(header, packetBytes) {
  if (!isPlainObject(header)) {
    throw new Error('Persistent vector cache header must be an object.');
  }
  const bytes = Buffer.isBuffer(packetBytes)
    ? packetBytes
    : typeof packetBytes === 'string'
      ? Buffer.from(packetBytes, 'utf8')
      : null;
  if (!bytes || bytes.length === 0) {
    throw new Error('packetBytes must be a non-empty Buffer or UTF-8 string.');
  }
  for (const field of REQUIRED_CACHE_HEADER_FIELDS) {
    if (header[field] === undefined || header[field] === null) {
      throw new Error(`Persistent vector cache header is missing required field '${field}'.`);
    }
  }
  for (const digestField of ['modelSha256', 'tokenizerSha256', 'encoderConfigSha256', 'runtimeQualificationDigest']) {
    if (!isSha256(header[digestField])) {
      throw new Error(`Cache header field '${digestField}' must be a 64-hex SHA-256 digest.`);
    }
  }
  if (!EXPERIMENTAL_PACKET_VERSIONS.includes(header.packetVersion)) {
    throw new Error(`Unsupported packetVersion '${header.packetVersion}'.`);
  }
  if (!isPositiveInteger(header.maxTokenCap)) {
    throw new Error('Cache header maxTokenCap must be a positive integer.');
  }
  if (!isPositiveInteger(header.dimensions)) {
    throw new Error('Cache header dimensions must be a positive integer.');
  }
  if (header.packetByteLength !== bytes.length) {
    throw new Error(
      `Cache header packetByteLength (${header.packetByteLength}) does not match packetBytes.length (${bytes.length}).`,
    );
  }
  const canonicalHeader = Buffer.from(serializeCanonicalJson(header), 'utf8');
  return crypto
    .createHash('sha256')
    .update(canonicalHeader)
    .update(Buffer.from([0x00]))
    .update(bytes)
    .digest('hex');
}

export function verifyPublicationEligibilityWitness(storedWitness, activeWitness) {
  const errors = [];
  if (!isPlainObject(storedWitness) || !isPlainObject(activeWitness)) {
    return { eligible: false, errors: ['Both stored and active publication witnesses must be objects.'] };
  }
  const required = ['publicationId', 'sourceSha256', 'ownerId', 'sourceSpan', 'incidentEdgeDigest'];
  for (const key of required) {
    if (storedWitness[key] === undefined || activeWitness[key] === undefined) {
      errors.push(`Missing eligibility witness field '${key}'.`);
    }
  }
  if (errors.length > 0) return { eligible: false, errors };

  pushIf(errors, storedWitness.publicationId !== activeWitness.publicationId, 'publicationId mismatch.');
  pushIf(errors, storedWitness.sourceSha256 !== activeWitness.sourceSha256, 'sourceSha256 mismatch.');
  pushIf(errors, storedWitness.ownerId !== activeWitness.ownerId, 'ownerId mismatch.');
  pushIf(
    errors,
    serializeCanonicalJson(storedWitness.sourceSpan) !== serializeCanonicalJson(activeWitness.sourceSpan),
    'sourceSpan mismatch.',
  );
  pushIf(
    errors,
    storedWitness.incidentEdgeDigest !== activeWitness.incidentEdgeDigest,
    'incidentEdgeDigest mismatch.',
  );

  return { eligible: errors.length === 0, errors };
}

export function checkRunComparability(baselineRun, candidateRun, options = {}) {
  const errors = [];
  const claimModelOnlySpeedup = options.claimModelOnlySpeedup !== false;

  if (!isPlainObject(baselineRun) || !isPlainObject(candidateRun)) {
    return { comparable: false, errors: ['Both baselineRun and candidateRun must be objects.'] };
  }
  if (baselineRun.corpusSha256 !== candidateRun.corpusSha256) {
    errors.push('Corpus digest mismatch between baseline and candidate runs.');
  }
  if (claimModelOnlySpeedup && baselineRun.freshnessMode !== candidateRun.freshnessMode) {
    errors.push(
      `Mismatched freshnessMode (${baselineRun.freshnessMode} vs ${candidateRun.freshnessMode}) cannot be compared as a model-only speedup.`,
    );
  }
  if (claimModelOnlySpeedup && baselineRun.debugMode !== candidateRun.debugMode) {
    errors.push(
      `Mismatched debugMode (${baselineRun.debugMode} vs ${candidateRun.debugMode}) cannot be compared as a model-only speedup.`,
    );
  }
  if (claimModelOnlySpeedup && baselineRun.runtimeMode !== candidateRun.runtimeMode) {
    errors.push(
      `Mismatched runtimeMode (${baselineRun.runtimeMode} vs ${candidateRun.runtimeMode}) cannot be compared as a model-only speedup.`,
    );
  }
  if (candidateRun.cacheState === 'revisit_cached' && candidateRun.timingScope?.novelQueryClaim === true) {
    errors.push('Candidate run relabels a cached revisit as novel-query latency.');
  }
  if (
    baselineRun.cacheState === 'initially_empty_novel_query'
    && candidateRun.cacheState === 'revisit_cached'
  ) {
    errors.push('Cannot compare a revisit_cached candidate against an initially_empty_novel_query baseline.');
  }
  if (baselineRun.host?.arch !== candidateRun.host?.arch) {
    errors.push(
      `Architecture mismatch (${baselineRun.host?.arch} vs ${candidateRun.host?.arch}); cross-platform results do not transfer.`,
    );
  }

  return { comparable: errors.length === 0, errors };
}
