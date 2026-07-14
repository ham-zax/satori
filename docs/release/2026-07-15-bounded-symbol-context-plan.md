# Bounded symbol context and progressive disclosure plan

Date: 2026-07-15

Status: planned follow-on; review validated, no production implementation changed

This document records the verified product gap and the smallest staged path to
give agents a bounded, trustworthy view of a known symbol. It is a follow-on to
the search-quality program, not a completion blocker for the already accepted
search-routing work in `2026-07-15-search-quality-program.md`.

## Decision record

The supplied review did not establish a current correctness or reproducibility
defect that justifies changing production behavior in this review.

The current exact-open behavior is intentional:

- `read_file(open_symbol)` resolves an exact registry symbol through
  `file_outline(resolveMode="exact")` and returns the resolved span. Exact
  outline validates current source where that validation is supported, accepts
  the explicit `not_applicable` capability outcome, and fails closed on
  ambiguous or unavailable validation.
- Exact opens deliberately disable the ordinary `READ_FILE_MAX_LINES`
  continuation path.
- The behavior spec explicitly says exact `open_symbol` expands to the full
  resolved symbol span.
- Search already avoids recommending that full open first for symbols of at
  least 200 lines. It recommends a bounded same-file `evidenceSpan` instead.

The current behavior is the baseline, not a compatibility requirement for the
future contract. The bounded-context release will replace exact-symbol full-span
responses cleanly after its frozen gates pass. It will not retain a parallel
legacy full-open mode, a `fullSymbol` escape hatch, or lifecycle telemetry for
obsolete behavior. The replacement must still be explicit and versioned: no
path may return partial source while presenting it as the complete symbol.

The product and economic limitation is real: a client that explicitly opens a
pathological symbol can receive a very large response, and the current
multi-tool workflow scatters symbol identity, source, structure, relationships,
and limitations across separate envelopes.

The current public `call_graph` description already states that CALLS v0 is
heuristic, name-based, bounded, incomplete, and advisory. Its generation and
manifest validation proves the graph artifact being traversed; it does not make
each static edge exhaustive runtime truth. No production correction is needed
for that point.

Unique exact ownership and caller/callee routing is also already conditional.
It avoids embedding, vector retrieval, and reranking only when exact identity,
navigation authority, and the requested structural evidence resolve safely.
Ambiguity, unavailable navigation, dirty participants, or empty relationship
evidence falls back to provider-backed search.

## Review disposition

| Review point | Current classification | Action |
|---|---|---|
| “Complete body” is too absolute | Wording correction for product descriptions. Current exact-open implementation intentionally returns the resolved full span and does not report truncation. | Describe the baseline exactly, then replace it through the explicit versioned bounded contract. |
| “Validated CALLS” needs a heuristic qualifier | Already satisfied in the public tool description; generation validation and edge truth remain separate concepts. | Preserve the qualifier in every composed response and agent instruction. |
| Exact ownership/caller routing is conditional | Already satisfied and focused-tested. | Document the conditions; do not broaden deterministic routing. |
| Authority should be per evidence domain | Justified design requirement for a composed response, not a current defect. | Add domain-specific authority projections in the composed package. |
| Empty states need more precision | Justified design requirement. The proposed review list mixes mutually exclusive status with orthogonal truncation/suppression facts. | Model status, completeness, truncation, suppression, and limitations separately. |
| Every item needs provenance | Partly satisfied: graph edges already carry sites and confidence, and dynamic fallback is distinguishable. Derivation is not uniformly public. | Standardize provenance without claiming a derivation the stored record cannot prove. |
| Context package should be request-shaped and budgeted | Accepted product direction. | Use explicit includes, presets, and hard response/source caps. Bounded-context v1 performs no provider-backed source selection. |
| Expose registry ownership metadata | Confirmed product gap. `SymbolRecord` contains metadata that `file_outline` currently drops. | Project it through one canonical identity mapper, starting with `file_outline`; measure before expanding other envelopes. |
| Stable parent symbol ID | Conditionally possible only. `parentKey` is not guaranteed to identify one concrete symbol instance. | Return `parentSymbolId` only after unique same-generation resolution; otherwise return the key/path with an explicit resolution state. |
| Agent contract is required | Accepted. | Add evidence interpretation rules and evaluate them with the pinned smaller-model harness. |
| Large symbols need progressive source disclosure | Accepted as a measured follow-on. | Return the full body only when it fits both byte and line caps; otherwise return deterministic excerpts and explicit omissions. |
| Ordinary line reads as trusted continuation | Rejected. A path/range read is not bound to the original symbol or continuity evidence. | Use an exact-symbol continuation fingerprint and full server-side revalidation. Keep direct line reads available only as unbound source reads. |
| Navigation observation token may be request-local | Not true in the current implementation: the token is a deterministic serialization of filesystem metadata and immutable navigation hashes, with no request ID, clock, or access time. The stability contract is still implicit and untested across fresh preparations. | Rename the public checksum to `continuationFingerprint`, include only reproducible identities, validate fresh observation separately, and add an unchanged-preparation test. |
| Legacy unlimited exact opens need a lifecycle | Superseded by the explicit product decision to remove legacy behavior. | Replace exact-symbol full-span responses in one versioned migration; delete the obsolete branch and tests that assert it remains supported. Retain migration rejection/unreachability proof and a historical golden fixture. Do not add a parallel legacy mode or `fullSymbol` escape hatch. |
| Compare a seventh `symbol_context` tool | Rejected under the current repository contract. Six public tool names remain fixed. | Compare replacement `read_file` request shapes and instruction burden. Revisit tool count only through a separate product-contract decision. |
| Numeric confidence may look calibrated | Accepted for the composed response. Existing edge scores are heuristic, not probabilities. | Publish a confidence class/basis and mark any raw score uncalibrated. Do not silently reinterpret the current score. |
| Use repository retrieval to select within a symbol | Rejected for bounded-context v1. | Score the already validated source locally. Semantic within-symbol selection remains a later measured experiment. |
| Unresolved `call_context` may trigger implicit providers | Confirmed contract ambiguity. | Make the complete bounded-context v1 composer provider-free. Return structural status/limitations and recommend a separate explicit search when needed. |
| Mandatory evidence can overflow the response | Confirmed plan gap. | Freeze a byte allocation hierarchy and per-class counts before selector implementation. |
| Optional relationships may force small-source truncation | Confirmed ordering defect in the plan. | Reserve mandatory metadata, then complete source; trim optional siblings and relationships before converting source to bounded mode. |
| Relationship authority and completeness are conflated | Confirmed contract defect in the plan. | Put generation validity under authority and `bounded_static` only under relationship completeness. |
| Complete source may overflow after mandatory metadata | Confirmed plan gap. | Full source is allowed only when mandatory metadata plus complete source fits the total response cap. |
| Continuation range may bypass disclosure caps | Confirmed plan gap. | Clamp every continuation to symbol, source, line, and total-envelope limits and return remaining omissions. |
| Continuation is overbound to unused evidence domains | Confirmed contract defect in the plan. | Derive one scoped fingerprint from the effective continuation domains; source-only continuation excludes relationship identity. |
| `resource_limit` transport is undefined | Confirmed public-contract gap. | Use one mode-independent structured MCP error envelope for exact-symbol requests; never emit the JSON object as plain source content. |
| Versioned migration has no version selector | Confirmed blocking contract gap. | Require the literal `open_symbol.contractVersion: 2`; MCP input validation rejects missing/other values before tool execution, and the server never silently changes an old valid request's response type. |
| `resource_limit` example compares the wrong quantities | Confirmed blocking contract defect. | Compare minimum required response bytes with the hard response limit; total source bytes remain diagnostic only. |
| Huge single-line excerpt policy is undefined | Confirmed selector ambiguity. | Bounded-context v1 never splits a source line. Return bounded source-unavailable metadata for an oversized line; reserve `resource_limit` for an unrepresentable minimum envelope. |
| Successful plain exact-symbol transport is undefined | Confirmed public-contract gap. | V2 exact-symbol success is one structured JSON text content block with `isError: false`, `formatVersion: 2`, and `kind: symbol_context` in both modes. |
| Relationship continuation identity is incomplete | Confirmed continuation gap. | Freeze the static relationship identity projection and separately bind every source-backed dynamic evidence input. |
| Deleting old tests erases migration evidence | Confirmed reproducibility risk. | Delete obsolete behavior assertions, but retain the prior golden fixture plus rejection, unreachability, and direct-read non-regression tests. |
| Evaluation gates are underspecified | Confirmed reproducibility gap in the plan. | Freeze numerical gates before Phase 1 and do not tune them after seeing feature results. |
| Aggregate efficiency can hide per-task regressions | Confirmed reproducibility gap. | Make agent steps primary, tool calls non-regressing, record paired per-task deltas, and freeze sample/tail-latency gates. |
| Ten samples are insufficient for p95 | Confirmed statistical defect. | Use at least 30 controlled repetitions for p95; keep stochastic model evaluation separate from byte-determinism tests. |
| p95 calculation method is undefined | Confirmed reproducibility gap. | Use nearest-rank p95, five unrecorded warm-ups, no post-hoc outlier deletion, recorded machine/runtime identity, and deterministically interleaved baseline/candidate runs. |
| Evaluation labels lack adjudication rules | Confirmed reproducibility gap. | Freeze the malformed, redundant, unnecessary, unsupported-claim, and required-evidence rubric in Phase 0. |
| One 3,000-line fixture can be overfit | Confirmed corpus gap. | Add varied positions, repeated branches, misleading lexical matches, remote call sites, exits, minified content, and two supported languages. |
| Supplied `evidenceSpan` can be stale or cross-symbol | Confirmed contract gap. | Accept it only under matching root, file, symbol, source, generation, and selection-policy identity; otherwise ignore it with a diagnostic. |
| Preset/include precedence is undefined | Confirmed schema ambiguity. | Presets establish defaults, explicit booleans override them, unsupported sections report status, server caps budgets, and the effective request is echoed. |
| Full authority identities are too expensive by default | Accepted. | Return compact classifications plus one continuation fingerprint; keep hashes/tokens in opt-in debug output. |
| `full_bounded_context` implies completeness | Accepted naming defect. | Remove it from bounded-context v1; reserve `maximal_bounded` for a later measured preset if one is still useful. |
| Exact-symbol and direct-span fields can be mixed | Confirmed schema ambiguity for the future contract. | Freeze a strict disjoint input union. Reject mixed and extra fields at MCP schema validation instead of choosing a branch. |
| V2 `mode` semantics are implicit | Confirmed public-contract ambiguity. | Retain and echo the requested mode for client migration, but specify that it does not alter v2 structured transport. |
| Streaming inspection may reopen a changed path | Confirmed future correctness risk. | Keep one root-bound descriptor from initial metadata through hashing and excerpt extraction, verify final descriptor metadata, then recheck authority before publication. |
| Streaming can silently weaken selection | Confirmed completeness-reporting risk. | Publish per-capability availability and never present line-window fallback as syntax-aware selection. |
| The emergency error can itself grow past transport limits | Confirmed future safety risk. | Freeze one compact mandatory error projection with its own small serialized-byte ceiling and no optional debug evidence. |
| Stable descriptor observations prove the current path | False. An atomically replaced path can leave the old open inode stable and readable. | After descriptor inspection, re-resolve the path through the root-bound owner and prove it still names the descriptor identity before publication. |
| Source availability and language selection are conflated | Confirmed taxonomy defect in the plan. | Keep readable source available when syntax-aware selection is unsupported; report language loss only through selection capabilities. |
| Mutated source may receive a continuation | Confirmed future correctness risk. | Publish no excerpts or source fingerprint after a failed source observation; require a fresh exact-symbol preparation. |
| Stateless continuation hashing cost is unmeasured | Confirmed reproducibility/economic gap. | Record bytes read, hashing and selection time, descriptor operations, continuation latency, and complete-file scans per task. |
| Line and byte coordinates can be interpreted inconsistently | Confirmed interoperability ambiguity. | Freeze one-based inclusive lines and zero-based half-open UTF-8 byte offsets before JSON escaping. |

