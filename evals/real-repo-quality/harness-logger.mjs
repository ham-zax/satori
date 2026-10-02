import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// The path classifier has a single owner: packages/mcp/src/core/search-non-production-path.ts.
// This module must not keep a second copy, or distractorShareTop10 measures a
// different predicate than the production path-demotion policy applies.
//
// The classifier cannot be imported statically here: this is plain .mjs and the
// production module is TypeScript. run.mjs (the only entry point that produces
// records) resolves it from the built dist and injects it. An injected function
// is required -- silently falling back to a local copy is the bug this design
// exists to prevent -- so the default is a hard throw.
let injectedDistractorPathClassifier = null;

export function setDistractorPathClassifier(classifier) {
    injectedDistractorPathClassifier = classifier;
}

export function isDistractorPath(relativePath) {
    if (typeof injectedDistractorPathClassifier !== 'function') {
        throw new Error(
            'harness path classifier not injected; call setDistractorPathClassifier() before building records',
        );
    }
    return injectedDistractorPathClassifier(relativePath);
}

export function matchCandidateToAcceptable(candidate, targetChunkIds, acceptableOwners = []) {
    if (!candidate) return false;
    if (targetChunkIds && targetChunkIds.size > 0 && candidate.candidateId && targetChunkIds.has(candidate.candidateId)) {
        return true;
    }
    const relPath = candidate.relativePath?.replace(/\\/g, '/');
    if (!relPath) return false;
    for (const owner of acceptableOwners) {
        if (!new RegExp(owner.pathRegex).test(relPath)) continue;
        if (!owner.symbolRegex) return true;
        // Line-based check if line ranges available (with ±2 line tolerance for comment/signature boundary)
        const candStart = candidate.startLine ?? 0;
        const candEnd = candidate.endLine ?? 0;
        const evidenceLines = (owner.evidence || '').match(/:(\d+)/g)?.map(m => parseInt(m.slice(1), 10)) || [];
        if (evidenceLines.some(l => l >= (candStart - 2) && l <= (candEnd + 2))) return true;
        // Whole file candidate matching
        if (candidate.ownerId?.startsWith('["file"')) return true;
    }
    return false;
}

export function computeTokenOverlap(queryText, acceptableOwners = []) {
    if (!queryText) return 0;
    const queryTokens = new Set(queryText.toLowerCase().match(/[a-z0-9]+/g) || []);
    let maxOverlap = 0;
    for (const owner of acceptableOwners) {
        const text = `${owner.pathRegex || ''} ${owner.symbolRegex || ''} ${owner.evidence || ''}`.toLowerCase();
        const targetTokens = new Set(text.match(/[a-z0-9]+/g) || []);
        let overlap = 0;
        for (const t of queryTokens) {
            if (targetTokens.has(t)) overlap++;
        }
        if (overlap > maxOverlap) maxOverlap = overlap;
    }
    return maxOverlap;
}

export function extractLaneMetrics(stage, targetChunkIds, acceptableOwners) {
    if (!stage || !Array.isArray(stage.candidates) || stage.candidates.length === 0) {
        return { targetRank: null, score: null, distractorShareTop10: 0 };
    }
    const top10 = stage.candidates.slice(0, 10);
    const distractorCount = top10.filter(c => isDistractorPath(c.relativePath)).length;
    const distractorShareTop10 = top10.length > 0 ? Number((distractorCount / top10.length).toFixed(3)) : 0;

    let targetRank = null;
    let score = null;
    for (const c of stage.candidates) {
        if (matchCandidateToAcceptable(c, targetChunkIds, acceptableOwners)) {
            targetRank = c.rank;
            score = typeof c.score === 'number' ? Number(c.score.toFixed(4)) : null;
            break;
        }
    }
    return { targetRank, score, distractorShareTop10 };
}

