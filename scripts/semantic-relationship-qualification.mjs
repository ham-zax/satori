import { createHash } from 'node:crypto';

const DECISIONS = new Set(['resolved', 'unresolved', 'ambiguous']);
const RELATIONSHIP_TYPES = new Set(['CALLS', 'REFERENCES']);
const AUTHORITIES = new Set([
    'direct_binding',
    'origin_flow',
    'heuristic_reference',
    'ambiguous',
    'unresolved',
    'unsupported',
    'unknown',
]);
const STRATEGIES = new Set([
    'direct_call',
    'type_dispatch',
    'embed_dispatch',
    'interface_dispatch',
    'inheritance_dispatch',
    'overload_resolution',
    'dynamic_dispatch',
    'unknown',
]);
const EVIDENCE_KINDS = new Set([
    'call_site',
    'caller_identity',
    'direct_symbol_binding',
    'alias_binding',
    'receiver_type',
    'constructor_origin',
    'assignment_origin',
    'field_origin',
    'flow_hop',
    'inheritance',
    'interface_contract',
    'overload_candidate',
    'branch_origin',
    'target_provenance',
    'candidate_set',
    'ambiguity',
    'unresolved_dependency',
    'dynamic_construct',
    'optional_receiver',
    'provider_specific',
]);

const MECHANISM_CLASSIFICATION = Object.freeze({
    direct_binding: 'The evidence establishes a direct symbol/import/lexical binding to the target.',
    origin_flow: 'The evidence follows a value, allocation, assignment, field, callback, or constructor origin to the target.',
    dispatch: 'The evidence resolves or bounds a receiver/type/interface/inheritance dispatch.',
    abstention: 'The output deliberately remains ambiguous or unresolved because the available evidence cannot prove one target.',
    unsupported_boundary: 'The provider explicitly identifies a capability boundary and supplies evidence for why this case is unsupported.',
    opaque_or_heuristic: 'The claimed mechanism is missing, heuristic, or not sufficiently connected to the presented evidence.',
});

export const RELATIONSHIP_QUALITATIVE_QUESTIONS = Object.freeze({
    evidence_sufficiency: {
        type: 'noul',
        instructions: 'Is the presented evidence sufficient to justify the relationship decision without relying on unstated provider knowledge?',
        criteria: {
            true: 'The evidence connects the call site, binding/origin/dispatch facts, and target or abstention reason strongly enough to justify the decision.',
            false: 'Critical binding, origin, dispatch, target-provenance, candidate, or missing-dependency evidence is absent or merely asserted.',
        },
    },
    relationship_usefulness: {
        type: 'noul',
        instructions: 'Would this relationship result materially help a coding agent navigate or reason about the call site safely?',
        criteria: {
            true: 'The result provides a useful exact target or a useful, bounded explanation of why no exact target is safe.',
            false: 'The result is misleading, too vague, or gives no actionable relationship information.',
        },
    },
    resolution_mechanism_quality: {
        type: 'noul',
        instructions: 'Is the declared resolution mechanism coherent with the evidence and appropriate for the observed construct?',
        criteria: {
            true: 'The mechanism is specific, internally consistent, and supported by the evidence trail.',
            false: 'The mechanism is generic, mismatched to the construct, or unsupported by the evidence trail.',
        },
    },
    mechanism_classification: {
        type: 'choice',
        instructions: 'Which mechanism best describes how this result is actually justified by the presented evidence?',
        criteria: MECHANISM_CLASSIFICATION,
    },
});

export const RELATIONSHIP_ABSTENTION_QUESTIONS = Object.freeze({
    ambiguity_unsupported_quality: {
        type: 'noul',
        instructions: 'When the result is ambiguous, unresolved, or unsupported, is that boundary represented precisely rather than as a generic failure?',
        criteria: {
            true: 'Competing candidates, conflicting origins, missing dependencies, dynamic behavior, or capability limits are identified specifically.',
            false: 'The result merely says it cannot resolve the call, hides competing candidates, or gives an unsupported boundary with no concrete basis.',
        },
    },
    actionable_unresolved_evidence: {
        type: 'noul',
        instructions: 'Does the unresolved or ambiguous evidence tell a coding agent what fact, dependency, or candidate distinction would need inspection next?',
        criteria: {
            true: 'The evidence identifies concrete candidates, source locations, dependencies, or missing facts that can be inspected next.',
            false: 'There is no concrete next inspection or the unresolved explanation is too generic to act on.',
        },
    },
});