## Verified current baseline

### Registry metadata exists but is not projected

`packages/core/src/symbols/contracts.ts` stores the following on each
`SymbolRecord`:

- `symbolInstanceId`, `symbolKey`, `name`, `qualifiedName`, `label`, and `kind`;
- file and source span;
- `parentKey` and `parentQualifiedNamePath`;
- export status and ontology tags;
- file hash and extractor version.

`packages/mcp/src/core/registry-file-outline.ts` currently maps a record to only
`symbolId`, `symbolLabel`, `span`, and `callGraphHint`. Exact
`read_file(open_symbol)` reuses that reduced outline projection. Call-graph nodes
similarly expose identity, label, file, language, and span, but not the richer
owner/ancestry metadata.

This is fragmentation, not missing index data.

### Current-source evidence already has an observed byte hash

`packages/mcp/src/core/current-source-symbols.ts` opens the current file through
the root-bound descriptor path, reads its exact observed size, verifies the file
observation stayed stable, and computes `CurrentSourceEvidence.observedHash`
from the bytes it actually read. Exact outline validation already consumes that
current evidence when rebuilding and matching structural identities.

The future continuation contract must reuse this proof shape. A registry
`SymbolRecord.fileHash` is index-time metadata and may be compared with current
evidence, but it is not a substitute for hashing the currently validated source
bytes.

The current helper intentionally stops at `CURRENT_SOURCE_MAX_BYTES` (256 KiB),
so it cannot be reused unchanged for the large-source corpus. Phase 0 must
freeze a separate maximum inspectable-source size above the response ceiling.
Phase 3 then needs a root-bound descriptor or streaming evidence path that
hashes the observed bytes and selects bounded lines without making response
size depend on full source size. Source above that inspectable safety limit is
reported unavailable; it does not become `resource_limit` unless the minimum
structured envelope itself cannot fit.

### Relationship evidence is bounded static evidence

The public traversal:

- caps depth at 3 and edges at the requested limit;
- asks the relationship store only for `CALLS` records;
- exposes confidence and call-site location;
- preserves suppressed/dynamic notes and note truncation counts;
- can add explicitly labelled source-backed dynamic Python fallback edges;
- returns an empty validated root when no usable edge was found.

The relationship builder also stores `IMPORTS` and `EXPORTS`, but the public
`call_graph` surface does not provide inheritance, implementation, universal
reference, configuration, or data-flow graphs. An empty edge list means “no
validated edge was returned by this bounded static traversal,” never “no runtime
relationship exists.”

### Authority domains are not interchangeable

