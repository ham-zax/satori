import { createHash } from 'node:crypto';

const DECISIONS = new Set(['resolved', 'unresolved', 'ambiguous']);
const RESULT_STATUSES = new Set(['ok', 'unsupported']);
const ORACLE_MODES = new Set(['exact', 'observation_only']);
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

function validateQualification(value, label) {
    if (!isRecord(value)) fail(`${label} must be an object.`);
    requireString(value.family, `${label}.family`);
    requireString(value.id, `${label}.id`);
    if (value.language !== undefined) requireString(value.language, `${label}.language`);
    if (value.provider !== undefined) requireString(value.provider, `${label}.provider`);
    if (value.description !== undefined) requireString(value.description, `${label}.description`);
}

function validateOracle(value, label) {
    if (!isRecord(value)) fail(`${label} must be an object.`);
    requireEnum(value.mode, ORACLE_MODES, `${label}.mode`);
    requireString(value.claim, `${label}.claim`);
    if (value.description !== undefined) requireString(value.description, `${label}.description`);
    for (const [index, perspective] of requireArray(value.perspectives ?? [], `${label}.perspectives`).entries()) {
        requireString(perspective, `${label}.perspectives[${index}]`);
    }
}

function validateExpected(expected, label) {
    if (!isRecord(expected)) fail(`${label} must be an object.`);
    const resultStatus = expected.resultStatus === undefined
        ? 'ok'
        : requireEnum(expected.resultStatus, RESULT_STATUSES, `${label}.resultStatus`);
    for (const [index, kind] of requireArray(expected.requiredEvidenceKinds, `${label}.requiredEvidenceKinds`).entries()) {
        requireEnum(kind, EVIDENCE_KINDS, `${label}.requiredEvidenceKinds[${index}]`);
    }
    if (resultStatus === 'unsupported') {
        return;
    }

    requireEnum(expected.decision, DECISIONS, `${label}.decision`);
    requireEnum(expected.relationshipType, RELATIONSHIP_TYPES, `${label}.relationshipType`);
    for (const key of ['targetRefs', 'candidateRefs', 'forbiddenTargetRefs', 'authorities', 'strategies']) {
        requireArray(expected[key], `${label}.${key}`);
    }
    for (const [index, authority] of expected.authorities.entries()) {
        requireEnum(authority, AUTHORITIES, `${label}.authorities[${index}]`);
    }
    for (const [index, strategy] of expected.strategies.entries()) {
        requireEnum(strategy, STRATEGIES, `${label}.strategies[${index}]`);
    }
    if (expected.decision === 'resolved' && expected.targetRefs.length === 0) {
        fail(`${label}.targetRefs must contain at least one target for a resolved case.`);
    }
    if (expected.decision !== 'resolved' && expected.targetRefs.length !== 0) {
        fail(`${label}.targetRefs must be empty for non-resolved cases.`);
    }
}

function oracleForCase(item) {
    return item.oracle ?? {
        mode: 'exact',
        claim: 'relationship',
    };
}

function qualificationForCorpus(corpus, fallbackFamily = 'common') {
    return corpus.qualification ?? {
        family: fallbackFamily,
        id: fallbackFamily === 'common' ? 'common-v1' : corpus.family,
    };
}

function qualificationForCase(corpus, item) {
    return item.qualification ?? qualificationForCorpus(corpus);
}

function qualificationKey(qualification) {
    return `${qualification.family}::${qualification.id}`;
}

export function validateRelationshipCorpus(corpus) {
    if (!isRecord(corpus)) fail('corpus must be an object.');
    if (corpus.version !== 1) fail(`unsupported corpus version '${String(corpus.version)}'.`);
    requireString(corpus.family, 'corpus.family');
    if (corpus.qualification !== undefined) validateQualification(corpus.qualification, 'corpus.qualification');
    const ids = new Set();
    for (const [index, item] of requireArray(corpus.cases, 'corpus.cases').entries()) {
        if (!isRecord(item)) fail(`corpus.cases[${index}] must be an object.`);
        const id = requireString(item.id, `corpus.cases[${index}].id`);
        if (ids.has(id)) fail(`duplicate corpus case '${id}'.`);
        ids.add(id);
        requireString(item.construct, `corpus.cases[${index}].construct`);
        requireString(item.scenario, `corpus.cases[${index}].scenario`);
        if (item.blindContext !== undefined) {
            requireString(item.blindContext, `corpus.cases[${index}].blindContext`);
        }
        if (item.qualification !== undefined) {
            validateQualification(item.qualification, `corpus.cases[${index}].qualification`);
        }
        const oracle = oracleForCase(item);
        validateOracle(oracle, `corpus.cases[${index}].oracle`);
        if (oracle.mode === 'exact') {
            validateExpected(item.expected, `corpus.cases[${index}].expected`);
        } else if (item.expected !== undefined) {
            validateExpected(item.expected, `corpus.cases[${index}].expected`);
        }
    }
    if (ids.size === 0) fail('corpus must contain at least one case.');
    return corpus;
}

