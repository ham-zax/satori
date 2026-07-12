# 2026-07-12 Review Claims Verification

## Scope

This report began by revalidating the supplied review claims against `HEAD`
`2a7a50cb896940a2d530d852fdf8eca1fe656958`. It now also records the remediation
implemented in the current uncommitted worktree and the follow-up generation,
policy, navigation, filesystem, and snapshot reviews.

`Verified open` means that the defect exists on this baseline. It does not mean
that the defect has been fixed. Unverified, superseded, unreachable, or purely
theoretical claims are omitted from the open list.

Priority meanings in this report:

- `P0`: release-blocking lifecycle or data-preservation failure.
- `P1`: high-impact trust-boundary or cross-root correctness failure.
- `P2`: material correctness, determinism, availability, or privacy defect.
- `P3`: bounded correctness or diagnostic debt worth fixing after P0-P2.

## Verdict

The original verified findings and the confirmed portions of the follow-up
reviews are remediated in the current worktree. Publication remains a staged
multi-artifact protocol, but no artifact is independently authoritative:
runtime activation requires one matching collection-marker-policy-navigation
tuple and fails closed on interruption or disagreement. Policy publication and
removal now return typed receipts; a post-commit acknowledgement failure cannot
be mistaken for an uncommitted mutation by background cleanup.

## Initial Verified Findings

The following table records the defects reproduced on the original baseline.
They are historical findings, not the current open-defect list; their fixes and
proofs are summarized in the follow-up sections below.

| ID | Priority | Owning boundary | Verified behavior |
| --- | --- | --- | --- |
| V1 | P0 | MCP index lifecycle | A successful sync erases the snapshot fields used to preserve the last complete generation, so a later partial reindex can publish the partial candidate and prune the complete collection. |
| V2 | P1 | Core index policy | Per-create custom extensions and ignore patterns mutate process-global `Context` state and leak into unrelated roots. |
| V3 | P1 | SQLite navigation cache | Direct SQLite reads accept malformed symbol/relationship rows and truncated symbol tables as `ok`. |
| V4 | P2 | Search front door | Freshness can be measured for one tracked root and returned for a different post-freshness root. |
| V5 | P2 | Search finalization | A watcher-touch failure converts already-computed search results into an error response. |
| V6 | P2 | Live exact-path recovery | Whole-token queries can return substring-only false positives. |
| V7 | P2 | Index batching | Invalid `EMBEDDING_BATCH_SIZE` disables bounded batching. |
| V8 | P2 | Full-index traversal | Unsorted filesystem traversal makes limited-index membership nondeterministic. |
| V9 | P2 | Incremental progress | A modified file advances progress twice against one work unit and reports 200%. |
| V10 | P2 | Relationship construction | Same-line call sites collapse into one relationship and lose byte/column precision. |
| V11 | P2 | Tree-sitter symbol ownership | Java enum methods lose enum ownership and Scala class methods remain functions. |
| V12 | P2 | Embedding boundary | `embedBatch()` results are consumed without count, shape, dimension, or finiteness validation. |
| V13 | P2 | Search diagnostics | Default logs contain complete user queries and embedding samples. |
| V14 | P3 | Chunking options | `NaN` or infinite overlap values can truncate coverage or amplify chunk production. |
| V15 | P3 | Search path normalization | Absolute paths are silently rewritten as relative paths and dot/duplicate-separator forms are not canonicalized. |
| V16 | P3 | Noise remediation hint | One ignored noisy file can produce a claim that the top noisy files are already covered. |
| V17 | P3 | Partial-index reporting | A partially indexed file is counted as processed and the terminal progress phase says indexing completed. |

### V1 - Sync defeats complete-generation preservation

**Evidence**

- `packages/mcp/src/core/snapshot.ts:1605` replaces an `indexed` record with a
  `sync_completed` record that omits `indexStatus`, `indexedFiles`, and
  `totalChunks`.
- `packages/mcp/src/core/sync.ts:756` performs that transition after an ordinary
  successful sync.
- `packages/mcp/src/core/manage-indexing-handlers.ts:1260` derives
  `previousCompleteGeneration` only when those three snapshot fields exist. It
  does not inspect the completion marker unless the snapshot-derived candidate
  first succeeds.
- With no previous candidate, a `limit_reached` result is published at line
  1415 and collection-family pruning runs at line 1480.
- The preservation test in
  `packages/mcp/src/core/manage-indexing-handlers.test.ts:786` injects an
  indexed-shaped `previousIndexedInfo`; it does not exercise the normal
  `indexed -> sync_completed -> reindex` transition.

