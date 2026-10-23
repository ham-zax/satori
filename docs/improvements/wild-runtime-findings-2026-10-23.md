# Installed-runtime findings and repairs, 23 October 2026

## Scope and starting state

User report: managed Satori 0.10.3, repository HEAD `5188f612`, publication
`3201ee80-81db-4024-8944-17d3abbb10f2`, relationship build
`2026-10-22T23:47:38.770Z`. The main checkout starts clean on `master`.
The unrelated dirty detached worktree remains outside this task.

The task repairs demonstrated defects, checks affected contracts, and explains
how agents discover the current API. It does not publish a package, rebuild the
live index, change versions, or alter benchmark expectations to improve scores.

## Evidence and repair plan

1. **S2, incremental claim loss.** An isolated three-file reproduction starts
   with `entry.ts -> Service.work`. Editing only `Unrelated.work` makes the
   provider recompute `unrelated.ts`. The relationship builder also selects
   `entry.ts` through its callee-name rule, then replaces its claims with an
   empty list. The call disappears. Preserve retained semantic claims only when
   an explicit provider affected-file set excludes the file. An affected file
   with empty claims must still clear old calls. Compare delta and cold output.
2. **S2, missing caller identity.** The live compiler claim resolves
   `executionContext.toolHandlers.handleSearchCode` exactly. The registry lacks
   the enclosing `searchCodebaseTool.execute` callback. A named function emits
   CALLS for the same method call, while an object-property callback emits only
   REFERENCES. Add stable object-callback ownership at the structural extractor.
3. **Harness contract drift.** The adapter reads retired `callGraphHint` and
   `nextActions.callGraph` fields. Current grouped results use
   `navigation.graph` and `target`. Correct the adapter and exercise the actual
   current response shape. Check codebase-memory parameter names and readiness.
4. **S1, owner recall.** The reported query reproduces. `handleSearchCode` is
   absent from all recorded candidate stages, without omitted stage entries.
   Other `handlers.ts` symbols reach grouping, with the first at rank 14.
   Reranking runs. Establish the missing representation or retrieval mechanism
   before changing ranking. Do not add a query-specific identifier rule.

S3 is an intentional 48 KiB response limit with continuation. S4 is an explicit
navigation contract: the symbol registry does not retain per-file indexing
timestamps. Exact registry search results can also return null. S5 is a reported
transient warning, with verified freshness during investigation. S6 does not
establish an ordering defect. These findings do not authorize arbitrary cap,
freshness, or reference-order changes.

## Ownership and checks

The relationship builder owns admission and retained claim composition. The
TypeScript provider owns its semantic recomputation scope. The structural
extractor owns callable symbol identity. The harness owns provider adaptation.
No new persistence schema, owner, service, dependency, or compatibility layer
is planned. Existing authoritative CALLS admission remains conservative.

TDD mode is off. Add regression coverage for the demonstrated gaps, without
changing existing test oracles. Run focused tests per slice, then the broader
checks required for indexing/search changes. Run heavy jobs serially.

Use Claive Sol 6.1 medium, Luna max, and Pi DeepSeek 4.1 max. Give workers
disjoint write ownership and a peer channel. The parent owns design, review,
integration, and final checks. Keep one small deliverable per worker turn.

## Contract provenance and agent guidance

The harness originally used the correct contract. Commit `0e6f7db9` on
18 June 2026 introduced both the harness and its then-valid
`callGraphHint`/`nextActions.callGraph.args` mapping. Commit `8bbfc816` on
13 July removed those grouped-result fields and introduced the compact
contract tests, without updating the harness. Commit `8617bf1b` on 26 July
changed the format version to 3. The harness file had no later commit before
this repair. Commit `7ee5e5ac` was not the grouped-field removal.

Producer tests asserted that the retired fields were absent. Harness tests
checked normalization and scoring, without exercising traversal from a current
producer response. Both sets could pass while the adapter silently classified
every current graph target as unsupported. The new regression builds an
envelope through the production projection and sends it through the adapter.

An agent discovers the current contract through MCP initialization instructions,
then tool descriptions and schemas from `tools/list`, then the returned
navigation fields. The shipped managed skill also states the exact mapping:
when `navigation.graph="ready"`, pass `target` as `symbolRef` and the envelope
`codebaseRoot` as `path`. The `call_graph` description and skill already gave
the correct rule. They did not cause the stale adapter.

The codebase-memory claim is version-specific. The inspected local server
source advertises `project` and `query`, while the current chat connector
advertises `project_name` and `name_pattern`. This task does not convert natural
language into a regular expression or rewrite arguments without the selected
server's actual schema.

## Progress and final evidence

