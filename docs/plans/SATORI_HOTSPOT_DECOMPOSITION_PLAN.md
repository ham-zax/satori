# Satori Hotspot Decomposition Roadmap

Date: 2026-08-12

Baseline repository: `/home/hamza/repo/satori`

Original baseline implementation: `6a5ee87680ccc09fc08ef5fe739fb0398e3b9401`

Source review: `docs/plans/SATORI_HOTSPOT_DECOMPOSITION_REVIEW.md`

Status: master roadmap. No implementation is authorized by this document. Each
implementation batch requires a fresh, bounded batch sheet derived from its current
HEAD; this document must not be executed continuously as one change.

## Execution checkpoint

Checkpoint HEAD: `bcc2460`

Completed ownership-bounded batches:

- Phase 0.2 / F024: `e56c973`;
- Phase 0.3 / F023: `83fb255`;
- Phase 1.1 / root gitignore matcher cache: `f70f972`;
- Phase 1.2 / pure sidecar validators: `7932fa8`.
- Phase 1.3 / stateless synchronizer snapshot codec: `9f77131`;
- Phase 1.4 / CLI install boundaries: `cec0d14`;
- Phase 2.1 / complete sidecar read boundary: `06bb5db`;
- Phase 2.2 / synchronizer scan boundary: `6bde22a`;
- Phase 2.3 / extract the Python relationship-resolution engine: `4389fe0`;
- Phase 2.4 / complete sidecar write/lifecycle decomposition: `c43ff1a`;
- Phase 3.1 / IndexPolicyRuntimeService ownership: `e665659`;
- Phase 3.2 / IndexPolicyDocumentStore ownership: `9cd239e`;
- Phase 3.3 / durable restore-transaction mechanics: `4db73b0`;
- Phase 4.1 / generation authority contract freeze: `1106ff4`;
- Phase 4.2 / proof state behind IndexAuthorityCoordinator: `c5806b7`;
- Phase 4.3 / publication/read/retention gate ownership: `9091a26`;
- Phase 4.4 / activation/rollback/retention/restore authority decisions: `9f96970`;
- Phase 4.5 / IndexGenerationWorkflow repair and full-index orchestration: `60a142e`;
- Phase 4.6 / SynchronizerRegistry synchronizer lifecycle ownership: `ca15dfe`;
- Phase 5.1 / SourceFreshnessPort read-facing source readiness: `5032875`;
- Phase 5.1 repair / single MCP checkpoint observation/handoff state owner + SourceFreshnessPort read-path migration: `61d8163`;
- Phase 5.2 / prepared publication-read session: `505358b`.
- Phase 5.3 / operation-level IndexMutationPort boundary: `319ea00`.
- Phase 6.1 / SearchRequestCoordinator extraction: `63e718e`.
- Phase 6.2 / search continuation in the bounded search owner: `7571fb5`.
- Phase 6.3 / retrieval-pass ownership in the pass executor: `011f054`.
- Phase 6.4 / call-graph request handling verified in NavigationHandlers: `011f054` (constraint check).
- Phase 6.5 / cohesive owners left intact: `011f054` (constraint check).
- Phase 7.1 / client config mutation builders: `2155f72`.
- Phase 7.2 / client config inspection and runtime authority: `c718ce8`.
- Phase 7.3 / runtime and reranker/vector-store selection: `4949568`.
- Phase 7.4 / install planning as a pure mutation plan: `b1f3a84`.
- Phase 7.5 / install application executor: `01bff81`.
- Phase 7.6 / runtime upgrade orchestration: `95cc653`.
- Phase 4.7 / review-driven ownership seal: neutral `generation/contracts` + `generation/errors` (no `generation/*` or synchronizer-registry imports of `core/context`), `SynchronizerRegistry` raw-map getters replaced by a narrow mutation port, Context compatibility accessor narrowed: `8737e8e`.
- Phase 8 gate correction A / neutral `SourceFreshnessPort` + `IndexMutationPort` contracts (no `core/context` import from the port modules; `ProvenSourceFreshnessCheckpointEvidence` now owned by the freshness port module), plus D-adjacent P2 cleanup (SourceObservationState dead mutable-map getters removed; test-only Context accessor removed; `InstallPlan` options snapshot + frozen prepared array): `e109651`.
- Phase 8 gate correction A/D follow-up / F6 fully closed: `InstallPlan` nested mutation records (`configMutation`, companion entries, `profileMutation`) now frozen copies, with a regression test proving strict-mode post-plan mutation throws: `fccc9e4`.
- Phase 8 gate correction B / grouped narrow search collaborator seams: the 54-member `SearchRequestCoordinatorHost` callback bag is replaced by six named collaborators (`SearchReadinessCollaborator`, `SearchHintPayloadCollaborator`, `SearchPreparedReadCollaborator`, `SearchFreshnessCollaborator`, `SearchEnvironmentCollaborator`, `SearchContinuationStoreCollaborator`) composed in `SearchRequestCoordinatorCollaborators`. All 54 member signatures and all 54 `ToolHandlers` bindings preserved verbatim (machine-verified); MCP core suite 1257/1257 green: `a58590e`.
- Phase 8 gate correction C / continuation owner identity: `SearchContinuationCoordinator` (and its pool) moved into the search module with the `SearchRequestCoordinator` as the registered owner token; store/lookup/advance/remove called directly (the `SearchContinuationStoreCollaborator` group left the collaborator set), routing hops coordinator-to-coordinator via `owner.continueOwned`, `ToolHandlers` keeps only constructor injection, the release delegate, and the `handleContinueSearch` entry point. Full MCP suite 1554 pass / 1 pre-existing skip: `eb42601`.
- Phase 8.1 / published-surface freeze + dead private façade removal: `contracts/published-surface.json` freezes the NAME set (481 barrel export names + 79 `Context` public member names) with a regenerating guard test (`src/core/published-surface.ts` computes via the TS API); five zero-caller private Context members deleted (two policy warm-state snapshot getters, `getIgnoreMatcherForCodebase`, both `withIndexPolicyMutationLock` wrappers) plus the two now-dead coordinator snapshot methods; oracles preserved (matcher-cache test moved to `ignore-rule-service.test.ts`, fenced-lock test now holds a synthetic lock file, warm-state asserts dropped where public `getActiveIgnorePatterns` oracles already prove the outcome). Dead-private scan now reports 0 candidates. Core suite 802 pass / 1 skip; MCP core suite 1257/1257: `8c8ab51`.
- Phase 8.2 / shallow ToolHandlers pass-through removal: `NavigationHandlersHost` now receives the `ToolResponseBuilders` capability directly instead of seven one-line payload-builder callbacks; the search hints collaborator's `buildRequiresReindexPayload` member removed in favor of the existing `getToolResponseBuilders()` accessor; eight private `ToolHandlers` wrapper methods deleted. The previously-masked runtime payload value `reason: "invalid_request"` is now declared in the `FileOutlineResponseEnvelope`/builder contracts. Outline/call-graph/requires-reindex payload fixtures identical; full MCP suite 1554 pass / 1 skip: `447b048`.
- Phase 8.3 / single-source collection naming: `collection-naming.ts` (pure grammar: family prefixes, `__gen_` separator, active/alternate family names, staged names, generation-id normalization, family membership, family-name parsing) and `collection-family-listing.ts` (I/O: list + hasCollection probe fallback over a narrow port). Context delegates; grammar call sites consolidated in `lancedb-vectordb.ts` (local `collectionFamilyName` deleted), `index-generation-workflow.ts`, MCP `manage-indexing-handlers.ts`, and `vector-backend-maintenance.ts` (`SATORI_COLLECTION_FAMILY_PREFIXES` now imported). Barrel expanded (+11 names, fixture regenerated to 492). Core suite 802 pass / 1 skip; full MCP suite 1554 pass / 1 skip: `777551d`.
- Phase 8.4A / workflow operation/capability warm state: `reindexByChangeQueues` and `preparedIndexCollectionReceipts` now declared and written only by `IndexGenerationWorkflow` (`registerPreparedIndexCollectionReceipt` / `discardPreparedIndexCollectionReceipt` / internal consume); Context delegates; raw-collection port members removed: `783a874`.
- Phase 8.4B / workflow navigation warm state: `navigationDeltaState` + `preparedNavigationDeltaStates` moved into `IndexGenerationWorkflow` with the complete stage -> promote -> delete lifecycle (`stagePreparedNavigationDelta` / `promotePreparedNavigationDelta`); the token resolver is passed to promote so observation resolution still happens only for staged candidates; `getNavigationDeltaState`/`setNavigationDeltaState` port members removed: `bc0e038`.
- Phase 8.5 / operation-scoped write-target authority: the ambient `writeCollectionOverrides` map is deleted. `PreparedIndexCollectionBinding` now carries `collectionName`; the receipt/binding/explicit `writeCollectionName` option (`IndexMutationOptions`/`MutationGuardOptions`) is threaded through `prepareCollection`, payload writes, completion markers, and finalization in `IndexGenerationWorkflow`. `ManageIndexingHandlers` no longer toggles `setWriteCollectionOverride` (host member, lifecycle capability, and required-capability entry removed); the staged target travels in the binding. `Context.setWriteCollectionOverride` became a documented no-op compatibility stub (8.1C; restored to a façade compatibility adapter in `cefd1a2` below). Core suite 802 pass / 1 skip; full MCP suite 1554 pass / 1 skip; CLI suite 364/364: `7901f4d`.
- Phase 8.5 review repairs: legacy write-target compatibility restored through a façade-only adapter (operation-scoped authority unchanged), `PreparedIndexCollectionBinding.collectionName` optional again, `getSyncManager()`/`contextLifecycle()` removed from the search collaborator boundary, signature-aware published-surface freeze (Context member signatures + selected declaration bodies), collection-naming barrel minimized to the two intentional exports, and the reindex queue-drain oracle relocated to `IndexGenerationWorkflow` owner tests. Core suite 805 pass / 1 skip; full MCP suite 1554 pass / 1 skip; CLI suite 364/364: `cefd1a2`.
- Phase 8.6 / PreparedReadCacheOwner: `preparedReadCache`, `statusPreparedReadObservations`, and `preparedNavigationCache` now owned by one MCP owner with narrow authority/source-freshness/revalidation/navigation collaborators; ABA identity checks preserved on every cache population path: `bc53cb4`.
- Phase 8.7 / InterruptedIndexRecoveryCoordinator: stale/grace decision, lease fencing, operation-phase persistence, completion-proof recovery, and startup recovery on one owner; `ToolHandlers` reduced to delegation: `bc53cb4`.
- Phase 8.8 / authority decision bodies: `getIndexAuthorityObservations`, `resolveEffectiveNavigationAuthority`, `proveEffectiveNavigationAuthority`, `isPreparedVectorReceiptBoundToCurrentAuthority`, `resolveGenerationProofIdentity`, marker equality, receipt cloning, generation proof state, and publication read/retention state moved into `IndexAuthorityCoordinator` with owner-level tests that construct the coordinator without Context: `bc53cb4`.
- Phase 8.7 compatibility repair / guarded `getIndexingCodebases` capability reads restored (recovery silently skips hosts without the capability, matching the pre-extraction optional behavior) and `extractIndexedRecoveryFromCompletionProof` restored as a thin `ToolHandlers` delegate: `2386ad3`.
- Phase 8.9 / policy publication transaction ownership: `publishResolvedIndexPolicy` / `clearPublishedIndexPolicy` / `forceClearPublishedIndexPolicy` (validation, v3/v4/v5 document selection, rollback, and committed-before-receipt acknowledgement) moved into `IndexAuthorityCoordinator` over primitive document-store/runtime-service ports; Context keeps thin delegates; `IndexGenerationWorkflow` uses the port publication plus the coordinator's marker-bound reconciliation. Owner-level publication test constructs the coordinator without Context: `31e60db`.
- Phase 8.10 / index teardown workflow: `IndexTeardownWorkflow` owns the cross-domain clear ordering under the shared policy-mutation lock (collections → durable policy → runtime policy → navigation sidecars → synchronizer checkpoint/registry → ignore state → compatibility state → index profile), wired through the new `IndexMutationPort.clearIndex` operation; `ManageMaintenanceHandlers` routes clears through the port; Context `clearIndex` is a thin delegate: `29db70d`.
- Phase 8 surface-guard P2 / the published-surface freeze now also pins the deliberately public port interfaces (`IndexMutationPort`, `IndexMutationPortDependencies`, `SourceFreshnessPort`): `0963ca9`.
- Phase 9.0 / version-support inventory (classification with writer/reader/selector evidence; recorded here, not guessed):
  - Durable disk format — completion markers: `satori_index_completion_v3` is the current writer/reader (`Context.publishCompletedIndexMarker` / `proveVectorGenerationWithEvidence`); `v1`/`v2` have no writer and are recognized only by the classifier in `persisted-index-authority.ts:425-475` (invalid/requires_reindex).
  - Durable disk format — policy documents: writer is `IndexAuthorityCoordinator.publishResolvedIndexPolicy` selecting `satori_index_policy_v5` (publication + controlSignature), `v4` (publication only), or `v3` (no publication); readers are `inspectIndexPolicyDocument`/`loadCustomIndexPolicy`. `satori_index_policy_v2` has no writer and is recognized only at `persisted-index-authority.ts:661` (requires_reindex). The v3/v4/v5 floor is the Phase 9.3 product decision.
  - Durable disk format — fingerprints: `LEGACY_BASE/ANALYSIS/PROJECTION_INDEX_FINGERPRINT_FIELDS` are reader-only classification (`persisted-index-authority.ts:214-216,334-335`) feeding `legacy_unverified_fingerprint`; `dense_v3`/`hybrid_v3` are the current fingerprint schema versions (`config.ts:414-420`), `assumed_v2` is a historical source label (`config.ts:302`).
  - Persisted operator/config state — MCP snapshot: `CodebaseSnapshotV3` is the only writer (`snapshot.ts:1278`); `V1`/`V2` are migration readers (`snapshot.ts:1051-1067`, `mapFromV1/V2Snapshot`) with no writer.
  - Persisted operator/config state — LateOn runtime: six `SATORI_LATEON_PROFILE` IDs and three activation-policy IDs are validated in `config.ts:731-808`; all six profile assets (`satori_lateon_runtime_profile_v1..v4`) are still executable via `lateon-reranker.ts` (current: `lateon_offline_quality_projection_v4_d32_v1`); historical IDs are recognized at the CLI migration boundary (`runtime-selection.ts`, `lateon-model-store.ts`, `runtime-config.ts` doctor checks).
  - Wire/provider identity (current, keep): `lexicographic_recursive_canonical_json_v1`, `relationship_manifest_v2`, `navigation_current_v2`, `search_disclosure_v1`, `provider_output_v1`, `embedding_projection_v1`, `lexical_projection_v1`, `VECTOR_CANDIDATE_RRF_K_V1`, `SHARED_RUNTIME_PROTOCOL_VERSION=2`, `satori_rerank_request_contract_v1` (frozen SHA `8a944603…`).
  - Rerank document projections: `search_rerank_document_v4` is current (selector: v4 profile `projectionVersion`, `search-request-coordinator.ts:2176-2180`); `v3` and `v2` are executable (`search-rerank-projection.ts`) and `v2` supplies 14-15 implementation-machinery symbols imported by v3/v4; `v1` (`search-rerank-document.ts`) is selected only by the legacy path in `search-query-support.ts`.
  - Bounded source selection: `bounded_source_selection_v2` is current (`document-v4.ts:340`, `symbol-context-composer.ts:402,419`); `_v1` is selected only by `SEARCH_RERANK_DOCUMENT_V2_POLICY.selector.version` (`document-v2.ts:42`) and drives the CRLF legacy branch (`bounded-source-selector.ts:160-189`).
  - Rerank query projections: `search_rerank_query_v2` is current (v4 profile); `v1` selected by the v3 profile (`query-routing.ts:28-33`); `semantic_query_raw_v1` is the raw fallback identity (`query-routing.ts:22-27`).
  - Public API identities (current, keep): `SearchGroupedResultV2`, `SearchRerankRequestIdentityV1`, `SearchNavigationUnavailableReasonV2`, `CodebaseSnapshotV1-V3` union export.
  - Deprecated compatibility seams (current): `Context.setWriteCollectionOverride` (legacy adapter), `navigation/runtime.ts:41` `servingStore` alias, `config.ts:55` `WATCHER_DEBOUNCE_MS` alias, `MCP_WATCH_DEBOUNCE_MS` (ignored).
  - No other versioned production symbol families found beyond these and their test-only fixtures.