A direct `SnapshotManager` transition reproduced the missing proof:

```json
{
  "status": "sync_completed",
  "collectionName": "collection_old",
  "fingerprintSource": "verified"
}
```

**Impact**

`complete index -> successful sync -> force reindex -> limit_reached` can
replace and retire the last complete generation. The new partial generation is
searchable only with partial-index warnings, while the complete fallback has
been destroyed.

**Required invariant and proof**

Derive previous-generation authority from the active completion proof
independently of lossy display state, or preserve complete-generation proof in
`sync_completed`. Add an end-to-end regression for the exact transition above
and assert that the old proven collection, marker, navigation generation, and
readiness remain active.

### V2 - Per-create policy leaks across roots

**Evidence**

- `packages/mcp/src/core/manage-indexing-handlers.ts:687` and line 692 apply
  request options through rootless `Context` mutation methods.
- `packages/core/src/core/context.ts:1769` appends ignore patterns to the global
  `runtimeCustomIgnorePatterns` array and rebuilds all root ignore states.
- `packages/core/src/core/context.ts:3544` appends extensions to the global
  `runtimeCustomExtensions` array; line 2021 includes that array in every
  root's supported-extension policy.

A two-root reproduction applied `.foo` and `private/**` for root A. Root B then
also accepted `.foo` and ignored `private/**`.

**Impact**

One public `manage_index create` request can silently change indexing, sync,
and search coverage for every other repository in the MCP process. A broad
ignore such as `src/**` can suppress another root's runtime source.

**Required invariant and proof**

Store custom policy overlays by canonical root and persist them with that
root's index policy. Add a two-root test proving create options for A do not
change extension or ignore decisions for B, including after sync and restart.

### V3 - SQLite accepts corrupt navigation as ready

**Evidence**

- `packages/core/src/navigation/sqlite.ts:299` reconstructs `SymbolRecord`
  values without the canonical sidecar validator.
- Line 342 reconstructs relationship records without validating type,
  confidence, target presence, path membership, or span ordering.
- The files table is compared with manifest metadata, but the actual symbols
  selected at line 504 are not counted against each manifest file's
  `symbolCount`.

Direct database corruption produced all of these `status: "ok"` results:

- A symbol with kind `invalid`, file `../escape.ts`, and span `-4..0`.
- A relationship with type `INVALID`, confidence `certain`, no target, and span
  `-2..0`.
- A manifest claiming one symbol after all symbol rows were deleted; the store
  returned zero symbols as `ok`.

The runtime's initial JSON/SQLite parity check lowers normal occurrence, but it
does not make direct SQLite reads self-validating. Cached parity is keyed by
unchanged manifests, so later row corruption can be served without another
parity pass.

**Required invariant and proof**

Share the JSON runtime validators with SQLite, validate every reconstructed
row, verify manifest membership/hash/language, and reconcile actual per-file
and total symbol counts. Regression tests must mutate each row class and prove
that direct SQLite reads return `incompatible`.

### V4 - Freshness can be attributed to the wrong root

`packages/mcp/src/core/search-frontdoor.ts:264` runs freshness against the
initial root. Lines 278-292 can then select a different, more-specific root,
while line 300 returns the original freshness decision. A two-root reproduction
measured root A, selected nested root B afterward, and returned A's `fresh`
decision and timestamp for B. If root identity changes, rerun freshness for the
new root with a bounded retry or pin the original root generation. Prove that
the returned root and freshness source are always identical.

### V5 - Watcher maintenance can discard successful search results

`packages/mcp/src/core/handlers.ts:2629` and line 2742 await watcher maintenance
after exact and normal search success. The outer search catch converts a watcher
exception into a failed response. A reproduction returned one semantic result,
then threw `watch boom`; the public result became `not_ready` with an empty
result list. Make post-search watcher touch best effort, as indexing and repair
already do, and test both successful result paths with a failing watcher.

### V6 - Exact-path live recovery emits substring false positives

`packages/mcp/src/core/search-query-support.ts:319` admits a file when
`lowerContent.includes(term)`. The result is still emitted when exact lexical
line selection finds no whole-token match. Query `path:src/a.ts auth` against
`const author = true;` reproduced a result even though the plan classified
`auth` as a whole-token term. Require the shared lexical scorer/token-boundary
match before publication and test positive and substring-only cases.

### V7 - Invalid embedding batch size disables batching

