# Satori Post-Phase 9 ROI Roadmap

> **Core Governance Rule:**
> **Architecture work requires a measurable hypothesis. LOC reduction, file count, coordinator count, graph centrality, or cognitive complexity alone are NOT sufficient justification for an engineering phase.**
>
> Every proposed initiative must define:
> `measurable problem / product goal | disproving check / baseline metric | bounded acceptance condition`
>
> **Candidate bets are hypotheses, not executable plans. A candidate becomes authorized only after a phase-specific experiment plan records its measured baseline, disconfirming condition, and bounded acceptance threshold.**

**Status:** Authoritative Post-Phase 9 Master Roadmap  
**Parent Baseline Commit:** `0121875` (*fix(generation): complete Phase 9 authority invariants and source checkpoint lifecycle*)  
**Reviewed Baseline HEAD:** `0142d97` (*fix(lint): remove unreachable code in index workflow and unused test constant*)  
**Target Packages:** `@zokizuan/satori-core`, `@zokizuan/satori-mcp`, `@zokizuan/satori-cli`

---

## 1. Mission & Conceptual Model

Improve real developer/agent value and operational reliability while preserving proven generation, authority, and source-freshness correctness.

* **Conceptual Model**: A searchable Satori state is a **proven publication of generation-bound vector, navigation, policy, and source-freshness evidence under one logical authority**. No individual durable store or generated projection independently determines currentness.
* **Architecture Boundary**: This concept defines our mental model and invariants—it does **NOT** authorize creating new abstract software layers (`IndexPublication`, `PublicationManager`, etc.) unless evidence demonstrates an unavoidable need.

---

## 2. Invariants & Compatibility Gates

### Phase 9 Safety Invariants (`0121875` Baseline)
All future work must preserve the invariants proven at `0121875`:

1. **One Synchronizer Lifecycle**: Deferred full indexing maintains a single file synchronizer lifecycle.
2. **Exact Source Revalidation Before Commit**: Full index checkpoint must assert exact observation currentness immediately prior to canonical authority commit.
3. **Unified Post-Commit Promotion**: Staged checkpoints and navigation generation pointers are promoted only after canonical authority is durable.
4. **Disposable Staged Failure Cleanup**: Indexing failures clean up only disposable staged collections; proven prior generations remain intact on `limit_reached` or failure.
5. **No Checkpoint Mutation Capability Leak**: `IndexCodebaseResult` exposes read-only evidence, not mutable checkpoint capabilities.
6. **Race Safety / Fail-Closed on Source Drift**: File modifications during full indexing fail closed before canonical publication, preserving data integrity.

### Current Compatibility Gates
* Unrelated refactors must preserve the current rerank request contract byte-for-byte (`packages/mcp/assets/lateon/rerank-request-contract-v1.json` with `contractSha256: f4e8ec82841f0496a592246008fc7bd05e61a66b4d482ef74b11db0e3fa3dd5d`) and pass `pnpm -C packages/mcp contract:check`.
* Intentional contract evolution requires a separately authorized, versioned contract change.

---

## 3. Active Authorized Execution Sequence

```text
┌─────────────────────────────────────────────────────────────┐
│ R0 Qualification & R1 Structural Baseline                   │
│   • Verify clean typecheck, full package tests, contracts   │
│   • Document static imports vs. runtime IoC callbacks       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ R2: FullIndexOperation Extraction                           │
│   • Extract startBackgroundIndexing + launch into operation │
│   • Single owner for run, detached error, & lease release   │
│   • Atomic handoff: launch() return transfers ownership     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
═══════════════════════════════════════════════════════════════
                 PRODUCT / ROI EVIDENCE GATE
═══════════════════════════════════════════════════════════════
                               │
                [ Choose ONE Highest-Value Bet ]
                               │
  ┌────────────────────────────┼────────────────────────────┐
  ▼                            ▼                            ▼
Bet A: Zero-Friction         Bet B: Polyglot              Bet C: ACID
Semantic Search Activation   Relationship Intelligence    Control-Plane SQLite
```

---

### Step 1: R0 Qualification & R1 Structural Baseline

