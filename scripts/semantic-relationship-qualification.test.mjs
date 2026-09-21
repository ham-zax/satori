import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildBlindRelationshipCases,
    compareRelationshipQualificationArtifacts,
    composeRelationshipCorpora,
    scoreRelationshipReport,
    summarizeRelationshipEvaluations,
    summarizeRelationshipPerformance,
    validateRelationshipCorpus,
    validateRelationshipReport,
} from './semantic-relationship-qualification.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const corpus = JSON.parse(fs.readFileSync(
    new URL('../evals/semantic-relationship-qualification/corpus.json', import.meta.url),
    'utf8',
));

function span(line, startByte = line * 10) {
    return {
        startLine: line,
        endLine: line,
        startByte,
        endByte: startByte + 5,
        startColumn: 0,
        endColumn: 5,
    };
}

function perfectReport() {
    return {
        version: 1,
        corpusVersion: corpus.version,
        provider: {
            id: 'provider-secret',
            version: '9.9.9',
            adapterVersion: 'qualification-adapter-v1',
        },
        language: 'fixture-language',
        cases: corpus.cases.map((item, index) => ({
            caseId: item.id,
            status: 'ok',
            observation: {
                decision: item.expected.decision,
                relationshipType: item.expected.relationshipType,
                callSite: {
                    file: `fixture/${item.id}.src`,
                    span: span(2),
                    text: 'receiver.call()',
                },
                source: {
                    ref: 'caller',
                    label: `caller_${item.id}`,
                    file: `fixture/${item.id}.src`,
                    span: span(1),
                },
                ...(item.expected.decision === 'resolved'
                    ? {
                        target: {
                            ref: item.expected.targetRefs[0],
                            label: `target_${item.id}`,
                            file: `fixture/${item.id}.src`,
                            span: span(3),
                        },
                    }
                    : {}),
                alternatives: item.expected.candidateRefs.map((ref, candidateIndex) => ({
                    ref,
                    label: ref,
                    file: `fixture/${item.id}.src`,
                    span: span(4 + candidateIndex),
                })),
                mechanism: {
                    authority: item.expected.authorities[0],
                    strategy: item.expected.strategies[0],
                    detail: 'Normalized fixture mechanism.',
                },
                evidence: item.expected.requiredEvidenceKinds.map((kind) => ({
                    kind,
                    subject: item.id,
                    detail: `Evidence for ${kind}`,
                    file: `fixture/${item.id}.src`,
                })),
                unresolvedEvidence: item.expected.decision === 'resolved'
                    ? []
                    : [{
                        kind: item.expected.requiredEvidenceKinds.at(-1),
                        subject: item.id,
                        detail: 'Concrete unresolved or ambiguous boundary.',
                        file: `fixture/${item.id}.src`,
                    }],
            },
            measurements: [
                {
                    wallMs: 10 + index,
                    cpuUserMs: 2 + index,
                    cpuSystemMs: 1,
                    peakRssBytes: 1000 + index,
                    inputBytes: 100 + index,
                    outputBytes: 20 + index,
                },
                {
                    wallMs: 20 + index,
                    cpuUserMs: 3 + index,
                    cpuSystemMs: 1,
                    peakRssBytes: 1100 + index,
                    inputBytes: 100 + index,
                    outputBytes: 20 + index,
                },
            ],
        })),
        runMeasurements: [{
            wallMs: 500,
            cpuUserMs: 100,
            cpuSystemMs: 20,
            peakRssBytes: 5000,
        }],
    };
}

function resolvedOverlayCase(id, claim = 'runtime_target') {
    return {
        id,
        construct: id.replaceAll('_', ' '),
        scenario: 'A synthetic overlay case has one proven callable target and one wrong-target decoy.',
        oracle: {
            mode: 'exact',
            claim,
        },
        expected: {
            decision: 'resolved',
            relationshipType: 'CALLS',
            targetRefs: ['target.overlay_primary'],
            candidateRefs: [],
            forbiddenTargetRefs: ['target.overlay_decoy'],
            authorities: ['direct_binding'],
            strategies: ['direct_call'],
            requiredEvidenceKinds: ['call_site', 'target_provenance'],
        },
    };
}