export function buildQueryHarnessRecord({
    query,
    repoName,
    commit,
    response,
    elapsedMs,
    scoreResult,
    targetChunkIds = new Set(),
    flags = {},
    workspaceHead = '',
    provenance = null,
}) {
    const survival = response?.hints?.debugSearch?.candidateSurvival;
    const stages = survival?.stages || [];
    const timings = response?.hints?.debugSearch?.phaseTimingsMs || {};

    const findStage = (predicate) => stages.find(predicate);

    const densePrimaryStage = findStage(s => s.stage === 'raw_dense' && (!s.passId || s.passId.includes('primary')));
    const rawLexPrimary = findStage(s => s.stage === 'raw_lexical' && (!s.passId || s.passId.includes('primary')) && s.candidates?.length > 0);
    const fallbackLexPrimary = findStage(s => s.stage === 'raw_lexical_fallback' && (!s.passId || s.passId.includes('primary')));
    const lexicalPrimaryStage = rawLexPrimary || fallbackLexPrimary;

    const denseExpandedStage = findStage(s => s.stage === 'raw_dense' && s.passId?.includes('expanded'));
    const rawLexExp = findStage(s => s.stage === 'raw_lexical' && s.passId?.includes('expanded') && s.candidates?.length > 0);
    const fallbackLexExp = findStage(s => s.stage === 'raw_lexical_fallback' && s.passId?.includes('expanded'));
    const lexicalExpandedStage = rawLexExp || fallbackLexExp;

    const fusionStage = findStage(s => s.stage === 'mcp_fusion') || findStage(s => s.stage === 'core_fusion');
    const rerankInputStage = findStage(s => s.stage === 'reranker_input');

    const densePrimary = extractLaneMetrics(densePrimaryStage, targetChunkIds, query.acceptable);
    const lexicalPrimary = extractLaneMetrics(lexicalPrimaryStage, targetChunkIds, query.acceptable);
    const denseExpanded = extractLaneMetrics(denseExpandedStage, targetChunkIds, query.acceptable);
    const lexicalExpanded = extractLaneMetrics(lexicalExpandedStage, targetChunkIds, query.acceptable);

    let fusedRank = null;
    if (fusionStage?.candidates) {
        for (const c of fusionStage.candidates) {
            if (matchCandidateToAcceptable(c, targetChunkIds, query.acceptable)) {
                fusedRank = c.rank;
                break;
            }
        }
    }
    const inTop80 = fusedRank !== null && fusedRank <= 80;
    // Actual reranker admission only: a fused rank <= 64 is not membership.
    // Family selection, projection failure, exact-pin skipping, disabled
    // reranking, or the byte budget can keep a fused top-64 target out of the
    // provider input, and inferring membership from rank is a false claim.
    const inRerankWindow = Boolean(rerankInputStage?.candidates?.some(c => matchCandidateToAcceptable(c, targetChunkIds, query.acceptable)));

    const finalRank = scoreResult?.rank ?? null;

    // Expansion trace.
    //
    // The terms actually SENT on the expanded pass, not the ones the caller
    // supplied. These previously came only from survival.lexicalRequests, which
    // is populated by the tracked-lexical debug lane; when that lane did not
    // run, termsEmitted and expandedQueryString were silently empty for every
    // query even though an expansion pass had run. The expansion decision's own
    // termsEmitted is the authoritative record of what the expanded pass
    // queried, so it is the fallback when the lexical request is absent.
    const expansionDecision = response?.hints?.debugSearch?.semanticExpansion;
    const lexicalRequests = survival?.lexicalRequests || [];
    const expandedLexReq = lexicalRequests.find(r => r.passId?.includes('expanded'));
    const expansionAttempted = expansionDecision?.attempted === true;
    const expansionPassRan = lexicalRequests.some(r => r.passId?.includes('expanded'))
        || expansionAttempted;
    const emittedTerms = expandedLexReq?.terms?.length > 0
        ? expandedLexReq.terms
        : (expansionDecision?.termsEmitted || []);
    const termsEmitted = expansionPassRan ? emittedTerms : [];

    return {
        query_id: query.id,
        repo: repoName,
        commit,
        query_text: query.query,
        variant: query.variant || 'original',
        split: query.split || (repoName === 'flatbuffers' ? 'heldout' : 'tune'),
        cohort: query.cohort || (query.id === 'r1' || query.id === 'r8' || query.tags?.includes('gap') ? 'gap' : 'control'),
        token_overlap: computeTokenOverlap(query.query, query.acceptable),
        targets: Array.from(targetChunkIds),
        config: {
            workspaceHead,
            // The RESOLVED flag set, not the flags the caller passed. A partial
            // object leaves every flag it does not name at its default, so the
            // passed set understates what the run actually did.
            flags: {
                compound_join: Boolean(flags.compound_join),
                dealias: Boolean(flags.dealias),
                focus_cue_wide: Boolean(flags.focus_cue_wide),
                path_demotion: Boolean(flags.path_demotion),
                prf: Boolean(flags.prf),
                rerank_blend: Boolean(flags.rerank_blend),
            },
            altTermsCap: provenance?.altTermsCap ?? null,
        },
        provenance,
        expansion_trace: {
            expansionAttempted,
            expansionPassRan,
            termsEmitted,
            termsDropped: expansionDecision?.termsDropped || [],
            expandedQueryString: termsEmitted.join(' '),
        },
        lanes: {
            dense_primary: densePrimary,
            lexical_primary: lexicalPrimary,
            dense_expanded: denseExpanded,
            lexical_expanded: lexicalExpanded,
        },
        fusion: {
            fused_rank: fusedRank,
            in_top80: inTop80,
            in_rerank_window: inRerankWindow,
        },
        final: {
            final_rank: finalRank,
            matchedTarget: scoreResult?.matched ?? null,
        },
        latency: {
            primaryPassMs: Math.round(timings.semanticSearch ?? 0),
            expandedPassMs: Math.round(timings.expandedSearch ?? 0),
            fusionMs: Math.round(timings.mcpFusion ?? 0),
            rerankMs: Math.round(timings.rerank ?? 0),
            totalElapsedMs: Math.round(elapsedMs),
        },
    };
}