Prepared navigation identity currently binds the canonical root, collection,
completion-marker run, policy digest/hash, navigation generation, registry and
relationship manifest hashes, navigation seal, navigation observation token,
and mutation generation.

Healthy structural reads can therefore share one generation-bound navigation
snapshot. Two degraded cases must remain visible rather than being described as
the same proof strength:

- source-backed navigation may remain usable during a runtime fingerprint
  mismatch that blocks vector search;
- a remote completion-proof probe failure may preserve local source-backed
  navigation with diagnostics.

Vector authority may be `not_required` for a purely structural symbol request.
It must not be reported as proven merely because a provider runtime exists.

### Existing latency evidence is not a composed benchmark

The live benchmark records independent samples for exact search,
`file_outline`, exact `read_file(open_symbol)`, and `call_graph`. These rows must
not be summed and described as a measured symbol-context operation. Phase 0
must capture an actual adaptive multi-tool baseline in one harness session.

## Objective

For a known symbol, return the minimum trustworthy evidence needed to decide
whether more source or relationships are necessary, while preserving exact
identity, current-source validation, navigation authority, mutation fencing,
deterministic failure behavior, and the existing six public tool names.

The desired user-facing rule is:

> Return the complete symbol when mandatory metadata plus source fits the
> source, line, and total-envelope budgets. Otherwise return a query-aware,
> structurally useful bounded view with explicit omissions and stable,
> revalidated continuation requests.

The package is not “everything related to this function.” It is a bounded
investigation result with explicit capability and completeness limits.

## Non-goals

- Do not claim exhaustive runtime callers, data flow, inheritance, references,
  tests, or configuration.
- Do not treat semantic similarity as a dependency or caller relationship.
- Do not add a seventh MCP tool or expose raw graph/storage queries.
- Do not weaken completion-marker, vector, source-freshness, navigation-seal,
  prepared-receipt, observation, or mutation-generation checks.
- Do not make ranking confidence, watcher state, cache age, or provider success
  substitute for authority evidence.
- Do not retain the obsolete exact-symbol full-span branch after the versioned
  bounded replacement is released.
- Do not fetch every optional section for every request.
- Do not invent a resolvable parent ID, edge derivation, or unsupported
  relationship kind.
- Do not change indexed representation or add a cache until the measured
  composed workflow demonstrates a remaining need.

## Contract strategy

Keep all six existing tool names. That is a product-surface decision, not a
claim that a seventh tool could never be designed. Develop the composer
internally first. If it passes the evaluation gates, compare replacement
`read_file` exact-symbol shapes in the smaller-model harness and choose the
least error-prone bounded contract.

Release that contract through one explicit version boundary: when
`open_symbol` carries `symbolId` or `symbolLabel`, the public input schema
requires the literal `contractVersion: 2`. Missing, `1`, or other values fail
MCP input validation before tool execution. Direct-span `open_symbol` and
ordinary file/range reads remain separate unversioned source-read variants. The
server does not run the old exact-symbol behavior and does not silently return a
new response type to an old valid request. Every success or tool error produced
after accepting a v2 exact-symbol request carries `formatVersion: 2` and
`kind: "symbol_context"`.

The input union is strict and disjoint:

- an exact-symbol v2 variant contains `contractVersion: 2`, exactly one of
  `symbolId` or `symbolLabel`, and exactly one of `context` or `continuation`;
- a direct-span source-read variant contains `startLine` and `endLine`, no
  `contractVersion`, no symbol identity, and no context or continuation;
- ordinary file/range reads contain neither exact-symbol nor direct-span-only
  fields; and
- every variant rejects unknown or cross-variant fields. A mixed request is a
  schema error, never a request whose meaning is selected by field precedence.

Exact `open_symbol` v2 requests return a structured complete-or-bounded symbol
package regardless of whether the caller supplied `mode="plain"` or
`mode="annotated"`; `mode="plain"` continues to mean source text only for
non-symbol file/range reads. Migrate all first-party callers, hints, schemas,
generated contracts, and tests in the same change, then delete the prior
exact-symbol full-span response branch. Do not keep a dual response path or an
opt-in unbounded escape hatch.

For v2 exact-symbol requests, retain `mode` as a required migration field and
echo it as `requestedMode` in the effective request. It does not select the
response representation: both values use the same structured JSON transport.
This avoids an ignored input while preventing clients from interpreting
`mode="plain"` as a source-text response.

The exact-symbol version discriminator and response transport above are frozen
before Phase 0. The remaining context-request nesting is shown to make the plan
testable; compare those candidate shapes internally, then freeze the selected
shape with schema, compact-contract, and generated-documentation tests before
public Phase 5 implementation:

```json
{
  "path": "/absolute/repo/src/payments.ts",
  "mode": "annotated",
  "open_symbol": {
    "contractVersion": 2,
    "symbolId": "syminst_...",
    "context": {
      "preset": "call_context",
      "query": "where is the transaction committed",
      "include": {
        "source": true,
        "lexicalContext": true,
        "callers": true,
        "callees": true
      },
      "budgets": {
        "sourceBytes": 12000,
        "sourceLines": 200,
        "excerpts": 5,
        "siblings": 12,
        "edgesPerDirection": 20,
        "totalResponseBytes": 24000
      }
    }
  }
}
```

Candidate presets:

| Preset | Default contents | Provider policy |
|---|---|---|
| `definition` | canonical identity, ancestry, signature/documentation, exact span | no provider calls |
| `implementation` | definition plus bounded implementation excerpts and siblings | no provider calls |
| `call_context` | implementation plus bounded callers/callees | no provider calls; unresolved graph evidence is returned explicitly |

Presets are defaults, not hidden work. Explicit includes and hard caps control
execution. The response reports the effective resolved request.

Preset/include resolution is fixed before schema work:

1. The preset establishes every include default.
2. Each explicitly supplied include boolean overrides only that default.
3. Omitted include fields inherit the preset; they do not mean `false`.
4. Requested unsupported sections remain in the effective request with an
   explicit unsupported status rather than disappearing.
5. The server clamps every caller budget to public maxima.
6. The response echoes the effective preset, includes, and clamped budgets.

Successful v2 exact-symbol transport is mode-independent: return
`isError: false` with exactly one JSON text content block whose payload starts
with this stable identity:

```json
{
  "formatVersion": 2,
  "kind": "symbol_context",
  "status": "ok",
  "symbol": {},
  "source": {}
}
```

The CLI and generated clients parse `kind` and `formatVersion` and present the
payload as symbol context, never as file contents. Missing or unsupported
versions never reach the handler; their deterministic MCP schema rejection is
the migration boundary. The v2 implementation contains no branch that serves
the previous full-span exact-symbol response.

In the remainder of this plan, “bounded-context v1” names the first feature
release; its exact-symbol wire contract is `formatVersion: 2` because it
replaces the existing unversioned response behavior.

The bounded-context v1 surface stops at canonical identity/ancestry,
complete-or-bounded source, siblings, callers/callees, compact
authority/limitations, and symbol-bound continuation. Arbitrary references,
tests, configuration recovery, semantic within-symbol selection, derived
behavioral regions, richer relationship kinds, and a possible
`maximal_bounded` preset are deferred until bounded-context v1 measurements
show that they are needed.

## Canonical symbol identity

