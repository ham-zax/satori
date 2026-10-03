# Improvement proposals

Deferred proposals and completed investigations. Each entry records the
problem, evidence, decision, and conditions for revisiting it. Moving a
proposal into implementation is a separate decision.

| Proposal | Status | Summary |
|---|---|---|
| [Self-contained distribution](self-contained-distribution.md) | Deferred | Ship one self-contained executable per platform so a curl/PowerShell script, Homebrew, and npm become thin downloaders. |
| [Change-proportional edit sync](change-proportional-sync.md) | Deferred | Make a one-file edit sync cost scale with the change, not the repository: warm worker, watcher change sets, delta publication. |
| [Retrieval quality investigation](retrieval-quality-investigation.md) | Completed | Import-chunk noise, CBM retrieval ideas vs the LateOn reranker, and live search latency, measured on judged React queries. |
| [Repository vocabulary experiment](repository-vocabulary-experiment.md) | Indexing and search off by default | Publication-bound source vocabulary is retained as an opt-in experiment; the 46-query ablation regressed overall strict MRR@3 from 0.1486 to 0.0725. |
| [Incremental semantic analysis](incremental-semantic-analysis.md) | Deferred | Re-analyse only changed files on edit sync for CBM semantic languages, behind a provider-owned delta contract. |