`packages/core/src/core/context.ts:2047` computes
`Math.max(1, parseInt(raw, 10))`. For `EMBEDDING_BATCH_SIZE=abc`, the result is
`NaN`; the threshold at line 2119 is therefore never true. A 205-chunk
reproduction called `embedBatch()` once with all 205 chunks rather than
`100, 100, 5`. Parse a positive safe integer, use 100 for invalid values, impose
an internal maximum, and test invalid, zero, negative, and oversized values.

### V8 - Full-index traversal is nondeterministic

`packages/core/src/core/context.ts:1991` consumes raw `readdir()` order and
returns the accumulated files without a final sort. Because indexing stops at
the 450,000-chunk limit, directory enumeration order changes which files enter
a `limit_reached` generation. Sort entries and the final normalized file list
with the contract comparator. A regression should feed different enumeration
orders and prove identical payload membership and marker statistics.

### V9 - Modified-file progress reaches 200%

`packages/core/src/core/context.ts:1148` counts each changed file once. A
modified file advances at line 1197 after deletion and again at line 1224 after
insertion. One modified file reproduced `current: 2`, `total: 1`, and
`percentage: 200`, followed by a terminal regression to 100%. Count actual work
units or advance once per complete file operation, then assert monotonic
progress, `current <= total`, and a percentage within 0-100.

### V10 - Same-line call relationships collapse

`packages/core/src/relationships/builder.ts:28` keys relationships by start line
only, and line 202 reduces byte/column-aware evidence to `{startLine, endLine}`.
Two `foo()` calls on one line with distinct byte spans reproduced one persisted
relationship. Preserve the complete evidence span and include its complete
identity in deduplication and ordering. Prove two same-line calls remain two
deterministically ordered records.

### V11 - Enum and Scala method ownership remains incorrect

`packages/core/src/language-analysis/tree-sitter-adapter.ts:194` does not treat
enums as declaration containers, and the Scala mapping at line 59 classifies
every `function_definition` as `function`. Direct analysis reproduced a Java
enum method `E.run` as unowned `run` and a Scala class method `Service.run` as a
function. Add enums to semantic containers and classify Scala definitions under
class/trait/object containers as methods, with exact ownership tests.

### V12 - Embedding batch output is not validated

`packages/core/src/core/context.ts:3254` accepts `embedBatch()` output and later
indexes by input position without verifying one finite vector of the configured
dimension per chunk. Short output fails later with an opaque access error,
extra output is ignored, and malformed vectors can reach the backend. Validate
the complete batch before constructing any document and test short, extra,
wrong-dimension, non-array, `NaN`, and infinite results.

### V13 - Default diagnostics expose query text and embeddings

`packages/mcp/src/core/handlers.ts:2534` logs the full public query.
`packages/core/src/core/context.ts:1424`, lines 1458-1461, and line 1480 log the
query again and the first five embedding values. The passing MCP suite itself
reproduced these diagnostics on normal search paths. Log query length/hash and
retrieval metadata by default; permit full text only behind an explicit
sensitive-debug option. Add log-capture tests proving default output omits both
query text and vector values.

### V14 - Non-finite overlap breaks chunking

`packages/core/src/language-analysis/chunks.ts:106` validates `chunkSize` but
allows `NaN` and `Infinity` through overlap normalization. With 6,000 input
bytes and `chunkSize=2500`, `NaN` produced one chunk covering only 2,500 bytes;
`Infinity` produced 3,501 chunks totaling 8,752,500 chunk bytes. This is a
programmatic option defect, not the normal MCP default. Require a finite,
nonnegative, bounded overlap and test both non-finite values.

### V15 - Search-relative paths are not canonicalized strictly

`packages/mcp/src/core/search-query-support.ts:213` strips leading slashes
before checking whether a path is absolute and does not run POSIX
normalization. Direct results included `/etc/passwd -> etc/passwd`, preserved
`src/./service.ts`, and preserved `src//service.ts`. This is not a demonstrated
host-file escape; it is a strict repo-relative contract and identity defect.
Reject absolute POSIX/Windows/UNC paths before transformation, normalize dot
and separator forms, reject traversal, and test canonical equivalence.

### V16 - Noise hint overstates `.gitignore` coverage

`packages/mcp/src/core/search-query-support.ts:1010` sets
`coveredByRootGitignore` with `some()`. When one of five observed noisy files was
ignored, the generated next step still said the top noisy files appeared
already covered. Compute complete observed-set coverage, or report partial
coverage explicitly. Test zero, partial, and complete coverage.

### V17 - Partial-index statistics and progress are misleading