function developmentOverlay() {
    return {
        version: 1,
        family: 'semantic_relationship_qualification',
        relationship: 'CALLS',
        qualification: {
            family: 'language_development',
            id: 'python-development-v1',
            language: 'python',
        },
        cases: [
            resolvedOverlayCase('python.lexical_function_local_import', 'source_declaration'),
            {
                id: 'python.decorator_replacement_uncertainty',
                construct: 'decorator replacement uncertainty',
                scenario: 'A decorator may replace the declared callable with another runtime callable.',
                oracle: {
                    mode: 'observation_only',
                    claim: 'callable_identity',
                    perspectives: ['source_declaration', 'runtime_callable'],
                    description: 'The product contract has not selected which identity is authoritative.',
                },
            },
            {
                id: 'python.explicit_dynamic_unsupported',
                construct: 'explicit unsupported dynamic semantics',
                scenario: 'The callable identity depends on runtime-only dynamic behavior outside the provider contract.',
                oracle: {
                    mode: 'exact',
                    claim: 'unsupported_dynamic',
                },
                expected: {
                    resultStatus: 'unsupported',
                    requiredEvidenceKinds: ['dynamic_construct', 'unresolved_dependency'],
                },
            },
        ],
    };
}

function heldOutOverlay() {
    return {
        version: 1,
        family: 'semantic_relationship_qualification',
        relationship: 'CALLS',
        qualification: {
            family: 'language_held_out',
            id: 'python-held-out-v1',
            language: 'python',
        },
        cases: [
            resolvedOverlayCase('python.held_out_callback_propagation', 'runtime_target'),
        ],
    };
}

function reportForSuite(suite, providerId = 'overlay-provider') {
    return {
        version: 1,
        corpusVersion: suite.version,
        provider: {
            id: providerId,
            version: '1.0.0',
            adapterVersion: 'qualification-adapter-v1',
        },
        language: 'python',
        cases: suite.cases.map((item, index) => {
            const oracle = item.oracle ?? { mode: 'exact', claim: 'relationship' };
            if (oracle.mode === 'observation_only') {
                return {
                    caseId: item.id,
                    status: 'ok',
                    observation: {
                        decision: 'resolved',
                        relationshipType: 'CALLS',
                        callSite: {
                            file: `fixture/${item.id}.py`,
                            span: span(2),
                            text: 'original()',
                        },
                        source: {
                            ref: 'caller',
                            file: `fixture/${item.id}.py`,
                            span: span(1),
                        },
                        target: {
                            ref: 'target.runtime_observed',
                            file: `fixture/${item.id}.py`,
                            span: span(3),
                        },
                        alternatives: [],
                        mechanism: {
                            authority: 'origin_flow',
                            strategy: 'dynamic_dispatch',
                        },
                        evidence: [
                            { kind: 'call_site', subject: item.id },
                            { kind: 'target_provenance', subject: 'observed callable' },
                        ],
                        unresolvedEvidence: [],
                    },
                    measurements: [{ wallMs: 30 + index }],
                };
            }
            if (item.expected.resultStatus === 'unsupported') {
                return {
                    caseId: item.id,
                    status: 'unsupported',
                    unsupportedReason: 'Runtime-only dynamic semantics are explicitly outside this provider boundary.',
                    unsupportedEvidence: item.expected.requiredEvidenceKinds.map((kind) => ({
                        kind,
                        subject: item.id,
                    })),
                    measurements: [{ wallMs: 30 + index }],
                };
            }

            return {
                caseId: item.id,
                status: 'ok',
                observation: {
                    decision: item.expected.decision,
                    relationshipType: item.expected.relationshipType,
                    callSite: {
                        file: `fixture/${item.id}.py`,
                        span: span(2),
                        text: 'receiver.call()',
                    },
                    source: {
                        ref: 'caller',
                        file: `fixture/${item.id}.py`,
                        span: span(1),
                    },
                    ...(item.expected.decision === 'resolved'
                        ? {
                            target: {
                                ref: item.expected.targetRefs[0],
                                file: `fixture/${item.id}.py`,
                                span: span(3),
                            },
                        }
                        : {}),
                    alternatives: item.expected.candidateRefs.map((ref, candidateIndex) => ({
                        ref,
                        file: `fixture/${item.id}.py`,
                        span: span(4 + candidateIndex),
                    })),
                    mechanism: {
                        authority: item.expected.authorities[0],
                        strategy: item.expected.strategies[0],
                    },
                    evidence: item.expected.requiredEvidenceKinds.map((kind) => ({
                        kind,
                        subject: item.id,
                    })),
                    unresolvedEvidence: [],
                },
                measurements: [{ wallMs: 30 + index }],
            };
        }),
        runMeasurements: [{ wallMs: 250 }],
    };
}