/**
 * Build the fused-pool top-80 sidecar entries for one query from a full
 * debug response. The pool is the `mcp_fusion` survival stage (fusion-score
 * order after reservation) with per-candidate pass tags joined from the
 * `mcp_pass` stages, symbols from the `grouped` stage, and rerank-window
 * membership from `reranker_input`.
 *
 * Throws when the `mcp_fusion` stage is absent: a run without the fused pool
 * must fail loudly rather than write a silent empty sidecar.
 */
export function buildFusedPoolEntries(response, queryId = '?') {
    const survival = response?.hints?.debugSearch?.candidateSurvival;
    const stages = survival?.stages;
    if (!Array.isArray(stages)) {
        throw new Error(`fused pool unavailable for ${queryId}: candidateSurvival.stages is absent`);
    }
    const fusionStage = stages.find(s => s.stage === 'mcp_fusion');
    if (!fusionStage || !Array.isArray(fusionStage.candidates)) {
        throw new Error(`fused pool unavailable for ${queryId}: mcp_fusion stage is absent`);
    }
    const idsIn = (stage, passFragment) => {
        const ids = new Set();
        for (const s of stages) {
            if (s.stage !== stage || !Array.isArray(s.candidates)) continue;
            if (passFragment && !(s.passId || '').includes(passFragment)) continue;
            for (const c of s.candidates) ids.add(c.candidateId);
        }
        return ids;
    };
    const primaryIds = idsIn('mcp_pass', 'primary');
    const expandedIds = idsIn('mcp_pass', 'expanded');
    const rerankStages = stages.filter(s => s.stage === 'reranker_input' && Array.isArray(s.candidates));
    const rerankIds = new Set(rerankStages.flatMap(s => s.candidates.map(c => c.candidateId)));
    const symbolById = new Map();
    for (const s of stages) {
        if (s.stage !== 'grouped' || !Array.isArray(s.candidates)) continue;
        for (const c of s.candidates) {
            if (symbolById.has(c.candidateId)) continue;
            const label = c.groupReplay?.displayLabel ?? '';
            // File-level groups carry no symbol: their label names the file.
            const symbol = label.startsWith('file ') ? '' : label;
            symbolById.set(c.candidateId, symbol);
        }
    }
    return fusionStage.candidates.slice(0, 80).map(c => {
        const passes = [
            ...(primaryIds.has(c.candidateId) ? ['primary'] : []),
            ...(expandedIds.has(c.candidateId) ? ['expanded'] : []),
        ];
        const symbol = symbolById.get(c.candidateId) ?? '';
        const span = `${c.startLine ?? ''}-${c.endLine ?? ''}`;
        return {
            rank: c.rank,
            key: `${c.relativePath}|${symbol}|${span}`,
            path: c.relativePath,
            symbol,
            span,
            retrievalPasses: passes,
            fusedScore: typeof c.score === 'number' ? c.score : null,
            // Actual admission only: without a reranker_input stage nothing was
            // admitted, so a fused rank <= 64 must not read as membership.
            in_rerank_window: rerankIds.has(c.candidateId),
        };
    });
}