function fail(message) {
    throw new Error(`Semantic relationship qualification: ${message}`);
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string.`);
    return value;
}

function requireArray(value, label) {
    if (!Array.isArray(value)) fail(`${label} must be an array.`);
    return value;
}

function requireEnum(value, allowed, label) {
    if (typeof value !== 'string' || !allowed.has(value)) {
        fail(`${label} has unsupported value '${String(value)}'.`);
    }
    return value;
}

function requireFiniteNonNegative(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite non-negative number.`);
    }
    return value;
}

function requireInteger(value, label, minimum) {
    if (!Number.isInteger(value) || value < minimum) {
        fail(`${label} must be an integer >= ${minimum}.`);
    }
    return value;
}

function validateSpan(value, label) {
    if (!isRecord(value)) fail(`${label} must be an object.`);
    const startLine = requireInteger(value.startLine, `${label}.startLine`, 1);
    const endLine = requireInteger(value.endLine, `${label}.endLine`, 1);
    const startByte = requireInteger(value.startByte, `${label}.startByte`, 0);
    const endByte = requireInteger(value.endByte, `${label}.endByte`, 0);
    requireInteger(value.startColumn, `${label}.startColumn`, 0);
    requireInteger(value.endColumn, `${label}.endColumn`, 0);
    if (endLine < startLine) fail(`${label}.endLine must not precede startLine.`);
    if (endByte < startByte) fail(`${label}.endByte must not precede startByte.`);
}

function validateTargetRef(value, label) {
    if (!isRecord(value)) fail(`${label} must be an object.`);
    requireString(value.ref, `${label}.ref`);
    if (value.label !== undefined) requireString(value.label, `${label}.label`);
    requireString(value.file, `${label}.file`);
    validateSpan(value.span, `${label}.span`);
}

function validateEvidenceAtom(value, label) {
    if (!isRecord(value)) fail(`${label} must be an object.`);
    requireEnum(value.kind, EVIDENCE_KINDS, `${label}.kind`);
    requireString(value.subject, `${label}.subject`);
    if (value.detail !== undefined) requireString(value.detail, `${label}.detail`);
    if (value.file !== undefined) requireString(value.file, `${label}.file`);
    if (value.span !== undefined) validateSpan(value.span, `${label}.span`);
}

function validateObservation(observation, label) {
    if (!isRecord(observation)) fail(`${label} must be an object.`);
    requireEnum(observation.decision, DECISIONS, `${label}.decision`);
    requireEnum(observation.relationshipType, RELATIONSHIP_TYPES, `${label}.relationshipType`);
    if (!isRecord(observation.callSite)) fail(`${label}.callSite must be an object.`);
    requireString(observation.callSite.file, `${label}.callSite.file`);
    validateSpan(observation.callSite.span, `${label}.callSite.span`);
    if (observation.callSite.text !== undefined) {
        requireString(observation.callSite.text, `${label}.callSite.text`);
    }
    validateTargetRef(observation.source, `${label}.source`);
    if (observation.target !== undefined && observation.target !== null) {
        validateTargetRef(observation.target, `${label}.target`);
    }
    for (const [index, alternative] of requireArray(observation.alternatives ?? [], `${label}.alternatives`).entries()) {
        validateTargetRef(alternative, `${label}.alternatives[${index}]`);
    }
    if (!isRecord(observation.mechanism)) fail(`${label}.mechanism must be an object.`);
    requireEnum(observation.mechanism.authority, AUTHORITIES, `${label}.mechanism.authority`);
    requireEnum(observation.mechanism.strategy, STRATEGIES, `${label}.mechanism.strategy`);
    if (observation.mechanism.detail !== undefined) {
        requireString(observation.mechanism.detail, `${label}.mechanism.detail`);
    }
    for (const [index, atom] of requireArray(observation.evidence, `${label}.evidence`).entries()) {
        validateEvidenceAtom(atom, `${label}.evidence[${index}]`);
    }
    for (const [index, atom] of requireArray(observation.unresolvedEvidence ?? [], `${label}.unresolvedEvidence`).entries()) {
        validateEvidenceAtom(atom, `${label}.unresolvedEvidence[${index}]`);
    }
}

