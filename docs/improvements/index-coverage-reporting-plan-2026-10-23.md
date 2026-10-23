# Index coverage reporting plan

Status: implemented on 23 October 2026; see Completion. The user approves
capability-based coverage labels on 23 October 2026 and requests this plan. The
planning session ran no implementation, reindex, or model work.

The writing-plans workflow shapes this plan because the change affects shared
MCP response fields as well as human interpretation. The approved outcome is
clear coverage reporting, not additional language support or indexing behavior.

## Problem and accepted representation

The Webharness publication contains 1,363 files. Its reported 1,085
`unsupportedFiles` combine expected text coverage with a label that suggests
indexing failure. Of those files, 965 are Markdown, 62 JSON, 43 YAML, ten text,
three HTML, one `.cmd`, and one extensionless file. These counts describe that
publication, not every repository.

The analyzer uses bounded text fallback when it has no structural backend.
Such files can contribute searchable chunks without code symbols or calls.
Documentation extensions appear in the default indexing configuration. Do not
describe this publication's documentation as ignored or disabled.

Use this presentation when published evidence supports these counts:

```text
Index ready · 1,363 files

Code structure
  276 files fully analyzed
    2 files analyzed with recovery

Text search
  1,085 additional files indexed as text
  Includes documentation, configuration, and other text formats.
  Code symbols and call analysis are unavailable for these files.
```

Text-only coverage is informational. Recovery, failure, and unknown coverage
remain visible. A code language without structural support still has a real
capability limit. The wording must not claim that every text-only file is
documentation or that structural analysis never applies to its format.

## Baseline and responsible owner

Planning baseline: clean checkout at `26eba5c8`. Preserve any later user work.
Read these files before implementation:

- `packages/core/src/symbols/symbol-quality.ts`: the authoritative summary owner,
  including `summarizePublishedStructuralAnalysis` and unknown summary handling.
- `packages/core/src/symbols/symbol-quality.test.ts`: summary and legacy evidence tests.
- `packages/core/src/language-analysis/service.ts`: text fallback and recovery outcomes.
- `packages/core/src/symbols/contracts.ts`: persisted structural evidence contract.
- `packages/core/src/config/defaults.ts`: default documentation admission.
- `packages/mcp/src/core/manage-maintenance-handlers.ts`: status response, capability
  gaps, and published evidence availability.
- `packages/mcp/src/core/manage-types.ts`: compact and detailed status contracts.
- `packages/mcp/src/core/search-result-finalization.ts`: search summary producer calls.
- `packages/mcp/src/core/search-response-envelopes.ts` and `search-types.ts`:
  compact, debug, raw, and grouped response propagation.
- `packages/mcp/src/core/search-compact-contract.test.ts` and
  `manage-maintenance-handlers.test.ts`: first-party output checks.

The invariant is that each published file contributes to exactly one structural
outcome count. The existing summary function is the only writer of aggregate
coverage policy. It derives counts during response construction from publication
evidence. It adds no mutable state. Status and search consume the same summary.
Persisted per-file evidence remains authoritative and unchanged.

## Contract and boundaries

Replace public `structuralAnalysis.unsupportedFiles` with `searchOnlyFiles`.
The new field counts published `structuralStatus: unsupported` outcomes. Its
description states that text search remains available while structural analysis
is unavailable. Do not infer that outcome from file extensions or symbol count.
An empty or comment-only code file can have complete analysis and zero symbols.

Keep `completeFiles`, `recoveredFiles`, and `unknownFiles`. Missing legacy
evidence remains unknown. Missing or unverified navigation must not become a
zero-failure success claim. Retain the existing evidence-availability fields.

The public `reasons` list reports recovery diagnostics. Stop presenting
`unsupported_language` there as a failure reason. Keep `syntax_error`,
`parser_unavailable`, and `analysis_failure` visible with their existing counts.
An analysis failure remains part of the recovered outcome when text fallback
succeeds. Do not add a second file count that overlaps recovered files.

Keep raw persisted `structuralStatus: unsupported` and
`structuralReason: unsupported_language` unchanged. Their internal meaning
continues to describe structural support. No sidecar schema, publication hash,
index policy, language routing, migration, or reindex change is needed.

The public field replacement changes the response contract. Update all actual
first-party consumers and applicable schema or version declarations. Do not add
an alias or compatibility layer. Identify the release impact before publishing.
This plan does not authorize a release or a version bump unrelated to that contract.

Keep existing `structuralCoverage` gaps for languages that claim structural
support. A text-only aggregate must not suppress those gaps. Show detailed
language capabilities through the existing capability output, without a new
capability registry or independently computed eligibility rule.

Excluded files form a separate concept. They do not appear in these indexed-file
counts. Do not derive exclusion counts from `unsupportedFiles`, repository file
totals, ignore patterns, or filename guesses. If no existing authoritative
exclusion evidence is available, omit the count. Do not add a scanner or persist
new exclusion records for this change. If another existing surface reports
exclusions, use "Excluded by configuration" only for recorded policy exclusions.

## Implementation tasks

1. Check repository status. Search first-party uses of `unsupportedFiles`,
   `PublishedStructuralAnalysisSummary`, `structuralAnalysis`, and exposed reason
   types. Identify any generated contract that the field replacement invalidates.
2. Change the summary type and its single calculation in `symbol-quality.ts`.
   Map text-only outcomes to `searchOnlyFiles`. Narrow public recovery reasons
   without changing persisted analyzer evidence. Preserve deterministic ordering.