Create one pure internal projection from `SymbolRecord` and use it in the
composer. The first public increment should enrich `file_outline`, because that
is already the registry-owned structure surface. Do not enlarge every search
result and call-graph node merely for symmetry; measure payload cost and agent
utility first.

The projection should include:

- concrete `symbolId` (`symbolInstanceId`), name, qualified name, label, kind,
  language, file, and span;
- export status and ontology/implementation role when present;
- parent key and qualified-name path;
- parent resolution state: `resolved`, `ambiguous`, `missing`, or
  `not_applicable`;
- `parentSymbolId` only when exactly one concrete parent resolves inside the
  same loaded registry generation.

Search targets, outline symbols, exact-open annotations, call-graph nodes, and
the composed response must use the same names for the fields they share. They
need not all carry the same amount of metadata.

## Evidence-domain projection

A composed response must not use one blanket `authority: "proven"` field.
Project compact domain classifications by default:

```json
{
  "authority": {
    "vector": "not_required",
    "navigation": "remote_generation_proven",
    "source": "current_span_validated",
    "relationships": "remote_generation_proven"
  },
  "relationships": {
    "status": "ok",
    "completeness": "bounded_static",
    "limitations": ["dynamic_relationships_unknown"]
  },
  "continuationFingerprint": "sha256_..."
}
```

Relationship authority answers whether the prepared relationship artifact was
valid. Its values are `not_requested`, `remote_generation_proven`,
`local_navigation_validated`, `degraded`, or `unavailable`. Relationship
completeness answers what coverage was attempted and belongs only in the
relationship section. Never publish `bounded_static` as an authority value.

Full marker, seal, manifest, observation, source-hash, and mutation identities
belong in opt-in debug output. `continuationFingerprint` is a deterministic
continuity checksum, not an authority receipt, context identifier, or
authorization token.

The current navigation observation token is reproducible across equivalent
preparations: `resolveNavigationObservation()` serializes `dev`, inode, mode,
size, modification time, and change time for the current pointer, seal,
manifests, indexes, and navigation directories, plus immutable navigation
hashes. It contains no request-local nonce, clock reading, or access time.
However, it spans both symbol and relationship artifacts, so it is a fresh
authority check rather than an unconditional source-continuity input. The
fingerprint contains only identities deterministic across equivalent
preparations and relevant to its effective domains; fresh observation validity
is checked separately immediately before publication.

Required rules:

1. Use one request-local prepared-read/navigation snapshot for identity,
   outline, graph, and source selection. Do not call public tools recursively or
   establish four independent authority observations.
2. Recheck the prepared observation before returning or seeding reusable
   evidence. A mutation or identity change invalidates the composed result.
3. Preserve degraded navigation distinctions. Do not label a local
   source-backed fallback as a remote generation proof.
4. Prove vector authority only if semantic/vector evidence is actually used.
   Otherwise report `not_required`.
5. Bind continuation requests only to the evidence domains they continue.
   Source-only continuation excludes relationship identities. A continuation
   that pages relationships includes the relationship manifest identity.
6. A newly prepared unchanged symbol must reproduce and accept the prior
   continuation fingerprint. If any future observation field becomes
   request-local, remove it from the fingerprint without removing the fresh
   pre-publication observation check.

## Relationship status and provenance

Do not flatten all relationship outcomes into one status enum. Use orthogonal
fields:

- `status`: `ok`, `unavailable`, `unsupported`, `ambiguous`, or `degraded`;
- `completeness`: `bounded_static` or the narrower capability actually used;
- `emptyReason`: `no_validated_edge_found` only when traversal ran and returned
  no usable edges;
- `truncated` and returned/available counts when known;
- `suppressedCount` and bounded suppression notes;
- limitations such as `dynamic_relationships_unknown`;
- an explicit unsupported relationship kind when the request asks for a graph
  the index does not build.

The entire bounded-context v1 composer is provider-free. Missing, empty, unavailable, or
degraded callers/callees do not trigger embedding, vector search, or reranking.
Return the structural outcome and a separate `search_codebase` recommended
action with reason `bounded_reference_recovery`; the agent decides whether to
pay for that explicit follow-up. The composer never executes the hint itself.

Each item must identify its evidence class without overstating it:

```json
{
  "symbolId": "syminst_...",
  "relationship": "caller",
  "source": "relationship_graph",
  "confidenceClass": "high",
  "confidenceBasis": "stored_static_relationship",
  "rawConfidenceScore": 0.95,
  "calibrated": false,
  "sites": [{ "file": "src/checkout.ts", "startLine": 84 }]
}
```

Use a more specific derivation only when the current extractor or fallback path
proves it. A Python source-backed dynamic fallback remains labelled dynamic.
Text search produces an `unclassified_reference`, and semantic search produces
`related_code`; neither may be projected as a caller, callee, implementation,
or dependency.

## Progressive source disclosure

### Budget rules

Bytes are the primary cap and lines are a secondary cap. Both must pass before
returning a full symbol. The implementation must also cap excerpt count and the
serialized total response, including JSON overhead.

Initial defaults should be evaluated rather than assumed. The starting corpus
may test:

- 8–16 KiB source;
- 150–250 source lines;
- 3–6 excerpts;
- 20–80 lines per excerpt;
- 10–20 siblings;
- 20 edges per direction.

Public maxima must be lower than the server's unsafe-resource threshold and
must remain deterministic under caller-supplied larger values.

First reserve mandatory metadata and attempt the complete-source rule below.
Only when complete source cannot fit do the bounded-source classes use this
strict allocation order, each with a configured maximum count:

1. Identity, compact authority, limitations, and omission metadata.
2. Signature/declaration and its minimum syntactic context.
3. The highest-scoring local query-relevant excerpt, when a query exists.
4. At most one terminal return/failure excerpt not already covered.
5. Additional distinct query-relevant excerpts up to the excerpt cap.
6. Bounded call/state/control-flow anchors with per-kind caps.
7. Siblings and caller/callee evidence.

Optional future references, tests, and configuration never displace classes
1–4. Enforce both source and final-envelope budgets using actual UTF-8 bytes
after JSON serialization, not JavaScript string length. If even identity,
authority, limitation, and omission metadata cannot fit, return an explicit
resource-limit outcome rather than malformed or silently partial JSON.

### Small symbols

Return the complete span only when all three conditions pass:

1. Source UTF-8 bytes fit the source cap.
2. Source lines fit the line cap.
3. Mandatory identity, authority, limitation, response, and completeness
   metadata plus complete source fit the total-response cap.

Allocate mandatory metadata first and serialize the complete-source candidate
with the same canonical serializer used for output. When it fits, preserve the
complete source and then add siblings, callers, and callees in priority order.
Deterministically truncate those optional sections before touching complete
source. Their status, returned count, available count when known, and
truncation must remain visible.

Switch source to bounded mode only when the source byte or line cap fails, or
mandatory metadata plus complete source exceeds the total-response cap. A small
function with 143 callers can therefore return complete source and 20 callers
with `truncated = true`; relationship volume must not make the source appear
incomplete.

When all three conditions pass, return:

- `source.mode = "complete"`;
- `completeSymbolReturned = true`;
- total and returned lines/bytes;
- no omitted ranges.

### Large symbols

When either cap is exceeded, return `source.mode = "bounded"` with:

- exact full symbol span and total lines/bytes;
- returned lines/bytes and excerpt count;
- `truncated = true` and `completeSymbolReturned = false`;
- deterministic excerpts with reason, exact span, and content;
- normalized, non-overlapping omitted ranges;
- selection bases and unsupported selection capabilities;
- revalidated continuation requests.

