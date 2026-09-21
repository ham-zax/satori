#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
    buildBlindRelationshipCases,
    scoreRelationshipReport,
    summarizeRelationshipEvaluations,
    summarizeRelationshipPerformance,
} from "./semantic-relationship-qualification.mjs";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_REPEATS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const SOURCE_EXCERPT_MAX_CHARS = 1_800;
const SOURCE_EXCERPT_MAX_LINES = 60;
const SEARCH_ROW = /^\s{2}(\S+)\s+(Function|Method|Class|Interface|Variable|File|Type|Constructor)\s+(\S+)\s+(\d+)-(\d+)\s+/;

const SET_QUESTIONS = Object.freeze({
    task_relevance: {
        type: "noul",
        instructions: "Would this candidate set materially help a coding agent locate code relevant to the task?",
        criteria: {
            true: "The candidates are substantially about the requested behavior or concept.",
            false: "The candidates are mostly tangential, generic, or about a different behavior.",
        },
    },
    direct_owner_present: {
        type: "noul",
        instructions: "Does this candidate set contain at least one plausible direct implementation owner for the requested behavior?",
        criteria: {
            true: "At least one candidate appears to implement or authoritatively control the requested behavior.",
            false: "The candidates are only tests, documentation, callers, wrappers, neighboring concepts, or otherwise lack a plausible owner.",
        },
    },
    actionable_next_inspection: {
        type: "noul",
        instructions: "Could a coding agent choose a concrete source file or symbol to inspect next from this candidate set without guessing?",
        criteria: {
            true: "The evidence points to one or more concrete implementation locations worth opening next.",
            false: "The evidence is too broad, ambiguous, empty, or indirect to choose a justified next inspection.",
        },
    },
    low_noise: {
        type: "noul",
        instructions: "Is most of this candidate set useful implementation evidence for the task rather than distracting material?",
        criteria: {
            true: "Most candidates add task-relevant implementation evidence.",
            false: "A large share of candidates are irrelevant, duplicative, benchmark artifacts, tests with no implementation value, or unrelated neighboring concepts.",
        },
    },
    evidence_complete: {
        type: "noul",
        instructions: "Does this candidate set contain enough evidence to stop broad repository discovery and proceed with focused source inspection for this task?",
        criteria: {
            true: "The set contains a plausible owner or authoritative control point plus enough supporting context to continue by opening specific files or symbols.",
            false: "A coding agent would still need broad repository discovery because the apparent owner, control path, or critical supporting context is unresolved.",
        },
    },
});

const ROLE_CRITERIA = Object.freeze({
    implementation_owner: "This candidate directly implements the requested behavior or is the primary behavioral control point.",
    state_owner: "This candidate authoritatively owns, stores, publishes, invalidates, or transitions state central to the requested behavior.",
    entrypoint_or_caller: "This candidate reaches or delegates to the behavior but is not itself the primary implementation owner.",
    policy_or_configuration: "This candidate defines policy, configuration, defaults, feature support, or another declarative rule governing the behavior.",
    contract_or_type: "This candidate defines a type, interface, schema, protocol, or contract consumed by the implementation.",
    test_or_fixture: "This candidate is test or fixture evidence that can corroborate behavior but does not own production behavior.",
    supporting_helper: "This candidate is a useful helper, adapter, response builder, warning builder, or other supporting implementation.",
    unrelated: "This candidate does not materially help explain, locate, or validate the requested behavior.",
});

const SIEVE_CRITERIA = Object.freeze({
    keep_exact: "Carry this candidate's exact source evidence forward because its content is likely needed to understand or safely act on the task.",
    keep_reference_only: "Keep the file/symbol/span as a navigation pointer, but the candidate's full content is not important enough to carry forward now.",
    drop: "Omit this candidate from the next context pack because it is redundant, tangential, misleading, or unlikely to help the current task.",
});