- Investigation: two isolated S2 reproductions confirm independent mechanisms.
- Sync repair: 54 builder tests pass independently in the parent checkout.
  The regression compares incremental records and claims with a cold build.
  Explicitly affected empty/absent claims still clear calls. An omitted
  affected-file witness still uses whole-language replacement.
- Harness repair: 16 tests pass independently, including production-shaped
  target selection, unsupported targets, and MCP traversal errors. Existing
  normalization assertions remain intact.
- Caller extraction: 11 unit tests and three filtered production publication
  tests pass independently in the parent checkout. Directly bound module object properties with
  static keys get canonical method identities and source-backed UTF-8 spans.
  Anonymous, nested, local, and dynamically keyed objects gain no guessed
  object owner. Production indexing admits `tool.execute -> Service.work`.
- Persistence: `SYMBOL_EXTRACTOR_VERSION` changes from v21 to v22. An upgraded
  runtime must reject older extraction output. No schema or package version
  changes occur in this task.
- Review: DeepSeek reports no proven defect in the sync or harness repairs.
  The owning resolution type now states that its affected-file set is complete
  and permits retention outside that set. Parser review found that Oxc accessor
  values also have function-expression nodes. A direct AST probe confirms that
  callable initializers use `kind: init`, while accessors use `get` or `set`.
  The extended negative fixture fails before the guard, reporting the unwanted
  `tool.getter` and `tool.setter` methods. Requiring `kind: init` makes all 11
  extraction tests pass. All three filtered production publication tests and
  all package typechecks pass after that final restriction. Existing class
  accessor handling remains unchanged.
- Repository checks: lint completes with warnings and no errors. All three
  package typechecks, package-version references, and package-scope checks pass.
  The new extraction test needs an explicit `ExtractedSymbol | undefined`
  annotation under the repository compiler. Renaming the local variable alone
  did not resolve TS7022. Assertions remain unchanged.
- Full `pnpm test` passes before the final accessor restriction: 2,767 passed,
  four skipped, no failures. Core: 1,025 regular tests plus 31 heavy tests.
  MCP: 1,229 tests. CLI: 482 tests. All four cold/warm sync-equivalence files
  and all 22 TypeScript publication tests pass. The four skips occur in
  `cbm-extractor-modules.test.ts`, `cbm-language-map.test.ts`, and
  `lateon-reranker.test.ts`.
- After the final restriction, focused extraction/publication tests, ESLint on
  both changed extraction files, and all package typechecks pass. The other
  full-suite inputs remain unchanged. The separate harness run passes all 16
  tests. `git diff --check` passes.
- S1 remains open. A separate metadata-only probe over package source places
  `handleSearchCode` at rank 824 among 1,386 matching symbols. This is not a
  production ranking measurement. Combined with the recorded candidate stages,
  the probe rules out a small candidate-limit increase as a demonstrated
  repair. The task adds no sample-specific synonym, rank boost, or expectation
  change.
- Installed runtime acceptance remains unmeasured. Source changes do not update
  the installed 0.10.3 runtime or repair its existing publication. No live
  reindex, upgrade, package publication, commit, or push occurs here.
- The historical sync that produced the reported publication was not replayed.
  The isolated reproduction and permanent differential test prove the claim
  loss mechanism, rather than attributing an unobserved historical event.

## Delivery state

Changes remain uncommitted on `master`, based on `5188f612`. The detached dirty
worktree remains untouched. Sol 6.1 medium implements sync and extraction;
Luna max implements the harness repair; Pi DeepSeek 4.1 max checks provenance
and reviews all three slices. Workers exchange evidence through bounded Claive
peer channels. The parent checks their artifacts and runs final verification.
All task workers finish before delivery. S1 remains an explicit open finding.
The parser worker's frozen result is superseded by the parent's explicit test
typing and accessor correction. Claive refuses to attach fresh verification
to a changed snapshot, so that worker result is rejected as superseded. The
final integrated source has the independent passing checks listed above.

## Brief retrospective and proposals

- **Silent contract drift:** producer and consumer tests passed independently.
  The repair adds a producer-to-consumer traversal test. Keep that test at the
  contract boundary when either side changes.
- **Peer messages:** worker-local aliases failed, while literal worker IDs
  worked. Supply literal IDs with channel membership in future worker briefs.
  This is a workflow proposal, not a change to Claive or global instructions.
- **Tool economy:** unfiltered worker-list JSON included unrelated session
  history, and missing skill-reference paths cost worker turns. Filter by the
  task label and pass exact reference paths. Propose a bounded worker-status
  view in Claive separately. No tooling changes belong to this repair.
- **Check coverage:** focused runtime tests did not expose the new test's
  inference error. Use the existing package typecheck before declaring a worker
  slice ready. This is a proposed workflow adjustment, not a new check or rule.