- Phase 9.1 / retired LateOn runtime profiles: only `lateon_offline_quality_projection_v4_d32_v1` can execute. `createMcpConfig` rejects every other known profile with a clear `Unsupported SATORI_LATEON_PROFILE` error carrying `satori upgrade` migration guidance, and the two historical activation policies are rejected the same way. `loadLateOnRuntimeProfile` rejects retired profile IDs and non-v4 schema assets; `PROFILE_PATHS` keeps only the v4 asset; the v1-v3 validation branches are deleted (`LATEON_RETIRED_RUNTIME_PROFILE_IDS` records the retired set). CLI upgrade/migration fixtures for historical managed profile IDs unchanged. Full MCP suite 1554 pass / 1 skip; CLI suite 364/364: `bcc2460`.
- Phase 9.2A / extract canonical rerank projection primitives: the neutral projection primitives and constants that V2/V3/V4 shared (validation, source-selection, physical-line/excerpt bounds, sibling normalization) are extracted out of the historical modules into `search-rerank-projection-primitives.ts`. Pure move/refactor; no supported route, projection bytes, request-contract fixture, or `requestContractSha256` change. Request-contract fixture still pins the recomputed `contractSha256` (search-rerank-request-contract.test.ts): `d622cff`.
- Phase 9.2B / retire executable historical rerank document projections: production search uses one canonical document projector; the executable V2/V3 builders and their projection dispatch are removed; historical V3 fixture/policy material required only to preserve the frozen current request-contract identity becomes inert contract evidence, not executable implementation: `304c87a`.
- Phase 9.2C / remove bounded-source selector v1: after no executable supported path selects it, the legacy CRLF newline branch is gone and `selectBoundedSource(...)` is one canonical algorithm; `bounded_source_selection_v2` remains the immutable current identity: `24a89d5`.
- Phase 9.2D / retire query projection v1 (review-driven close): production routing accepts only raw (`semantic_query_raw_v1`) or current (`search_rerank_query_v2`) and rejects the retired v1 identity (`search_rerank_query_projection_identity_unknown`). The current projector is canonical (`buildSearchRerankQuery`, `SEARCH_RERANK_QUERY_PROJECTION_IDENTITY`, `search-rerank-query.ts`; immutable serialized identity stays `search_rerank_query_v2`). The retired v1 query bytes survive only as frozen inert literal contract evidence in `search-rerank-request-contract.ts`, decoupled from the current answer-focus model; `contractSha256` unchanged (contract test pins recomputation against the committed asset). A coordinator-level boundary test proves `handleSearchCode` fails closed with provider rerank call count 0 when a reranker advertises `search_rerank_query_v1`. Full MCP suite 1525 pass / 1 skip: `0564384`.
- Phase 9.2 review repair / close projection retirement boundaries: document projection routing (`search-rerank-document-routing.ts`) is now symmetric with query routing — undefined/blank resolves to `semantic_document_raw_v1`, `search_rerank_document_v4` to the canonical publication-bound projector, and every other advertised identity (v1/v2/v3/unknown) throws `search_rerank_document_projection_identity_unknown` before any provider rerank call. The retired V3 document bytes and policy material survive only as frozen inert literal contract evidence (`SEARCH_RERANK_DOCUMENT_V3_CONTRACT_EVIDENCE`, `SEARCH_RERANK_DOCUMENT_V3_POLICY_EVIDENCE`); `buildSearchRerankDocumentV3ContractEvidence()` is deleted; no historical document builder executes during contract recomputation. Coordinator-level boundary tests cover retired V1/V2/V3 and one unknown document projection with provider rerank call count 0. `contractSha256` unchanged (`f4e8ec82`). Full MCP suite 302 pass / 1 skip: `8931e68`.
- Phase 9.3 / durable index policy floor & fingerprint reindex floor: retired satori_index_policy_v3 and v4 semantic support in inspectIndexPolicyDocument and loadCustomIndexPolicy. Recognized v3/v4 policy documents return requires_reindex. V5 is the sole current policy document. Recognized historical fingerprints require reindex; malformed fingerprints return corrupt. Core + MCP suites pass: cc2ef7c.
- Phase 9.4 / close Phase 9.4 dead compatibility runtime: deleted 8 obsolete LateOn profile JSON assets (v1, v2-d16, v2-d32, v3-d32, v3-d32-v2); deleted search-rerank-contract-evidence.ts (inlined V3 evidence literals directly into search-rerank-request-contract.ts); simplified LateOn runtime profile types and reranker execution to V4 exclusively; removed retired hasBoundedExecutionContract and legacy profile execution branches; verified clean typecheck (tsc --noEmit) and lint (eslint src) across core and mcp: aef98f8.
- Phase 9.5 / structural architecture guard: added phase9-architecture-boundary.test.ts scanning production source tree in packages/core/src and packages/mcp/src for forbidden retired module imports, retired index policy generation branching, and retired LateOn profile schema branching outside designated boundary files. Unit tests cover full tree scan (0 violations), synthetic planted import failure, synthetic planted policy branch failure, synthetic planted LateOn branch failure, and positive acceptance of current versioned identities (e.g. SearchGroupedResultV2): ee9c02e.
- Phase 9 review repairs & superseding final seal: post-9.3 review repairs (`0121875`, `0142d97`, `284b197`, `8a7c0be`, `dd5fb42`) enforced genuine source-checkpoint lifecycle authority for V5 policy publication, independent workflow validation of PreparedSourceContract, snapshotting of source file-hash sets with pre-mutation Merkle binding, fail-closed missing/tampered contracts, WeakSet-based authentic capability provenance with frozen PreparedFileChangeSet objects, and strict historical retired policy envelope validation. Phase 9 is sealed and declared complete.