function usage() {
    return `Usage:
  node scripts/jev-retrieval-lab.mjs --report <code-intelligence-vs.json> --out <result.json> [options]
  node scripts/jev-retrieval-lab.mjs --mode relationship --report <provider-report.json> --out <result.json> [options]

Options:
  --mode <name>         "retrieval" (default) or "relationship".
  --report <file>       Retrieval report or provider-neutral relationship report.
  --out <file>          Output JSON path. Parent directories are created.
  --corpus <file>       Relationship corpus. Default: evals/semantic-relationship-qualification/corpus.json
  --deterministic-only  Relationship mode only: skip Jev calls and emit exact + performance metrics.
  --repeats <n>         Repeat each blind Jev evaluation. Default: ${DEFAULT_REPEATS}
  --model <name>        TypeSafe model. Default: ${DEFAULT_MODEL}
  --timeout-ms <n>      Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --source-root <dir>   Retrieval mode: repository root used to attach exact source excerpts. Default: current directory.
  --help                Show this help.

Environment:
  TYPESAFE_API_KEY      Required when Jev evaluation is enabled. Read only at runtime; never written to artifacts.

Retrieval mode measures set-level search quality and evidence completeness.
Relationship mode keeps deterministic semantic correctness, blind Jev qualitative judgment, and
provider performance/resource measurements in separate artifact sections. Provider identity, incumbent status,
expected truth, deterministic metrics, and performance data are not sent to Jev.
`;
}

function parseArgs(argv) {
    const options = {
        mode: "retrieval",
        reportFile: null,
        outFile: null,
        corpusFile: path.resolve("evals/semantic-relationship-qualification/corpus.json"),
        deterministicOnly: false,
        repeats: DEFAULT_REPEATS,
        model: DEFAULT_MODEL,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        sourceRoot: process.cwd(),
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[++index];
            if (!value) throw new Error(`Missing value for ${arg}.`);
            return value;
        };
        if (arg === "--mode") options.mode = next();
        else if (arg === "--report") options.reportFile = path.resolve(next());
        else if (arg === "--out") options.outFile = path.resolve(next());
        else if (arg === "--corpus") options.corpusFile = path.resolve(next());
        else if (arg === "--deterministic-only") options.deterministicOnly = true;
        else if (arg === "--repeats") options.repeats = Number.parseInt(next(), 10);
        else if (arg === "--model") options.model = next();
        else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(next(), 10);
        else if (arg === "--source-root") options.sourceRoot = path.resolve(next());
        else if (arg === "--help") options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.help) return options;
    if (options.mode !== "retrieval" && options.mode !== "relationship") {
        throw new Error("--mode must be either retrieval or relationship.");
    }
    if (options.deterministicOnly && options.mode !== "relationship") {
        throw new Error("--deterministic-only is valid only in relationship mode.");
    }
    if (!options.reportFile) throw new Error("--report is required.");
    if (!options.outFile) throw new Error("--out is required.");
    if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 10) {
        throw new Error("--repeats must be an integer from 1 to 10.");
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 120_000) {
        throw new Error("--timeout-ms must be an integer from 1000 to 120000.");
    }
    return options;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeFile(value) {
    if (typeof value !== "string") return null;
    return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeSymbol(label) {
    if (typeof label !== "string") return null;
    return label.replace(/^(?:function|method|class|interface|variable|type|constructor|file)\s+/i, "").trim() || null;
}

function candidateKey(candidate) {
    return [
        candidate.file || "",
        candidate.symbol || "",
        candidate.startLine || 0,
        candidate.endLine || 0,
    ].join("\u0000");
}

function stableCandidates(candidates) {
    const seen = new Set();
    return candidates
        .filter((candidate) => candidate.file || candidate.symbol || candidate.preview)
        .sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)))
        .filter((candidate) => {
            const key = candidateKey(candidate);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function projectSatoriSearch(text) {
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(payload.results)) return [];
    return stableCandidates(payload.results.map((result) => ({
        file: normalizeFile(result?.target?.file),
        symbol: normalizeSymbol(result?.displayLabel),
        symbolKind: typeof result?.symbolKind === "string" ? result.symbolKind : null,
        startLine: Number.isInteger(result?.target?.span?.startLine) ? result.target.span.startLine : null,
        endLine: Number.isInteger(result?.target?.span?.endLine) ? result.target.span.endLine : null,
        evidenceStartLine: Number.isInteger(result?.evidenceSpan?.startLine) ? result.evidenceSpan.startLine : null,
        evidenceEndLine: Number.isInteger(result?.evidenceSpan?.endLine) ? result.evidenceSpan.endLine : null,
        preview: typeof result?.preview === "string" ? result.preview.trim().slice(0, 900) : null,
    })));
}

function projectCodebaseMemorySearch(text) {
    const candidates = [];
    for (const line of String(text || "").split("\n")) {
        const match = line.match(SEARCH_ROW);
        if (!match) continue;
        const [, qualifiedName, label, file, startLine, endLine] = match;
        candidates.push({
            file: normalizeFile(file),
            symbol: qualifiedName.split(".").at(-1) || null,
            symbolKind: label.toLowerCase(),
            startLine: Number.parseInt(startLine, 10),
            endLine: Number.parseInt(endLine, 10),
            preview: null,
        });
    }
    return stableCandidates(candidates);
}

function projectSearchCandidates(result) {
    if (result.provider === "satori") return projectSatoriSearch(result.text);
    if (result.provider === "codebase-memory") return projectCodebaseMemorySearch(result.text);
    return [];
}

function stripBenchmarkArtifacts(candidates, suitePath) {
    const normalizedSuite = normalizeFile(suitePath);
    const kept = [];
    const stripped = [];
    for (const candidate of candidates) {
        const file = normalizeFile(candidate.file);
        if (file && normalizedSuite && (file === normalizedSuite || file.endsWith(`/${normalizedSuite}`))) {
            stripped.push(candidate);
        } else {
            kept.push(candidate);
        }
    }
    return { kept, stripped };
}

function exactSourceExcerpt(candidate, sourceRoot) {
    if (!candidate.file || !Number.isInteger(candidate.startLine) || candidate.startLine < 1) return null;
    const resolvedRoot = path.resolve(sourceRoot);
    const resolvedFile = path.resolve(resolvedRoot, candidate.file);
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) return null;

    const lines = fs.readFileSync(resolvedFile, "utf8").split(/\r?\n/);
    const evidenceSpanValid = Number.isInteger(candidate.evidenceStartLine)
        && Number.isInteger(candidate.evidenceEndLine)
        && candidate.evidenceStartLine >= candidate.startLine
        && candidate.evidenceEndLine >= candidate.evidenceStartLine
        && (
            !Number.isInteger(candidate.endLine)
            || candidate.evidenceEndLine <= candidate.endLine
        );
    const excerptStartLine = evidenceSpanValid
        ? candidate.evidenceStartLine
        : candidate.startLine;
    const excerptEndLine = evidenceSpanValid
        ? candidate.evidenceEndLine
        : (
            Number.isInteger(candidate.endLine) && candidate.endLine >= candidate.startLine
                ? candidate.endLine
                : candidate.startLine
        );
    const startIndex = excerptStartLine - 1;
    if (startIndex >= lines.length) return null;
    const requestedEnd = excerptEndLine;
    const endExclusive = Math.min(
        lines.length,
        requestedEnd,
        startIndex + SOURCE_EXCERPT_MAX_LINES,
    );
    return lines.slice(startIndex, endExclusive)
        .join("\n")
        .slice(0, SOURCE_EXCERPT_MAX_CHARS)
        .trim() || null;
}