function qualificationArtifact(suite, report) {
    return {
        version: 1,
        family: 'semantic_relationship_qualification',
        provider: report.provider,
        language: report.language,
        deterministic: scoreRelationshipReport(suite, report),
        qualitative: {
            status: 'skipped',
            reason: 'deterministic_only',
        },
        performance: summarizeRelationshipPerformance(suite, report),
    };
}

test('semantic relationship corpus and perfect provider report score exactly', () => {
    validateRelationshipCorpus(corpus);
    const report = perfectReport();
    validateRelationshipReport(report, corpus);

    const score = scoreRelationshipReport(corpus, report);
    assert.equal(score.totalCases, 12);
    assert.equal(score.coverage.ok, 12);
    assert.equal(score.coverage.unsupported, 0);
    assert.equal(score.exactness.decisionExact.rate, 1);
    assert.equal(score.exactness.relationshipTypeExact.rate, 1);
    assert.equal(score.exactness.semanticExact.rate, 1);
    assert.equal(score.exactness.strictCaseExact.rate, 1);
    assert.equal(score.exactness.authorityAgreement.rate, 1);
    assert.equal(score.exactness.strategyAgreement.rate, 1);
    assert.equal(score.exactness.evidenceContractExact.rate, 1);
    assert.equal(score.exactness.safeAbstentionExact.rate, 1);
    assert.equal(score.exactness.candidateSetExact.rate, 1);
    assert.equal(score.exactness.decoyAvoidance.rate, 1);
    assert.equal(score.resolvedTarget.precision, 1);
    assert.equal(score.resolvedTarget.recall, 1);
    assert.equal(score.resolvedTarget.f1, 1);

    const performance = summarizeRelationshipPerformance(corpus, report);
    assert.equal(performance.measuredCases, 12);
    assert.equal(performance.caseSamples, 24);
    assert.equal(performance.runSamples, 1);
    assert.equal(performance.aggregateRunSamples.wallMs.mean, 500);
    assert.equal(performance.byCase[0].metrics.wallMs.p50, 10);
    assert.equal(performance.byCase[0].metrics.wallMs.p95, 20);
});

test('blind Jev cases omit provider identity, expected truth, and performance', () => {
    const cases = buildBlindRelationshipCases(corpus, perfectReport());
    assert.equal(cases.length, 12);

    for (const item of cases) {
        const blind = JSON.stringify(item.state);
        assert.equal(blind.includes('provider-secret'), false);
        assert.equal(blind.includes('9.9.9'), false);
        assert.equal(blind.includes('target.primary'), false);
        assert.equal(blind.includes('target.decoy'), false);
        assert.equal(blind.includes('target.impl_a'), false);
        assert.equal(blind.includes('measurements'), false);
        assert.equal(blind.includes('wallMs'), false);
        assert.equal(blind.includes('forbiddenTargetRefs'), false);
        assert.equal(blind.includes('authorities'), false);
        assert.equal(blind.includes('requiredEvidenceKinds'), false);
        assert.equal(Object.hasOwn(item.state, 'provider'), false);
        assert.equal(Object.hasOwn(item.state.task, 'expected'), false);
    }
});