export function computeCohortAggregates(records) {
    const total = records.length;
    if (total === 0) {
        return { count: 0, recall80_dense: 0, recall80_lexical: 0, recall80_fused: 0, hit1: 0, hit5: 0, mrr: 0 };
    }
    let dense80 = 0, lex80 = 0, fused80 = 0;
    let hit1 = 0, hit5 = 0, sumReciprocalRank = 0;

    for (const r of records) {
        if (r.lanes.dense_primary.targetRank !== null && r.lanes.dense_primary.targetRank <= 80) dense80++;
        if (r.lanes.lexical_primary.targetRank !== null && r.lanes.lexical_primary.targetRank <= 80) lex80++;
        if (r.fusion.in_top80) fused80++;

        const rank = r.final.final_rank;
        if (rank !== null) {
            if (rank <= 1) hit1++;
            if (rank <= 5) hit5++;
            sumReciprocalRank += 1 / rank;
        }
    }

    return {
        count: total,
        recall80_dense: Number((dense80 / total).toFixed(3)),
        recall80_lexical: Number((lex80 / total).toFixed(3)),
        recall80_fused: Number((fused80 / total).toFixed(3)),
        hit1: Number((hit1 / total).toFixed(3)),
        hit5: Number((hit5 / total).toFixed(3)),
        mrr: Number((sumReciprocalRank / total).toFixed(3)),
        counts: {
            dense80,
            lex80,
            fused80,
            hit1,
            hit5,
        },
    };
}

export function computeSummaryReport(records, baselineRecordsMap = null, regressionThreshold = 3) {
    const byCohort = {
        gap: records.filter(r => r.cohort === 'gap'),
        control: records.filter(r => r.cohort === 'control'),
        all: records,
    };
    const bySplit = {
        tune: records.filter(r => r.split === 'tune'),
        tune_clean: records.filter(r => r.split === 'tune' && r.query_id !== 'r1' && r.query_id !== 'r8'),
        heldout: records.filter(r => r.split === 'heldout'),
    };

    const aggregates = {
        cohorts: {
            gap: computeCohortAggregates(byCohort.gap),
            control: computeCohortAggregates(byCohort.control),
            all: computeCohortAggregates(byCohort.all),
        },
        splits: {
            tune: computeCohortAggregates(bySplit.tune),
            tune_clean: computeCohortAggregates(bySplit.tune_clean),
            heldout: computeCohortAggregates(bySplit.heldout),
        },
    };

    const diffs = [];
    let regressionsCount = 0;
    if (baselineRecordsMap) {
        for (const r of records) {
            const base = baselineRecordsMap.get(r.query_id);
            if (!base) continue;
            const rankBase = base.final.final_rank;
            const rankCurr = r.final.final_rank;
            let rankDelta = 0;
            let regression = false;
            let regressionReason = null;

            if (rankBase !== null && rankCurr === null) {
                rankDelta = 999;
                regression = true;
                regressionReason = 'dropped_out_of_rankings';
            } else if (rankBase !== null && rankCurr !== null) {
                rankDelta = rankCurr - rankBase;
                if (rankDelta > regressionThreshold) {
                    regression = true;
                    regressionReason = `rank_worsened_by_${rankDelta}`;
                }
            } else if (rankBase === null && rankCurr !== null) {
                rankDelta = -1; // improved
            }

            if (base.fusion.in_top80 && !r.fusion.in_top80) {
                regression = true;
                regressionReason = 'dropped_out_of_top80';
            }

            if (regression) regressionsCount++;

            diffs.push({
                query_id: r.query_id,
                repo: r.repo,
                cohort: r.cohort,
                split: r.split,
                rank_baseline: rankBase,
                rank_current: rankCurr,
                rank_delta: rankDelta,
                in_top80_baseline: base.fusion.in_top80,
                in_top80_current: r.fusion.in_top80,
                regression,
                regressionReason,
            });
        }
    }

    return {
        aggregates,
        diffs,
        regressionsCount,
    };
}

/**
 * Resolve acceptable target chunk ids for a repo from the published index.
 *
 * Failures are hard errors, not a silent empty map. A silent empty map makes
 * every query look like a total miss: the run completes, the report is written,
 * and recall80_* reads 0.0 without anything indicating that the index was never
 * read at all. The pathRegex/evidence fallback in matchCandidateToAcceptable
 * does not rescue this -- it only applies to the fusion-stage rank, so the
 * mismatch is invisible in the summary.
 */