Next open batch at this checkpoint: Phase 9 complete (sealed). Next is Post-Phase 9 ROI roadmap execution.
Phase 8 is sealed (`bc53cb4 → 0963ca9`, review-approved). Phase 9 is sealed (`bcc2460 → dd5fb42`, review-approved). Refresh this checkpoint only after an accepted batch is
committed; preserve the original baseline above as historical lineage.

## Goal

Reduce the major Satori hotspots by moving behavior to its demonstrated owner while
preserving current public behavior, persisted contracts, ranking contracts, and
compatibility façades.

Success is an ownership result, not a line-count result:

- one authoritative writer for each mutable domain;
- narrow dependency contracts;
- `Context` becomes a compatibility façade;
- MCP coordinators no longer receive raw cross-domain capability bags;
- unchanged public and persisted contracts remain byte/behavior compatible;
- each extraction is independently reviewable and reversible.

## Non-goals

- No ranking, admission, provider-order, fusion, reranker, grouping, pagination,
  projection, or ignore-semantics changes.
- No new completion-marker state or speculative `replacing` marker.
- No persisted-format migration unless separately reviewed and authorized.
- No hard file-size CI limit.
- No broad rewrite of `Context`, `ToolHandlers`, `SyncManager`, or
  `ManageIndexingHandlers`.
- No test deletion or oracle weakening.

## Global invariants

### Publication and reads

```text
candidate staging may overlap retention waiting for readers
destructive retention excludes candidate staging
newer in-flight activation makes older retention abandon cleanup
publication-bound reads hold their lease through final authority revalidation
```

### In-place incremental mutation

```text
completion authority is withdrawn before payload mutation
no result is disclosed without post-retrieval authority revalidation
completion authority is republished only after exact payload/policy/navigation proof
```

### Ownership: current and target

Current state at the execution checkpoint:

```text
Context owns broad active generation/publication authority
GenerationProofCoordinator owns generation proof state
FileSynchronizer owns source checkpoint persistence and comparisons
MutationLeaseCoordinator owns persisted root mutation fencing
SyncManager owns watcher/sync coordination but still depends on Context
ManageIndexingHandlers owns MCP action orchestration but still depends on Context
```

Target state:

```text
FileSynchronizer owns source checkpoint persistence and comparisons
SnapshotManager owns MCP lifecycle persistence and merge arbitration
MutationLeaseCoordinator continues to own root mutation fencing
IndexAuthorityCoordinator owns active generation/publication authority
SyncManager owns watcher/sync coordination, not Core checkpoint truth
ManageIndexingHandlers owns MCP action orchestration, not Core publication policy
```

### Extraction migration

For every mutable-state migration:

```text
1. characterize the current owner, invariant, writer, persistence boundary, and façade;
2. introduce the destination type or port with zero duplicate mutable state;
3. move the state collection and every mutation method for that collection together;
4. make Context/the prior owner a delegate in the same batch;
5. prove the prior owner can no longer mutate that state directly;
6. only then migrate the next collection.
```

Never mirror authoritative writes or retain two authoritative caches during a
transition. This applies in particular to generation bindings, proof caches/flights,
policy bindings, retention state, source-checkpoint observations, and synchronizer
registries.

### Dependency direction

```text
Context → domain coordinator → narrow stores/ports
MCP action/read coordinator → Core public or narrow mutation/read port

Never: domain owner → Context
Never: Core → MCP
```

## Required batch protocol

Production batches run sequentially by default. Parallelism is allowed for read-only
investigation. Parallel production work requires a preflight proving that the complete
touched-file sets are disjoint, including public export barrels, shared tests, package
manifests, and generated-contract assets.

Before implementation, create a batch sheet from the current HEAD with:

```text
owner before / owner after
exact state and functions moving
exact files touched and dependency direction
compatibility façade
regression or characterization oracle
forbidden adjacent changes
verification command(s)
stopping condition
```

Every stopping condition in that sheet must resolve to exact existing test names and
commands or be marked `new oracle required`. A new oracle must fail against the
pre-move defect or characterize the current behavior before production code moves.

Every batch must then follow this sequence:

1. confirm current HEAD and preserve unrelated work;
2. identify invariant, owner, writer, persistence boundary, callers, and façade;
3. add or identify a regression/contract test capable of detecting drift;
4. make one ownership-bounded change;
5. run focused tests and typecheck for the affected package;
6. run the relevant package suite;
7. inspect the complete diff and public exports;
8. if commit authorization exists, stage only the exact batch paths, inspect the
   staged diff, and commit one ownership-bounded batch; otherwise leave the verified
   diff unstaged and record its exact paths and verification;
9. stop before the next batch.

For delegated read-only reviews, use an isolated checkout or equivalent
write-isolated workspace. Record HEAD and `git status --porcelain` before and after
the review. Unexpected writes invalidate that review evidence and must be reconciled
before another batch starts.

### Risk rubric

```text
S  pure or owner-local extraction with no authority transition
M  bounded stateful owner or compatibility boundary
L  cross-owner workflow, public contract, or lifecycle transition
XL authority, persistence, concurrency, rollback, or multi-owner transaction
```