Never return the first N lines as the sole strategy. Candidate evidence should
be gathered in this order:

1. Mandatory structural evidence: declaration/signature, annotations,
   documentation, opening setup, and terminal return/throw behavior where the
   language analyzer can identify them.
2. Query evidence: local exact phrase/token matching, identifier splitting, and
   lightweight lexical scoring over the already validated source span, plus a
   supplied search `evidenceSpan` when it belongs to the same file and symbol.
3. Behavioral anchors: validated call sites, state writes, branches,
   exceptions, resource boundaries, synchronization, and persistence where the
   analyzer has explicit support.
4. Context boundaries: block-aware surrounding lines without splitting syntax
   nodes when supported; deterministic line windows otherwise.
5. Distinctness: merge overlapping excerpts and prefer separated evidence over
   adjacent variants of the same setup block.

Use fixed reason priority and stable span tie-breaking. Do not let filesystem
order, provider order, or locale collation determine the selected excerpts.

### Huge single-line source

Bounded-context v1 never splits a physical source line. It therefore never
returns a byte fragment that could be mistaken for a complete statement or
syntax node. When a candidate line alone exceeds the per-excerpt source cap,
omit that line and report its line and UTF-8 byte range explicitly.
All source coordinates use one frozen convention: line numbers are one-based
and inclusive; byte offsets are zero-based and half-open; bytes mean the UTF-8
source bytes before JSON escaping. A client's treatment of `endByte` as
exclusive must not cause it to treat `endLine` as exclusive.

If a symbol consists only of such an oversized line, return a successful
bounded package with:

```json
{
  "formatVersion": 2,
  "kind": "symbol_context",
  "status": "ok",
  "source": {
    "mode": "bounded",
    "status": "unavailable",
    "emptyReason": "line_exceeds_excerpt_limit",
    "completeSymbolReturned": false,
    "returnedLines": 0,
    "omittedRanges": [
      { "startLine": 1, "endLine": 1, "startByte": 0, "endByte": 840000 }
    ]
  },
  "continuation": {
    "available": false,
    "reason": "line_splitting_unsupported"
  }
}
```

Identity, authority, limitations, and requested relationship evidence remain
usable. The large line does not by itself cause `resource_limit`; that error is
reserved for a minimum safe structured envelope that cannot fit the hard
response limit.

Source availability is separate from selection capability. Its status is one
of `available`, `partially_available`, `unavailable`, or `stale`. The frozen v1
unavailable/stale reasons are:

- `line_exceeds_excerpt_limit`: one physical line cannot fit and v1 does not
  split lines;
- `source_exceeds_inspection_limit`: the descriptor is stable but the source is
  above the server's bounded inspection ceiling;
- `source_changed_during_inspection`: descriptor metadata changed between the
  initial and final observations;
- `path_identity_changed_during_inspection`: the descriptor remained stable,
  but a fresh root-bound path resolution no longer names the same device/inode
  identity;
- `source_descriptor_unavailable`: a root-bound descriptor could not be opened
  or retained safely.

These reasons do not alias `resource_limit`, stale continuation, unavailable
navigation, or unsupported relationship evidence. The response may still
return identity, authority, limitations, and independently requested graph
evidence when doing so remains valid.

An unsupported language does not make readable source unavailable. Keep
`source.status = "available"` or `partially_available`, use local lexical
matching and line windows when valid, and report parser-backed capabilities as
`unsupported_language`. Capability loss must not be copied into
`source.emptyReason`.

When source changed or the path identity no longer binds to the inspected
descriptor, return no excerpts from that observation, set source authority and
status to `stale` or `unavailable`, issue no source continuation fingerprint,
and recommend a fresh exact-symbol preparation. Independently valid identity
or relationship evidence may still be returned.

A supplied `evidenceSpan` is advisory and accepted only when its attached
metadata matches the canonical root, file, symbol instance, current source hash,
navigation generation, and selection-policy version, and the span lies entirely
inside the revalidated symbol. Ignore any mismatch with a bounded diagnostic;
never clamp stale or cross-symbol coordinates into apparent validity. Until a
search response publishes compatible evidence metadata, use only same-request
internal evidence spans and ignore standalone client-supplied spans.

Bounded-context v1 does not send the symbol through repository retrieval or call
embedding, vector, or reranking providers to select excerpts. A later semantic
selector experiment requires a deterministic observed miss where local query
matching, existing same-generation evidence, and structural anchors omit
necessary evidence. Any such experiment must explicitly budget and report
provider work and prove vector authority independently.

### Derived internal map

For a possible post-v1 experiment, a bounded control-flow or behavioral map can
guide expansion. These entries are not symbols. Label them as `derivedRegion`,
include their source span, derivation, confidence class/basis, and an
uncalibrated raw score only when useful. Omit the map entirely for a
language/case the analyzer cannot support.

Any branch handle must be deterministic from validated source identity and
syntax span. Do not expose unstable ordinal branch IDs.

### Continuation

Trusted continuation remains an exact-symbol operation:

- expand a range with `open_symbol.contractVersion = 2`, `symbolId`, and a
  `continuation` object;
- repeat bounded symbol context with a new within-symbol query;
- open a returned caller/callee by concrete symbol ID;
- request a larger permitted budget explicitly.

A candidate continuation request is:

```json
{
  "open_symbol": {
    "contractVersion": 2,
    "symbolId": "syminst_...",
    "continuation": {
      "continuationFingerprint": "sha256_...",
      "startLine": 1800,
      "endLine": 1960
    }
  }
}
```

Compute one continuation fingerprint through canonical serialization of only
the stable identities required by the effective continuation domains. Every
source continuation includes canonical root, symbol instance, revalidated full
span, the SHA-256 of the descriptor-bound current source bytes, symbol-registry
manifest identity, and selection-policy version. It must use
`CurrentSourceEvidence.observedHash` or equivalent freshly observed bytes, not
the registry's index-time `SymbolRecord.fileHash` by itself.

A source-only `definition`, `implementation`, query, or range continuation does
not include relationship-manifest identity. A continuation that pages or
reuses caller/callee evidence does include it. The response echoes the
fingerprint's effective domains so a client cannot mistake source continuity
for relationship continuity.

The static relationship continuation component contains exactly:

- canonical root and target symbol instance;
- symbol-registry and relationship-manifest identities;
- relationship kind, direction, depth, and effective edge limit;
- relationship projection/confidence policy version; and
- deterministic edge-ordering policy version.

Stored static graph paging does not require current-source identity by default.
If the projection revalidates any returned site against current source, add a
sorted `(relativeFile, observedHash)` set for every revalidated file. A
source-backed dynamic relationship component always includes its fallback
policy version and that sorted observed-source set for every file used to
derive its edges. When the server cannot bind all dynamic source inputs, those
edges are not continuation-eligible and the response reports that limitation;
it must not reuse the static fingerprint for them.

The server recomputes and compares the scoped fingerprint after a new
request-local preparation. Marker, seal, navigation observation, mutation
generation, and every requested evidence domain are still validated freshly
before publication; they are authority checks, not unconditional continuity
inputs. The hash itself proves nothing and needs no trust. This remains
stateless and introduces no context cache.