function validateMeasurements(value, label) {
    for (const [index, sample] of requireArray(value ?? [], label).entries()) {
        if (!isRecord(sample)) fail(`${label}[${index}] must be an object.`);
        const keys = ['wallMs', 'cpuUserMs', 'cpuSystemMs', 'peakRssBytes', 'inputBytes', 'outputBytes'];
        let numericCount = 0;
        for (const key of keys) {
            if (sample[key] === undefined) continue;
            requireFiniteNonNegative(sample[key], `${label}[${index}].${key}`);
            numericCount += 1;
        }
        if (numericCount === 0) fail(`${label}[${index}] must contain at least one numeric measurement.`);
    }
}

function validateExpected(expected, label) {
    if (!isRecord(expected)) fail(`${label} must be an object.`);
    requireEnum(expected.decision, DECISIONS, `${label}.decision`);
    requireEnum(expected.relationshipType, RELATIONSHIP_TYPES, `${label}.relationshipType`);
    for (const key of ['targetRefs', 'candidateRefs', 'forbiddenTargetRefs', 'authorities', 'strategies', 'requiredEvidenceKinds']) {
        requireArray(expected[key], `${label}.${key}`);
    }
    for (const [index, authority] of expected.authorities.entries()) {
        requireEnum(authority, AUTHORITIES, `${label}.authorities[${index}]`);
    }
    for (const [index, strategy] of expected.strategies.entries()) {
        requireEnum(strategy, STRATEGIES, `${label}.strategies[${index}]`);
    }
    for (const [index, kind] of expected.requiredEvidenceKinds.entries()) {
        requireEnum(kind, EVIDENCE_KINDS, `${label}.requiredEvidenceKinds[${index}]`);
    }
    if (expected.decision === 'resolved' && expected.targetRefs.length === 0) {
        fail(`${label}.targetRefs must contain at least one target for a resolved case.`);
    }
    if (expected.decision !== 'resolved' && expected.targetRefs.length !== 0) {
        fail(`${label}.targetRefs must be empty for non-resolved cases.`);
    }
}

export function validateRelationshipCorpus(corpus) {
    if (!isRecord(corpus)) fail('corpus must be an object.');
    if (corpus.version !== 1) fail(`unsupported corpus version '${String(corpus.version)}'.`);
    requireString(corpus.family, 'corpus.family');
    const ids = new Set();
    for (const [index, item] of requireArray(corpus.cases, 'corpus.cases').entries()) {
        if (!isRecord(item)) fail(`corpus.cases[${index}] must be an object.`);
        const id = requireString(item.id, `corpus.cases[${index}].id`);
        if (ids.has(id)) fail(`duplicate corpus case '${id}'.`);
        ids.add(id);
        requireString(item.construct, `corpus.cases[${index}].construct`);
        requireString(item.scenario, `corpus.cases[${index}].scenario`);
        validateExpected(item.expected, `corpus.cases[${index}].expected`);
    }
    if (ids.size === 0) fail('corpus must contain at least one case.');
    return corpus;
}