For behavior-preserving refactors, request/profile/embedding identities must remain
unchanged. A clean build may change the compiled-runtime tree identity because files
move; measure that identity only from the exact clean implementation commit when an
evidence receipt requires it.

## Phase 0 — Rebaseline and close live authority defects

### 0.1 Current finding ledger

Record current disposition:

- F021: resolved by `6a5ee87`;
- F022: torn semantic-search disclosure resolved by `6a5ee87`;
- F067: the marker-withdrawn interval remains intentional fail-closed availability
  behavior, not an open defect; do not add a speculative completion or `replacing`
  marker. A future mutation-intent record would require separate authorization and a
  durable contract;
- F050: resolved by provider-backed lazy startup recovery;
- F024: resolved by `e56c973`;
- F023: resolved by `83fb255`.

Stopping condition: no implementation task refers to F021, F022, F023, F024, F050,
or F067 as an unfixed incident.

### 0.2 F024 durable-recovery prerequisite — completed by `e56c973`

Add phase-aware validation for `swapping` restore journals. Before resuming each
entry, every target, temporary artifact, and displaced artifact must match the
allowed digest/state for that transaction phase and entry. A mismatched or newer
authority fails closed; recovery must not move it aside.

Required test:

```text
interrupted swapping journal
+ newer authority publication
→ recovery refuses displacement
→ newer authority remains exact
```

Stopping condition: durable recovery proves transaction ownership before replacing
any remaining authority path, and it has a complete phase/state contract before
extraction.

### 0.3 F023 staging-owner prerequisite — completed by `83fb255`

Owners:

- navigation sidecar staging;
- synchronizer checkpoint staging.

Required behavior:

```text
post-rename qualification/fsync failure
→ staging owner verifies the final path still belongs to this staging attempt
→ staging owner removes only that identity-bound final artifact and fsyncs its parent
→ cleanup confirmation is recorded before claiming the artifact is absent

cleanup/remove/parent-fsync cannot be confirmed
→ caller receives failure with explicit unresolved-cleanup evidence
→ artifact never becomes authoritative
```

Do not broadly remove a final path merely because a prior rename succeeded.

Required tests: deterministic failure after final rename for each staging owner,
including an identity change before cleanup and an unconfirmable cleanup path.

Stopping condition: no artifact created by a failed attempt remains when
identity-bound removal and parent-directory durability can be confirmed; otherwise
the owner preserves explicit unresolved-cleanup evidence and never treats the artifact
as authoritative.

## Phase 1 — Low-risk owner-internal extractions

Execute these batches sequentially unless the required production parallelism preflight
proves their complete touched-file sets are disjoint.

### 1.1 Move the root gitignore matcher cache

Completed by `f70f972`.

Move `rootGitignoreMatcherCache` into `SearchQuerySupport`, preserving the existing
`ToolHandlers` lifecycle and reload policy.

Risk: S.

Stopping condition: cache behavior, force-reload cadence, path canonicalization,
and search outputs are unchanged.

### 1.2 Extract pure sidecar validators

Completed by `7932fa8`.

Create a validator module for symbol, relationship, seal, resolution-proof, and
analysis-evidence parsing. Preserve `symbols/index.ts` re-exports.

Do not move atomic write or publication callbacks in this batch.

Risk: S.

Stopping condition: existing sidecar fixtures round-trip identically and malformed
inputs receive unchanged classifications.

### 1.3 Extract only stateless synchronizer snapshot codec logic

Completed by `9f77131`.

Move serialization, parsing, and stateless validation only.

Keep these in `FileSynchronizer`:

- checkpoint staging and commit;
- atomic write/fsync/rename;
- snapshot loading into instance state;
- checkpoint authority and observation tokens;
- freshness comparisons.

Risk: M.

Stopping condition: V2/V3 migration and byte-level payload fixtures remain exact. The
Phase 1.3 batch sheet must resolve the exact fixture names — e.g. `FileSynchronizer
defers legacy snapshot replacement until a prepared checkpoint commits`, `FileSynchronizer
snapshot JSON key order is independent of String.prototype.localeCompare`, and
`FileSynchronizer rejects corrupt current-format snapshots` in
`packages/core/src/sync/synchronizer.test.ts` — or mark `new oracle required`; the sheet
must state explicitly whether byte-exact payload fixtures already exist or are new.

### 1.4 Extract CLI neutral contracts, detection, and runtime paths

Completed by `cec0d14`.

Create bounded modules for:

- install/client contracts;
- client target resolution and detection;
- pure managed-runtime path resolution.

Keep `install.ts` as a compatibility façade and re-export established public symbols.

Risk: M.

Stopping condition: client auto/all detection, configured path handling, and public
imports remain unchanged.

## Phase 2 — Core utility/storage seams

### 2.1 Complete the sidecar read boundary

Completed by `06bb5db`.

Order:

1. shared generation/seal helpers;
2. seal verification and generation resolution;
3. symbol-registry reads;
4. relationship reads.

Keep sidecar-specific rollback/replace behavior with the write lifecycle.

Risk: M.

Stopping condition: navigation seal, registry, and relationship read contracts remain
exact through existing package exports.

### 2.2 Extract synchronizer scanning behind an explicit context

Define a scan context containing only:

- canonical root identity;
- ignore matcher;
- supported extensions;
- hash/full-hash policy;
- bounded concurrency;
- prior stat/hash evidence needed by the scan.

Return immutable scan results. `FileSynchronizer` retains checkpoint and freshness
state.

Risk: M.

Stopping condition: symlink/root safety, partial scans, cached stat behavior, full
hashing, and concurrency fixtures remain unchanged.

The Phase 2.2 batch sheet must add a deterministic bounded-concurrency oracle; no
current synchronizer fixture directly proves the scan worker bound. Resolve the
remaining named behaviors to exact existing fixtures under the normal batch-sheet
gate.

### 2.3 Extract the Python relationship-resolution engine

Define a real engine contract rather than reusing only generic proof helpers.

Inputs must explicitly include module/symbol indexes, flow facts, ownership evidence,
and resolution settings. Outputs must contain resolved edges and proof evidence without
publishing side effects.

Keep `builder.ts` as the analyze → resolve → emit pipeline façade.

Risk: L.

Stopping condition: full rebuild and delta relationship outputs are identical,
including proof steps and deterministic order.

### 2.4 Complete sidecar write/lifecycle decomposition

After read contracts are stable, separate:

- symbol writes;
- relationship writes;
- generation staging/publish/discard/prune;
- sidecar-specific atomic replacement/rollback.

The sidecar modules store artifacts. They do not decide which generation is active.

Risk: L.

Stopping condition: F023 remains closed and publication/rollback fixtures are exact.

## Phase 3 — Policy ownership

### 3.1 Extract `IndexPolicyRuntimeService`

Own:

- runtime profile/custom extension/custom ignore composition;
- policy hash resolution;
- runtime compatibility evaluation.

Do not own `publishedPolicyBindingsByCodebase` or active generation state.

Risk: L.

Stopping condition: policy hashes, compatibility outcomes, and control signatures are
unchanged for all current fixtures.

### 3.2 Extract `IndexPolicyDocumentStore`

Own durable policy document I/O and reuse the existing policy mutation lock owner.
Do not create a second broadly named policy coordinator.

Risk: M.

Stopping condition: durable formats and locking behavior remain unchanged; no active
generation state enters the store.

The Phase 3.2 batch sheet must add direct owner-level document-store and mutation-lock
contract tests before moving production I/O. Existing `Context` policy fixtures remain
integration oracles, not substitutes for the extracted owner's contract.

### 3.3 Extract durable restore transaction mechanics

Move the corrected F024 transaction parser/writer/executor behind a narrow internal
contract. It remains an infrastructure dependency of generation authority.

Risk: M.

Stopping condition: prepared/swapping/recovery/newer-authority fixtures pass without
changing persisted journal format unless separately authorized.

## Phase 4 — Core generation authority

This is the XL track. Execute incrementally; do not rewrite `Context` in one batch.

### 4.1 Freeze the authority contract

Define the coordinator's inputs and results before moving mutable state.

Current proof state belongs to the coordinator created by
`createGenerationProofCoordinator()`. This batch must decide whether that owner is
composed by or re-parented into the authority coordinator; it must not create a
second proof cache or proof-flight registry.

Own:

- generation proof caches and proof flights;
- published collection/marker/navigation/policy binding;
- current phase-aware read/publication/retention gate;
- activation, rollback, retention, proof rebinding, and durable restoration.

Do not own:

- scanning or embedding;
- semantic ranking;
- MCP snapshots or root leases;
- navigation artifact serialization;
- source checkpoint persistence.

Add focused authority-contract tests before moving state.

Risk: M.

Stopping condition: the contract names one writer for proof state, publication
bindings, activation, rollback, retention, and durable restore decisions; every
dependency is a narrow port/type and no production state has moved yet.

### 4.2 Move proof state and exact binding validation

Move one mutable collection at a time. Keep `Context` methods as delegates.

Risk: L.

Stopping condition: warm proof, ABA, marker, payload-count, policy, navigation, and
observation-token tests pass without public API changes.

### 4.3 Move the current publication/read/retention state machine unchanged

