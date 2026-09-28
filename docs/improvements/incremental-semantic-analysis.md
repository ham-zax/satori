# Incremental semantic analysis on edit sync

Status: deferred. Recorded 2026-09-28.

## Question

Should a one-file edit re-analyse only the changed files with the CBM
semantic engine, instead of the whole language?

## Findings

- Edit sync re-analyses every file of each affected semantic language
  (`rebuildNavigationArtifactsForSyncDelta` in
  `packages/core/src/generation/index-generation-workflow.ts`). The
  `SemanticProjectAnalyzer` port only accepts a complete project.
- On trufflehog (3,295 Go files) a one-comment edit sync took ~20 s, of which
  Go analysis was 8.5 s before the string-table fix (`52b59d76`) and ~4 s
  after. The rest of the sync is shared, language-independent work: two
  full-tree source scans, navigation reloads in the isolated sync worker,
  sidecar staging, and activation.
- Inside the engine, tree-sitter parsing is 69% of Go analysis (2.6 s of
  3.75 s); call resolution is 0.6 s. Re-resolving only the changed files while
  still parsing every file therefore saves at most ~0.6 s.
- Saving the parse requires reusing each unchanged file's definitions across
  syncs. Each language driver in `third_party/cbm-semantic/satori_semantic.c`
  builds its own registry (Go types and interfaces, Java/C# class hierarchies,
  C++, Rust, Kotlin/PHP scopes), so each needs its own serialized definition
  summary.
- Soundness is per language. A changed file can change results in files that
  never import it: Go interface dispatch looks for implementers across the
  project, and signature or field-type changes alter receiver inference in
  callers.
- The TypeScript compiler provider and the CBM symbol extractors are outside
  this path; this only helps Go, Java, Rust, C#, C++, Kotlin and PHP.

## Proposal

1. Add an optional provider-owned delta operation to `SemanticProjectAnalyzer`.
   The workflow asks the provider; the provider either returns evidence for the
   changed files plus reusable prior evidence, or declines, and the workflow
   falls back to full analysis. The workflow never decides semantic
   equivalence (no comment stripping or language shortcuts).
2. Engine: per-file definition summaries (emitted at full analysis, persisted
   with the publication's relationship evidence) and an entry point that
   resolves target files against supplied summaries plus the parsed targets.
3. Invalidation: reuse an unchanged file's occurrences only when its bytes,
   every definition summary, auxiliary files (go.mod, Cargo.toml, ...), provider
   version, and environment config are unchanged; if a changed file's summary
   changes, re-resolve every file that could depend on it or decline.
4. Start with Go only; add other languages one at a time with their own
   dependency rule.
5. Equivalence tests against a fresh full analysis: trailing comment, changed
   call, changed import or receiver type, added and deleted file, changed
   go.mod or `//go:build` directive, lines inserted before a call.

## When to do it

When large repositories in these languages make edit sync the main complaint,
and the ~3.5 s it can save per edit (on a ~3k-file Go repo) outweighs
multi-day engine work and per-language soundness proofs. The shared per-sync
costs above are a separate, cross-language target.