export function validateRelationshipReport(report, corpus) {
    validateRelationshipCorpus(corpus);
    if (!isRecord(report)) fail('provider report must be an object.');
    if (report.version !== 1) fail(`unsupported provider report version '${String(report.version)}'.`);
    if (report.corpusVersion !== corpus.version) {
        fail(`provider report corpusVersion ${String(report.corpusVersion)} does not match corpus version ${corpus.version}.`);
    }
    if (!isRecord(report.provider)) fail('provider must be an object.');
    requireString(report.provider.id, 'provider.id');
    requireString(report.provider.version, 'provider.version');
    if (report.provider.adapterVersion !== undefined) {
        requireString(report.provider.adapterVersion, 'provider.adapterVersion');
    }
    requireString(report.language, 'language');

    const corpusIds = new Set(corpus.cases.map((item) => item.id));
    const reportIds = new Set();
    for (const [index, result] of requireArray(report.cases, 'cases').entries()) {
        if (!isRecord(result)) fail(`cases[${index}] must be an object.`);
        const caseId = requireString(result.caseId, `cases[${index}].caseId`);
        if (!corpusIds.has(caseId)) fail(`cases[${index}] references unknown corpus case '${caseId}'.`);
        if (reportIds.has(caseId)) fail(`duplicate provider result for corpus case '${caseId}'.`);
        reportIds.add(caseId);
        requireEnum(result.status, new Set(['ok', 'unsupported', 'error']), `cases[${index}].status`);
        if (result.status === 'ok') {
            validateObservation(result.observation, `cases[${index}].observation`);
        } else if (result.status === 'unsupported') {
            requireString(result.unsupportedReason, `cases[${index}].unsupportedReason`);
            for (const [evidenceIndex, atom] of requireArray(
                result.unsupportedEvidence ?? [],
                `cases[${index}].unsupportedEvidence`,
            ).entries()) {
                validateEvidenceAtom(atom, `cases[${index}].unsupportedEvidence[${evidenceIndex}]`);
            }
        } else {
            requireString(result.error, `cases[${index}].error`);
        }
        validateMeasurements(result.measurements, `cases[${index}].measurements`);
    }
    validateMeasurements(report.runMeasurements, 'runMeasurements');
    return report;
}