Preserve the `6a5ee87` invariant. Do not fully serialize publication behind reader
drainage.

Risk: XL.

Stopping condition: F021 fork race, active-reader Q/R publication, retention cleanup,
failure recovery, and reader-drain tests all pass.

### 4.4 Move activation, rollback, retention, and durable restoration

Wire vector publication, marker/policy contracts, sidecar artifact ports, and source
checkpoint evidence through narrow dependencies.

Phase 3.3 owns restore transaction parsing/writing/execution mechanics. This batch
owns the authority decision to invoke those mechanics and must not duplicate them.
Use the existing Core checkpoint-evidence types behind a narrow dependency; do not
prematurely create the MCP read-facing `SourceFreshnessPort` from Phase 5.1.

Risk: XL.

Stopping condition: one owner writes active generation authority; Context delegates;
no persisted format or externally observable behavior changes.

### 4.5 Extract repair and full-index orchestration

After the authority owner is stable, extract a Core `IndexGenerationWorkflow` for
repair and full-index domain workflow. It owns Core candidate-generation operations,
generation proof, calls to publication/rollback/retention operations, and Core domain
results. It does not own MCP snapshot lifecycle, mutation leases, status/progress,
response envelopes, checkpoint persistence, or sidecar activation policy.

Here `generation proof` means orchestrating proof requests and consuming proof
results. Proof caches, proof flights, and exact binding validation remain exclusively
owned by the authority/proof owner established in Phases 4.1–4.2.

It calls the authority owner through narrow dependencies; it must not acquire
authority state by reachability through `Context`.

Risk: XL.

Stopping condition: repair, full index, partial limit, rollback, and navigation
publication fixtures pass through operation-level contracts.

### 4.6 Extract synchronizer registry last

Move registry/lifecycle access only after authority and policy consumers use narrow
ports.

Risk: M.

Stopping condition: Context retains compatibility delegates but no synchronizer
domain state or policy decisions.

## Phase 5 — MCP read, freshness, and mutation boundaries

### 5.1 Centralize source readiness and full-index handoff

Define separately:

- a narrow Core `SourceFreshnessPort`, built on the existing checkpoint-evidence
  types, for read-facing preparation and revalidation;
- one MCP state owner for generation-scoped observations, handoff, and derived
  readiness.

The read-facing port must establish `prepareCurrentSourceObservation(...)` and
`revalidateCurrentSourceObservation(...)` before prepared reads are extracted.
Migrate `SyncManager`, full-index handoff, and direct search checkpoint inspection to
that owner before removing old paths.

Risk: L.

Stopping condition: one mutable MCP owner exists for checkpoint observation/handoff;
watcher, sync, source-state-unverified, and no-watcher fallback fixtures pass.

### 5.2 Extract a prepared publication-read session

Own the full lifetime:

```text
prepare readiness
→ acquire publication read lease
→ execute search/navigation read
→ revalidate authority
→ release lease
```

Do not place a short-lived lease callback inside readiness preparation.
Depend on `SourceFreshnessPort` from the first batch; do not take a new direct
dependency on `SyncManager` or `ToolHandlers` readiness internals.

R3 resolution (sealed with the 5.1 repair): the search session's revalidation
callable remains `finalBarrierChanged` (compatibility rule), and its
source-freshness components are port-backed — full-comparison branches call
`compareCurrentSourceToCheckpoint` / `compareAllCurrentSourceToCheckpoint` and
the prepared-read cache flows through `SyncManager → SourceObservationState →
port.currentObservationToken`. The port's registered-token
`revalidateCurrentSourceObservation` is not substituted because it cannot
reproduce the richer barrier semantics. Navigation sessions revalidate
navigation/watcher identity and are out of source-freshness scope.

Risk: M.

Stopping condition: search, outline, call-graph, continuation, and failure paths prove
lease release and final revalidation.

### 5.3 Introduce an operation-level `IndexMutationPort`

The port exposes Core mutation/publication operations. It does not contain MCP
snapshot phases or response projection.

Keep `ManageIndexingHandlers` as the request/action coordinator. The concrete large
workflow is `ManageIndexingHandlers.startBackgroundIndexing()`. If it needs a file
move, extract a named MCP `FullIndexActionCoordinator` with explicit inputs/results.
It owns request/action interpretation, mutation-lease use, MCP lifecycle phases,
calls to `IndexMutationPort`, status/progress, and response projection. It does not
own generation authority, policy publication rules, checkpoint storage, or sidecar
activation rules.

Risk: L.

Stopping condition: handler host no longer exposes raw Context/vector/publication
capabilities; operation phase order and responses remain unchanged.

## Phase 6 — MCP search/navigation decomposition

### 6.1 Extract `SearchRequestCoordinator`

Move the dominant search attempt only after prepared-read and freshness boundaries
exist. Depend on existing leaf modules and bounded collaborators, not dozens of
private `ToolHandlers` callbacks.

Risk: L.

Stopping condition: exact registry, semantic execution, grouping, continuation
admission, hints, diagnostics, and source-drift retry behavior remain unchanged.

### 6.2 Move continuation handling

Continuation must depend on the bounded search/read owner, not `ToolHandlers` as an
ownership token and capability bag.

Risk: M.

Stopping condition: frozen set identity, offset, runtime/publication/source
revalidation, cache mutation, and response projection fixtures remain exact.

### 6.3 Extract pure retrieval-pass execution

Return ordered, labelled retrieval-pass outcomes only. Keep fusion, filtering,
`must:` admission, survival diagnostics, reranker admission, and provider ordering in
the established owner.

Risk: L.

Stopping condition: canonical request/ranking/diagnostic fixtures and provider-order
tests remain byte/order equivalent; no request/profile digest changes occur.

Completed by `011f054`. The pure retrieval-pass executor already existed as
`search-execution.ts` (ordered, labelled `SearchExecutionOutcome`; fusion,
filtering, must-admission, survival diagnostics, reranker admission, and provider
ordering all owned there with dedicated fixtures). The Phase 6.1 move made the
coordinator consume it through a bounded call, and this batch moved the last
pass-level concern (SATORI_TEST_FAIL_SEARCH_PASS fault injection) from the
coordinator into the pass executor as its default host fallback. Behavior verified
by execution-policy, must-lane, native-order, expansion, rerank-integration, and
fault-injection fixtures.

### 6.4 Extract call-graph request handling

Do this after prepared-read session extraction so the new module does not recreate
the broad readiness/currentness host.

Risk: M.

Stopping condition: exact-symbol resolution, depth, continuation, sealed authority,
and partial-coverage behavior remain unchanged.

Completed as a constraint check at `011f054`. Call-graph request handling is already
owned by `NavigationHandlers` (1737-line bounded owner with a narrow
`NavigationHandlersHost` and the Phase 5.2 `PreparedPublicationReadSession`);
`ToolHandlers` only delegates `handleCallGraph`/`handleFileOutline` and supplies
bounded payload-builder collaborators. No broad readiness/currentness host is
recreated. Behavior pinned by handlers.call_graph, call-graph, file_outline,
current-source-symbols, and canonical-symbol-identity fixtures (115 tests).

### 6.5 Leave cohesive owners alone

- Keep `SnapshotManager` intact.
- Keep `symbol-context-composer.ts` until a new demonstrated owner appears.
- Keep runtime-owner domain logic in `runtime-owner.ts`; move only MCP response
  adaptation if it materially shrinks handlers.

Completed as a constraint check at `011f054`. None of the Phase 6 batches touched
`SnapshotManager`, `symbol-context-composer.ts`, or `runtime-owner.ts`. The MCP
runtime-owner response adaptation already lives as narrow host-builder delegation
(`buildRuntimeOwnerConflictResponseIfBlocked`, `buildManageActionBlockedMessage`);
moving it would not materially shrink handlers, so it stays.

## Phase 7 — CLI decomposition

Execute sequentially by default while preserving `install.ts` exports:

1. Client config mutation builders. Risk: M. Stop when exact Codex, Claude Code,
   and OpenCode mutation fixtures remain unchanged.
2. Client config inspection/runtime authority. Risk: L. Stop when all supported
   client inspection fixtures and managed-launcher precedence remain unchanged.
3. Runtime and reranker/vector-store selection. Risk: M. Stop when offline/connected
   defaults, explicit overrides, dimensions, and provider selections remain exact.
4. Install planning as a pure mutation plan. Risk: M. Stop when dry-run, auto/all
   detection, prepared target sets, and no-write guarantees remain exact.
5. Install application/activation/lock/cleanup as a separate executor. Risk: L. Stop
   when activation, mutation locking, cleanup, local developer install, and rollback
   fixtures remain exact. Preserve the existing
   `installLocalMcpRuntime delegates exact local selection and preflights before
   activation` script fixture; add an executor-level oracle only if that fixture does
   not cross the extracted application boundary.
6. Runtime upgrade orchestration last. Risk: L. Stop when version selection,
   published-runtime activation, launcher precedence, and rollback fixtures remain
   exact.

Do not merge planning and application into one generic module. When a batch changes
`install.ts` exports, package entrypoints, runtime-path resolution, or client
discovery, run the relevant packed-artifact proof in addition to source-tree tests
(using the existing package-installability or packed release-smoke owner as applicable).