If any identity inside the effective fingerprint changed, return a
stale-context outcome and require a fresh exact resolution. A relationship-only
change does not invalidate a source-only continuation. The requested range must
remain inside the revalidated full symbol span. Ordinary
`read_file(start_line,end_line)` remains available as an unbound source read,
but generated context-package hints must not present it as a trusted
continuation.

Every continuation remains bounded. Clamp the requested range and any supplied
budgets to the validated symbol boundary, maximum source bytes, maximum source
lines, and maximum serialized response. When the requested range cannot fit,
return the selected bounded portion, `completeSymbolReturned = false`, updated
omitted ranges, and another continuation fingerprint/request. A continuation
means “show more bounded evidence,” never “disable safety limits.”

## Exact-open replacement and resource-limit transport

There is no legacy lifecycle. Once the bounded contract passes its release
gates, replace the current exact-symbol full-span branch and delete tests that
assert it remains supported, along with obsolete hints, documentation, and
compatibility code. Retain the migration evidence defined below. Non-symbol
plain file and range reads remain outside this migration.

Normal large symbols return a successful bounded package. Use
`resource_limit` only when the server cannot serialize the minimum safe
structured result within the hard response ceiling after all optional evidence
has been removed or compacted. Total source size is diagnostic and never the
deciding comparison. The mode-independent error payload is:

```json
{
  "formatVersion": 2,
  "kind": "symbol_context",
  "status": "resource_limit",
  "code": "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT",
  "reason": "minimum_safe_package_exceeds_limit",
  "message": "The exact symbol cannot be represented safely within the bounded response contract.",
  "symbolId": "syminst_...",
  "totalSourceBytes": 840000,
  "minimumRequiredResponseBytes": 280000,
  "hardResponseLimitBytes": 262144,
  "recommendedNextAction": {
    "tool": "search_codebase",
    "reason": "narrow_query_before_symbol_context"
  }
}
```

The error projection is a fixed transport escape hatch, not the general debug
response. Its mandatory fields are exactly `formatVersion`, `kind`, `status`,
`code`, `reason`, `symbolId`, `minimumRequiredResponseBytes`, and
`hardResponseLimitBytes`. The bounded ASCII `message` and
`recommendedNextAction` shown above are optional and are removed first if the
frozen emergency-error ceiling would be exceeded. No hash, path, source span,
relationship data, arbitrary exception text, or caller-controlled value is
allowed in this projection. Phase 0 records the canonical serialized maximum
and proves it fits beneath the MCP transport ceiling independently of the
normal symbol-context cap.

For both `mode="plain"` and `mode="annotated"` exact-symbol requests, transport
that payload as an MCP tool error (`isError: true`) with one JSON text content
block. Never return it as successful plain source content and never include a
partial source field. Schema/types, generated contracts, CLI formatting, and
golden tests must cover the same payload. Phase 0 freezes the hard ceiling and
proves separately that very large source uses bounded success and only an
unrepresentable minimum package uses this error.

## Agent evidence contract

Generated tool documentation and the paired-agent instructions must state:

1. Treat only returned graph edges as validated bounded relationships.
2. An empty caller/callee list is not proof that no caller/callee exists.
3. Do not call text matches or semantic similarity a dependency or reference.
4. Cite concrete symbol IDs, files, spans, edge sites, and evidence source when
   making structural claims.
5. State unsupported, degraded, ambiguous, truncated, and unresolved evidence.
6. Do not make claims about omitted source. Expand the relevant range when the
   answer depends on it.
7. Stop when the requested claim is supported; do not fetch optional sections
   merely because they exist.

## Implementation phases

### Phase 0 — Freeze the baseline and corpus

Before production changes:

- add a small complete function fixture;
- add a small function with enough callers to overflow the complete serialized
  candidate and prove optional relationships truncate while source stays
  complete;
- add large owners with relevant behavior near the beginning, middle, and end;
- freeze a maximum inspectable-source size distinct from the hard response cap
  and include a source larger than the response cap but below that inspection
  limit;
- put relevant logic in the third or fourth of several similar branches;
- repeat query terms in irrelevant branches and place a useful call site far
  from the strongest lexical match;
- include multiple returns and exception paths;
- add a huge single-line/minified case and prove it returns bounded
  source-unavailable metadata without splitting the line or triggering
  `resource_limit` solely because total source is large;
- cover at least two supported languages with structural extraction;
- add ambiguous same-name owners and an unresolved parent key;
- add empty, suppressed, dynamic, truncated, unavailable, and unsupported graph
  cases;
- add source mutation between preparation, composition, and continuation;
- freeze schema fixtures proving the exact-symbol, direct-span, and ordinary
  read variants are disjoint and reject mixed or extra fields;
- prove v2 echoes `requestedMode` while plain and annotated use the same
  structured transport;
- define streamed-source capability fixtures that distinguish local lexical
  and line-window availability from unavailable syntax boundaries and
  control-flow anchors;
- freeze each source failure reason independently from resource, continuation,
  navigation, relationship, and language-capability outcomes;
- prove one root-bound descriptor supplies initial metadata, hashing, source
  inspection, and excerpt extraction, final descriptor metadata is unchanged,
  a fresh root-bound path identity still names that descriptor, and
  mutation/navigation authority is rechecked before publication;
- atomically replace a repository path while its old descriptor remains stable
  and readable, and prove old-inode source is not published, no source
  continuation is issued, and fresh exact preparation is required;
- prove an unsupported language retains readable lexical/line-window evidence
  while only parser-backed selection capabilities report
  `unsupported_language`;
- freeze the compact emergency-error projection and prove its maximum canonical
  serialization remains beneath the MCP transport ceiling;
- prepare an unchanged symbol twice through separate request-local preparations
  and prove the same continuation fingerprint validates;
- change only the relationship manifest and prove a source-only continuation
  remains valid while relationship-bound continuation becomes stale;
- prove static relationship continuation binds direction, depth, limit, policy,
  and edge ordering, and dynamic continuation binds every observed source input
  or reports itself ineligible;
- change current source bytes without relying on the registry `fileHash` and
  prove the source continuation becomes stale;
- request an oversized continuation and prove source/line/response caps plus
  remaining omissions are preserved;
- supply evidence spans with wrong root, file, symbol, source hash, navigation
  generation, and selection-policy version and prove each is ignored with a
  diagnostic;
- record the current adaptive workflow (`search_codebase` -> exact open ->
  outline -> graph -> bounded reference search) in one harness session;
- record a historical golden fixture for the current unversioned full-span
  exact-symbol response before removing it;
- prove the input schema rejects missing, `1`, and unsupported exact-symbol
  contract versions before tool execution, v2 success has `formatVersion: 2`
  and `kind: symbol_context` in both modes, every accepted-v2 tool error carries
  the same identity, and ordinary plus direct-span non-symbol reads remain
  unchanged;
- prove a very large multi-line source returns bounded success below the hard
  response cap; and
- force the minimum safe package over the hard ceiling and prove plain and
  annotated exact-symbol requests return the same structured MCP
  `resource_limit` error with no partial source.

Record answer correctness, owner rank, tool calls, agent steps, provider calls,
wall time, response bytes/tokens, model input/output tokens, malformed and
redundant calls, unsupported structural claims, omitted-range correctness, and
determinism across repeated runs. Source-context workloads also record actual
source bytes read from descriptors, hashing time, excerpt-selection time, total
descriptor operations, continuation latency, and complete-file scan count per
request and per completed task. Response bytes are not a substitute for bytes
read from source.