export function composeRelationshipCorpora(commonCorpus, overlayCorpora = []) {
    validateRelationshipCorpus(commonCorpus);
    const commonQualification = qualificationForCorpus(commonCorpus, 'common');
    const qualificationSets = [{ ...commonQualification }];
    const seenIds = new Set();
    const cases = [];

    const appendCorpus = (corpus, qualification, label) => {
        for (const item of corpus.cases) {
            if (seenIds.has(item.id)) fail(`${label} duplicates corpus case '${item.id}'.`);
            seenIds.add(item.id);
            cases.push({
                ...item,
                qualification: item.qualification ?? qualification,
            });
        }
    };

    appendCorpus(commonCorpus, commonQualification, 'common corpus');
    for (const [index, overlay] of requireArray(overlayCorpora, 'overlayCorpora').entries()) {
        validateRelationshipCorpus(overlay);
        if (overlay.version !== commonCorpus.version) {
            fail(`overlayCorpora[${index}] version ${overlay.version} does not match common corpus version ${commonCorpus.version}.`);
        }
        if (!overlay.qualification) {
            fail(`overlayCorpora[${index}].qualification is required so overlay results retain family identity.`);
        }
        const qualification = qualificationForCorpus(overlay, 'overlay');
        if (qualificationSets.some((item) => qualificationKey(item) === qualificationKey(qualification))) {
            fail(`duplicate qualification set '${qualificationKey(qualification)}'.`);
        }
        qualificationSets.push({ ...qualification });
        appendCorpus(overlay, qualification, `overlayCorpora[${index}]`);
    }

    return {
        ...commonCorpus,
        qualificationSets,
        cases,
    };
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

function unsupportedEvidenceKinds(result) {
    return new Set((result?.unsupportedEvidence ?? []).map((item) => item.kind));
}

function expectedResultStatus(expected) {
    return expected.resultStatus ?? 'ok';
}

function observedRelationship(observation) {
    if (!observation) return null;
    const kinds = evidenceKinds(observation);
    return {
        decision: observation.decision,
        relationshipType: observation.relationshipType,
        targetRef: observation.target?.ref ?? null,
        alternativeRefs: (observation.alternatives ?? []).map((candidate) => candidate.ref),
        authority: observation.mechanism.authority,
        strategy: observation.mechanism.strategy,
        evidenceKinds: [...kinds].sort(),
    };
}

function scoreRelationshipCases(corpus, cases, results) {
    const rows = [];
    let ok = 0;
    let unsupported = 0;
    let errors = 0;
    let missing = 0;
    let scoredCases = 0;
    let observationOnlyCases = 0;
    let decisionExact = 0;
    let decisionTotal = 0;
    let relationshipExact = 0;
    let relationshipTotal = 0;
    let semanticExact = 0;
    let strictCaseExact = 0;
    let authorityExact = 0;
    let authorityTotal = 0;
    let strategyExact = 0;
    let strategyTotal = 0;
    let evidenceContractExact = 0;
    let evidenceContractTotal = 0;
    let safeAbstentionExact = 0;
    let safeAbstentionTotal = 0;
    let candidateSetExact = 0;
    let candidateSetTotal = 0;
    let ambiguousCandidateExact = 0;
    let ambiguousCandidateTotal = 0;
    let unsupportedExact = 0;
    let unsupportedExpectedTotal = 0;
    let decoyAvoided = 0;
    let decoyTotal = 0;
    let decoyHits = 0;
    let falseResolved = 0;
    let wrongTargets = 0;
    let targetTp = 0;
    let targetFp = 0;
    let targetFn = 0;

    for (const item of cases) {
        const result = results.get(item.id);
        const oracle = oracleForCase(item);
        const qualification = qualificationForCase(corpus, item);
        if (!result) missing += 1;
        else if (result.status === 'ok') ok += 1;
        else if (result.status === 'unsupported') unsupported += 1;
        else errors += 1;

        const observation = result?.status === 'ok' ? result.observation : null;
        const targetRef = observation?.target?.ref ?? null;
        const alternatives = observation?.alternatives?.map((candidate) => candidate.ref) ?? [];
        const baseRow = {
            caseId: item.id,
            construct: item.construct,
            qualification,
            oracle,
            status: result?.status ?? 'missing',
            ...(result?.status === 'unsupported' ? { unsupportedReason: result.unsupportedReason } : {}),
            ...(result?.status === 'error' ? { error: result.error } : {}),
        };

        if (oracle.mode === 'observation_only') {
            observationOnlyCases += 1;
            rows.push({
                ...baseRow,
                checks: null,
                semanticExact: null,
                strictCaseExact: null,
                observed: observedRelationship(observation),
            });
            continue;
        }

        scoredCases += 1;
        const expected = item.expected;
        const resultStatus = expectedResultStatus(expected);
        if (resultStatus === 'unsupported') {
            unsupportedExpectedTotal += 1;
            evidenceContractTotal += 1;
            const kinds = unsupportedEvidenceKinds(result);
            const checks = {
                resultStatus: result?.status === 'unsupported',
                evidence: Boolean(result?.status === 'unsupported'
                    && expected.requiredEvidenceKinds.every((kind) => kinds.has(kind))),
            };
            if (checks.resultStatus) unsupportedExact += 1;
            if (checks.evidence) evidenceContractExact += 1;
            const semantic = checks.resultStatus;
            const strict = semantic && checks.evidence;
            if (semantic) semanticExact += 1;
            if (strict) strictCaseExact += 1;
            if (observation?.decision === 'resolved') {
                falseResolved += 1;
                if (targetRef !== null) targetFp += 1;
            }
            rows.push({
                ...baseRow,
                checks,
                semanticExact: semantic,
                strictCaseExact: strict,
                observed: observedRelationship(observation),
            });
            continue;
        }

        decisionTotal += 1;
        relationshipTotal += 1;
        authorityTotal += 1;
        strategyTotal += 1;
        evidenceContractTotal += 1;
        const requiredKinds = evidenceKinds(observation);
        const checks = {
            resultStatus: result?.status === 'ok',
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
        if (expected.decision === 'ambiguous') {
            ambiguousCandidateTotal += 1;
            if (checks.candidates) ambiguousCandidateExact += 1;
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

        const semantic = checks.resultStatus
            && checks.decision
            && checks.relationshipType
            && checks.target
            && checks.candidates
            && checks.decoyAvoidance;
        const strict = semantic && checks.authority && checks.strategy && checks.evidence;
        if (semantic) semanticExact += 1;
        if (strict) strictCaseExact += 1;

        rows.push({
            ...baseRow,
            checks,
            semanticExact: semantic,
            strictCaseExact: strict,
            observed: observedRelationship(observation),
        });
    }

    const total = cases.length;
    const precisionDenominator = targetTp + targetFp;
    const recallDenominator = targetTp + targetFn;
    const precision = precisionDenominator === 0 ? null : targetTp / precisionDenominator;
    const recall = recallDenominator === 0 ? null : targetTp / recallDenominator;
    const f1 = precision === null || recall === null || precision + recall === 0
        ? null
        : 2 * precision * recall / (precision + recall);

    return {
        totalCases: total,
        scoredCases,
        observationOnlyCases,
        coverage: {
            ok,
            unsupported,
            error: errors,
            missing,
            okRate: ratio(ok, total),
        },
        exactness: {
            decisionExact: { count: decisionExact, total: decisionTotal, rate: ratio(decisionExact, decisionTotal) },
            relationshipTypeExact: { count: relationshipExact, total: relationshipTotal, rate: ratio(relationshipExact, relationshipTotal) },
            semanticExact: { count: semanticExact, total: scoredCases, rate: ratio(semanticExact, scoredCases) },
            strictCaseExact: { count: strictCaseExact, total: scoredCases, rate: ratio(strictCaseExact, scoredCases) },
            authorityAgreement: { count: authorityExact, total: authorityTotal, rate: ratio(authorityExact, authorityTotal) },
            strategyAgreement: { count: strategyExact, total: strategyTotal, rate: ratio(strategyExact, strategyTotal) },
            evidenceContractExact: {
                count: evidenceContractExact,
                total: evidenceContractTotal,
                rate: ratio(evidenceContractExact, evidenceContractTotal),
            },
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
            ambiguousCandidateExact: {
                count: ambiguousCandidateExact,
                total: ambiguousCandidateTotal,
                rate: ratio(ambiguousCandidateExact, ambiguousCandidateTotal),
            },
            unsupportedExact: {
                count: unsupportedExact,
                total: unsupportedExpectedTotal,
                rate: ratio(unsupportedExact, unsupportedExpectedTotal),
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

export function scoreRelationshipReport(corpus, report) {
    validateRelationshipReport(report, corpus);
    const results = new Map(report.cases.map((item) => [item.caseId, item]));
    const overall = scoreRelationshipCases(corpus, corpus.cases, results);
    const groups = new Map();
    for (const item of corpus.cases) {
        const qualification = qualificationForCase(corpus, item);
        const key = qualificationKey(qualification);
        const group = groups.get(key) ?? { qualification, cases: [] };
        group.cases.push(item);
        groups.set(key, group);
    }
    return {
        ...overall,
        qualificationFamilies: [...groups.values()].map((group) => ({
            qualification: group.qualification,
            ...scoreRelationshipCases(corpus, group.cases, results),
        })),
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
    const caseById = new Map(corpus.cases.map((item) => [item.id, item]));
    const byCase = [];
    const allSamples = [];
    const groups = new Map();
    for (const result of report.cases) {
        const samples = result.measurements ?? [];
        if (samples.length === 0) continue;
        const corpusCase = caseById.get(result.caseId);
        const qualification = qualificationForCase(corpus, corpusCase);
        allSamples.push(...samples);
        byCase.push({
            caseId: result.caseId,
            qualification,
            samples: samples.length,
            metrics: summarizeSamples(samples),
        });
        const key = qualificationKey(qualification);
        const group = groups.get(key) ?? { qualification, samples: [], measuredCases: 0 };
        group.samples.push(...samples);
        group.measuredCases += 1;
        groups.set(key, group);
    }
    const runSamples = report.runMeasurements ?? [];
    return {
        measuredCases: byCase.length,
        caseSamples: allSamples.length,
        byCase,
        aggregateCaseSamples: summarizeSamples(allSamples),
        qualificationFamilies: [...groups.values()].map((group) => ({
            qualification: group.qualification,
            measuredCases: group.measuredCases,
            caseSamples: group.samples.length,
            aggregateCaseSamples: summarizeSamples(group.samples),
        })),
        runSamples: runSamples.length,
        aggregateRunSamples: summarizeSamples(runSamples),
    };
}

function blindTokenMap(item, result, provider) {
    const expected = item.expected ?? {};
    const refs = new Set([
        ...(expected.targetRefs ?? []),
        ...(expected.candidateRefs ?? []),
        ...(expected.forbiddenTargetRefs ?? []),
    ]);
    if (result.status === 'ok') {
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
        const oracle = oracleForCase(item);
        const qualification = qualificationForCase(corpus, item);
        return {
            caseId: item.id,
            provider: report.provider,
            language: report.language,
            qualification,
            oracle,
            screenReasons,
            state: {
                task: {
                    relationship: 'CALLS',
                    language: report.language,
                    ...(item.blindContext ? { context: item.blindContext } : {}),
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

function summarizeEvaluationRows(rows) {
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

export function summarizeRelationshipEvaluations(evaluations) {
    const rows = [];
    for (const evaluation of evaluations) {
        const qualification = evaluation.qualification ?? { family: 'common', id: 'common-v1' };
        if (evaluation.screenReasons.length > 0) {
            rows.push({
                caseId: evaluation.caseId,
                qualification,
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
            qualification,
            status: 'evaluated',
            dimensions,
            mechanismClassification: topChoice(
                evaluation.runs,
                'mechanism_classification',
                MECHANISM_CLASSIFICATION,
            ),
        });
    }

    const overall = summarizeEvaluationRows(rows);
    const groups = new Map();
    for (const row of rows) {
        const key = qualificationKey(row.qualification);
        const group = groups.get(key) ?? { qualification: row.qualification, rows: [] };
        group.rows.push(row);
        groups.set(key, group);
    }
    return {
        ...overall,
        qualificationFamilies: [...groups.values()].map((group) => ({
            qualification: group.qualification,
            ...summarizeEvaluationRows(group.rows),
        })),
    };
}

function metricOrNull(value) {
    return isRecord(value) ? value : null;
}

function comparisonDeterministicRow(artifact, deterministic) {
    const exactness = deterministic.exactness ?? {};
    return {
        provider: artifact.provider,
        language: artifact.language,
        totalCases: deterministic.totalCases,
        scoredCases: deterministic.scoredCases ?? deterministic.totalCases,
        observationOnlyCases: deterministic.observationOnlyCases ?? 0,
        coverage: deterministic.coverage,
        semanticExact: metricOrNull(exactness.semanticExact),
        strictCaseExact: metricOrNull(exactness.strictCaseExact),
        wrongTargetCount: exactness.wrongTargetCount ?? null,
        falseResolvedCount: exactness.falseResolvedCount ?? null,
        safeAbstentionExact: metricOrNull(exactness.safeAbstentionExact),
        ambiguousCandidateExact: metricOrNull(
            exactness.ambiguousCandidateExact ?? exactness.candidateSetExact,
        ),
        unsupported: {
            reported: deterministic.coverage?.unsupported ?? null,
            exact: metricOrNull(exactness.unsupportedExact),
        },
        resolvedTarget: deterministic.resolvedTarget ?? null,
    };
}

function artifactQualificationFamilies(artifact) {
    const families = artifact.deterministic?.qualificationFamilies;
    if (Array.isArray(families) && families.length > 0) return families;
    return [{
        qualification: { family: 'common', id: 'common-v1' },
        ...artifact.deterministic,
    }];
}

export function compareRelationshipQualificationArtifacts(artifacts) {
    const inputs = requireArray(artifacts, 'artifacts');
    if (inputs.length === 0) fail('artifacts must contain at least one completed qualification artifact.');

    const deterministicProviders = [];
    const qualitativeProviders = [];
    const performanceProviders = [];
    const familyGroups = new Map();

    for (const [index, artifact] of inputs.entries()) {
        if (!isRecord(artifact)) fail(`artifacts[${index}] must be an object.`);
        if (artifact.family !== 'semantic_relationship_qualification') {
            fail(`artifacts[${index}] is not a semantic relationship qualification artifact.`);
        }
        if (!isRecord(artifact.provider)) fail(`artifacts[${index}].provider must be an object.`);
        requireString(artifact.provider.id, `artifacts[${index}].provider.id`);
        requireString(artifact.provider.version, `artifacts[${index}].provider.version`);
        requireString(artifact.language, `artifacts[${index}].language`);
        if (!isRecord(artifact.deterministic)) fail(`artifacts[${index}].deterministic must be an object.`);
        if (!isRecord(artifact.qualitative)) fail(`artifacts[${index}].qualitative must be an object.`);
        if (!isRecord(artifact.performance)) fail(`artifacts[${index}].performance must be an object.`);

        deterministicProviders.push(comparisonDeterministicRow(artifact, artifact.deterministic));
        qualitativeProviders.push({
            provider: artifact.provider,
            language: artifact.language,
            status: artifact.qualitative.status,
            model: artifact.qualitative.model ?? null,
            repeats: artifact.qualitative.repeats ?? null,
            summary: artifact.qualitative.summary ?? null,
        });
        performanceProviders.push({
            provider: artifact.provider,
            language: artifact.language,
            measuredCases: artifact.performance.measuredCases ?? 0,
            caseSamples: artifact.performance.caseSamples ?? 0,
            aggregateCaseSamples: artifact.performance.aggregateCaseSamples ?? {},
            runSamples: artifact.performance.runSamples ?? 0,
            aggregateRunSamples: artifact.performance.aggregateRunSamples ?? {},
            qualificationFamilies: artifact.performance.qualificationFamilies ?? [],
        });

        for (const family of artifactQualificationFamilies(artifact)) {
            const qualification = family.qualification ?? { family: 'common', id: 'common-v1' };
            const key = qualificationKey(qualification);
            const group = familyGroups.get(key) ?? { qualification, providers: [] };
            group.providers.push(comparisonDeterministicRow(artifact, family));
            familyGroups.set(key, group);
        }
    }

    return {
        version: 1,
        family: 'semantic_relationship_provider_comparison',
        lanes: {
            deterministic: {
                providers: deterministicProviders,
                qualificationFamilies: [...familyGroups.values()],
            },
            qualitative: {
                providers: qualitativeProviders,
            },
            performance: {
                providers: performanceProviders,
            },
        },
    };
}