export async function resolveRepoTargetChunkIds(stateRoot, repoDir, queries) {
    const targetMap = new Map();
    const unanswerableQueryIds = [];
    const lancedbPath = path.resolve('packages/core/node_modules/@lancedb/lancedb/dist/index.js');
    let db;
    try {
        const lancedb = await import(pathToFileURL(lancedbPath).href);
        db = await lancedb.connect(path.join(stateRoot, 'vector', 'lancedb'));
    } catch (cause) {
        throw new Error(
            `harness target resolution failed: cannot open the vector index at ${stateRoot}/vector/lancedb (${cause?.message ?? cause})`,
            { cause },
        );
    }
    let targetTable = null;
    const tableNames = await db.tableNames();
    for (const name of tableNames) {
        const t = await db.openTable(name);
        const sample = await t.query().limit(1).toArray();
        const meta = JSON.parse(sample[0]?.metadataJson || '{}');
        if (meta.codebasePath === repoDir) {
            targetTable = t;
            break;
        }
    }
    if (!targetTable) {
        throw new Error(
            `harness target resolution failed: no published index table for ${repoDir} under ${stateRoot}. `
            + `Re-index the repo before running the harness; a missing target table would report every query as a miss.`,
        );
    }
    const rows = await targetTable.query().toArray();
    for (const q of queries) {
        const chunkIds = new Set();
        for (const acc of q.acceptable) {
            const pathRe = new RegExp(acc.pathRegex);
            const symRe = acc.symbolRegex ? new RegExp(acc.symbolRegex) : null;
            const evidenceLines = (acc.evidence || '').match(/:(\d+)/g)?.map(m => parseInt(m.slice(1), 10)) || [];
            for (const r of rows) {
                if (!pathRe.test(r.relativePath)) continue;
                if (!symRe) {
                    chunkIds.add(r.id);
                    continue;
                }
                const meta = JSON.parse(r.metadataJson || '{}');
                const label = (meta.symbolLabel || '').replace(/^(function|method|class|constructor|interface|type|enum|struct|trait|module|namespace|variable|constant|macro|file)\s+/, '');
                const lineOverlaps = evidenceLines.some(l => l >= r.startLine && l <= r.endLine);
                if (symRe.test(label) || lineOverlaps) {
                    chunkIds.add(r.id);
                }
            }
        }
        if (chunkIds.size === 0) {
            // A judge target that does not exist in this index can never be
            // retrieved, so the query is unanswerable rather than a miss. Aborting
            // the run would discard every other query's result over a property of
            // the judge, so record it loudly and let the scorer exclude it.
            unanswerableQueryIds.push(q.id);
        }
        targetMap.set(q.id, chunkIds);
    }
    if (unanswerableQueryIds.length > 0) {
        console.warn(
            `[harness] WARNING: ${unanswerableQueryIds.length} query target(s) resolved to zero chunks in ${repoDir}: `
            + `${unanswerableQueryIds.join(', ')}. These are unanswerable against this index and are excluded from scored metrics.`,
        );
    }
    return targetMap;
}