function sameSet(left, right) {
    const a = [...new Set(left)].sort();
    const b = [...new Set(right)].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function ratio(count, total) {
    return total === 0 ? null : Number((count / total).toFixed(4));
}

function evidenceKinds(observation) {
    return new Set([
        ...(observation?.evidence ?? []).map((item) => item.kind),
        ...(observation?.unresolvedEvidence ?? []).map((item) => item.kind),
    ]);
}

export function scoreRelationshipReport(corpus, report) {
    validateRelationshipReport(report, corpus);
    const results = new Map(report.cases.map((item) => [item.caseId, item]));
    const rows = [];
    let ok = 0;
    let unsupported = 0;
    let errors = 0;
    let missing = 0;
    let decisionExact = 0;
    let relationshipExact = 0;
    let semanticExact = 0;
    let strictCaseExact = 0;
    let authorityExact = 0;
    let strategyExact = 0;
    let evidenceContractExact = 0;
    let safeAbstentionExact = 0;
    let safeAbstentionTotal = 0;
    let candidateSetExact = 0;
    let candidateSetTotal = 0;
    let decoyAvoided = 0;
    let decoyTotal = 0;
    let decoyHits = 0;
    let falseResolved = 0;
    let wrongTargets = 0;
    let targetTp = 0;
    let targetFp = 0;
    let targetFn = 0;

    for (const item of corpus.cases) {
        const result = results.get(item.id);
        const expected = item.expected;
        if (!result) missing += 1;
        else if (result.status === 'ok') ok += 1;
        else if (result.status === 'unsupported') unsupported += 1;
        else errors += 1;

        const observation = result?.status === 'ok' ? result.observation : null;
        const targetRef = observation?.target?.ref ?? null;
        const alternatives = observation?.alternatives?.map((candidate) => candidate.ref) ?? [];
        const requiredKinds = evidenceKinds(observation);
        const checks = {
            decision: Boolean(observation && observation.decision === expected.decision),
            relationshipType: Boolean(observation && observation.relationshipType === expected.relationshipType),
            target: expected.decision === 'resolved'
                ? Boolean(observation && expected.targetRefs.includes(targetRef))
                : Boolean(observation && targetRef === null),
            candidates: Boolean(observation && sameSet(alternatives, expected.candidateRefs)),
            authority: Boolean(observation && expected.authorities.includes(observation.mechanism.authority)),
            strategy: Boolean(observation && expected.strategies.includes(observation.mechanism.strategy)),
            evidence: Boolean(observation && expected.requiredEvidenceKinds.every((kind) => requiredKinds.has(kind))),
            decoyAvoidance: expected.forbiddenTargetRefs.length === 0
                ? true
                : Boolean(!targetRef || !expected.forbiddenTargetRefs.includes(targetRef)),
        };

        if (checks.decision) decisionExact += 1;
        if (checks.relationshipType) relationshipExact += 1;
        if (checks.authority) authorityExact += 1;
        if (checks.strategy) strategyExact += 1;
        if (checks.evidence) evidenceContractExact += 1;

        if (expected.decision !== 'resolved') {
            safeAbstentionTotal += 1;
            if (checks.decision && checks.relationshipType && checks.target) safeAbstentionExact += 1;
            if (observation?.decision === 'resolved') falseResolved += 1;
        }
        if (expected.candidateRefs.length > 0) {
            candidateSetTotal += 1;
            if (checks.candidates) candidateSetExact += 1;
        }
        if (expected.forbiddenTargetRefs.length > 0) {
            decoyTotal += 1;
            if (checks.decoyAvoidance) decoyAvoided += 1;
            else decoyHits += 1;
        }

        const expectedResolved = expected.decision === 'resolved';
        const predictedResolved = observation?.decision === 'resolved' && targetRef !== null;
        const correctTarget = predictedResolved && expectedResolved && expected.targetRefs.includes(targetRef);
        if (correctTarget) targetTp += 1;
        if (predictedResolved && !correctTarget) targetFp += 1;
        if (expectedResolved && !correctTarget) targetFn += 1;
        if (expectedResolved && predictedResolved && !correctTarget) wrongTargets += 1;

        const semantic = checks.decision
            && checks.relationshipType
            && checks.target
            && checks.candidates
            && checks.decoyAvoidance;
        const strict = semantic && checks.authority && checks.strategy && checks.evidence;
        if (semantic) semanticExact += 1;
        if (strict) strictCaseExact += 1;

        rows.push({
            caseId: item.id,
            construct: item.construct,
            status: result?.status ?? 'missing',
            ...(result?.status === 'unsupported' ? { unsupportedReason: result.unsupportedReason } : {}),
            ...(result?.status === 'error' ? { error: result.error } : {}),
            checks,
            semanticExact: semantic,
            strictCaseExact: strict,
            observed: observation
                ? {
                    decision: observation.decision,
                    relationshipType: observation.relationshipType,
                    targetRef,
                    alternativeRefs: alternatives,
                    authority: observation.mechanism.authority,
                    strategy: observation.mechanism.strategy,
                    evidenceKinds: [...requiredKinds].sort(),
                }
                : null,
        });
    }

    const total = corpus.cases.length;
    const precisionDenominator = targetTp + targetFp;
    const recallDenominator = targetTp + targetFn;
    const precision = precisionDenominator === 0 ? null : targetTp / precisionDenominator;
    const recall = recallDenominator === 0 ? null : targetTp / recallDenominator;
    const f1 = precision === null || recall === null || precision + recall === 0
        ? null
        : 2 * precision * recall / (precision + recall);

    return {
        totalCases: total,
        coverage: {
            ok,
            unsupported,
            error: errors,
            missing,
            okRate: ratio(ok, total),
        },
        exactness: {
            decisionExact: { count: decisionExact, rate: ratio(decisionExact, total) },
            relationshipTypeExact: { count: relationshipExact, rate: ratio(relationshipExact, total) },
            semanticExact: { count: semanticExact, rate: ratio(semanticExact, total) },
            strictCaseExact: { count: strictCaseExact, rate: ratio(strictCaseExact, total) },
            authorityAgreement: { count: authorityExact, rate: ratio(authorityExact, total) },
            strategyAgreement: { count: strategyExact, rate: ratio(strategyExact, total) },
            evidenceContractExact: { count: evidenceContractExact, rate: ratio(evidenceContractExact, total) },
            safeAbstentionExact: {
                count: safeAbstentionExact,
                total: safeAbstentionTotal,
                rate: ratio(safeAbstentionExact, safeAbstentionTotal),
            },
            candidateSetExact: {
                count: candidateSetExact,
                total: candidateSetTotal,
                rate: ratio(candidateSetExact, candidateSetTotal),
            },
            decoyAvoidance: {
                count: decoyAvoided,
                total: decoyTotal,
                rate: ratio(decoyAvoided, decoyTotal),
                hits: decoyHits,
            },
            falseResolvedCount: falseResolved,
            wrongTargetCount: wrongTargets,
        },
        resolvedTarget: {
            truePositive: targetTp,
            falsePositive: targetFp,
            falseNegative: targetFn,
            precision: precision === null ? null : Number(precision.toFixed(4)),
            recall: recall === null ? null : Number(recall.toFixed(4)),
            f1: f1 === null ? null : Number(f1.toFixed(4)),
        },
        cases: rows,
    };
}

function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[index];
}

