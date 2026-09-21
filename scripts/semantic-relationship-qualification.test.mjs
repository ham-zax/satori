import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildBlindRelationshipCases,
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