export function sha256File(absolutePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

export function sha256String(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateHarnessSummaryMarkdown(records, report, title = 'Retrieval Quality & Per-Lane Evaluation') {
    const lines = [];
    lines.push(`# ${title}`, '');
    const meta = records[0];
    if (meta) {
        lines.push(`- **Commit / Workspace:** \`${meta.config.workspaceHead}\``);
        lines.push(`- **Flags (resolved):** ${Object.entries(meta.config.flags).filter(([, v]) => v).map(([k]) => `\`${k}\``).join(', ') || 'none (baseline)'}`);
        lines.push(`- **Total Queries Evaluated:** ${records.length}`);
        const provenance = meta.provenance;
        if (provenance) {
            lines.push('');
            lines.push('## Provenance', '');
            lines.push(`- **Git SHA:** \`${provenance.gitSha}\``);
            lines.push(`- **Dirty-tree hash** (\`git diff HEAD | sha256sum\`): \`${provenance.dirtyTreeHash ?? 'clean'}\``);
            lines.push(`- **Resolved flags:** \`${JSON.stringify(provenance.resolvedFlags)}\``);
            if (provenance.reservation) {
                lines.push(`- **Expansion slot reservation:** ${provenance.reservation.enabled ? 'on' : 'off'}; cap \`${provenance.reservation.cap}\``);
            }
            lines.push(`- **alt_terms cap:** \`${provenance.altTermsCap}\``);
            lines.push(`- **Judge file sha256:** \`${provenance.judgeFileSha256 ?? 'n/a'}\``);
            lines.push(`- **Alt-terms file sha256:** \`${provenance.altTermsFileSha256 ?? 'n/a'}\``);
            lines.push(`- **Alt-terms caller model:** \`${provenance.altTermsModel ?? 'n/a'}\``);
        }
        lines.push('');
    }

    lines.push('## Aggregate Metrics by Cohort and Split', '');
    lines.push('| Cohort / Split | N | Recall@80 (Dense) | Recall@80 (Lex) | Recall@80 (Fused) | Hit@1 | Hit@5 | MRR |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');

    const addRow = (label, agg) => {
        if (!agg || agg.count === 0) return;
        lines.push(`| **${label}** | ${agg.count} | ${agg.counts.dense80}/${agg.count} (${(agg.recall80_dense * 100).toFixed(0)}%) | ${agg.counts.lex80}/${agg.count} (${(agg.recall80_lexical * 100).toFixed(0)}%) | **${agg.counts.fused80}/${agg.count} (${(agg.recall80_fused * 100).toFixed(0)}%)** | ${agg.counts.hit1}/${agg.count} | ${agg.counts.hit5}/${agg.count} | ${agg.mrr.toFixed(3)} |`);
    };

    addRow('Cohort: gap', report.aggregates.cohorts.gap);
    addRow('Cohort: control', report.aggregates.cohorts.control);
    addRow('Cohort: all', report.aggregates.cohorts.all);
    addRow('Split: tune (all)', report.aggregates.splits.tune);
    if (report.aggregates.splits.tune_clean && report.aggregates.splits.tune_clean.count > 0) {
        addRow('Split: tune (excl r1, r8)', report.aggregates.splits.tune_clean);
    }
    addRow('Split: heldout', report.aggregates.splits.heldout);
    lines.push('');

    if (report.diffs && report.diffs.length > 0) {
        lines.push('## Paired Baseline Comparison', '');
        lines.push(`**Regressions Detected:** ${report.regressionsCount}`);
        lines.push('');
        lines.push('| ID | Repo | Cohort | Baseline Rank | Current Rank | Delta | In Top 80 (Base) | In Top 80 (Curr) | Status |');
        lines.push('|---|---|---|---:|---:|---:|:---:|:---:|---|');
        for (const d of report.diffs) {
            const status = d.regression ? `🚨 REGRESSION (${d.regressionReason})` : (d.rank_delta < 0 ? '✅ IMPROVED' : (d.rank_delta === 0 ? '➖ UNCHANGED' : '⚠️ SLOWER'));
            lines.push(`| ${d.query_id} | ${d.repo} | ${d.cohort} | ${d.rank_baseline ?? 'absent'} | ${d.rank_current ?? 'absent'} | ${d.rank_delta} | ${d.in_top80_baseline ? 'Y' : 'N'} | ${d.in_top80_current ? 'Y' : 'N'} | ${status} |`);
        }
        lines.push('');
    }

    lines.push('## Per-Query Lane Detail', '');
    lines.push('| ID | Repo | Cohort | Dense Rank | Lex Rank | Fused Rank | In Top 80 | Final Rank | Noise | Overlap | Latency |');
    lines.push('|---|---|---|---:|---:|---:|:---:|---:|---:|---:|---:|');
    for (const r of records) {
        const dense = r.lanes.dense_primary.targetRank ?? 'absent';
        const lex = r.lanes.lexical_primary.targetRank ?? 'absent';
        const fused = r.fusion.fused_rank ?? 'absent';
        const top80 = r.fusion.in_top80 ? 'Y' : 'N';
        const finalRank = r.final.final_rank ?? 'absent';
        const distractor = `${(r.lanes.dense_primary.distractorShareTop10 * 100).toFixed(0)}%`;
        const overlap = r.token_overlap ?? '-';
        const ms = `${r.latency.totalElapsedMs}ms`;
        lines.push(`| ${r.query_id} | ${r.repo} | ${r.cohort} | ${dense} | ${lex} | ${fused} | ${top80} | ${finalRank} | ${distractor} | ${overlap} | ${ms} |`);
    }
    lines.push('');

    return lines.join('\n');
}