function withCandidateIds(candidates, sourceRoot) {
    return candidates.map((candidate, index) => {
        const { preview: _providerPreview, ...location } = candidate;
        return {
            candidateId: `c${String(index + 1).padStart(2, "0")}`,
            ...location,
            sourceExcerpt: exactSourceExcerpt(candidate, sourceRoot),
        };
    });
}

function buildCaseQuestions(candidates) {
    const questions = { ...SET_QUESTIONS };
    for (const candidate of candidates) {
        questions[`role_${candidate.candidateId}`] = {
            type: "choice",
            instructions: `What is the primary evidence role of candidate ${candidate.candidateId} relative to the task?`,
            criteria: ROLE_CRITERIA,
        };
        questions[`sieve_${candidate.candidateId}`] = {
            type: "choice",
            instructions: `How should candidate ${candidate.candidateId} be carried into the next coding-agent context for this task?`,
            criteria: SIEVE_CRITERIA,
        };
    }
    return questions;
}

function buildCases(report, sourceRoot) {
    const tasks = new Map(report.tasks.filter((task) => task.kind === "search").map((task) => [task.id, task]));
    const cases = [];
    for (const result of report.results) {
        const task = tasks.get(result.taskId);
        if (!task) continue;
        const candidates = projectSearchCandidates(result);
        const { kept, stripped } = stripBenchmarkArtifacts(candidates, report.suite);
        const blindCandidates = withCandidateIds(kept, sourceRoot);
        const screenReasons = [];
        if (result.status !== "ok") screenReasons.push(`status:${result.status}`);
        if (result.unsupported) screenReasons.push("unsupported");
        if (kept.length === 0) screenReasons.push("no_candidates_after_screening");
        cases.push({
            taskId: task.id,
            provider: result.provider,
            mechanical: {
                status: result.status,
                unsupported: Boolean(result.unsupported),
                benchmarkArtifactsStripped: stripped.length,
                candidateCountBeforeScreening: candidates.length,
                candidateCountAfterScreening: kept.length,
                sourceExcerptCount: blindCandidates.filter((candidate) => candidate.sourceExcerpt).length,
                legacyAnchorScore: result.score
                    ? { ratio: result.score.ratio, passed: result.score.passed }
                    : null,
            },
            screenReasons,
            state: {
                task: {
                    kind: task.kind,
                    query: task.query,
                },
                candidates: blindCandidates,
            },
            questions: buildCaseQuestions(blindCandidates),
        });
    }
    return cases;
}