test('wrong-target decoys produce deterministic false-positive and false-negative evidence', () => {
    const report = perfectReport();
    const direct = report.cases.find((item) => item.caseId === 'direct_call');
    direct.observation.target = {
        ref: 'target.decoy',
        label: 'wrong target',
        file: 'fixture/direct_call.src',
        span: span(9),
    };

    const score = scoreRelationshipReport(corpus, report);
    assert.equal(score.exactness.semanticExact.count, 11);
    assert.equal(score.exactness.strictCaseExact.count, 11);
    assert.equal(score.exactness.decoyAvoidance.hits, 1);
    assert.equal(score.exactness.wrongTargetCount, 1);
    assert.equal(score.resolvedTarget.truePositive, 7);
    assert.equal(score.resolvedTarget.falsePositive, 1);
    assert.equal(score.resolvedTarget.falseNegative, 1);
    assert.equal(score.resolvedTarget.precision, 0.875);
    assert.equal(score.resolvedTarget.recall, 0.875);
    assert.equal(score.resolvedTarget.f1, 0.875);
});

test('unexpected alternatives fail exact candidate-set semantics even when the oracle expects none', () => {
    const report = perfectReport();
    const direct = report.cases.find((item) => item.caseId === 'direct_call');
    direct.observation.alternatives = [{
        ref: 'target.extra',
        label: 'unexpected alternative',
        file: 'fixture/direct_call.src',
        span: span(8),
    }];

    const score = scoreRelationshipReport(corpus, report);
    const row = score.cases.find((item) => item.caseId === 'direct_call');
    assert.ok(row);
    assert.equal(row.checks.candidates, false);
    assert.equal(row.semanticExact, false);
    assert.equal(score.exactness.semanticExact.count, 11);
    assert.equal(score.exactness.strictCaseExact.count, 11);
});

test('unsupported cases remain visible to Jev and deterministic coverage', () => {
    const report = perfectReport();
    const dynamic = report.cases.find((item) => item.caseId === 'dynamic_unresolved');
    dynamic.status = 'unsupported';
    delete dynamic.observation;
    dynamic.unsupportedReason = 'Dynamic lookup is outside the provider capability boundary.';
    dynamic.unsupportedEvidence = [{
        kind: 'dynamic_construct',
        subject: 'dynamic lookup',
        detail: 'The callee is selected through runtime-only lookup.',
    }];

    const score = scoreRelationshipReport(corpus, report);
    assert.equal(score.coverage.ok, 11);
    assert.equal(score.coverage.unsupported, 1);
    assert.equal(score.exactness.strictCaseExact.count, 11);

    const blind = buildBlindRelationshipCases(corpus, report)
        .find((item) => item.caseId === 'dynamic_unresolved');
    assert.ok(blind);
    assert.equal(blind.screenReasons.length, 0);
    assert.equal(blind.state.result.status, 'unsupported');
    assert.equal(Object.hasOwn(blind.questions, 'ambiguity_unsupported_quality'), true);
    assert.equal(Object.hasOwn(blind.questions, 'actionable_unresolved_evidence'), true);
});

test('qualitative summaries keep Jev dimensions separate from deterministic truth', () => {
    const item = buildBlindRelationshipCases(corpus, perfectReport())[0];
    const answers = Object.fromEntries(Object.entries(item.questions).map(([key, question]) => {
        if (question.type === 'noul') return [key, { type: 'noul', noul: 0.8 }];
        const options = Object.keys(question.criteria);
        return [key, {
            type: 'choice',
            choice: options[0],
            probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.7 : 0.06])),
            confidence: 0.8,
        }];
    }));
    const summary = summarizeRelationshipEvaluations([{
        caseId: item.caseId,
        screenReasons: [],
        questions: item.questions,
        runs: [{ answers }],
    }]);

    assert.equal(summary.evaluatedCases, 1);
    assert.equal(summary.dimensions.evidence_sufficiency.mean, 0.8);
    assert.equal(summary.dimensions.relationship_usefulness.mean, 0.8);
    assert.equal(summary.dimensions.resolution_mechanism_quality.mean, 0.8);
    assert.equal(Object.hasOwn(summary.dimensions, 'strictCaseExact'), false);
});