`packages/core/src/core/context.ts:2142` increments `processedFiles` even when
the chunk limit interrupted that file. `indexCodebase()` then emits `Indexing
complete!` and 100% at line 970 for `limit_reached`. The readiness status itself
remains partial, so this is reporting rather than readiness corruption. Count
only fully persisted files and emit a distinct terminal partial phase; extend
the existing partial-index test to assert file counts and progress wording.

## Closed Or Rejected Claims

| Current change | Current conclusion |
| --- | --- |
| `43cadb6` | Closed: semantic search no longer falls back to unproven collections; active resolution enforces runtime fingerprints and exact payload proof; full indexing reconciles stale payload; marker maintenance is default; publication is tied to the indexed snapshot; chunk IDs and file-local chunk indices are stable; marker numbers are strictly validated. |
| `58d75ff`, `b2b09e6` | Closed: symbol and relationship evidence is complete before publication; navigation uses one staged generation and atomic pointer; source hashes, shard membership/counts, canonical symbol kinds, relationship coverage, and fenced clearing are validated. SQLite is tied to the active generation. V3 is row-level self-validation, not stale-generation selection. |
| `e2134a9`, `e10a359` | Closed: Tree-sitter uses ESM-safe module paths and UTF-8 byte spans; direct/member/constructor calls are distinguished; Python plain imports/nested functions and C++ qualified methods are handled; synchronizer hashing uses stable handles; snapshots and expanded fingerprints are validated; prepared checkpoint publication is mutation-fenced. V11 is the remaining ownership subset. |
| `9222a4a`, `2a7a50c` | Closed in the covered paths: partial recovery status and full fingerprints are preserved; local readiness requires proof; mutation capabilities and persistence fail closed; staged publication preserves a previous complete generation when the snapshot still carries its proof. V1 is the untested normal-sync exception. |
| `deab6d8` | Closed: tracked/live lexical reads use root-bound regular-file opens and reject symlink escape. |
| Current six-tool surface | Rejected as stale: arbitrary host access through `read_code`; that tool is not registered. `read_file` is tracked-root constrained, size bounded, and symlink/`..` escape tested. |
| Current public schemas | Rejected as stale: fractional or unbounded public search limits. The registered `search_codebase` schema requires a positive integer and applies the capability maximum. |
| Current MCP bootstrap | Closed for protocol integrity: diagnostic output no longer corrupts stdout framing. V13 remains a privacy issue because sensitive content still reaches diagnostics. |
| Context relative-path deletion claim | Rejected as a demonstrated filesystem traversal: the reachable caller uses internally tracked paths in an escaped vector filter, not a filesystem join. V15 is a separate strict search-path contract defect. |
| Malformed ignore-rule claim | Omitted: tested string patterns did not produce a reachable matcher-construction failure, so the supplied fail-open/fail-closed allegation was not reproduced. |

## Verification

- Worktree was clean before this document was added.
- `pnpm --filter @zokizuan/satori-core test`: 284 passed, 0 failed.
- `pnpm --filter @zokizuan/satori-mcp test`: 724 passed, 0 failed.
- Focused current-HEAD reproductions covered V1-V7, V9-V11, and V13-V16.
- Focused synchronizer/root-bound/Merkle tests: 28 passed.
- Focused JSON/SQLite/runtime navigation tests: 23 passed.
- Focused relationship-builder tests: 12 passed.
- Focused language-analysis tests: 41 passed.
- No provider-backed create, reindex, repair, sync, or clear operation was run.

The green suites establish regression stability for covered behavior; they do
not close a reproduced claim when the necessary transition or malformed input
is absent from the suite. In particular, no existing test covers V1's
`indexed -> sync_completed -> limit_reached reindex` sequence.

## Fix Order

1. V1: preserve the last complete generation across sync and partial reindex.
2. V2-V3: restore root-scoped policy ownership and fail-closed SQLite reads.
3. V4-V6: make search freshness/finalization/exact-path recovery trustworthy.
4. V7-V13: restore bounded resource use, determinism, navigation precision,
   analyzer ownership, provider validation, and log privacy.
5. V14-V17: close bounded option, path, hint, and partial-reporting defects.

## Follow-up remediation plan

The implementation sequence for the generation-bound follow-up reviews is:

1. Prove the accepted-generation read boundary before changing publication:
   collection payload, v2 marker, runtime fingerprint, persisted policy,
   navigation generation ID, and both manifest hashes must agree.
2. Make `resolveProvenGeneration()` the sole rollback authority and return the
   exact persisted policy sealed to that generation.
3. Preserve staged navigation and policy candidates until final acceptance;
   treat interrupted publication as unavailable rather than mixing artifacts.
4. Make policy persistence ordered, complete, reloadable across Context
   instances, and rollback-safe when fenced publication does not return a
   successful receipt.
