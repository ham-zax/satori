# Language-Intelligence Platform & CBM-Derived Semantic WASM Engine Implementation Plan (Revised)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Implement task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal & Core Philosophy

**Go is not the feature. Go is the first acceptance test for a language-intelligence platform inside Satori.**

The primary objective is to **stop owning separate language implementations in Satori and make language support and upgrades a CBM/platform concern.**

Adding subsequent languages (Rust, Java, TypeScript, C#, C++, etc.) must only require:
1. Updating the vendored CBM-derived engine closure + grammar
2. Adding one declarative language descriptor (`semantic-languages.json`)
3. Adding parity and qualification test fixtures

**Zero language-specific branches in `builder.ts`, `IndexGenerationWorkflow`, or `Context`.**

---

## 1. Target Architecture & Ownership Boundary

```text
                 EXACT REPOSITORY SNAPSHOT
                          │
                          ▼
               Language Backend Registry
                          │
                 ┌────────┴─────────┐
                 │                  │
             CBM engine        legacy backend
          WASM/native facts     temporary only
                 │
                 ▼
          Language Intelligence
                 │
        ┌────────┼───────────┐
        ▼        ▼           ▼
   definitions relationships diagnostics
        │        │
        └────┬───┘
             ▼
       SATORI CANONICALIZATION
             │
     ┌───────┴────────┐
     ▼                ▼
 SymbolRegistry   RelationshipRecord
     │                │
     └───────┬────────┘
             ▼
        NAVIGATION STORE
             │
 ┌───────────┼────────────┬──────────────┐
 ▼           ▼            ▼              ▼
open_symbol file_outline call_graph   search context
```

### Core Separation of Concerns

* **CBM tells Satori what the code *means*:** CBM produces semantic facts (definitions, relationships, diagnostics) with exact target provenance.
* **Satori decides what evidence becomes *canonical, fresh, and published navigation*:** Satori manages `SymbolRegistry`, admission of `RelationshipRecord`s, snapshot hashing, incremental revalidation, vector indexing, and navigation query endpoints (`open_symbol`, `file_outline`, `call_graph`, search context).
* **Two ROI Milestones:**
  1. **Milestone 1 — Eliminate Relationship Implementations (Current Focus)**: Satori symbol extraction + CBM semantic relationships $\rightarrow$ Universal canonical `CALLS`, call graph, and generic provider architecture.
  2. **Milestone 2 — Eliminate Language Parsing/Extraction Implementations (Future)**: CBM definitions + CBM relationships $\rightarrow$ Satori canonicalization $\rightarrow$ Delete legacy Satori-owned implementations (e.g., TS syntactic resolver).

---

## 2. Core Architectural Invariants

1. **Zero Language Branching in Builder & Workflow**: `builder.ts` dispatches through a generic contribution engine without `if (language === 'go')`, `goFiles` sets, or language-specific record manufacturing. `IndexGenerationWorkflow` queries declarative auxiliary input descriptors.
2. **The Architecture Acceptance Criterion**:
   > *Adding a new CBM-backed language MUST NOT require modifying `Context`, `IndexGenerationWorkflow`, or `relationships/builder.ts`. A required modification to those files is an architecture-review trigger.*
3. **True Compiled WASM (P0 Requirement)**: Tests must execute against the real Emscripten-compiled `satori-semantic-engine.wasm` binary generated from `third_party/cbm-semantic/` C sources, never a handwritten JS resolver mockup.
4. **Dynamic Memory Allocation in WASM Session**: The TypeScript WASM engine allocates and frees memory using module `_malloc` and `_free` (or C-owned session buffers), with zero hardcoded static memory offsets.
5. **Frozen Multi-Stream ABI with Bounded Initial Scope**:
   - `satori_semantic_definition_count() / definitions()` $\rightarrow$ ABI frozen (returns 0 entries initially in B1).
   - `satori_semantic_relationship_count() / relationships()` $\rightarrow$ ABI frozen + populated with production Go `CALLS` data.
   - `satori_semantic_diagnostic_count() / diagnostics()` $\rightarrow$ ABI frozen (returns 0 entries initially in B1).
6. **Target Provenance by Exact Definition Byte Span**: Native engines provide exact target definition byte spans (`targetProvenance: { file, span: { startByte, endByte } }`). Satori maps targets to `SymbolRecord`s by exact byte span containment. Names are validation hints, never the authority.
7. **Central Proof-Backed Admission**: Every relationship claim produced by CBM adapters passes through central `admitResolvedCallClaims()`. No language provider manufactures authoritative records or self-declares authority.
8. **Strict Decoupling of Native Backend vs Satori Capability**:
   - Backend availability (`cbm.supportsLanguage(lang)`) is strictly decoupled from Satori public publication qualification (`callsCapability: 'production_ready'`).
   - `|| strategy === 'cbm_semantic'` must never bypass product qualification.
9. **No Cross-Language Leakage**: Go does not produce language-specific `TESTS` edges at this phase. `test-path.ts` preserves Python and general test-path semantics without cross-language side effects.
10. **Python Invariant**: Satori's mature 78KB native Python engine (`python-resolution.ts`) remains 100% authoritative and completely unchanged. CBM/WASM is explicitly disabled for Python (`supportsLanguage('python') === false`).
11. **Committed WASM Runtime & Digest Verification**: Compiled assets (`satori-semantic-engine.wasm`, `satori-semantic-engine.js`, `semantic-engine.manifest.json`, and `THIRD_PARTY_LICENSES.md`) are committed in `packages/core/assets/semantic-engine/`. Standard builds and `release:check` require no Emscripten; a source-digest check enforces WASM freshness against C source changes.

---

### Resource Operating Envelope & Limits (Codified & Synchronized)
* **Maximum Concurrent Session Handles**: `64` (`SATORI_MAX_HANDLES`); this is a handle-slot ceiling, not a per-session memory guarantee.
* **Maximum Source Files per Session**: `20,000` (`SATORI_MAX_SOURCES`)
* **Maximum Auxiliary Files per Session**: `1,000` (`SATORI_MAX_AUXILIARIES`)
* **Maximum Aggregate Source Bytes**: `100 MiB` (`SATORI_MAX_AGGREGATE_SOURCE_BYTES`, fails with `SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED`)
* **Maximum Aggregate Auxiliary Bytes**: `10 MiB` (`SATORI_MAX_AGGREGATE_AUXILIARY_BYTES`, fails with `SATORI_SEMANTIC_ERR_RESOURCE_LIMIT_EXCEEDED`)
* **Maximum Total Input Bytes**: `110 MiB` (`SATORI_MAX_TOTAL_INPUT_BYTES`)
* **Maximum String Table Size**: `64 MiB` (`SATORI_MAX_STR_TABLE_BYTES`, deterministic error propagation)
* **Maximum Relationship Records**: `500,000` (`SATORI_MAX_RESULTS`)
* **Multi-stream POD ABI**: Fixed 64-byte POD struct layouts for Relationships (`SatoriSemanticResultV1`), Definitions (`SatoriSemanticDefinitionV1`), and Diagnostics (`SatoriSemanticDiagnosticV1`) with compile-time static assertions.
* **Arena Structural Capacity**: `4,096` block structural limit; normal block size `64 KiB`; oversized allocations may use larger blocks; WASM linear memory remains the hard aggregate ceiling.
* **WASM Initial Linear Memory**: `64 MiB` (`-sINITIAL_MEMORY=67108864`)
* **WASM Maximum Linear Memory**: `1 GiB` (`-sMAXIMUM_MEMORY=1073741824` hard ceiling for module linear memory)
* **WASM Stack Size**: `2 MiB` (`-sSTACK_SIZE=2097152`)
* **Toolchain Pin & Verification Modes**:
  - `semantic:build` requires exact Emscripten `3.1.64` matching and records logical build recipe digest.
  - `semantic:verify` validates source digest, logical build recipe digest, recorded Emscripten version, committed JS/WASM digests, and manifest integrity without requiring Emscripten installed.

---

## 3. Component Design & Repository Organization

```text
satori/
├─ third_party/
│  └─ cbm-semantic/
│     ├─ LICENSE
│     ├─ UPSTREAM.md
│     ├─ UPDATING.md                           (mechanical runbook for upstream sync)
│     ├─ minimal-compat/ (cbm_compat.h)
│     ├─ common/ (arena, scope, type_rep, type_registry)
│     ├─ languages/go/ (go_lsp, go_mod, go_stdlib_data, go_surface)
│     ├─ tree-sitter/ (runtime + tree-sitter-go)
│     └─ satori_semantic.c / .h               (multi-stream ABI exports & resource limits)
│
├─ packages/core/
│  ├─ assets/semantic-engine/
│  │  ├─ satori-semantic-engine.js            (generated Emscripten JS glue)
│  │  ├─ satori-semantic-engine.wasm          (real compiled WASM binary)
│  │  ├─ semantic-engine.manifest.json        (digest manifest with per-language metadata)
│  │  └─ THIRD_PARTY_LICENSES.md              (bundled licenses)
│  └─ src/
│     ├─ semantic/
│     │  ├─ contracts.ts                      (SemanticProjectInput, SemanticProjectEvidence)
│     │  ├─ descriptor.ts                     (Declarative language descriptor types)
│     │  ├─ analyzer-port.ts                  (SemanticProjectAnalyzer port)
│     │  ├─ noop-analyzer.ts
│     │  ├─ languages/
│     │  │  └─ semantic-languages.json        (Declarative language descriptor registry)
│     │  └─ wasm/
│     │     ├─ wasm-types.ts                  (64-byte POD struct & ABI offsets)
│     │     ├─ wasm-loader.ts                 (singleton module loader)
│     │     ├─ wasm-engine.ts                 (dynamic memory session & ABI unpacker)
│     │     ├─ wasm-analyzer.ts               (implements SemanticProjectAnalyzer via descriptors)
│     │     ├─ wasm-smoke.test.ts
│     │     ├─ wasm-engine.test.ts
│     │     ├─ wasm-stress.test.ts            (resource limit, growth, and lifecycle stress tests)
│     │     ├─ packed-core-smoke.test.ts
│     │     └─ utf8-span-parity.test.ts
│     ├─ relationships/
│     │  ├─ resolution-strategy-registry.ts   (strategy mapping: python->python_native, go->cbm_semantic, etc.)
│     │  ├─ resolution.ts                     (ResolutionClaim, ResolutionAuthority, proof steps)
│     │  ├─ python-resolution.ts              (UNCHANGED native Python engine)
│     │  ├─ builder.ts                        (generic strategy-driven dispatch & central admission)
│     │  ├─ go-call-characterization.test.ts  (end-to-end Go calls and dispatch characterization)
│     │  └─ contributions/
│     │     ├─ contracts.ts                   (CallResolutionContribution, CallResolutionEngine)
│     │     ├─ python.ts                      (legacy Python adapter)
│     │     ├─ syntactic.ts                   (legacy Syntactic adapter)
│     │     └─ cbm.ts                         (generic CbmSemanticContributionEngine for any CBM language)
│     └─ generation/
│        └─ index-generation-workflow.ts      (generic auxiliary input collection & semantic orchestration)
│
├─ docs/
│  └─ architecture/
│     └─ LANGUAGE_INTELLIGENCE.md             (authoritative architecture guide & extension invariants)
│
├─ scripts/
│  ├─ build-semantic-engine.mjs               (pinned Emscripten 3.1.64 build script)
│  └─ verify-semantic-engine-reproducibility.mjs
```

---

## 4. Implementation Tasks & Review Checkpoints

### Phase A: Language Intelligence Spine Refactor (COMPLETED & VERIFIED)
- [x] Task A1: Define `CallResolutionContribution` contract in `packages/core/src/relationships/contributions/contracts.ts`
- [x] Task A2: Wrap existing Python engine into `PythonResolutionContributionEngine`
- [x] Task A3: Wrap existing Syntactic engine into `SyntacticResolutionContributionEngine`
- [x] Task A4: Establish `ResolutionStrategyRegistry`
- [x] Task A5: Establish Provider-Neutral `SemanticProjectAnalyzer` interface & No-Op analyzer
- [x] Task A6: Implement Central Admission in `builder.ts` via `admitAuthoritativeProofBackedCalls`
- [x] Task A7: Unify Full & Incremental Relationship Generation in `IndexGenerationWorkflow`
- [x] Task A8: Phase A Zero-Behavior Parity Verification & Review Checkpoint

---

### Phase B: Generalized CBM Language Platform & Go Acceptance Qualification

#### Task B1: Real WASM Engine Compilation & Dynamic Memory Session Runtime (QUALIFIED & APPROVED)
- [x] Implement Emscripten C entrypoints in `third_party/cbm-semantic/satori_semantic.c` with multi-stream query exports:
  - Freeze definitions stream (`satori_semantic_definition_count`, `satori_semantic_definitions`).
  - Freeze & populate relationship stream with Go CALLS (`satori_semantic_relationship_count`, `satori_semantic_relationships`).
  - Freeze diagnostics stream (`satori_semantic_diagnostic_count`, `satori_semantic_diagnostics`).
- [x] Compile real WASM binary using pinned Emscripten (`emcc 3.1.64`) into `packages/core/assets/semantic-engine/satori-semantic-engine.wasm` and `satori-semantic-engine.js`.
- [x] Implement dynamic memory management (`_malloc` / `_free`) in `wasm-engine.ts`.
- [x] Enforce strict resource budgets (64 session handles, 20k source files, 100 MiB source, 1k auxiliary files, 10 MiB auxiliary, 110 MiB total semantic input, 64 MiB string table, 500k relationships, arena structural ceiling, 1 GiB WASM linear memory ceiling, 2 MiB stack).
- [x] Centralize ownership and cleanup of Tree-sitter trees, parsers, and temporary resolution structures across success and error paths; verify repeated lifecycle stability.
- [x] Enforce C ABI language validation (reject unsupported languages at create time).
- [x] Verify `wasm-smoke.test.ts`, `wasm-engine.test.ts`, `wasm-stress.test.ts`, `packed-core-smoke.test.ts`, `utf8-span-parity.test.ts`, and `go-call-characterization.test.ts` pass executing real WASM.
- [x] **B1 implementation review passed; user acceptance pending**

#### Task B2: Declarative Language Registry & Generic CBM Contribution Engine (IMPLEMENTED & HARDENED)
- [x] Create authoritative `packages/core/assets/semantic-engine/semantic-languages.json` with draft-07 JSON schema `semantic-languages.schema.json` and fail-closed loader in `descriptor.ts`.
- [x] Implement declarative strategy resolution in `DefaultLanguageResolutionStrategyRegistry` dynamically selecting `cbm_semantic` from language descriptors without hardcoded language branches.
- [x] Implement generic `CbmSemanticContributionEngine` in `packages/core/src/relationships/contributions/cbm.ts` supporting any CBM-backed language.
- [x] Implement exact byte-span target resolution (`targetProvenance.span -> SymbolRecord.span.startByte/endByte`) with decoy rejection test.
- [x] Implement fail-closed caller binding in `CbmSemanticContributionEngine` with strict byte containment.
- [x] Enforce Central Satori Admission via neutral `packages/core/src/relationships/admission.ts` (`admitAuthoritativeProofBackedCalls`) breaking circular dependencies.
- [x] Unify single registry instance threading from analyzer → pipeline/workflow → strategy registry → CBM contribution.
- [x] Enforce descriptor-manifest alignment and fail-closed manifest checking in `WasmSemanticProjectAnalyzer` and `verifySemanticEngine()`.
- [x] Add TypeScript Layer Acceptance test proving second CBM language integration with zero builder/dispatch code modifications.

#### Task B3: Incremental Semantic Rebuild & Descriptor-Driven Auxiliary Observation (COMPLETED)
- [x] **Incremental CBM Rebuild**: In `rebuildNavigationArtifactsForSyncDelta()` and `buildRelationshipDelta()`, when any source or semantic auxiliary for a CBM language changes in a sync delta:
  - Reread current complete source snapshot for that language.
  - Rerun semantic analysis to produce fresh `semanticEvidenceByLanguage`.
  - Re-resolve and replace affected language claims and relationships during delta publication.
- [x] **Descriptor-Driven Auxiliary Observation**: Separate semantic auxiliary observation from vector search indexing (auxiliary input ≠ searchable/vector-indexed document) using root-bound/freshness-safe observation (`collectSemanticAuxiliariesForLanguage`).
- [x] **Capability Decoupling & Qualification**: Maintain strict separation between descriptor existence, compiled native engine availability, and Satori publication capability (`callGraphBuild`).

#### Task B4: Architectural & Upstream Documentation Deliverables (COMPLETED)
- [x] Author `docs/architecture/LANGUAGE_INTELLIGENCE.md` covering the full platform architecture, extension invariants, and future language migration steps (including strategic second-language selection: Rust / TypeScript).
- [x] Author `third_party/cbm-semantic/UPDATING.md` covering upstream synchronization, Emscripten toolchain pinning, asset generation, and verification.

#### Task B5: Characterization, Parity & Release Qualification Gate (COMPLETED)
- [x] Update end-to-end multi-file characterization tests in `packages/core/src/relationships/go-call-characterization.test.ts` to test CBM contribution engine through generic builder.
- [x] Run full test suites across all packages:
  - `pnpm --filter @zokizuan/satori-core test` (863 tests passing)
  - `pnpm --filter @zokizuan/satori-mcp test` (19 tests passing)
  - `pnpm --filter @zokizuan/satori-cli test` (366 tests passing)
  - `pnpm run check` (lint, typecheck, version freshness clean across all packages)
  - `pnpm run semantic:verify` (reproducibility digest & descriptor alignment verified)
  - `pnpm run release:check` (clean build, packed smoke, CLI/MCP packaged runs pass)
- [x] Inspect complete diff to verify clean adherence to the generalized language-intelligence platform architecture.