Freeze this adjudication rubric in the unchanged baseline artifact:

- `malformed request`: a tool request rejected by the published schema or using
  the wrong field/type such that the agent must correct and retry it;
- `redundant call`: a call that repeats an earlier evidence request without a
  changed input, authority state, or new evidence need;
- `unnecessary call`: a call made after the task's required evidence is already
  available, or to a section not required by the frozen task rubric;
- `unsupported structural claim`: a caller, callee, ownership, absence, or
  exhaustiveness claim not supported by the returned evidence class and its
  stated limitations; and
- `required evidence recovered`: the answer identifies the frozen owner and
  source span and cites the task-specific implementation or relationship
  evidence required by the answer key without inferring from omitted source.

Keep deterministic component proof separate from stochastic agent evaluation:

- pure selector/composer fixtures must be byte-identical across repeated
  invocations;
- controlled local latency workloads use at least 30 repetitions for median and
  empirical p95; and
- the pinned smaller-model harness uses at least 10 paired runs per task and arm
  for correctness, calls, steps, tokens, and latency. Model text itself is not
  required to be byte-identical.

Controlled latency uses nearest-rank percentiles: sort all 30 recorded samples
and select rank `ceil(0.95 * 30)`, the 29th observation, for p95. Run five
unrecorded warm-ups per workload, delete no outliers after observation, and
record machine, OS, CPU, runtime, provider/model, index generation, Git tree,
and diff identity. Interleave baseline and candidate in a frozen seeded AB/BA
order rather than running all samples for one state first.

Freeze these release gates in the unchanged baseline artifact before Phase 1:

- no deterministic correctness, authority, safety, or required-evidence
  regression;
- primary efficiency: median agent steps decrease by at least 1 absolute or 20%
  relative; record both values;
- secondary efficiency: median tool calls do not increase, no deterministic
  workload adds more than one unnecessary call, and no large-symbol workload
  regresses in median steps or calls;
- median model-visible UTF-8 bytes reduced by at least 20%;
- total source bytes read per completed task no more than 20% above the adaptive
  baseline, with paired per-task deltas and complete-file scan counts reported;
- zero provider-call increase for structural tasks;
- median end-to-end latency no more than 10% above the adaptive baseline;
- controlled local p95 latency no more than 20% above the adaptive baseline
  over at least 30 repetitions;
- every large-symbol response below the hard serialized-response cap;
- malformed calls, redundant calls, and unsupported structural claims no worse
  than baseline; and
- byte-identical pure fixture responses across all repeated component runs.

The baseline may justify stricter gates, but no gate may be weakened after a
feature result is observed. Record paired per-task deltas; aggregate medians do
not excuse a regression hidden in a large-symbol or degraded-graph workload.

### Phase 1 — Canonical identity projection

Implement one pure mapper from `SymbolRecord`. Enrich `file_outline` first and
let annotated exact opens inherit it. Add parent resolution against the loaded
registry with explicit ambiguous/missing outcomes.

Measure envelope growth before adding richer identity to grouped search or every
call-graph node. If the composed package removes the need for those additions,
keep the other envelopes compact.

### Phase 2 — Normalize relationship evidence internally

Build an internal projection for graph status, completeness, truncation,
suppression, limitations, item source, confidence class/basis, optional
uncalibrated raw score, and sites. Preserve current edge ordering and current
fallback labels. Do not change the relationship sidecar schema merely to obtain
a nicer public label.

### Phase 3 — Deterministic source selector

Implement the complete-versus-bounded selector as a pure component over a
validated symbol, current source, optional query evidence, structural anchors,
and explicit budgets. Add byte-accurate response accounting, excerpt merging,
omitted-range construction, and a stable continuation fingerprint.

Extend current-source evidence through a root-bound descriptor/streaming owner
for files above the existing 256 KiB helper cap and below the frozen inspectable
limit. Hash the bytes actually observed; do not raise the response budget or
materialize unbounded source merely to support selection.

Open the source once through the canonical-root-bound descriptor. Record its
initial descriptor metadata, hash and inspect bytes from that same descriptor,
derive excerpts without reopening the path for source extraction, then compare
final descriptor metadata. After descriptor stability succeeds, perform a
fresh root-bound path resolution and compare the path's current device/inode
identity with the open descriptor. Reject disappearance, replacement, changed
symlink/directory traversal, changed canonical-root binding, or root escape as
`path_identity_changed_during_inspection`. This final rebinding check verifies
identity only; it must not become a second source used for hashing or excerpt
selection. Recheck mutation and navigation authority after descriptor and path
identity checks and immediately before publication.

Atomic-replacement coverage must keep file A's original descriptor readable,
replace its repository path with file B, and prove that no source evidence from
A is published as current evidence for the path. Watcher or navigation checks
remain additional fences, not substitutes for descriptor-to-path rebinding.

Streaming inspection publishes its actual selector capabilities. Local lexical
matching and bounded line windows may remain available, while syntax
boundaries, branch IDs, state-write extraction, control-flow anchors, or a
whole-file parser may be `unavailable_streaming_source`. The selector must not
silently replace an unavailable parser-backed claim with a line window; the
response reports the capability loss and the evidence actually used.

Bounded-context v1 uses only validated local source, supplied same-generation
evidence, and structural anchors. Semantic provider selection is a separately
accepted or rejected post-v1 experiment, not an automatic Phase 3 expansion.

### Phase 4 — Request-local composer

Compose identity, ancestry, source, outline, relationships, provenance,
authority, and limitations from one prepared navigation snapshot. Reuse
existing internal owners rather than invoking MCP tools recursively. Revalidate
authority and mutation generation immediately before response publication.

### Phase 5 — Versioned public replacement

Only after Phases 0–4 are green, compare at least two replacement `read_file`
exact-symbol shapes in the smaller-model harness. Measure malformed calls,
instruction-token overhead, redundant calls, and successful task completion.
Choose the better bounded contract and publish it as a versioned exact-symbol
response requiring `open_symbol.contractVersion: 2` for both plain and
annotated requests.

Update Zod schemas, TypeScript envelopes, compact-contract tests, tool
descriptions, CLI formatting, generated docs, behavior spec, every first-party
caller, `recommendedNextAction`, and agent instructions in the same change.
Delete the old exact-symbol full-span response branch and tests that assert it
is still supported; do not retain a compatibility flag. Preserve the historical
golden fixture and add tests proving the old branch is unreachable, old or
missing versions are rejected, and direct non-symbol plain reads are unchanged.
Publish the mode-independent structured `resource_limit` error for the unsafe
cases defined above.

### Phase 6 — Evaluation and retention decision

Compare the composed path with the current adaptive multi-tool workflow using
the pinned smaller model and harness. Run both known-symbol and conceptual
within-symbol tasks across the beginning/middle/end, repeated-branch,
misleading-lexical, remote-call-site, multi-exit, minified, and two-language
fixtures.

Retain the public feature only if it meets the numerical gates frozen in Phase
0, including:

- preserves deterministic owner/behavior correctness and safety outcomes;
- reduces primary median agent steps by at least 1 absolute or 20% relative;
- does not increase median tool calls, add more than one unnecessary call to any
  deterministic workload, or regress median steps/calls on a large-symbol
  workload;