5. Give ignore control files the same bounded, descriptor-stable,
   pathname-identity proof used for indexed source files, with a strict
   final-component no-symlink rule.
6. Make legacy completion-marker classification reachable through the real
   Context-backed validation path without weakening v2 exact-payload proof.
7. Canonicalize snapshot lifecycle tokens and prove both stale-writer rejection
   and valid metadata-only persistence.
8. Run Core, MCP, CLI, integration, typecheck, lint, versions, and diff checks;
   do not commit or alter pre-existing staging.

## Follow-up review dispositions

### Accepted-generation identity

- **Partially confirmed and fixed:** `resolveActiveIndexedCollection()` already
  compared the actual current navigation generation ID and both manifest
  hashes, so marker B plus navigation A was not searchable as claimed. A
  narrower race remained if the pointer changed between active resolution and
  `resolveProvenGeneration()`'s second read. The second read now repeats all
  three navigation identity checks and fails closed.
- **Confirmed and fixed:** rollback no longer recomputes `previousPolicy` from
  mutable `.gitignore`, `.satoriignore`, or `satori.toml`. The proven-generation
  tuple returns a cloned copy of the exact persisted accepted policy, and MCP
  restores that sealed object.
- **Rejected as a required redesign:** a second active-generation pointer is
  not required for correctness. Marker, policy, and navigation remain staged
  durable candidates; the existing active resolver is the authoritative read
  gate and accepts only a fully matching tuple. A crash between publications
  produces fail-closed unavailability, not split-brain searchability.

### Policy ordering, publication, and cache coherence

- **Confirmed and fixed:** ordered ignore rules are no longer deduplicated.
  Repeated rules around negation survive resolution, persistence, activation,
  and restart in contract order.
- **Confirmed and fixed:** the complete resolved policy includes custom rules,
  root ignore-file rules, effective rules, profile, extensions, and generation
  binding. Context policy reads reload the durable document, so a long-lived
  instance observes another process's accepted publication.
- **Confirmed and fixed:** policy publication restores the previous in-process
  state only when activation or durable replacement fails before the rename
  completes. Once the replacement completes, a later wrapper failure does not
  perform an unfenced durable rollback; the published file and runtime state
  remain consistent and cannot overwrite a newer publisher's file.
- **Rejected as an external contract defect:** `publishResolvedIndexPolicy()`
  is an internal lifecycle primitive, not an MCP tool or independent source of
  search authority. Its binding can only activate search when marker, payload,
  runtime fingerprint, and actual navigation pointer independently match.

### Filesystem observation

- **Confirmed and fixed:** ignore files use bounded exact descriptor reads,
  compare descriptor identity/size/mtime/ctime after the read, then reopen the
  pathname and require the same device/inode.
- **Confirmed and fixed:** policy control files use `O_NOFOLLOW` on the final
  pathname and reject even inside-root final-component symlinks. Intermediate
  escapes remain rejected by the root-bound descriptor layer.
- Source reads and ignore reads are byte-capped before allocation; raw ignore
  contents are not logged.

### Marker migration and snapshot metadata

- **Confirmed and fixed:** Core now exposes a validation-only marker reader.
  It returns a proven v2 marker when available and otherwise exposes only a raw
  stored v1 marker for typed `legacy_policy_unsealed` classification. Malformed
  v2 data does not bypass exact proof.
- **Partially confirmed and fixed:** metadata setters do not mutate lifecycle
  `lastUpdated`, so the claimed positive-write loss was not reproduced.
  Lifecycle-token serialization is nevertheless canonical now, and a positive
  call-graph metadata save/reload test complements the stale-writer test.

### Previously raised items confirmed closed

- SyncManager forwards `indexedFiles`, `totalChunks`, and `indexStatus` through
  its real `SyncStats` object to `setCodebaseSyncCompleted()`.
- Completion markers use the incompatible-schema-safe
  `satori_index_completion_v2` kind.
- Navigation rollback republishes manifest-derived generation metadata rather
  than fabricated zero counts.
- Profile resolution occurs inside `resolveIndexPolicyForCodebase()`.
- Freshness/root rebinding uses a bounded identity loop and returns readiness
  for the rebound root.

## Added deterministic proofs

- Proven generation returns the persisted old policy after `.gitignore`
  changes and after Context restart.
- A navigation pointer changed after active resolution makes
  `resolveProvenGeneration()` return `null`.
- Candidate policy publication followed by navigation-pointer failure restores
  the previous collection policy.
- Duplicate ignore rules around a negation preserve exact order through
  restart.