function summarizeNumbers(values) {
    if (values.length === 0) return null;
    const sum = values.reduce((total, value) => total + value, 0);
    return {
        samples: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: Number((sum / values.length).toFixed(4)),
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
    };
}

function summarizeSamples(samples) {
    const keys = ['wallMs', 'cpuUserMs', 'cpuSystemMs', 'peakRssBytes', 'inputBytes', 'outputBytes'];
    const summary = {};
    for (const key of keys) {
        const values = samples.flatMap((sample) => (
            typeof sample[key] === 'number' ? [sample[key]] : []
        ));
        const metric = summarizeNumbers(values);
        if (metric) summary[key] = metric;
    }
    const cpuTotals = samples.flatMap((sample) => (
        typeof sample.cpuUserMs === 'number' && typeof sample.cpuSystemMs === 'number'
            ? [sample.cpuUserMs + sample.cpuSystemMs]
            : []
    ));
    const cpuTotal = summarizeNumbers(cpuTotals);
    if (cpuTotal) summary.cpuTotalMs = cpuTotal;
    return summary;
}

export function summarizeRelationshipPerformance(corpus, report) {
    validateRelationshipReport(report, corpus);
    const byCase = [];
    const allSamples = [];
    for (const result of report.cases) {
        const samples = result.measurements ?? [];
        if (samples.length === 0) continue;
        allSamples.push(...samples);
        byCase.push({
            caseId: result.caseId,
            samples: samples.length,
            metrics: summarizeSamples(samples),
        });
    }
    const runSamples = report.runMeasurements ?? [];
    return {
        measuredCases: byCase.length,
        caseSamples: allSamples.length,
        byCase,
        aggregateCaseSamples: summarizeSamples(allSamples),
        runSamples: runSamples.length,
        aggregateRunSamples: summarizeSamples(runSamples),
    };
}

function blindTokenMap(item, result, provider) {
    const refs = new Set([
        ...item.expected.targetRefs,
        ...item.expected.candidateRefs,
        ...item.expected.forbiddenTargetRefs,
    ]);
    if (result.status === 'ok') {
        refs.add(result.observation.source.ref);
        if (result.observation.target?.ref) refs.add(result.observation.target.ref);
        for (const alternative of result.observation.alternatives ?? []) refs.add(alternative.ref);
    }
    const replacements = new Map(
        [...refs].sort().map((ref) => [
            ref,
            `symbol_${createHash('sha256').update(ref).digest('hex').slice(0, 10)}`,
        ]),
    );
    replacements.set(provider.id, 'provider_hidden');
    replacements.set(provider.version, 'provider_version_hidden');
    return replacements;
}

function sanitizeBlindValue(value, replacements) {
    if (typeof value === 'string') {
        let sanitized = value;
        for (const [token, replacement] of replacements) {
            sanitized = sanitized.replaceAll(token, replacement);
        }
        return sanitized;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeBlindValue(entry, replacements));
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, sanitizeBlindValue(entry, replacements)]),
    );
}