Privacy-safe doctor output remains a cross-batch public oracle whenever inspection,
runtime authority, selection, or launcher behavior moves.

## Phase 8 — Facade/host deepening

Status: planned, not implemented. Authorized revision (replaces the `5db7b4e`
draft and its first revision). Evidence re-verified at checkpoint `8737e8e`.
Plan every batch from its immediate parent HEAD; old line numbers and callback
counts are evidence, not implementation authority.

### Phase 8 global rules

- Public Core façade compatibility is frozen unless a separately authorized
  breaking API change says otherwise.
- Move mutable state **with every writer**, never state first and writers later.
- No temporary mirrored Maps/WeakMaps/caches.
- `Context` and `ToolHandlers` may delegate but must not remain hidden secondary
  owners.
- Do not create generic "manager", "shared", or "utils" modules when a
  demonstrated domain owner exists.
- Every extraction keeps its existing public/integration oracle and adds
  owner-level contracts; façade-test removal requires equivalent or stronger
  owner/public coverage.
- No ranking, admission, provider order, fusion, grouping, pagination,
  projection, ignore-policy, or persisted-format changes.
- The destructive/authority-heavy batches (L/XL) stop independently for review
  after they pass their stopping condition; the next batch starts only after
  that review. (This supersedes the pre-Phase-8 "no per-batch review" mode.)

### Execution amendment — sequencing and anti-overarchitecture guardrails

The remaining decomposition work follows this order:

```text
finish Phase 8
    → final Phase 8 ownership review/seal
    → Phase 9 canonicalization and executable-history retirement
    → fresh architecture rebaseline
    → only then consider deeper simplification
```

Do not run a new architectural campaign in parallel with Phase 8 or Phase 9.
The purpose of the sequence is to distinguish ownership repairs from intentional
redesign and to avoid designing against complexity that the canonicalization
phase may remove.

For every remaining Phase 8/9 batch:

> Do not interpret decomposition as a requirement to introduce more
> coordinators, ports, managers, adapters, or stores. A new abstraction must own
> an invariant, mutable state, lifecycle, transaction, or genuine variable
> external boundary. Prefer direct domain dependencies otherwise. Delete mere
> forwarding.

Use this classification before adding a named abstraction:

```text
persistent/shared state → named owner
per-operation state      → operation/session data
pure transformation      → function/module
external variability      → port/interface
mere forwarding           → delete it
```

The abstraction must have an explicit owner, invariant, lifecycle, persistence or
transaction boundary, and callers. If none of those exist, keep the code direct
or make the transformation a function. This is a design constraint, not a
request to flatten an owner that genuinely holds state or lifecycle authority.

Phase 8.8 and 8.9 settle the final authority shape before teardown is considered:

```text
8.8/8.9 → stabilize IndexAuthorityCoordinator ownership
8.10    → prove final owners compose under destructive teardown
Phase 9 → remove historical executable variants
then    → rebaseline and decide what can be deleted or flattened
```

Do not pre-authorize a Phase 10/11/12 series for search pipelines, mutation
sessions, public APIs, or port flattening. Those are hypotheses for the fresh
post-Phase-9 review, not current implementation scope.

### Gate — Phase 5–7 review corrections (must precede Phase 8)

Blockers from the Phase 5–7 review; Phase 8 would otherwise build on boundaries
already known to be transitional. Use the Phase 4.7 pattern (`8737e8e`: neutral
contracts/errors in the generation domain, no `core/context` imports).

A. Neutral Core contracts for `SourceFreshnessPort` / `IndexMutationPort` (L).
   The ports still depend on Context contract types. Give each port neutral
   contract/error types in its own domain so Core ports no longer import
   `core/context`. Stopping condition: no `core/context` import from the port
   modules or their contracts; port fixtures unchanged.

B. Narrow the `SearchRequestCoordinatorHost` (L). The Phase 6.1 host is still a
   giant callback bag. Replace with grouped narrow collaborators (readiness,
   hints/payloads, prepared-read, freshness). Stopping condition is a
   placeholder until the full Phase 6 review issue list lands; the batch sheet
   must resolve it to exact fixtures before starting.

C. Make `SearchRequestCoordinator` the continuation owner (M).
   `SearchContinuationCoordinator` still types `ToolHandlers` as its owner token
   and store/unregister route through the host. Move ownership (register/store/
   unregister) to the coordinator so ToolHandlers is no longer the token.
   Stopping condition: frozen-set identity, offset, revalidation, cache
   mutation, and response projection fixtures remain exact.

D. Cheap P2 cleanup where naturally adjacent (S). Only when the file is already
   open in a correction batch.

### 8.1 Freeze the façade/API contract, then remove only genuinely internal dead surface (S)

Generate/freeze the published package surface first: Core ships
`dist/index.d.ts`; the root barrel exports `context`; that exports `Context`.
Freeze the member-NAME set (barrel export names + `Context` public member
names), not the full d.ts text — type-shape churn from unrelated edits must not
fail the fixture. Regeneration only under breaking-API authorization.

Classify candidates:

```text
A. private + zero caller
   → safe deletion

B. test-only façade
   → move oracle to actual owner
   → keep façade if public

C. public Context method
   → keep thin compatibility delegate
   → removal only under separate breaking-API authorization
```

Methods such as `getLanguageAnalyzer`, `isLanguageSupported`, `updateEmbedding`,
`hasIndexedCollection` are not automatically dead merely because repository grep
finds no callers.

Stopping condition: no dead private implementation remains; no unintended change
to the generated/public Core API (surface fixture green); no behavior oracle
deleted merely to make a façade smaller.

### 8.2 Remove shallow ToolHandlers indirection (S)

Pass the already-existing `ToolResponseBuilders` capabilities directly to
`NavigationHandlers` / `TrackedRootReadiness` hosts and remove the one-line
ToolHandlers wrappers. No new owner; no behavior change. Do this early: it
reduces the host surface before the deeper extractions.

Stopping condition: identical payload fixtures for every outline/call-graph/
requires-reindex path; fewer ToolHandlers delegates.

### 8.3 Single-source collection naming (M)

Two deliberately different seams:

```text
collection-naming.ts
    pure:
    active family name
    alternate family name
    staged generation name
    belongsToFamily()
    __gen_ formatting

collection-family-listing.ts
    I/O:
    list collections through a narrow vector-store port
    apply collection-naming policy
```

The listing layer is I/O, not pure. Later workflow, teardown, registry, and
indexing batches get a stable naming authority instead of asking `Context`.
Preserve the current backend-enumeration fallback/probe behavior.

Stopping condition: only one production module knows the naming grammar; all
existing naming/family fixtures remain byte-for-byte/element-for-element
equivalent.

### 8.4 Move IndexGenerationWorkflow's warm mutable state (L)

#### 8.4A — operation/capability state

Move `reindexByChangeQueues` and `preparedIndexCollectionReceipts` into
`IndexGenerationWorkflow` — and move their operations too, not merely the
collections. The workflow must own the complete prepared-receipt lifecycle:
create/register, validate, consume, discard. Today `Context` still adds/deletes
the receipt while the workflow consumes it.

After the batch:

```text
Context
    → prepare/discard delegate

IndexGenerationWorkflow
    → owns the WeakSet and the complete receipt lifecycle
```

#### 8.4B — navigation warm state

Move `navigationDeltaState` and `preparedNavigationDeltaStates` with the entire
stage → publish → promote/delete lifecycle (today that lifecycle crosses several
Context methods). Do not leave Context writing one side of the state while the
workflow owns the map. A dedicated warm-state owner only if multiple navigation
operations genuinely need it.

Stopping condition: grep shows exactly one declarer/writer per collection and no
mirrored writes.

### 8.5 Make the write target operation-scoped (L)

Today:

```text
codebase root
→ Context.writeCollectionOverrides Map
→ getWriteCollectionName()
```

Instead:

```text
prepare staged collection
→ produce operation-bound receipt
    { canonicalRoot, generation, operationId, writeCollectionName }

indexing operation
→ consumes receipt

completion / failure / cancel / clear
→ invalidates receipt
```

No global ambient write-target state that handlers toggle.
`ManageIndexingHandlers` must not know how a Core write-target override is
represented. The receipt already carries the needed fields; the batch is mostly
deletion of the map plus threading the receipt through the four
`getWriteCollectionName` readers and the workflow port.
`setWriteCollectionOverride` is published `Context` surface; treat per 8.1C.

Stopping condition: no handler mutates Context-owned write-target state;
write-target authority cannot outlive the operation that created it; operation
phase order and responses unchanged.

### 8.6 PreparedReadCacheOwner (M/L)

The cluster is cohesive: authority observation, source observation, cache
identity, navigation identity, status-prepared observations, eviction, and warm
revalidation belong to one concept (invariant: cached/prepared read evidence may
only be reused while its authority and source observations remain current).

Create `PreparedReadCacheOwner` owning:

```text
preparedReadCache
statusPreparedReadObservations
preparedNavigationCache

build cache identity
lookup
store
evict
warm revalidation decision
navigation cache identity
```