- A long-lived Context reloads a policy published by another Context.
- A long-lived Context accepts a newly published profile-bound generation on
  its first active-resolution read without mixing stale and reloaded inputs.
- A publication wrapper throwing after a completed `publish()` returns a typed
  committed receipt, leaves durable and runtime state consistent, preserves
  candidate artifacts in the background handler, and cannot trigger an
  unfenced stale rollback over a newer publication.
- Ignore-file final symlinks and post-read pathname replacement are rejected.
- A stored v1 marker reaches `legacy_policy_unsealed` through the real Context
  reader.
- Metadata-only call-graph updates survive save and reload for an unchanged
  lifecycle generation.

## Follow-up Remediation Plan (Current Worktree)

This section supersedes the earlier fix order for the current staged worktree.
The original findings above remain as historical evidence for their reviewed
baseline; they must not be read as the current open-defect list.

### Boundary and invariants

- Keep the fixed six-tool MCP surface unchanged.
- Treat vector payload, navigation generation, custom index policy, completion
  proof, and snapshot lifecycle as one accepted index generation. A rejected
  candidate must not change the policy or metadata of the previous generation.
- A previous generation may be restored only after live proof validates its
  collection, exact payload count, runtime fingerprint, completion status, and
  navigation generation.
- Every full-index source read must come from a regular-file descriptor opened
  inside the canonical repository root. Directory-scan pathnames are discovery
  hints, not content authority.
- Persisted snapshots, policy documents, and SQLite navigation caches must fail
  closed on malformed, internally inconsistent, or content-incompatible state.
- Default diagnostics must not expose reversible identifiers for user queries.

### Implementation slices

1. **Stage and patch custom policy.** Replace complete-array assignment with an
   optional-field update contract, retain omitted fields, add explicit per-field
   reset semantics, and defer persistence/runtime activation until the staged
   index generation is accepted. Bind the published policy document to a
   versioned digest and the accepted collection/navigation generation.
2. **Restore lifecycle safely.** On foreground reindex launch failure, restore
   the previous lifecycle only after the live completion proof matches it.
   Strengthen rollback proof resolution to validate runtime fingerprint and the
   active navigation pointer. Do not retain candidate call-graph metadata when
   rolling back to the previous generation.
3. **Secure full-index reads.** Read, hash, classify, analyze, and chunk each
   discovered source file through the root-bound descriptor layer, rejecting
   pathname replacement or symlink escape before provider calls.
4. **Seal persisted state.** Add canonical symbol and relationship row digests
   to SQLite and verify them on every read. Reject partially supplied sync
   completion proof, validate `totalChanges` against its components, and bind
   metadata-only overlays to an explicit lifecycle generation token.
5. **Remove query fingerprints and close freshness rebinding.** Replace raw
   unsalted query hashes with process-scoped opaque request IDs. Re-resolve root
   identity before returning a freshness-blocked response and rerun freshness
   once for a rebound root.

### Test-first proof

- Policy tests: ignore-only and extension-only updates retain the omitted field;
  explicit resets clear only their target; failed/partial staged reindex leaves
  the previous runtime and persisted policy unchanged; successful acceptance
  publishes the candidate policy identity.
- Lifecycle tests: foreground launch failure preserves a live-proven previous
  index; mismatched fingerprint/navigation proof cannot authorize rollback;
  candidate metadata cannot attach to a restored generation.
- Filesystem test: replace a discovered file with an outside-root symlink before
  its full-index read and prove that no embedding/vector write observes it.
- SQLite tests: mutate otherwise valid symbol and relationship rows without
  changing counts and require `incompatible`.
- Snapshot tests: reject incomplete/invalid explicit proof and inconsistent
  persisted `totalChanges`; reject metadata overlay across distinct lifecycle
  tokens.
- Search tests: default logs contain neither raw queries nor deterministic query
  digests; a root change during a blocked freshness decision is rebound before
  the response is finalized.

### Verification gates

Run the smallest focused tests during each slice, followed by:

```bash
pnpm --filter @zokizuan/satori-core test
pnpm --filter @zokizuan/satori-mcp test
pnpm run typecheck
pnpm run lint
```

No provider-backed lifecycle operation and no commit is part of this plan.

## Follow-up Generation/Policy Review (Current Uncommitted Worktree)

This section records the disposition of the later generation-bound policy,
navigation, and filesystem review. It supersedes that review's static verdict;
the historical findings above still describe their original baselines.

### Claim disposition