function blindObservation(item, result, provider) {
    const replacements = blindTokenMap(item, result, provider);
    let projected;
    if (result.status === 'unsupported') {
        projected = {
            status: 'unsupported',
            unsupportedReason: result.unsupportedReason,
            evidence: result.unsupportedEvidence ?? [],
        };
    } else if (result.status !== 'ok') {
        projected = { status: result.status };
    } else {
        projected = {
            status: 'ok',
            observation: {
                decision: result.observation.decision,
                relationshipType: result.observation.relationshipType,
                callSite: result.observation.callSite,
                source: result.observation.source,
                target: result.observation.target ?? null,
                alternatives: result.observation.alternatives ?? [],
                mechanism: result.observation.mechanism,
                evidence: result.observation.evidence,
                unresolvedEvidence: result.observation.unresolvedEvidence ?? [],
            },
        };
    }
    return sanitizeBlindValue(projected, replacements);
}

export function buildBlindRelationshipCases(corpus, report) {
    validateRelationshipReport(report, corpus);
    const results = new Map(report.cases.map((item) => [item.caseId, item]));
    return corpus.cases.map((item) => {
        const result = results.get(item.id);
        const screenReasons = [];
        if (!result) screenReasons.push('missing_provider_result');
        else if (result.status === 'error') screenReasons.push('provider_error');
        const stateResult = result
            ? blindObservation(item, result, report.provider)
            : { status: 'missing' };
        const nonResolved = stateResult.status === 'unsupported'
            || stateResult.observation?.decision === 'ambiguous'
            || stateResult.observation?.decision === 'unresolved';
        return {
            caseId: item.id,
            provider: report.provider,
            language: report.language,
            screenReasons,
            state: {
                task: {
                    relationship: 'CALLS',
                    language: report.language,
                    construct: item.construct,
                    scenario: item.scenario,
                },
                result: stateResult,
            },
            questions: {
                ...RELATIONSHIP_QUALITATIVE_QUESTIONS,
                ...(nonResolved ? RELATIONSHIP_ABSTENTION_QUESTIONS : {}),
            },
        };
    });
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topChoice(runs, key, criteria) {
    const probabilities = Object.fromEntries(Object.keys(criteria).map((option) => [
        option,
        mean(runs.map((run) => run.answers[key].probabilities[option])),
    ]));
    const [choice, probability] = Object.entries(probabilities)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
    return {
        choice,
        probability: Number(probability.toFixed(4)),
        probabilities: Object.fromEntries(
            Object.entries(probabilities).map(([option, value]) => [option, Number(value.toFixed(4))]),
        ),
    };
}

export function summarizeRelationshipEvaluations(evaluations) {
    const rows = [];
    for (const evaluation of evaluations) {
        if (evaluation.screenReasons.length > 0) {
            rows.push({
                caseId: evaluation.caseId,
                status: 'screened',
                reasons: evaluation.screenReasons,
            });
            continue;
        }
        const dimensions = {};
        for (const [key, question] of Object.entries(evaluation.questions)) {
            if (question.type !== 'noul') continue;
            dimensions[key] = Number(mean(
                evaluation.runs.map((run) => run.answers[key].noul),
            ).toFixed(4));
        }
        rows.push({
            caseId: evaluation.caseId,
            status: 'evaluated',
            dimensions,
            mechanismClassification: topChoice(
                evaluation.runs,
                'mechanism_classification',
                MECHANISM_CLASSIFICATION,
            ),
        });
    }

    const evaluated = rows.filter((row) => row.status === 'evaluated');
    const dimensionKeys = new Set(evaluated.flatMap((row) => Object.keys(row.dimensions)));
    const aggregate = {};
    for (const key of dimensionKeys) {
        const values = evaluated.flatMap((row) => (
            typeof row.dimensions[key] === 'number' ? [row.dimensions[key]] : []
        ));
        aggregate[key] = {
            cases: values.length,
            mean: values.length === 0 ? null : Number(mean(values).toFixed(4)),
        };
    }

    return {
        evaluatedCases: evaluated.length,
        screenedCases: rows.length - evaluated.length,
        dimensions: aggregate,
        cases: rows,
    };
}