test('relationship CLI emits the three qualification lanes without a Jev key in deterministic-only mode', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-rel-qualification-'));
    const reportFile = path.join(temp, 'provider.json');
    const outFile = path.join(temp, 'result.json');
    fs.writeFileSync(reportFile, JSON.stringify(perfectReport()));

    const child = spawnSync(process.execPath, [
        'scripts/jev-retrieval-lab.mjs',
        '--mode', 'relationship',
        '--report', reportFile,
        '--out', outFile,
        '--deterministic-only',
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, TYPESAFE_API_KEY: '' },
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Semantic Relationship Qualification/);
    const artifact = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(artifact.deterministic.exactness.strictCaseExact.rate, 1);
    assert.equal(artifact.qualitative.status, 'skipped');
    assert.equal(artifact.performance.caseSamples, 24);
    assert.equal(artifact.provider.id, 'provider-secret');

    fs.rmSync(temp, { recursive: true, force: true });
});

test('provider reports reject evidence outside the versioned neutral vocabulary', () => {
    const report = perfectReport();
    report.cases[0].observation.evidence[0].kind = 'made_up_provider_fact';
    assert.throws(
        () => validateRelationshipReport(report, corpus),
        /unsupported value 'made_up_provider_fact'/,
    );
});

test('unchanged J1 reports remain valid when the common corpus is composed with zero overlays', () => {
    const suite = composeRelationshipCorpora(corpus, []);
    const report = perfectReport();

    validateRelationshipReport(report, suite);
    const score = scoreRelationshipReport(suite, report);

    assert.equal(score.totalCases, 12);
    assert.equal(score.scoredCases, 12);
    assert.equal(score.observationOnlyCases, 0);
    assert.equal(score.exactness.semanticExact.rate, 1);
    assert.equal(score.exactness.strictCaseExact.rate, 1);
    assert.equal(score.qualificationFamilies.length, 1);
    assert.equal(score.qualificationFamilies[0].qualification.family, 'common');
    assert.equal(score.qualificationFamilies[0].totalCases, 12);
});

test('overlay composition preserves common cases and separates development and held-out families', () => {
    const suite = composeRelationshipCorpora(corpus, [developmentOverlay(), heldOutOverlay()]);
    const report = reportForSuite(suite);

    assert.equal(suite.cases.length, 16);
    assert.deepEqual(
        suite.qualificationSets.map((item) => item.family),
        ['common', 'language_development', 'language_held_out'],
    );

    const score = scoreRelationshipReport(suite, report);
    assert.equal(score.totalCases, 16);
    assert.equal(score.scoredCases, 15);
    assert.equal(score.observationOnlyCases, 1);
    assert.equal(score.coverage.ok, 15);
    assert.equal(score.coverage.unsupported, 1);
    assert.equal(score.exactness.semanticExact.rate, 1);
    assert.equal(score.exactness.strictCaseExact.rate, 1);
    assert.equal(score.exactness.unsupportedExact.count, 1);
    assert.equal(score.exactness.unsupportedExact.total, 1);

    const development = score.qualificationFamilies.find(
        (item) => item.qualification.family === 'language_development',
    );
    const heldOut = score.qualificationFamilies.find(
        (item) => item.qualification.family === 'language_held_out',
    );
    assert.ok(development);
    assert.ok(heldOut);
    assert.equal(development.totalCases, 3);
    assert.equal(development.scoredCases, 2);
    assert.equal(development.observationOnlyCases, 1);
    assert.equal(heldOut.totalCases, 1);
    assert.equal(heldOut.exactness.semanticExact.rate, 1);

    const performance = summarizeRelationshipPerformance(suite, report);
    assert.equal(performance.qualificationFamilies.length, 3);
    assert.equal(
        performance.qualificationFamilies.find(
            (item) => item.qualification.family === 'language_held_out',
        ).measuredCases,
        1,
    );
});

