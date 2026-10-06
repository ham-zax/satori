# Improvement proposals

Proposals, completed investigations and implemented improvements. Each entry
records the problem, evidence, decision, and remaining limitations.

| Proposal | Status | Summary |
|---|---|---|
| [Self-contained distribution](self-contained-distribution.md) | Deferred | Ship one self-contained executable per platform so a curl/PowerShell script, Homebrew, and npm become thin downloaders. |
| [Change-proportional edit sync](change-proportional-sync.md) | Deferred | Make a one-file edit sync cost scale with the change, not the repository: warm worker, watcher change sets, delta publication. |
| [Retrieval quality investigation](retrieval-quality-investigation.md) | Completed | Import-chunk noise, CBM retrieval ideas vs the LateOn reranker, and live search latency, measured on judged React queries. |
| [Repository vocabulary experiment](repository-vocabulary-experiment.md) | Indexing and search off by default | Publication-bound source vocabulary is retained as an opt-in experiment; the 46-query ablation regressed overall strict MRR@3 from 0.1486 to 0.0725. |
| [Implementation ownership in discovery](implementation-owner-ranking.md) | Definition discovery enabled by default | Published-symbol admission, definition/LateOn fusion and selection within each file improve measured top-rank discovery, with substantial latency and known regressions; the blanket path-preference pilot remains off. |
| [Agent alt terms in definition discovery](agent-alt-terms-definition-discovery.md) | Enabled by default when callers send `alt_terms` | Caller alt terms feed symbol-metadata search and definition fusion: 27 → 34 of 46 owners in the top 10; wrong terms cost more than none. Also records seven label corrections, a rejected window cap, and a Potion vs CodeRankEmbed comparison. |
| [Q5 retrieval and delegated validation owners](q5-retrieval-investigation.md) | Default repair implemented and evaluated | Broad Q5 now discloses both legality owners at ranks 4 and 8, with its guard at rank 1; admission alone was insufficient. |
| [Owner discovery and reranker investigation](reranker-owner-investigation.md) | Default repair retained after four-repository audit | Records ten-repository research, implementation, corrected ON/OFF symbol/path metrics, latency, regressions, causal limits and withdrawn recommendations. |
| [Release QA, October 2026](release-qa-2026-10.md) | In progress | Freshness, detect_changes and file_outline fixes from colonist-assistant QA, plus open defects from a staged-diff review and four QA workers. |
| [Incremental semantic analysis](incremental-semantic-analysis.md) | Deferred | Re-analyse only changed files on edit sync for CBM semantic languages, behind a provider-owned delta contract. |