async function askJev({ apiKey, model, state, questions, timeoutMs }) {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            model,
            state,
            questions,
        }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = { raw: text.slice(0, 2_000) };
    }
    if (!response.ok) {
        const message = typeof body?.message === "string"
            ? body.message
            : typeof body?.error === "string"
                ? body.error
                : `HTTP ${response.status}`;
        throw new Error(`TypeSafe request failed: ${message}`);
    }
    return body;
}

function parseAnswers(response, questions) {
    const answers = response?.answers;
    if (!answers || typeof answers !== "object") {
        throw new Error("TypeSafe response did not contain answers.");
    }

    const parsed = {};
    for (const [key, question] of Object.entries(questions)) {
        const answer = answers[key];
        if (question.type === "noul") {
            const value = answer?.noul;
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new Error(`TypeSafe answer '${key}' did not contain a finite noul.`);
            }
            parsed[key] = { type: "noul", noul: value };
            continue;
        }
        if (question.type === "choice") {
            const choice = answer?.choice;
            const probabilities = answer?.probabilities;
            const confidence = answer?.confidence;
            const options = Object.keys(question.criteria);
            if (typeof choice !== "string" || !options.includes(choice)) {
                throw new Error(`TypeSafe answer '${key}' selected an unknown choice.`);
            }
            if (!probabilities || typeof probabilities !== "object") {
                throw new Error(`TypeSafe answer '${key}' did not contain choice probabilities.`);
            }
            for (const option of options) {
                const probability = probabilities[option];
                if (typeof probability !== "number" || !Number.isFinite(probability)) {
                    throw new Error(`TypeSafe answer '${key}' did not contain finite probability for '${option}'.`);
                }
            }
            if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
                throw new Error(`TypeSafe answer '${key}' did not contain finite confidence.`);
            }
            parsed[key] = { type: "choice", choice, probabilities, confidence };
            continue;
        }
        throw new Error(`Unsupported question type '${question.type}' for '${key}'.`);
    }
    return parsed;
}

function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanChoiceProbabilities(runs, questionKey, criteria) {
    return Object.fromEntries(Object.keys(criteria).map((option) => [
        option,
        mean(runs.map((run) => run.answers[questionKey].probabilities[option])),
    ]));
}

function topProbability(probabilities) {
    return Object.entries(probabilities)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
}

function summarizeCandidateJudgments(evaluation) {
    return evaluation.blindState.candidates.map((candidate) => {
        const roleProbabilities = meanChoiceProbabilities(
            evaluation.runs,
            `role_${candidate.candidateId}`,
            ROLE_CRITERIA,
        );
        const sieveProbabilities = meanChoiceProbabilities(
            evaluation.runs,
            `sieve_${candidate.candidateId}`,
            SIEVE_CRITERIA,
        );
        const [role, roleProbability] = topProbability(roleProbabilities);
        const [sieve, sieveProbability] = topProbability(sieveProbabilities);
        const roleChoices = evaluation.runs.map(
            (run) => run.answers[`role_${candidate.candidateId}`].choice,
        );
        const sieveChoices = evaluation.runs.map(
            (run) => run.answers[`sieve_${candidate.candidateId}`].choice,
        );
        return {
            candidateId: candidate.candidateId,
            file: candidate.file,
            symbol: candidate.symbol,
            role,
            roleProbability: Number(roleProbability.toFixed(4)),
            roleChoices,
            sieve,
            sieveProbability: Number(sieveProbability.toFixed(4)),
            sieveChoices,
        };
    });
}