Depend on narrow interfaces — `GenerationAuthorityReader`,
`SourceFreshnessPort`, `PreparedGenerationRevalidator`, `NavigationStore`,
`Clock` — never `ToolHandlers`. Search and navigation consume it. Do this after
gate correction B so the owner is not designed around the old giant host bag.

Stopping condition: one writer for all three caches; same ABA/source-freshness/
navigation invalidation behavior.

### 8.7 InterruptedIndexRecoveryCoordinator (M)

One explicit owner in the MCP recovery domain:

```text
InterruptedIndexRecoveryCoordinator
```

Keep `decideInterruptedIndexingRecovery()` as the existing pure decision leaf.
The coordinator owns: stale/grace determination, mutation lease acquisition,
operation phase persistence, completion marker probe, snapshot promotion/
failure, lease release (~190 lines currently on ToolHandlers). Preserve
`skipGrace` semantics (an existing lease skips the grace window) and keep
`recoverInterruptedIndexingAtStartup` as a thin delegate so the server entry
point does not churn.

Consumers: startup recovery, `ManageIndexingHandlers`,
`ManageMaintenanceHandlers` — the same owner.

Stopping condition: exactly one implementation of recovery orchestration;
identical lease/receipt/snapshot behavior across all three consumers.

### 8.8 Move authority decisions into the authority owner (L)

Before policy publication orchestration. Move bodies such as:

```text
resolveEffectiveNavigationAuthority
proveEffectiveNavigationAuthority
isPreparedVectorReceiptBoundToCurrentAuthority
resolveGenerationProofIdentity
receipt/marker clone/equality rules where domain-specific
```

into `IndexAuthorityCoordinator` / its proof collaborator.

Target:

```text
Context
    → supplies primitive adapters/state stores

IndexAuthorityCoordinator
    → decides generation authority itself
```

No second authority coordinator.

Stopping condition: authority coordinator tests exercise authority decisions
without constructing a live `Context`; warm proof, marker ABA, navigation token,
and publication fixtures unchanged.

### 8.9 Move policy publication orchestration (L)

After 8.8, so the authority owner already understands its own decision
semantics and this does not produce another callback-heavy façade inside the
coordinator. Split:

```text
IndexPolicyDocumentStore
    owns durable policy document bytes

IndexPolicyRuntimeService
    owns effective runtime policy

IndexAuthorityCoordinator
    owns whether/how policy binds to the current generation
    and publication acknowledgement semantics
```

Do not create a `PolicyPublicationCoordinator` unless evidence forces another
distinct owner. Preserve: v3/v4/v5 document interpretation, policy hash
computation, binding validation, committed-before-acknowledgement semantics,
runtime rollback on failed publication, generation binding rules.

Evidence note: at `95cc653` the coordinator had a runtime
`IndexPolicyPublicationError` import from `core/context`, not type-only imports;
`8737e8e` moved contracts/errors into the generation domain, so plan from the
current HEAD, not the stale checkpoint.

Stopping condition: publication receipts, committed-before-acknowledgement
semantics, and v3/v4/v5 document fixtures unchanged.

### 8.10 Index teardown workflow — LAST (XL)

Do not extract `clearIndex` while its dependencies are transitional. By now its
collaborators are: `IndexGenerationWorkflow`, `IndexAuthorityCoordinator`,
`IndexPolicyRuntime/DocumentStore`, `SynchronizerRegistry`, collection
naming/family owner, navigation lifecycle, source/checkpoint owner.

Introduce a Core `IndexTeardownWorkflow` that owns **ordering only**:

```text
fence mutation
→ withdraw authority as required
→ clear generation/vector artifacts
→ clear navigation lifecycle
→ clear checkpoint/synchronizer state
→ clear policy/runtime state
→ final durable proof
```

The exact order must come from the current implementation and F023/F024
regressions, not from this illustrative sequence. The workflow clears Core state
only — MCP-side warm/operation state (the 8.6 caches) stays with MCP owners
invoked by the MCP caller; Core must not reach MCP.

MCP calls through the existing Core operation boundary:

```text
ManageMaintenanceHandlers
    ↓
IndexMutationPort.clearIndex(...)
    ↓
IndexTeardownWorkflow
```

not by importing the workflow implementation directly.

Stopping condition: exact current teardown ordering and rollback/failure behavior
survives; no domain state has two writers; F023/F024 remain green.

### Execution order

| Order | Batch                                           | Risk |
| ----: | ----------------------------------------------- | ---- |
|  Gate | Phase 5–7 review corrections A–D                | M/L  |
|   8.1 | Private dead surface + API compatibility freeze | S    |
|   8.2 | Shallow ToolHandlers pass-through removal       | S    |
|   8.3 | Collection naming/family policy                 | M    |
|  8.4A | Workflow queue + receipt capability ownership   | L    |
|  8.4B | Navigation delta warm-state ownership           | L    |
|   8.5 | Operation-scoped write-target authority         | L    |
|   8.6 | PreparedReadCacheOwner                          | M/L  |
|   8.7 | InterruptedIndexRecoveryCoordinator             | M    |
|   8.8 | Authority decision bodies                       | L    |
|   8.9 | Policy publication orchestration                | L    |
|  8.10 | Index teardown workflow                         | XL   |

Stop and review after every L/XL batch, especially 8.4, 8.5, 8.8, 8.9, 8.10.

### Phase 8 endpoint

```text
Context
    = public compatibility/composition façade

ToolHandlers
    = MCP wiring/public request façade

mutable domain state
    = one demonstrated owner each

authority decisions
    = IndexAuthorityCoordinator

generation workflows
    = IndexGenerationWorkflow

read cache
    = PreparedReadCacheOwner

recovery
    = InterruptedIndexRecoveryCoordinator

teardown
    = composition of those owners, not another owner of their state
```

### 8.11 Explored and dismissed (recorded so they are not re-suggested)

- Payload probing + observation-token relocation (`context.ts`:1768–1809,
  3934–4013, 4459–4548): move is feasible (sidecar layout helpers already live
  in `symbols/`), but leverage is low while the code is stable. Revisit when the
  probe or observation format next changes.
- Completion-proof orchestration on the host: the leaf `completion-proof.ts`
  already owns validation; only ~80 lines of snapshot-recovery glue remain on
  ToolHandlers. Fold that glue into 8.7/8.10 if touched, otherwise leave.
- Path predicates: no duplication — the ToolHandlers predicates are aliases of
  `search-ranking-policy.ts` exports; the owner is correct.


## Phase 9 — Canonicalization and compatibility retirement

Status: planned, not implemented. Goal: every domain has ONE canonical current
implementation; legacy versions shrink to a tiny compatibility boundary (recognize
→ classify → requires_reindex / unsupported) or are rejected outright.
Version-awareness terminates at boundaries — workflows, coordinators, and search
must never branch on `schemaVersion` or import retired compatibility modules.

Depends on Phase 8 being sealed (the durable-floor decision lives in the authority
owner that 8.8/8.9 establish). Starts only after Phase 8 is sealed and reviewed.

### Phase 9 global rules

- Not every `v1`/`v2` string is dead code. Some are the CURRENT contract identity
  (`canonical_json_v1`, `relationship_manifest_v2`, `search_rerank_document_v4`,
  `SearchGroupedResultV2`). A `v1`/`V2` suffix says nothing about obsolescence.
- Deletion criterion: is there a supported input/output/runtime path that still
  requires this implementation?
  - No → delete.
  - Only to recognize obsolete persisted state → shrink to a decoder/rejection
    boundary.
  - Current stable identity → keep the identity; the implementation may become
    unversioned.
- Contract identity is frozen unless separately authorized: the current
  reranker request-contract SHA-256 is part of the active request identity.
  Retiring executable implementations must not change it.
- Public npm APIs keep semver compatibility until an explicitly authorized
  breaking Core release. Internal renames must preserve published names (keep
  export aliases or confine renames to unpublished internals).
- Persisted-format policy changes (retiring a durable format) require separate
  authorization; they are product decisions, not refactors.

### 9.0 Version-support inventory (S)

Search: `V[0-9]`, `-v[0-9]`, `_v[0-9]`, `formatVersion`, `schemaVersion`,
`previousVersion`, `LEGACY`, `deprecated`, profile IDs, policy IDs, and package
export barrels/maps — plus known filename families the suffix patterns miss
(`search-rerank-query-v2.ts`, `CodebaseSnapshotV1/V2/V3`,
`CallGraphSidecarInfo.version`, `SearchGroupedResultV2`).

Classify every hit: `wire/provider identity` | `durable disk format` |
`persisted operator/config state` | `public API` | `process-local/internal` |
`test-only`. Record current writer, current reader, and whether anything
actually selects it. `SATORI_LATEON_PROFILE`-style state is persisted
operator/config, not durable index format and not process-local.

Stopping condition: every versioned symbol classified with writer/reader/
selector evidence, including the named filename families above; the inventory
is recorded in the batch sheet, not guessed.

### 9.1 Retire old LateOn/runtime profiles (L)

Retired LateOn profiles are packaged runtime contracts, not durable index
generations. `runtime-profile-v1.json` is a checked-in packaged authority asset
carrying model identity, artifact digests, and runtime bounds. MCP/LateOn
runtime supports only the current profile; old explicit profiles fail with a
clear `unsupported_profile`-equivalent error instead of invoking old behavior.