test('observation-only oracle cases expose the semantic claim without target pass-fail scoring', () => {
    const suite = composeRelationshipCorpora(corpus, [developmentOverlay()]);
    const report = reportForSuite(suite);
    const observation = report.cases.find(
        (item) => item.caseId === 'python.decorator_replacement_uncertainty',
    );
    observation.observation.target.ref = 'target.any_runtime_replacement';

    const score = scoreRelationshipReport(suite, report);
    const row = score.cases.find(
        (item) => item.caseId === 'python.decorator_replacement_uncertainty',
    );
    assert.ok(row);
    assert.equal(row.oracle.mode, 'observation_only');
    assert.equal(row.oracle.claim, 'callable_identity');
    assert.deepEqual(row.oracle.perspectives, ['source_declaration', 'runtime_callable']);
    assert.equal(row.semanticExact, null);
    assert.equal(row.strictCaseExact, null);
    assert.equal(score.exactness.semanticExact.rate, 1);

    const blind = buildBlindRelationshipCases(suite, report).find(
        (item) => item.caseId === 'python.decorator_replacement_uncertainty',
    );
    assert.ok(blind);
    assert.equal(blind.state.task.semanticClaim, 'callable_identity');
    assert.equal(blind.state.task.oracleMode, 'observation_only');
    assert.deepEqual(blind.state.task.perspectives, ['source_declaration', 'runtime_callable']);
    assert.equal(JSON.stringify(blind.state).includes('target.any_runtime_replacement'), false);
});

test('overlay cases may be unsupported or missing without requiring every provider to implement them', () => {
    const suite = composeRelationshipCorpora(corpus, [developmentOverlay(), heldOutOverlay()]);
    const report = reportForSuite(suite);
    const lexical = report.cases.find(
        (item) => item.caseId === 'python.lexical_function_local_import',
    );
    lexical.status = 'unsupported';
    delete lexical.observation;
    lexical.unsupportedReason = 'Lexical local-import binding is outside this provider adapter.';
    lexical.unsupportedEvidence = [{
        kind: 'unresolved_dependency',
        subject: 'local import environment',
    }];
    report.cases = report.cases.filter(
        (item) => item.caseId !== 'python.held_out_callback_propagation',
    );

    const score = scoreRelationshipReport(suite, report);
    const development = score.qualificationFamilies.find(
        (item) => item.qualification.family === 'language_development',
    );
    const heldOut = score.qualificationFamilies.find(
        (item) => item.qualification.family === 'language_held_out',
    );

    assert.equal(development.coverage.unsupported, 2);
    assert.equal(development.exactness.semanticExact.count, 1);
    assert.equal(heldOut.coverage.missing, 1);
    assert.equal(heldOut.exactness.semanticExact.count, 0);
    assert.equal(score.coverage.unsupported, 2);
    assert.equal(score.coverage.missing, 1);
});