| Supplied claim | Disposition | Current result |
| --- | --- | --- |
| Candidate policy can make vector generation B active while navigation still points to A | Rejected as stated | Active collection resolution reads the actual navigation pointer and requires its generation ID, symbol manifest hash, and relationship manifest hash to match the completion marker. The described crash state is rejected rather than exposed as searchable. |
| File-based ignore policy is not installed or persisted | Confirmed and fixed | `ResolvedIndexPolicy` now carries the complete file-based and effective policy; the v2 persisted policy reloads and installs the same inputs after restart. |
| Navigation rollback republishes zero counts | Rejected as a runtime defect | Navigation `current.json` has no count fields and the publisher did not serialize the fabricated adapter values. The misleading fields were removed from the restoration input. |
| Rollback authorization does not prove one navigation/policy/vector tuple | Confirmed and fixed | `resolveProvenGeneration()` now returns the exact active collection marker and matching current navigation tuple. Foreground and background rollback use that result instead of independent marker and pointer reads. |
| Policy persistence and runtime activation are outside one fence | Confirmed and fixed | The durable rename and in-memory activation now run inside the same exactly-once fenced publication callback. |
| Full-file descriptor reads can allocate through concurrent growth | Confirmed and fixed | Full-index and ignore-file reads use an exact-size descriptor helper capped at the observed byte count plus growth detection. Short reads and growth fail closed. |
| Ignore-file resolution follows outside-root symlinks, is unbounded, and logs raw rules | Confirmed and fixed | Root ignore files must be root-contained regular files, symlinks are rejected, reads are capped at 1 MiB, and MCP logging reports only rule count plus a short policy identity. |
| Blocked freshness can return an old-root decision | Confirmed and fixed | Search freshness now uses a bounded two-pass root-identity loop, returns rebound readiness when non-ready, and rejects a second identity change. |
| Incremental completion counts are not forwarded by `SyncManager` | Rejected as stale | The real call already forwards the complete `reindexByChange()` stats object to `setCodebaseSyncCompleted()`. |
| Completion marker changed incompatibly without a schema bump | Confirmed and fixed | Current proof uses `satori_index_completion_v2`; v1 proof is classified explicitly as `legacy_policy_unsealed` and requires reindex. |
| Tree-sitter `startIndex`/`endIndex` are UTF-8 byte offsets | Rejected for the actual runtime binding | Direct `web-tree-sitter` measurement after a Unicode prefix returned UTF-16 index 14 for a declaration whose UTF-8 byte offset was 21. `spanFromUtf16()` is the required conversion; Unicode fixtures prove exact byte slices and UTF-16 columns across Python, Go, Rust, Java, C#, C++, and Scala. |
| Policy resolution depends on external profile-load ordering | Confirmed and fixed | `resolveIndexPolicyForCodebase()` loads the repository profile itself before deriving extensions and the policy hash. |
| Policy publication accepts malformed bindings or unrelated hashes | Partially confirmed and fixed at the reachable boundary | Publication rejects empty collection bindings, malformed navigation IDs, and policy hashes inconsistent with effective inputs. Active resolution independently proves collection payload, marker, policy binding, and navigation identity before use. |
| Snapshot-derived metadata can cross lifecycle generations | Confirmed and fixed | Pending metadata carries the lifecycle token observed at mutation time and is discarded when persisted lifecycle authority changed. |
| Policy digest is authenticity proof | Rejected | The digest is a consistency seal, not an authenticity mechanism. Validation now also enforces field shapes, policy hash format and derivation, nonempty collection binding, navigation ID format, and effective-input consistency. |
| Ignore-file discovery order is filesystem-dependent | Rejected for the current contract | The v1 policy reads only root `.satoriignore` then root `.gitignore` in an explicit order; no directory enumeration participates. |

### Publication invariant

The implementation deliberately retains immutable candidate artifacts plus
separate durable publications. This is not presented as a multi-file atomic
transaction. Safety comes from the read gate: a candidate is not active unless
the vector marker, exact payload proof, runtime fingerprint, published policy
binding, actual navigation pointer, and both navigation manifest hashes all
agree. An interrupted publication can therefore make the index temporarily
unavailable, but it cannot produce the split-brain searchable generation
claimed by the review. A new active-generation file was not added because it
would duplicate the existing navigation pointer authority without proving a
reachable correctness defect.

### Added proof

- Policy tests cover real `.gitignore` publication, active ignore state,
  restart reload, first-read cross-process profile replacement, malformed
  policy rejection, optional-field preservation, and explicit reset behavior.
- Root-bound filesystem tests cover exact-length reads, growth, short reads,
  symlinked ignore files, and oversized ignore files.
