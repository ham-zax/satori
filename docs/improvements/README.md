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
| [Implementation ownership in discovery](implementation-owner-ranking.md) | Proposal; path-preference pilot off by default | Prefer relevant behavior owners; the neutral role partition did not recover the judged owners and can displace useful tests. |
| [Q5 retrieval and delegated validation owners](q5-retrieval-investigation.md) | Metadata retrieval experiment off by default | Symbol BM25 admits missing legality owners, but reranking places them below disclosure; focused controls work. |
| [Owner discovery and reranker investigation](reranker-owner-investigation.md) | Investigation consolidated; no default repair accepted | Records admission and ranking results, withdrawn wrapper/facet recommendations, metric corrections, and the failed budgeted window policy. |
| [Incremental semantic analysis](incremental-semantic-analysis.md) | Deferred | Re-analyse only changed files on edit sync for CBM semantic languages, behind a provider-owned delta contract. |