test('multi-provider comparison keeps lanes separate and exposes wrong-target precision-recall tradeoffs', () => {
    const suite = composeRelationshipCorpora(corpus, [developmentOverlay(), heldOutOverlay()]);
    const reportA = reportForSuite(suite, 'provider-a');
    const reportB = reportForSuite(suite, 'provider-b');
    const direct = reportB.cases.find((item) => item.caseId === 'direct_call');
    direct.observation.target.ref = 'target.decoy';

    const artifactA = qualificationArtifact(suite, reportA);
    const artifactB = qualificationArtifact(suite, reportB);
    const comparison = compareRelationshipQualificationArtifacts([artifactA, artifactB]);

    assert.equal(Object.hasOwn(comparison, 'overallScore'), false);
    assert.equal(comparison.lanes.deterministic.providers.length, 2);
    assert.equal(comparison.lanes.qualitative.providers.length, 2);
    assert.equal(comparison.lanes.performance.providers.length, 2);

    const providerA = comparison.lanes.deterministic.providers.find(
        (item) => item.provider.id === 'provider-a',
    );
    const providerB = comparison.lanes.deterministic.providers.find(
        (item) => item.provider.id === 'provider-b',
    );
    assert.equal(providerA.wrongTargetCount, 0);
    assert.equal(providerB.wrongTargetCount, 1);
    assert.equal(providerB.resolvedTarget.falsePositive, 1);
    assert.equal(providerB.resolvedTarget.falseNegative, 1);
    assert.ok(providerB.resolvedTarget.precision < providerA.resolvedTarget.precision);
    assert.ok(providerB.resolvedTarget.recall < providerA.resolvedTarget.recall);
    assert.equal(providerB.ambiguousCandidateExact.rate, 1);
    assert.equal(providerB.unsupported.reported, 1);

    const common = comparison.lanes.deterministic.qualificationFamilies.find(
        (item) => item.qualification.family === 'common',
    );
    assert.ok(common);
    assert.equal(common.providers.length, 2);
    assert.equal(
        common.providers.find((item) => item.provider.id === 'provider-b').wrongTargetCount,
        1,
    );
});

test('comparison accepts a legacy J1 artifact without new family or ambiguity fields', () => {
    const report = perfectReport();
    const legacy = qualificationArtifact(corpus, report);
    delete legacy.deterministic.scoredCases;
    delete legacy.deterministic.observationOnlyCases;
    delete legacy.deterministic.qualificationFamilies;
    delete legacy.deterministic.exactness.ambiguousCandidateExact;
    delete legacy.deterministic.exactness.unsupportedExact;
    delete legacy.performance.qualificationFamilies;

    const comparison = compareRelationshipQualificationArtifacts([legacy]);
    const row = comparison.lanes.deterministic.providers[0];

    assert.equal(row.scoredCases, 12);
    assert.equal(row.observationOnlyCases, 0);
    assert.equal(row.ambiguousCandidateExact.rate, 1);
    assert.equal(
        comparison.lanes.deterministic.qualificationFamilies[0].qualification.family,
        'common',
    );
});

test('comparison CLI emits a matrix artifact without collapsing evidence lanes', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-rel-comparison-'));
    const suite = composeRelationshipCorpora(corpus, [developmentOverlay()]);
    const artifactA = qualificationArtifact(suite, reportForSuite(suite, 'provider-a'));
    const reportB = reportForSuite(suite, 'provider-b');
    const direct = reportB.cases.find((item) => item.caseId === 'direct_call');
    direct.observation.target.ref = 'target.decoy';
    const artifactB = qualificationArtifact(suite, reportB);
    const aFile = path.join(temp, 'a.json');
    const bFile = path.join(temp, 'b.json');
    const outFile = path.join(temp, 'comparison.json');
    fs.writeFileSync(aFile, JSON.stringify(artifactA));
    fs.writeFileSync(bFile, JSON.stringify(artifactB));

    const child = spawnSync(process.execPath, [
        'scripts/semantic-relationship-comparison.mjs',
        '--input', aFile,
        '--input', bFile,
        '--out', outFile,
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Semantic Relationship Provider Comparison/);
    const comparison = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(comparison.lanes.deterministic.providers.length, 2);
    assert.equal(comparison.lanes.qualitative.providers.length, 2);
    assert.equal(comparison.lanes.performance.providers.length, 2);
    assert.equal(
        comparison.lanes.deterministic.providers.find(
            (item) => item.provider.id === 'provider-b',
        ).wrongTargetCount,
        1,
    );

    fs.rmSync(temp, { recursive: true, force: true });
});