function summarizeEvaluations(evaluations) {
    const rows = [];
    for (const evaluation of evaluations) {
        if (evaluation.screenReasons.length > 0) {
            rows.push({
                taskId: evaluation.taskId,
                provider: evaluation.provider,
                status: "screened",
                reasons: evaluation.screenReasons,
            });
            continue;
        }
        const dimensions = {};
        for (const key of Object.keys(SET_QUESTIONS)) {
            dimensions[key] = Number(mean(
                evaluation.runs.map((run) => run.answers[key].noul),
            ).toFixed(4));
        }
        rows.push({
            taskId: evaluation.taskId,
            provider: evaluation.provider,
            status: "evaluated",
            dimensions,
            candidateJudgments: summarizeCandidateJudgments(evaluation),
        });
    }
    return rows;
}

function printSummary(summary) {
    process.stdout.write("Jev Retrieval Lab\n=================\n");
    for (const row of summary) {
        if (row.status === "screened") {
            process.stdout.write(`- ${row.taskId} / ${row.provider}: screened (${row.reasons.join(", ")})\n`);
            continue;
        }
        const dimensions = Object.entries(row.dimensions)
            .map(([key, value]) => `${key}=${value.toFixed(3)}`)
            .join(", ");
        process.stdout.write(`- ${row.taskId} / ${row.provider}: ${dimensions}\n`);
    }
}

