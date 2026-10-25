# MCP benchmark contract follow-ups, 25 October 2026

Status: proposals only. The completed benchmark keeps its frozen oracles.

## Readiness adapter

The task-owned QAP waiter tested `ready`, while Satori returned `ok`.
Publication finished in about 14 seconds. The waiter ran for 45.1 minutes
and delayed the other workers' indexing gate. The helper now uses `ok`,
and its original code and logs remain in the benchmark failure archive.

Proposal: reuse the repository's existing provider-specific readiness owner
instead of creating an independent polling loop. Check actual response fixtures
for Satori `ok`, CBM `ready`, failure, cancellation and deadline cleanup. Stop
when the same completed response cannot enter another polling interval.

## Scoring and reporting

The three packs used different call-site citation rules and architecture
predicates. Claive named a top-three quality threshold `completed`. QAP's
CBM path correction retained stale citation fields. Lingua required two
adapter iterations before its final run. Scores stay repository-specific.

Proposal: define each scoring predicate before measurement, bind every score
file to its pack hash, and distinguish successful calls, correct answers,
rank thresholds and applicable citations. Keep corrected derivatives beside
the original scores. Check these observed cases without another benchmark.

## Review delivery

The independent reviewer saved a report and claims file, then hit the free
provider quota before a successful terminal handoff. The parent recovered
the written evidence and disclosed that execution failed. No retry follows.

Proposal: require a compact findings file early in the review and a bounded
checklist. Preserve partial evidence when quota stops execution. Report the
artifact's evidence separately from the worker's terminal status. Stop when
provider failure cannot leave the parent waiting for a missing final message.

The parent summary is retained at
`~/.cache/satori-agent-vs-20261025/final-summary.md`. Raw reports, snapshots,
frozen packs, scores, failure evidence and the saved review share that root.
The separate product repair is commit `1fa26e08`, checked by a regression
and a fresh public MCP trace of the previously missing Python call.