Historical managed profile IDs may remain recognized exclusively at the CLI
upgrade/migration boundary so existing managed installations can be migrated to
the current profile; they must never become executable runtime profiles.

Stopping condition: no retired profile can execute in MCP/LateOn runtime
(rejection tests per retired profile); current-profile runtime fixtures and
current profile digest/identity unchanged; CLI upgrade migration fixtures for
historical managed profile IDs unchanged.

### 9.2 Canonicalize the rerank implementation

V4 currently imports implementation machinery out of the V2 module, and V3 is
built on V2 helpers. Do NOT delete V2/V3 files first.

#### 9.2A Extract canonical projection primitives (S/L)

Extract the neutral primitives out of the historical modules
(`search-rerank-document.ts` / `search-rerank-projection-validation.ts` /
`search-rerank-source-selection.ts`). Pure move/refactor only. No supported
route, projection bytes, request-contract fixture, or `requestContractSha256`
changes.

Stopping condition: current projection bytes and current request-contract SHA
byte-identical; suite green with no behavior delta.

#### 9.2B Retire executable historical document projections (L)

After 9.1 guarantees old LateOn profiles cannot execute:

- production search uses one canonical document projector;
- ToolHandlers has no V2/V3 projection dispatch;
- historical V3 fixture/policy material required solely to preserve the frozen
  current request-contract identity becomes inert contract evidence, not
  executable implementation;
- V2/V3 builders are deleted.

Stopping condition: current projection bytes unchanged; current
`requestContractSha256` unchanged; current LateOn profile digest/identity
unchanged; no executable V2/V3 document-projection route remains.

#### 9.2C Remove bounded-selector V1 (M)

Only after no executable supported path selects it (9.2B). Keep
`bounded_source_selection_v2` as the immutable current identity, but expose one
unversioned implementation (`selectBoundedSource(...)` → one canonical
algorithm; the CRLF legacy branch disappears).

Stopping condition: selector V2 fixtures unchanged; no legacy selection branch
remains.

#### 9.2D Canonicalize query projection routing (L)

Inventory raw/v1/v2 query-projection identities first. Remove executable
historical query projection only where no supported provider path selects it.
Frozen request-contract evidence may retain historical fixture bytes without
retaining historical executable code.

Stopping condition: current query-projection bytes and request-contract SHA
unchanged; no executable historical query-projection route remains.

Terminology: production names become `SearchRerankDocumentInput`,
`SearchRerankDocumentResult`, `buildSearchRerankDocument()`. Keep a canonical
policy object — `SEARCH_RERANK_DOCUMENT_POLICY` with
`id: "search_rerank_document_v4"` and its full frozen policy semantics — not
merely a contract-ID constant, because the current request contract serializes
that policy. Internal renames only where names are unpublished.

### 9.3 Durable compatibility floor — separately authorized (XL)

Current policy authority accepts `satori_index_policy_v3/v4/v5` as readable
documents; `persisted-index-authority.ts` parses legacy fingerprint shapes
(`LEGACY_*_INDEX_FINGERPRINT_FIELDS`). Completion markers already model the
target pattern (V3 canonical; V1/V2 minimally recognized → `requires_reindex`).

Proposed policy (requires explicit product authorization — it forces a one-time
reindex on upgrade):

```text
full semantic reader/validator → V5 only
retired-version classifier    → recognizes V3/V4 enough to return requires_reindex
writer                        → V5 only

recognized old generation     → requires_reindex (never "corrupt")
unknown malformed             → corrupt
```

Target: policy documents V5-only writer/validator; current completion marker
V3; current full fingerprint only. This supersedes the v3/v4/v5 document
fixtures pinned by Phase 8.9 — the batch sheet must explicitly replace those
oracles with rejection tests.

Do not proceed without authorization. Risk XL (persisted-format policy change).

### 9.4 Delete resulting dead assets (S)

Old runtime-profile fixtures, historical active branches, old builder tests,
and compatibility utilities go. Keep a small set of rejection tests proving an
old profile/index receives the intended unsupported/requires_reindex result.

Stopping condition: no dead production path references retired versions; all
retired versions have rejection coverage.

### 9.5 Architecture guard (M)

Version/compatibility parsing may exist only in explicitly designated boundary
modules (codec / profile-loader / compatibility). Production
workflow/coordinator/search modules may not import retired compatibility
modules or branch on persisted schema/profile generations.

The guard is structural — dependency boundaries and a classified deny-list of
retired modules — NOT a regex on V1/V2/V3 naming. Active types such as
`SearchGroupedResultV2` must pass. Add the guard with the first boundary that
exists (eslint rule or architectural test).

Stopping condition: the guard exists, fails on a planted violation (retired
module import), and passes on active versioned types; current suite green.

### Post-Phase-9 architecture rebaseline (review input, not an authorized phase)

After Phase 9, reread the surviving architecture from current source. Do not
carry today's decomposition assumptions forward without evidence. Ask:

1. Which abstractions now have only one trivial implementation?
2. Which coordinators own no state or invariant and merely forward calls?
3. Which ports exist only because an older `Context`/`ToolHandlers` boundary
   required them?
4. Which parameter groups always travel together and should become operation or
   session data?
5. Which mutable values are operation-local rather than application-global?
6. Which public exports are accidental rather than established contract?
7. Which workflows can become explicit data pipelines?

The likely simplification candidates are hypotheses to test after the rebaseline,
not commitments made now:

```text
SearchRequest
    → PreparedSearchRequest
    → RetrievedSearch
    → RankedSearch
    → FrozenSearchResult
    → Response

prepareIndexMutation()
    → IndexMutationSession
    → execute(session)
```

An operation/session candidate may bind root, generation, operation ID,
collection, policy, lease, and receipts once, but only if those values already
form one lifecycle boundary. Prepared reads may use the same principle when the
post-Phase-9 evidence shows a genuine operation/session invariant.

Potential flattening must be evidence-led:

```text
Coordinator → Port → Adapter → single concrete Owner
        may become
Coordinator → Owner
        or
workflow function → Owner
```

Flatten only when the removed layers own no independent state, invariant,
lifecycle, transaction, or external variability. Preserve the canonical owner
and its proofs when they do.

Phase 9 itself remains deliberately narrow: remove historical executable
variants and converge on one canonical internal model. Compatibility parsing
stays at the boundary, followed by the canonical model and one implementation;
do not widen the public API by exporting every neutral helper created during
canonicalization. Do not turn Phase 9 into the search-pipeline or mutation-
session redesign.

### Recommended aggressiveness for Satori

```text
runtime/provider compatibility → latest only
rerank projection              → latest only
query projection               → latest only
bounded selector               → latest only
process-local caches           → latest only
durable disk state             → current generation supported;
                                 recognized old → requires_reindex
                                 (separately authorized)
public npm API                 → semver until an authorized breaking release
```

The reranker cleanup (9.1/9.2) is first: clearest payoff, least durable-state
risk.


## Test migration policy

There is no final “test split” phase. Each production extraction owns its test move.

Keep public integration oracles while adding owner-level contracts. Suggested
destinations include:

- generation proof;
- publication/read/retention;
- policy runtime;
- policy document store;
- durable restoration;
- repair/full index;
- synchronizer registry;
- source readiness/handoff;
- prepared publication reads;
- search request/continuation;
- sidecar read/write lifecycle;
- Python resolution engine;
- CLI mutation, inspection, selection, planning, and application.

Do not weaken, delete, or rewrite expected behavior merely to permit a move.

## Architecture guardrails after extraction

Add checks only after the target boundary exists:

- no new mutable domain state in `Context`;
- no raw Context/vector/persistence capabilities in new MCP handler hosts;
- only the approved authority owner writes generation/marker/policy/navigation
  activation state;
- new domain services may not depend on broad `Context`;
- enforce `Context → domain coordinator → narrow stores/ports` and MCP coordinator
  → Core public/narrow port imports; reject Core → MCP imports;
- when a target boundary first exists, add an enforceable import/ownership check in
  that same batch before relying on the boundary as an invariant;
- public façade exports remain stable;
- size/complexity metrics remain reporting signals, not hard gates.

## Completion criteria

The decomposition is complete only when:

1. every mutable domain has one named authoritative owner;
2. F023/F024 are closed before their code is moved;
3. F021/F022 behavior remains closed without full serialization or a speculative
   completion marker;
4. `Context` delegates established APIs and owns no new domain state;
5. MCP mutation/read/search coordinators use bounded contracts;
6. all package tests/typechecks and affected contract manifests pass;
7. public exports and persisted formats remain compatible;
8. each batch is independently reviewable and, when commit authorization exists,
   independently committed;
9. no unrelated user work is staged, modified, or committed.

## Recommended next implementation batch

At checkpoint `cec0d14`, start with Phase 2.1: complete the sidecar read boundary.
Derive a current-HEAD batch sheet naming the exact shared generation/seal helpers,
seal verification and generation resolution, symbol-registry reads, relationship
reads, and affected contract tests. Keep sidecar-specific rollback, replace, and
write lifecycle behavior with its existing owner.