- reduces median model-visible UTF-8 bytes by at least 20%;
- does not increase provider calls on deterministic structural cases;
- does not hide truncation, unsupported capabilities, or degraded authority;
- keeps median end-to-end latency within 10% of the adaptive baseline;
- keeps controlled local p95 latency within 20% of the adaptive baseline with
  at least 30 repetitions per workload;
- keeps every large-symbol response under the frozen hard cap;
- does not increase malformed/redundant calls or unsupported structural claims;
  and
- produces byte-identical pure selector/composer fixture responses. The pinned
  model's answer text is judged by the frozen rubric, not byte equality.

If two materially different excerpt-selection strategies fail to improve the
measured workflow, revert the public exposure and retain only independently
useful metadata/status improvements.

## Validation matrix

| Contract | Required proof |
|---|---|
| Small source | Full validated body remains complete whenever mandatory metadata plus source fits; a large caller set truncates optional relationships first. |
| Large source | Required evidence is recovered across beginning/middle/end and repeated-branch fixtures; exact omissions are disclosed; a first-N-lines strategy fails the corpus. |
| Byte safety | Huge/minified line is never split, returns explicit bounded source-unavailable metadata, and cannot exceed the serialized response cap. |
| Determinism | The pure selector/composer produces byte-identical excerpt order and scoped continuation fingerprints across equivalent separate preparations. |
| Authority | Marker, seal, observation, and mutation changes fail fresh publication checks; a changed identity rejects only continuations whose effective domains include it. |
| Current source identity | Continuation uses a hash of descriptor-bound currently validated bytes, not the registry's index-time file hash alone. |
| Current path identity | Atomic replacement leaves the old descriptor readable but prevents its evidence from publication because current root-bound path identity no longer matches. |
| Domain-scoped continuation | A relationship-only change preserves source-only continuation and rejects relationship-bound continuation. |
| Relationship continuation | Static paging binds target, manifests, kind, direction, depth, limit, projection/confidence policy, and ordering; dynamic paging also binds every observed source input or is explicitly ineligible. |
| Source mutation | Mutation before publication or continuation yields stale/retry behavior, never mixed-generation evidence. |
| Continuation bounds | Oversized requested ranges remain inside the symbol and all source/line/serialized caps, with remaining omissions disclosed. |
| Evidence span | Root, file, symbol, source, generation, policy, or containment mismatch is ignored with a diagnostic. |
| Parent identity | Unique parent gets concrete ID; ambiguous/missing parent never gets an invented ID. |
| Empty graph | Reports bounded empty evidence, not “no callers.” |
| Suppression/truncation | Counts and limitations remain visible under total-response pressure. |
| Unsupported language/kind | Unsupported sections are explicit while supported source/identity remains usable. |
| Provenance | Static graph, dynamic fallback, and exact text items remain distinguishable; any later semantic experiment adds a distinct related-code class. |
| Provider economy | Every bounded-context v1 definition/implementation/call-context request uses zero embedding, vector, and rerank calls, including degraded/empty graph outcomes. |
| Budget pressure | Mandatory identity/authority/omission facts survive before optional siblings and relationships. |
| Version boundary | Exact-symbol requests require the literal `open_symbol.contractVersion: 2`; MCP input validation rejects missing/old/unsupported values before execution, and all accepted-v2 outcomes carry `formatVersion: 2` plus `kind: symbol_context`. |
| Input discrimination | Exact-symbol, direct-span, and ordinary read variants are strict and disjoint; mixed and unknown fields fail schema validation. |
| Exact-open replacement | Plain and annotated v2 exact-symbol requests return the same structured complete-or-bounded transport; the obsolete full-span branch is unreachable while ordinary and direct-span non-symbol reads are unchanged. |
| Mode semantics | V2 echoes `requestedMode`, but `plain` and `annotated` do not change the structured response representation. |
| Migration evidence | The prior response remains as a historical golden fixture, while tests prove it cannot be served by v2. |
| Resource limit | Very large source returns bounded success; only `minimumRequiredResponseBytes > hardResponseLimitBytes` returns the same structured MCP error in both modes, with no partial source content. |
| Emergency transport | The compact fixed-field error projection has a separately frozen canonical byte ceiling that always fits the MCP transport limit. |
| Streaming source | One root-bound descriptor is stable across metadata, hashing, inspection, and excerpt extraction; current path identity is rebound before publication; capability loss and source availability remain separate. |
| Continuation economy | Descriptor bytes read, hashing/selection time, operations, latency, and complete-file scans are recorded; total source bytes per completed task remain within the frozen 20% baseline allowance. |
| Completeness honesty | No path returns partial source marked or implied as a complete symbol. |

Focused package tests must precede MCP, Core, CLI, integration, typecheck,
build, lint, repository checks, controlled failure harnesses, live latency runs,
and paired native-versus-Satori evaluation. Record immutable Git and diff
identity for every benchmarked state.

## Completion standard

Return `BOUNDED SYMBOL CONTEXT COMPLETE` only when:

- the deterministic corpus and frozen safety contracts pass;
- small symbols are complete and large symbols are byte- and line-bounded;
- omitted source and relationship limitations are explicit;
- continuation requests are domain-scoped, current-source-bound, freshly
  authority-validated, and mutation-fenced;
- a failed descriptor or current-path identity check publishes no source
  excerpt or source continuation and requires fresh exact-symbol preparation;
- all bounded-context v1 composer requests use no providers, including
  unresolved call context;
- every exact-symbol request requires the literal
  `open_symbol.contractVersion: 2`, MCP input validation rejects old, missing,
  or unsupported versions before execution, and every accepted-v2 success or
  tool error carries `formatVersion: 2` and `kind: symbol_context`;
- the prior exact-symbol full-span response branch and compatibility code are
  removed while its historical golden fixture and migration rejection tests
  remain;
- oversized single-line source returns explicit bounded source-unavailable
  evidence without line splitting, and ordinary very large multi-line source
  returns bounded success;
- unsafe unrepresentable exact symbols fail through the mode-independent
  structured `resource_limit` MCP error only when the minimum required response
  exceeds the hard response limit, and never return partial content;
- quality, latency, provider work, response bytes/tokens, tool calls, and agent
  steps are measured against the adaptive baseline, together with descriptor
  source bytes, hashing/selection time, operations, and complete-file scans;
- the pinned smaller-model comparison has no deterministic correctness or
  safety regression, reduces primary median agent steps by at least 1 absolute
  or 20% relative, does not increase median tool calls, reduces median
  model-visible bytes by at least 20%, adds no provider calls, keeps median
  latency within 10%, and keeps nearest-rank controlled local p95 latency within
  20% of the adaptive baseline over at least 30 repetitions per workload under
  the frozen warm-up, outlier, identity, and interleaving policy, while total
  source bytes read per completed task remain within 20% of baseline; and
- the tested tree and diff have immutable identities.

Until those conditions are met, this remains a measured follow-on plan. The
current search-quality program should not claim this future composed context
surface as already implemented.

## Continuation checkpoint

The next session should begin with Phase 0, not production schema work:

1. Confirm the worktree and current six-tool names are unchanged.
2. Add the deterministic small/large/minified/graph-state fixtures and adaptive
   baseline recorder.
3. Record the unchanged baseline artifact with immutable tree/diff identity.
4. Implement only Phase 1 after the baseline exists.

No production code was changed while writing this plan because the review did
not prove a current correctness or reproducibility defect.