3. Update the actual MCP consumers and affected fixtures. Ensure status and search
   expose the new name in compact, full, raw, and grouped forms where coverage is
   already present. Do not add a new CLI formatter or expose coverage in unrelated
   responses. Add one short explanation at the existing status presentation seam
   so agents understand the field without this plan.
4. Add focused assertions to existing tests for the cases below. Update only
   expectations that the approved public contract changes. Do not regenerate
   unrelated snapshots or weaken assertions.
5. Update directly affected public documentation and generated contract output,
   if the consumer search identifies any. Use only the targeted generation path.
   Record completion and limitations in this plan and its README row.

## Acceptance and focused verification

TDD Route: off, decision skipped. No strict test-first workflow is requested.
Implementation still needs focused regression evidence for the changed summary
and public response contract.

Required cases:

- A mixed fixture with complete, recovered, text-only, and legacy unknown files
  produces correct non-overlapping counts whose sum equals its file count.
- A text-only documentation file does not count as a parser failure.
- A text-only code format still discloses absent structural capability.
- A complete file without symbols remains complete, not text-only or unknown.
- Recovery reasons remain visible, including unavailable parser and analysis failure.
- Missing or unverified publication evidence retains its existing status.
- Status and applicable search envelopes expose the same coverage fields. The old
  `unsupportedFiles` key and failure-style text-only reason are absent from the
  ordinary coverage summary. Raw persisted evidence remains unchanged.
- Existing claimed-language structural gaps remain visible. The change invents
  no exclusion count or documentation-disabled claim.

Run these focused files serially using each package's `test:raw` Node flags,
with the named file replacing its glob. Do not invoke core's heavy test tail:

```bash
cd packages/core
node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/symbols/symbol-quality.test.ts
cd ../mcp
node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/core/manage-maintenance-handlers.test.ts src/core/search-compact-contract.test.ts
```

From the repository root, run `pnpm run check` and `git diff --check`.
Run any additional focused contract check only when the changed consumer requires
it. No full search benchmark, indexing run, model call, or broad suite is needed.
Do not require access to the historical Webharness publication for these tests.

## Scope and stopping condition

No indexing, retrieval, ranking, provider, parser, or freshness behavior changes.
No new state, dependency, service, owner, or persistent compatibility component.
No commit or push unless the user asks.

Stop when the focused checks pass, the public summary describes actual coverage,
real degradation remains visible, and the diff contains only required changes.
Report the new example, contract impact, checks, and any unresolved limitation.

## Completion

Implemented on 23 October 2026.

- `packages/core/src/symbols/symbol-quality.ts`: `summarizePublishedStructuralAnalysis`
  writes `searchOnlyFiles` for published `structuralStatus: unsupported` files, so every
  published file still lands in exactly one non-overlapping outcome. Its `reasons` list is
  now `PublishedStructuralRecoveryReason`, which excludes `unsupported_language`; the
  subset of a literal union keeps `syntax_error`, `parser_unavailable`, and
  `analysis_failure` visible with their existing counts. Persisted evidence is unchanged.
- `packages/mcp/src/core/manage-maintenance-handlers.ts`: the status message states
  search-only coverage next to the existing symbol-quality marker when it is non-zero.
  `structuralAnalysis` propagation, `Unknown` handling for missing or unverified registry
  evidence, and claimed-language `structuralCoverage` gaps are untouched.
- `packages/mcp/src/core/search-types.ts`: the shared envelope field documents coverage
  plus recovery outcomes instead of parser outcomes only.
- No first-party consumer other than the tests read `unsupportedFiles`, and no generated
  contract, schema, or published documentation referenced it, so nothing else needed
  regeneration and no version declaration changed.

Verification, run serially:

- `packages/core/src/symbols/symbol-quality.test.ts`: 12 passed. New cases cover a mixed
  complete/recovered/text-only/unknown fixture whose counts sum to its file count, text-only
  documentation and a text-only code format (`cobol`) that stay out of failure reasons while
  the language evidence still reports its `search_only` claim, a symbol-free complete file
  that stays complete, and missing or unverified registry evidence that stays unknown.
- `packages/core/src/symbols/sidecar-writes.test.ts`: 4 passed after the fixture field name.
- `packages/mcp/src/core/manage-maintenance-handlers.test.ts`: 6 passed, including a status
  read whose `structuralAnalysis`, search-only message line, `cobol` capability claim, and
  single claimed-language coverage gap agree.
- `packages/mcp/src/core/search-compact-contract.test.ts`: 10 passed, including the new
  field on raw and grouped envelopes and the absence of the old key.
- Root `pnpm run check`: lint 0 errors (pre-existing warnings only), typecheck for all three
  packages, versions fresh, scope current. `git diff --check` clean.

Parent acceptance: independent plan-compliance and code-quality reviews both pass
without findings. The parent reruns the four focused files above: 32 tests pass.
The parent also checks the final scoped diff and whitespace. The adjacent UX
wording audit remains read-only and introduces no implementation changes.

Limitations: the 1,363-file publication figures stay presentation policy, not a test
fixture; no historical Webharness publication was read, so no live status output was
reproduced here. The MCP package imports `@satori-code/core` through its built `dist`, so
running the focused MCP tests requires a core build first. Removing the public field is a
response contract change for MCP clients; no alias, migration, or version bump was added and
no release was made.