- Lifecycle tests cover proven-generation rollback and legacy v1 completion
  proof classification.
- Search-frontdoor tests cover ready-root rebound, non-ready rebound, and
  repeated root instability.
- Snapshot tests cover metadata overlay rejection across lifecycle tokens.

### Verification

- `pnpm --filter @zokizuan/satori-core test`: 320 passed, 0 failed.
- `pnpm --filter @zokizuan/satori-mcp test`: 744 passed, 0 failed.
- `pnpm --filter @zokizuan/satori-cli test`: 112 passed, 0 failed.
- `pnpm run test:integration`: 30 passed, 0 failed.
- `pnpm run typecheck`: passed for core, MCP, and CLI.
- `pnpm run lint`: passed for core, MCP, and CLI.
- `pnpm run versions:check`: passed.
- `git diff --check`: passed.
- No provider-backed lifecycle operation was run and no commit was created.

## Policy Authority, Cache Coherence, and Publication Receipt Review

This section records the final supplied review. It distinguishes reachable
defects from recommendations that did not demonstrate a contract violation.

| Supplied claim | Disposition | Current result |
| --- | --- | --- |
| A committed policy publication is reported as an ordinary failure | Confirmed in a narrower reachable form and fixed | The production mutation coordinator holds the root lock through its synchronous callback and has no post-callback lease check, so the review's ownership-transfer sequence cannot occur through `publishWhileCurrent()`. A post-rename exception or another supported wrapper can still produce an ambiguous acknowledgement. Publish now returns a typed receipt and throws `IndexPolicyPublicationError` with `committed=true` and that receipt after a durable commit. Background indexing preserves candidate vector/navigation artifacts and performs no destructive cleanup in this state. |
| Policy removal has the same ambiguous acknowledgement | Confirmed and fixed | Removal returns the same typed receipt model, including the previous document token, and reports a committed removal distinctly when a wrapper throws after invocation. |
| `indexCodebase()` accepts a resolved policy from another root | Confirmed and fixed | `indexCodebase()`, expected-chunk reconstruction, and navigation generation construction reject a policy whose canonical root differs from the operation root before collection or policy mutation. Tests prove neither root is mutated. |
| Direct Context indexing has hidden publication semantics | Partially confirmed and clarified | The method contract now states that ordinary calls build and publish the complete generation, while `deferFullIndexPublication` leaves publication to the staged-generation owner. Production callers were audited: MCP background indexing uses deferred publication and the Core fallback intentionally uses complete publication; no duplicate production policy publisher remains. |
| Invalid-v2 evidence reports an invented payload mismatch | Confirmed and fixed | Core evidence is intentionally coarse (`invalid_v2`); it no longer labels every parseable but unproven marker as `payload_mismatch`. MCP retains its public fail-closed `invalid_payload` lifecycle reason. |
| An orphan staged v2 marker can mask the base legacy v1 marker | Confirmed as diagnostic debt and fixed | Marker evidence uses deterministic collection authority: a published policy binding first, then active/base families, then staged family debris. A base v1 marker now yields `legacy_policy_unsealed` even when an unrelated staged v2 marker remains. |
| Descriptor capability failure occurs after collection mutation | Confirmed and fixed | `assertDescriptorBoundIndexingSupported()` runs at both direct full-index entry and collection-preparation entry before vector creation, marker clearing, or navigation staging. The error names the missing Linux descriptor capability and platform. |
| Policy cache performs synchronous metadata I/O on active reads | Bounded performance observation, not remediated | Token caching already prevents JSON parsing, policy activation, and matcher rebuilding when the file is unchanged. No latency or throughput defect was demonstrated, so this patch does not add polling infrastructure or duplicate revision state. |
| Parallel policy maps should be consolidated | Design recommendation, not a verified defect | Active and proven-generation resolution already checks the complete policy, binding, compatibility, marker, and navigation tuple. A broad state-model refactor would add risk without changing a demonstrated outcome. |

### Receipt and boundary proofs

- Existing-generation and first-generation handler tests force policy commit
  followed by acknowledgement failure and prove that candidate collections are
  not deleted, navigation candidates are not discarded, old policy is not
  blindly restored, and no false terminal snapshot is published.
- Core tests prove both publish and clear expose committed receipts after a
  post-callback exception.
- Cross-root policy tests fail before either collection or durable policy is
  mutated.
- Completion-proof tests cover both invalid-current-v2 precedence and the
  inverse case where orphan staged v2 debris must not mask the base v1 marker.
- Descriptor capability has an explicit unit proof and is invoked before both
  direct and MCP-preparatory collection mutation paths.
