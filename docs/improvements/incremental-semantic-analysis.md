# Incremental semantic analysis on edit sync

Status: dependency-scoped analysis remains deferred; bounded parse reuse implemented and measured in SL-5. Recorded 2026-09-28, updated 2026-10-27.

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

## SL-5 bounded parse reuse, 27 October 2026

The measured Go cost includes parsing unchanged sources. SL-5 first removes
that parsing from a prepared standby's critical path. It does not reuse type
registries, definitions, resolved calls, or source spans across different
source inputs.

The native parser owns a bounded cache of Tree-sitter trees. A cache hit needs
the same grammar, source length, and exact source bytes. A hash only locates
an entry. A mismatch calls the existing parser. Callers receive `ts_tree_copy`
and retain their existing ownership and cleanup. Cache storage is bounded to
32 MiB of owned source/path bytes and 16,384 direct-mapped slots. It retains
only the current grammar, clearing earlier trees when the grammar changes.
That prevents trees from another language raising a later analysis's peak.
Collisions and pressure
cost a parse; they cannot authorize reuse. The native module owns the cache
until its semantic worker exits.

Allocation failures under the cache's direct control skip insertion. The
pinned Tree-sitter allocator aborts on exhaustion, including during tree
copying. That existing native failure behavior remains unchanged; it cannot
be treated as a recoverable cache miss without changing the upstream allocator.

An explicit native prepare operation parses session sources without resolving
calls. The WASM provider exposes optional preparation through its existing
semantic analyzer port. The threaded provider uses its current request timeout,
termination, and disposal path. The generation workflow prepares native source
trees after loading the previous Publication's navigation state. It uses the
same root-bound source reads and byte-hash check as the normal semantic path.
It prepares only when the registry has exactly one supported native language.
With one cached grammar, preparing several languages would retain only the
last one's trees and could delay a request for another language. Such roots
keep the normal analysis path.
A changed source, an unsupported provider, or failed preparation keeps the
normal analysis path available. A failed threaded preparation retires its
worker before returning, so normal analysis gets a fresh native runtime.
Preparation writes no Publication data.

The sync worker aborts optional source-tree preparation when its start message
arrives. The threaded provider terminates and drains that preparation before
the operation continues. Navigation preload still completes under its existing
contract. This keeps an unfinished speculative parse from delaying a request
that does not need native analysis.

Analysis still builds definitions, module and build context, and resolves calls
against all current inputs. The common parser cache applies to the engine's
native languages. TypeScript uses its compiler provider and receives the
separate per-discovery config-client change recorded in TASKS.md.

Required evidence: prepared and fresh-engine output equivalence for source,
auxiliary, path, byte-position and language changes; a mutation check that
breaks the source witness; bounded lifecycle checks; the existing native
language tests; and three-run before/after edit probes with load and RSS.
The idle standby memory and preparation time must also be reported.