* **Purpose**: Establish verified branch health and structural baseline.
* **Verification Gate**:
  ```bash
  git status --short
  git diff --check
  pnpm run check
  pnpm --filter @zokizuan/satori-core test
  pnpm --filter @zokizuan/satori-mcp test
  pnpm --filter @zokizuan/satori-cli test
  pnpm -C packages/mcp contract:check
  ```
* **Structural Reality**:
  * `@zokizuan/satori-core` has **zero** imports from `@zokizuan/satori-mcp`.
  * `assertMutationCurrent` is an **Inversion of Control (IoC)** callback injected by MCP's `MutationLeaseCoordinator` into Core's `IndexMutationPort`, not an illegal package dependency.

---

### Step 2: Phase R2 — `FullIndexOperation` Extraction

* **Plan File**: [`docs/superpowers/plans/2026-08-14-r2-mcp-full-index-operation.md`](../superpowers/plans/2026-08-14-r2-mcp-full-index-operation.md)
* **Problem**: `ManageIndexingHandlers` mixes request-level admission with background full-index lifecycle orchestration and detached promise rejection handling (Cyclomatic 83, Cognitive 248).
* **Bounded Scope**:
  1. `ManageIndexingHandlers` performs request-level admission, path validation, runtime-owner gating, already-indexed decisions, reindex preflight, remote collection deletion, and lease acquisition.
  2. At the launch boundary, the acquired `RootMutationLease` is transferred to `FullIndexOperation.launch(input)`.
  3. `FullIndexOperation.launch()` has atomic acceptance semantics: normal return means it fully owns detached execution, rejection handling (`.catch`), failure persistence, and terminal `mutationLeaseCoordinator.release(lease)`. A synchronous throw means no detached work was retained and caller cleanup remains authoritative.
  4. The request-level `leaseTransferred` guard remains in `ManageIndexingHandlers`, becoming `true` only after `launch()` returns normally.
  5. The existing `startBackgroundIndexing` host override seam is preserved for testability.
* **Stopping Condition**: Background full-index lifecycle, detached failure handling, and terminal lease release have one explicit per-run owner; public behavior, override seams, and compatibility paths are unchanged; all authority/race/contract tests pass. Complexity reduction is recorded as a secondary outcome, not an acceptance criterion.

---

## 4. Product / ROI Evidence Gate (Post-R2)

**No additional architecture phase is pre-authorized after R2.** 

Upon completing R2 and standard release qualification (`pnpm run release:check`), the next initiative is selected from competing candidate bets based on measured real-world friction, reliability problems, or product value:

```text
Measure:
1. Real-World Discovery (tested on a handful of real/unseen repositories):
   - Where does Satori actually fall short on real code maintenance and navigation questions?
   - Did relationship/navigation evidence materially help vs. lexical search?
2. Product Activation Friction: Time from install → MCP startup → first useful semantic search result.
3. Failure Diagnostics: Frequency and cause of indexing, provider, or lease recovery errors.
4. Language Quality: Baseline precision and recall of code navigation across supported languages.
5. Coordinator Friction: Actual engineering hours blocked by search coordinator complexity.
6. Persistence Tax: Runtime bugs or complexity traceable to mutable SnapshotManager JSON files.
```

---

## 5. Candidate ROI Bets (Compete for Next Phase)

### Candidate Bet A — Zero-Friction First Useful Search
* **Hypothesis**: Provider configuration materially increases time-to-first-useful-semantic-search or causes activation failure.
* **Target Scope**: Embedded local embedding model defaults or graceful lexical-first progressive search activation.