async function runRelationshipMode(options) {
    const report = readJson(options.reportFile);
    const corpus = readJson(options.corpusFile);
    const deterministic = scoreRelationshipReport(corpus, report);
    const performance = summarizeRelationshipPerformance(corpus, report);
    const cases = buildBlindRelationshipCases(corpus, report);

    const evaluations = [];
    let qualitativeSummary = null;
    if (!options.deterministicOnly) {
        const apiKey = process.env.TYPESAFE_API_KEY?.trim();
        if (!apiKey) {
            throw new Error("TYPESAFE_API_KEY is required unless --deterministic-only is used.");
        }
        for (const item of cases) {
            const evaluation = {
                caseId: item.caseId,
                language: item.language,
                screenReasons: item.screenReasons,
                blindState: item.state,
                questions: item.questions,
                runs: [],
            };
            if (item.screenReasons.length === 0) {
                for (let repeat = 0; repeat < options.repeats; repeat += 1) {
                    const response = await askJev({
                        apiKey,
                        model: options.model,
                        state: item.state,
                        questions: item.questions,
                        timeoutMs: options.timeoutMs,
                    });
                    evaluation.runs.push({
                        repeat: repeat + 1,
                        model: response.model || options.model,
                        answers: parseAnswers(response, item.questions),
                        usage: response.usage || null,
                    });
                }
            }
            evaluations.push(evaluation);
        }
        qualitativeSummary = summarizeRelationshipEvaluations(evaluations);
    }

    const artifact = {
        version: 1,
        generatedAt: new Date().toISOString(),
        family: "semantic_relationship_qualification",
        provider: report.provider,
        language: report.language,
        sourceReport: path.relative(process.cwd(), options.reportFile),
        sourceCorpus: path.relative(process.cwd(), options.corpusFile),
        corpusVersion: corpus.version,
        deterministic,
        qualitative: options.deterministicOnly
            ? {
                status: "skipped",
                reason: "deterministic_only",
            }
            : {
                status: "evaluated",
                model: options.model,
                repeats: options.repeats,
                blindness: {
                    omittedFromJevState: [
                        "provider identity and version",
                        "incumbent or baseline status",
                        "expected decision and target truth",
                        "wrong-target decoy labels",
                        "deterministic correctness metrics",
                        "latency and resource measurements",
                    ],
                    providerComparisonInSinglePrompt: false,
                },
                evaluations,
                summary: qualitativeSummary,
            },
        performance,
    };

    fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
    fs.writeFileSync(options.outFile, `${JSON.stringify(artifact, null, 2)}\n`);

    process.stdout.write("Semantic Relationship Qualification\n===================================\n");
    process.stdout.write(`- provider: ${report.provider.id}@${report.provider.version} (${report.language})\n`);
    process.stdout.write(
        `- deterministic: strict=${deterministic.exactness.strictCaseExact.count}/${deterministic.totalCases}, `
        + `semantic=${deterministic.exactness.semanticExact.count}/${deterministic.totalCases}, `
        + `unsupported=${deterministic.coverage.unsupported}, errors=${deterministic.coverage.error}, missing=${deterministic.coverage.missing}\n`,
    );
    process.stdout.write(
        `- resolved targets: precision=${deterministic.resolvedTarget.precision ?? "n/a"}, `
        + `recall=${deterministic.resolvedTarget.recall ?? "n/a"}, f1=${deterministic.resolvedTarget.f1 ?? "n/a"}\n`,
    );
    process.stdout.write(
        options.deterministicOnly
            ? "- Jev qualitative: skipped (--deterministic-only)\n"
            : `- Jev qualitative: evaluated ${qualitativeSummary.evaluatedCases} cases, screened ${qualitativeSummary.screenedCases}\n`,
    );
    process.stdout.write(
        `- performance: ${performance.caseSamples} case samples across ${performance.measuredCases} cases\n`,
    );
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(usage());
        return;
    }
    if (options.mode === "relationship") {
        await runRelationshipMode(options);
        return;
    }

    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("TYPESAFE_API_KEY is required.");
    }

    const report = readJson(options.reportFile);
    const cases = buildCases(report, options.sourceRoot);
    if (cases.length === 0) {
        throw new Error("The report contains no search tasks to evaluate.");
    }

    const evaluations = [];
    for (const item of cases) {
        const evaluation = {
            taskId: item.taskId,
            provider: item.provider,
            mechanical: item.mechanical,
            screenReasons: item.screenReasons,
            blindState: item.state,
            runs: [],
        };
        if (item.screenReasons.length === 0) {
            for (let repeat = 0; repeat < options.repeats; repeat += 1) {
                const response = await askJev({
                    apiKey,
                    model: options.model,
                    state: item.state,
                    questions: item.questions,
                    timeoutMs: options.timeoutMs,
                });
                evaluation.runs.push({
                    repeat: repeat + 1,
                    model: response.model || options.model,
                    answers: parseAnswers(response, item.questions),
                    usage: response.usage || null,
                });
            }
        }
        evaluations.push(evaluation);
    }

    const summary = summarizeEvaluations(evaluations);
    const artifact = {
        version: 2,
        generatedAt: new Date().toISOString(),
        families: [
            "search_retrieval_quality",
            "evidence_role_classification",
            "context_sieve",
            "evidence_completeness",
        ],
        model: options.model,
        repeats: options.repeats,
        sourceReport: path.relative(process.cwd(), options.reportFile),
        sourceNormalization: {
            mode: "exact_matched_source_excerpt",
            sourceRoot: path.relative(process.cwd(), options.sourceRoot) || ".",
            maxChars: SOURCE_EXCERPT_MAX_CHARS,
            maxLines: SOURCE_EXCERPT_MAX_LINES,
            preferReturnedEvidenceSpan: true,
            providerPreviewOmitted: true,
        },
        blindness: {
            omittedFromJevState: [
                "provider identity",
                "provider rank and score",
                "legacy expected anchors",
                "legacy pass/fail",
                "latency",
                "incumbent winner",
            ],
            neutralCandidateOrder: "file, symbol, source span",
            deterministicScreening: [
                "non-ok or unsupported provider result",
                "benchmark task-suite self-hit",
                "empty candidate set after screening",
            ],
        },
        questions: {
            set: SET_QUESTIONS,
            roleCriteria: ROLE_CRITERIA,
            sieveCriteria: SIEVE_CRITERIA,
        },
        evaluations,
        summary,
    };

    fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
    fs.writeFileSync(options.outFile, `${JSON.stringify(artifact, null, 2)}\n`);
    printSummary(summary);
}

try {
    await main();
} catch (error) {
    process.stderr.write(`jev-retrieval-lab failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
