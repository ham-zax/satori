# Improvement proposals

Ideas that were evaluated and judged worthwhile, but deliberately not built yet.
Each proposal records the problem, the evidence behind it, the recommended
design, and what would make it worth doing. Moving an idea into implementation
is a separate decision.

| Proposal | Status | Summary |
|---|---|---|
| [Self-contained distribution](self-contained-distribution.md) | Deferred | Ship one self-contained executable per platform so a curl/PowerShell script, Homebrew, and npm become thin downloaders. |
| [Model mirror fallback](model-mirror-fallback.md) | Deferred | Publish pinned model files as GitHub Release assets and fall back to them when Hugging Face fails. |
| [Change-proportional edit sync](change-proportional-sync.md) | Deferred | Make a one-file edit sync cost scale with the change, not the repository: warm worker, watcher change sets, delta publication. |
| [Incremental semantic analysis](incremental-semantic-analysis.md) | Deferred | Re-analyse only changed files on edit sync for CBM semantic languages, behind a provider-owned delta contract. |