### Candidate Bet B — Polyglot Relationship Intelligence
* **Hypothesis**: Upgrading one currently `symbol_only` language (Go, Java, Rust, C#, C++, Scala) to qualified relationship navigation materially improves cross-file and member-call navigation quality on representative repositories.
* **Target Scope**: Implement and benchmark a qualified relationship resolution provider for Go or Java against baseline precision/recall on unseen repositories.

### Candidate Bet C — ACID Control-Plane SQLite
* **Hypothesis**: Replacing mutable `SnapshotManager` JSON persistence with SQLite transactions can eliminate application-managed snapshot locking/merge paths and reduce crash/contention failure modes while preserving existing generation authority and fencing semantics.
* **Target Scope**: Prototype only the mutable MCP control state currently owned by `SnapshotManager`:
  - Repository lifecycle and status
  - Durable operation receipts and phases
  - Tombstones and runtime bookkeeping
* **Explicitly Excluded Initially**: Core generation authority, vector generation payloads, LanceDB storage, navigation generation artifacts, source-freshness proof semantics, and mutation fencing semantics.

### Candidate Bet D — Search Control-Flow Linearization
* **Status**: **Dormant**.
* **Activation Condition**: Activate only if measured evidence shows that `SearchRequestCoordinator` orchestration materially blocks ranking/retrieval experiments, increases regression frequency, or dominates search feature development time.
* **Until Then**: Do not refactor it.

### Candidate Bet E — Context Façade Attrition (Opportunistic)
* **Policy**: No standalone "Context refactoring phase." New and modified first-party code binds directly to domain owners or narrow exported ports (`IndexMutationPort`). `Context` remains the frozen 79-member external compatibility façade and shrinks over time through standard development attrition.

---

## 6. Continuous Test Strangler Policy

* **Rule**: Do NOT create a standalone "Test Refactoring Phase."
* **Policy**:
  1. No new behavior tests may be added to [`handlers.scope.test.ts`](../../packages/mcp/src/core/handlers.scope.test.ts) (~14k LOC) or [`context.test.ts`](../../packages/core/src/core/context.test.ts) (~12k LOC) unless testing those specific façades.
  2. Whenever a domain is substantially modified during an authorized bet, write focused tests in dedicated domain test suites (e.g., [`manage-indexing-handlers.test.ts`](../../packages/mcp/src/core/manage-indexing-handlers.test.ts) or `full-index-operation.test.ts`).
  3. Legacy monolithic test files will naturally starve and shrink over time.

---

## 7. Operating Cadence: Rebaseline & Stop

After every authorized bet:
1. Run relevant tests + normal release qualification (`pnpm run release:check`).
2. Inspect the diff.
3. Merge / rebaseline.
4. Stop before authorizing more architecture.

---

## 8. 2026-09-22 Session Handoff — Ownership Finish Line and Deferred Frontier

**Date:** 2026-09-22
**Purpose:** Preserve the decisions, evidence, and intentionally deferred work from the current Satori development session so the next session can resume from an explicit frontier instead of rediscovering the same reasoning.
**Status:** Handoff record and future-work map. This section is **not blanket implementation authorization** for the deferred tracks below. Each track still requires a fresh evidence/plan gate before mutation.
**Authoritative supporting references:**
- `docs/architecture/LANGUAGE_INTELLIGENCE.md`
- `docs/plans/CBM_BORROWABILITY_MASTER_PLAN.md`
- `evals/semantic-relationship-qualification/README.md`
- the 2026-09-22 behavioral-search benchmark/diagnosis artifacts under the session's `/tmp/opencode/satori-b1*` and `/tmp/opencode/satori-b3*` paths when they are still locally available.

#### State snapshot at handoff creation

This record was written while:

- current `master` was `b99d08e9c8005e691159a1755b2b0822bbf2fc3a` (`fix(core): recover strong lexical fallback candidates`);
- the package-ownership candidate was isolated on `agent-p/package-ownership-foundation`;
- the ownership candidate chain was:
  - `2c091330c4bc36f8641ab2c8db6b2fef2b444860` — `feat(core): persist package ownership`;
  - `a10150509839cfd6ebe0d2ae1928e0d35c47c14a` — `fix(core): harden package ownership publication`;
  - `fe415eecb1d4ba3a1dfaddd87ae13545a82c46d2` — `fix(core): seal package ownership publication`;
- final independent ownership re-review was still pending;
- P3 package architecture had not started.

These hashes are historical anchors for this handoff. The next session must trust the then-current integrated `master`, not assume these hashes are still the live frontier.

### 8.1 What this session was about

This session deliberately moved through two product goals before stopping:

1. **Close demonstrated search/navigation correctness gaps instead of continuing speculative reranker tuning.**
   - Exact-reference evidence and language aliases were exposed cleanly.
   - `call_graph.path` became a hard graph/evidence boundary.
   - A fresh Colonist benchmark showed that the important behavioral-search failure was **retrieval recall**, not reranker ordering.
   - The high-signal lexical fallback defect was repaired with a tiny bounded discovery prefix; the previously unreachable `src/page/bridge.ts` publisher became reachable and finished at rank 3 in the live acceptance replay.
   - The benchmark also identified two separate lower-priority search-policy questions that were intentionally **not** folded into that repair: weak-signal candidates below the production fallback cutoff, and final disclosure losses from `file_diversity_cap`.

2. **Build factual package ownership before attempting package-aware architecture.**
   - The ownership foundation persists package/workspace facts and file-to-package ownership in the same immutable Publication generation as search/navigation state.
   - Independent review found and drove repairs for root-package discovery, semantic sidecar integrity, workspace-control sync transitions, and root-confined workspace globbing.
   - A final sealing repair binds the exact canonical ownership snapshot to immutable Publication descriptor evidence so complete and partial Publications cannot silently accept a substituted ownership snapshot.

The intent is to finish the ownership review/integration and one bounded **P3 package-architecture projection**, then stop this session. The larger items below are carry-forward work for the next development session.

#### Condensed execution chronology

```text
C2  exact-reference evidence summary + language alias normalization
    -> integrated/reviewed

C3  hard nested path scope for call_graph
    -> integrated/reviewed

B1  fresh behavioral search benchmark on Colonist
    -> reranker defect refuted; retrieval-recall defect identified

B2  read-only root-cause diagnosis
    -> strong lexical candidate was being filtered before fusion;
       separate weak-signal cutoff cases identified

B3  bounded strong lexical fallback discovery
    -> integrated/reviewed/live-validated;
       bridge publisher absent -> final rank 3

P1  persisted package ownership foundation
    -> independent review found persistence/sync/path-integrity gaps

P2+ repairs
    -> root package + semantic validation + sync transitions + glob confinement
    -> exact ownership snapshot sealing added after the next review found
       remaining substitution and character-class escape cases

R6  final independent ownership review
    -> pending at the time this handoff section was written

P3  factual package-aware architecture projection
    -> intended final implementation mission of this session
```

This chronology matters because several deferred items were **separated by causal evidence**. The next session should not merge them back into one generic “search quality” or “graph intelligence” effort.

### 8.2 Current-session stop boundary

As recorded on 2026-09-22, the intended final sequence for this session is:

```text
Package ownership candidate
    |
    v
independent final re-review
    |
    v
integrate ownership foundation
    |
    v
P3: package-aware architecture projection
    |
    v
independent review + integration
    |
    v
STOP CURRENT SESSION
```

P3 should consume persisted ownership rather than rediscovering packages from the filesystem. Its bounded purpose is to make factual package structure useful to architecture queries, for example:

- list factual packages/workspace membership;
- map indexed files/symbols to their owning package;
- aggregate existing relationship evidence into package-to-package dependencies;
- distinguish repository-level/unowned files;
- preserve exact Publication/path-scope and coverage semantics.

P3 should **not** infer subjective layers such as “UI”, “domain”, “service”, or “persistence” unless a separate future evidence-backed feature explicitly defines those semantics.

### 8.3 Deferred frontier overview

The following tracks are intentionally deferred beyond P3:

| Track | Status after this session | Why deferred | Future intent |
| --- | --- | --- | --- |
| TypeScript: combine Satori + CBM semantic strengths | **Deferred / high-value next-session candidate** | Current TypeScript already has production OXC structure and conservative Satori `calls_v0`; replacing it blindly would risk regressions. Upstream CBM has a richer TypeScript hybrid resolver that should be evaluated as a semantic contributor, not assumed superior everywhere. | Keep OXC/Satori as the canonical structural lane while selectively admitting CBM TypeScript semantic evidence through Satori's neutral evidence/admission boundary. |
| Bounded generic graph/path querying | **Deferred** | Package ownership/architecture should land first so future graph queries can operate on stable symbol/package facts. A full Cypher port is explicitly unwanted. | Build a read-only, capped path/trace surface over Satori's existing navigation graph, with hard Publication/path scope, edge-kind filters, budgets, and truthful coverage. |
| Weak-signal retrieval cutoff | **Deferred** | B2 proved `request` (~fallback rank 146) and `boardCommandStillLegal` (~105) are a different failure class from the fixed bridge defect; they are below the product fallback top-K rather than incorrectly filtered. | Measure whether important owners systematically sit just below candidate budgets, then design the smallest bounded recovery lane. Do not globally raise depth/budgets without evidence. |
| `file_diversity_cap` disclosure policy | **Deferred** | `send` and `executeBoardAction` were retrieved and reranked correctly, then dropped during final grouped disclosure. This is not a retrieval or reranker defect. | Evaluate answer completeness vs. redundancy and decide whether disclosure should become owner-aware/query-aware or expose complementary sibling results differently. |
| Multi-ecosystem package ownership | **Deferred / conditional** | Node workspace ownership is enough for the immediate P3 target and is a valid versioned v1. Expanding ecosystems during P1 would have enlarged the persistence contract without a demonstrated consumer. | Add Go/Rust/other package ecosystems only when architecture use cases require them; keep architecture consumers generic over package root/identity/file ownership. |
| Behavioral reranker changes | **Cancelled unless new evidence appears** | The 2026-09-22 benchmark showed that owners which reached the reranker were generally ordered well; the demonstrated bridge failure happened before reranking. | Do not reopen reranker tuning merely because a search result is missing. First prove a ranking defect with admitted candidates. |
| Unbounded/full Cypher graph engine | **Rejected direction** | High implementation/operational cost and unnecessary for the agent-facing questions Satori is targeting. | Prefer a bounded `query_graph`/path-trace surface over existing navigation storage. |

### 8.4 Deferred Track A — TypeScript “best of both worlds”: Satori OXC + CBM semantic resolution

#### Current reality

Satori's current TypeScript/JavaScript production path is:

- **OXC** for structural analysis and Satori symbol identity;
- Satori's existing **syntactic relationship resolver** for the currently qualified `calls_v0` slice;
- existing production test-reference support;
- one Publication-bound symbol/relationship graph.

Upstream CBM separately contains a substantial TypeScript/JavaScript hybrid resolver at:

`codebase-memory-mcp/internal/cbm/lsp/ts_lsp.c`

and supporting project/path-alias/cross-file infrastructure. That resolver contains semantics Satori's current conservative TypeScript path does not claim broadly, including richer receiver typing, overload selection, generic receiver substitution, aliases/origins, namespace/member behavior, and configured-project context.

The future goal is **not “replace Satori TypeScript with CBM TypeScript.”** The goal is to preserve the best proven properties of both.

#### Target architecture hypothesis

```text
                         TypeScript / TSX / JavaScript source
                                      |
                    +-----------------+-----------------+
                    |                                   |
                    v                                   v
        SATORI STRUCTURAL LANE                 CBM SEMANTIC LANE
        ----------------------                 -----------------
        OXC parser/analyzer                    CBM TS hybrid resolver
        canonical symbols                      receiver/type evidence
        exact byte spans                       overload candidates
        lexical ownership                      aliases/origin flow
        import/export facts                    project/path-alias context
        current direct syntactic calls         richer member-call evidence
        current test references                ambiguity/unresolved evidence
                    |                                   |
                    |                                   |
                    +-----------------+-----------------+
                                      |
                                      v
                         NEUTRAL SATORI EVIDENCE
                  SemanticProjectEvidence / ResolutionClaim
                  provider provenance preserved explicitly
                                      |
                                      v
                         CENTRAL ADMISSION BOUNDARY
                  exact caller/target SymbolRegistry binding
                  build/project authority checks
                  ambiguity and conflict -> abstain/fail closed
                                      |
                                      v
                    DETERMINISTIC EDGE MERGE / DEDUP
                  one Publication-bound relationship graph
                                      |
                                      v
                         CAPABILITY QUALIFICATION
                  calls_v0 remains the current floor
                  receiver/type-aware promotion only after eval
```

#### Design rules to preserve

1. **OXC remains the structural authority unless evidence justifies changing it.**
   Satori already has mature TypeScript symbol identity, source spans, namespaces/signatures, search projections, and test-reference behavior. A semantic resolver should not silently redefine those identities.

2. **CBM contributes semantic proof, not a second competing graph.**
   CBM-derived results should enter the existing neutral semantic/evidence contract and central relationship admission, then produce ordinary Satori relationships only after registry-bound validation.

3. **Provider identity is provenance, not precedence.**
   “CBM says so” and “Satori says so” are not ranking rules. Exact target/caller binding, candidate ambiguity, project authority, and the admitted proof class determine whether an edge is safe.

4. **Duplicate observations collapse to one relationship.**
   If the current syntactic lane and CBM semantic lane prove the same call, publication should contain one canonical edge with sufficient provenance/evidence rather than duplicate CALLS edges.

5. **Disagreement should fail closed at the semantic frontier.**
   For receiver/dynamic/overload cases, conflicting or multi-candidate evidence must not be resolved by arbitrary provider priority.

6. **TypeScript build context becomes freshness-bound evidence.**
   `tsconfig.json`, project references, path aliases, and any other semantic control needed by the CBM TypeScript lane must be observed as Publication inputs so semantic edges cannot outlive the configuration that proved them.

7. **Qualification precedes public promotion.**
   Use `evals/semantic-relationship-qualification/` and TypeScript-specific overlays for:
   - class-field receivers;
   - constructor parameter properties;
   - assignment/origin flow;
   - aliases;
   - optional receivers;
   - inheritance/interface dispatch;
   - overload ambiguity;
   - branch-conflicted origins;
   - unresolved/dynamic constructs;
   - tsconfig/path aliases;
   - project references;
   - generic receivers and structural-typing decoys.

8. **Keep capabilities separable.**
   Search eligibility, structural symbols, imports/exports, `calls_v0`, test references, and future `type_receiver_aware` claims should remain independently qualified.

#### Suggested next-session phases

```text
TS0  Characterize current Satori vs upstream CBM on the shared qualification corpus
  |
  v
TS1  Define the neutral evidence adapter for CBM TypeScript
     (no public behavior change)
  |
  v
TS2  Run both providers in qualification/shadow mode
     compare coverage + false positives + disagreements
  |
  v
TS3  Admit only evidence-backed semantic cases through central admission
  |
  v
TS4  Re-run real repositories and qualification corpus
  |
  +---- evidence insufficient / regressions ----> keep current Satori calls_v0
  |
  v
TS5  Promote a bounded receiver/type-aware slice only if proven
```

A future implementation should resist the temptation to port CBM's whole TypeScript subsystem wholesale. Vendor or adapt only the dependency closure needed for the qualified semantic cases.

### 8.5 Deferred Track B — bounded generic graph/path querying

The previous CBM review already concluded that Satori should **not** port a full Cypher engine. The useful missing capability is a bounded, read-only graph-query surface over the existing Publication navigation data.

The intended progression is:

```text
existing symbols + CALLS/IMPORTS/EXPORTS/... relationships
                        |
                        +---- package ownership / P3 package rollups
                        |
                        v
                bounded graph/path engine
                        |
          +-------------+--------------+
          |                            |
          v                            v
   source -> target paths       bounded neighborhood
   shortest/simple paths        filtered multi-hop trace
          |                            |
          +-------------+--------------+
                        |
                        v
                MCP projection/tooling
```

Minimum contract principles:

- read-only;
- Publication-bound;
- requested `path` is a hard result/evidence boundary, reusing the C3 scope model;
- explicit allowed relationship kinds;
- explicit source/target symbol or package identities rather than free-form graph-language text;
- deterministic max depth;
- deterministic node/edge/path budgets;
- cycle handling;
- stable paging/continuation identity;
- coverage/truncation honesty;
- no result must mean “no path found within the requested bounded evidence,” not “proof no path exists anywhere”;
- no arbitrary mutation clauses, procedures, filesystem access, or unbounded expressions.

The first useful product primitive may be narrower than “generic query”: for example a `trace_path` / shortest-path query across selected relationship kinds. The next session should prove which agent questions require more generality before expanding the surface.

### 8.6 Deferred Track C — weak-signal retrieval cutoff

The 2026-09-22 benchmark separated two retrieval failure classes.

The fixed class was:

```text
strong lexical fallback candidate
    -> incorrectly constrained to dense-discovered files
    -> never reaches fusion
```

B3 repaired that with the intentionally tiny strong-fallback discovery prefix.

The still-deferred class is:

```text
dense miss
    +
primary conjunctive lexical miss
    +
OR lexical fallback has some evidence
    +
candidate rank below product fallback top-K
    -> candidate never becomes a production fusion input
```

Known examples from the benchmark:

- `DecisionWorkerClient.request`: diagnostic fallback approximately rank 146;
- `boardCommandStillLegal`: diagnostic fallback approximately rank 105;
- product fallback budget in that experiment: top 80.

These should **not** be “fixed” by simply raising all candidate depths. Dense depth 160 already failed to recover the relevant semantic match, and diagnostic-only lanes are intentionally not production fusion inputs.

Future investigation should answer:

1. Are important implementation owners regularly concentrated just below the fallback cutoff, or were these isolated support-symbol misses?
2. Would recovering them materially improve answer completeness beyond already surfaced sibling/owner results?
3. Can a bounded second-chance rule use stronger evidence than raw fallback rank alone?
4. Can owner/file evidence, exact identifiers, package context, or relationship evidence recover these cases without broad candidate growth?
5. What is the latency/reranker-pool effect?

Possible hypotheses to evaluate—not pre-authorized solutions—include:

- a tiny second-chance lexical lane for high-specificity identifier/owner evidence;
- bounded owner/file recovery once another chunk from the same factual owner/package is already supported;
- adaptive fallback admission based on evidence strength rather than a globally larger top-K.

Do not change the current global candidate budget until an experiment demonstrates that budget itself is the right owner.

### 8.7 Deferred Track D — `file_diversity_cap` disclosure policy

This is a **disclosure policy** question, not a retrieval or reranker question.

The benchmark observed examples such as:

- `send`: retrieved and reranked, then removed during grouped -> disclosed selection;
- `executeBoardAction`: likewise available upstream, then removed by `file_diversity_cap`.

The current cap exists to prevent one file from flooding the final answer. That remains a valid product goal. The unresolved question is whether the cap sometimes removes **complementary sibling owners/functions from the same file** that are necessary to answer a multi-part behavioral question.

The next-session experiment should compare:

- answer completeness;
- duplicate/redundant result rate;
- serialized context size;
- distinct file count;
- distinct symbol/owner count;
- whether removed siblings add genuinely new behavior.

Potential policy shapes to evaluate:

- owner-aware rather than raw file-count diversity;
- a small reserved slot for a complementary sibling when evidence shows a different behavior role;
- query-aware diversity for explicitly multi-part behavioral questions;
- keep the cap but expose the next sibling through continuation/evidence rather than initial disclosure.

Do not weaken the cap based only on one observed removed row.

### 8.8 Deferred Track E — multi-ecosystem package ownership

The ownership foundation intentionally starts with Node facts:

- root `package.json`;
- `pnpm-workspace.yaml`;
- `package.json` workspaces;
- workspace member manifests;
- nearest factual file owner.

This is enough for Satori's own monorepo and for P3.

Future ecosystem support should preserve a **generic consumer contract**:

```text
package identity
package root
manifest/control identity
workspace/project membership
file -> package ownership
```

Architecture/query consumers should not contain Node-specific logic merely because v1 discovery is Node-only.

Only add Cargo/go.mod/Maven/Gradle/.NET/etc. ownership when a concrete architecture consumer and representative fixtures establish the semantics. Existing Go/Rust auxiliary semantic controls are useful evidence sources, but they should not automatically be promoted into package ownership without defining factual ownership/workspace rules.

### 8.9 Explicitly dormant/rejected work

These decisions should survive into the next session unless new evidence overturns them.

#### Behavioral reranker rewrite/tuning — dormant

Do not schedule a reranker mission merely because a result is missing. The current benchmark showed that admitted relevant owners were generally ordered well and that the demonstrated q3 failure happened upstream.

Reopen only when a controlled benchmark shows:

```text
relevant candidate reaches reranker
    +
reranker systematically demotes it below weaker evidence
```

#### Global dense-depth increase — rejected as a default repair

The q3 bridge owner remained absent at diagnostic dense depth 160. More depth is not a substitute for understanding retrieval-lane evidence.

#### Global fallback-budget increase — unproven

The weak-signal cases expose a cutoff, but there is not yet evidence that globally raising the budget is the best quality/latency trade.

#### Full Cypher port — rejected

Use bounded Satori-native graph/path primitives instead.

#### Semantic “layer” inference — deferred

Package ownership and P3 should stay factual. Inferred architectural roles such as “domain”, “service”, “UI”, or “persistence” need their own explicit ontology/evidence contract if ever added.

### 8.10 Proposed next-session ordering

This ordering is a **resume hypothesis**, not authorization. Re-check it against the integrated P3 baseline before execution.

```text
NEXT SESSION START
      |
      v
N0  Rebaseline master after ownership + P3
    read this handoff + LANGUAGE_INTELLIGENCE + CBM plan
      |
      v
N1  TypeScript Satori+CBM qualification/design
    (largest semantic-quality opportunity)
      |
      v
N2  Bounded graph/path querying
    (consume stable symbol + package architecture evidence)
      |
      +-----------------------------+
      |                             |
      v                             v
N3  Weak-signal cutoff study    N4  File-diversity disclosure study
    retrieval policy                final-result policy
      |                             |
      +--------------+--------------+
                     |
                     v
N5  Conditional follow-ups only when evidence justifies:
    - multi-ecosystem package ownership
    - receiver/type-aware public promotion
    - richer graph query surface
    - any reranker/disclosure expansion
```

N3 and N4 are intentionally independent: retrieval admission and final disclosure have different causal owners and should not be bundled into one search-quality patch.

### 8.11 Next-session resume checklist

Before starting implementation in the next session:

1. Verify final `master`, clean working tree, and the integrated ownership/P3 commits.
2. Re-read this dated handoff rather than relying on conversational memory.
3. Re-read `docs/architecture/LANGUAGE_INTELLIGENCE.md` before TypeScript semantic work.
4. Re-read the relevant CBM implementation at the exact local/upstream revision before borrowing code; do not assume this 2026-09-22 snapshot is still current.
5. Use the semantic relationship qualification corpus as the neutral comparison boundary for Satori vs. CBM TypeScript.
6. Keep provider output separate from central admission and public capability claims.
7. For search-policy tracks, reproduce the relevant benchmark behavior before changing budgets/policies.
8. For graph work, preserve Publication identity, hard path scope, boundedness, and truthful coverage.
9. Run an independent review gate for persistence/public-contract/semantic-provider changes before integration.
10. Stop after each evidence-backed mission; do not treat this deferred list as a mandate to implement every item.

### 8.12 Why this handoff exists

The main failure mode this section is intended to prevent is **context loss turning deliberate deferrals into forgotten work or, conversely, turning them into unexamined implementation assumptions**.

The current session established several important negative conclusions:

- a missing search result is not automatically a reranker problem;
- a useful CBM capability should not automatically replace Satori's existing implementation;
- a generic graph need does not justify importing a general Cypher engine;
- package facts should precede package architecture;
- retrieval admission and result disclosure are different policy layers;
- semantic provider richness is only valuable when its evidence can be bound safely into Satori's Publication and capability contracts.

The next session should resume from those conclusions, then revalidate them against the final integrated P3 baseline before choosing the next mission.
