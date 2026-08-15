# Satori Language Intelligence & Semantic Architecture

This document specifies the architecture, invariants, boundaries, and extension mechanics of Satori's multi-language semantic resolution platform.

---

## 1. Executive Summary

Satori's language intelligence platform is designed around **high-precision, proof-backed semantic relationship extraction** across diverse programming languages. Rather than relying on fragile syntactic heuristics or language-specific branching across indexing and relationship pipelines, Satori uses a **three-tier decoupled architecture**:

```text
┌──────────────────────────────────────────────────────────────────┐
│ Tier 1: Declarative Language Descriptors & Validation            │
│  - packages/core/assets/semantic-engine/semantic-languages.json   │
│  - packages/core/src/semantic/descriptor.ts                      │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ Tier 2: Generic Strategy Dispatch & Neutral Central Admission    │
│  - packages/core/src/relationships/admission.ts                  │
│  - packages/core/src/relationships/builder.ts                    │
│  - packages/core/src/relationships/contributions/cbm.ts          │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ Tier 3: Isolated WebAssembly Semantic Engine                     │
│  - packages/core/src/semantic/wasm/wasm-analyzer.ts              │
│  - packages/core/src/semantic/wasm/wasm-engine.ts                │
│  - third_party/cbm-semantic/satori_semantic.c (64-byte POD ABI)  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Architectural Layers

### Tier 1: Declarative Language Descriptors & Schema
Language capabilities, file extensions, semantic revisions, grammar references, and auxiliary file patterns (e.g. `go.mod`, `go.sum`, `go.work`, `Cargo.toml`) are declared centrally in `packages/core/assets/semantic-engine/semantic-languages.json` and validated by `semantic-languages.schema.json`.

* **Fail-Closed Validation:** Runtime loading via `loadDefaultLanguagesConfig()` and build-time verification via `validateSemanticLanguagesConfig()` reject unknown properties, unapproved resolution strategies, duplicate canonical language identifiers, and malformed extension patterns.
* **Auxiliary File Routing:** The `SemanticLanguageRegistry` matches and routes auxiliary configuration files directly to their owning language without hardcoding file names into generic indexing logic.

### Tier 2: Generic Strategy Dispatch & Central Admission
Relationship construction in `packages/core/src/relationships/builder.ts` is fully strategy-driven and free of hardcoded language branches:

1. **Resolution Strategy Selection:** Each source file is routed to its designated strategy (`python_native`, `cbm_semantic`, `syntactic`) based on the declarative registry.
2. **Generic CBM Contribution Engine (`cbm.ts`):** Handles any CBM-backed language uniformly by consuming `SemanticProjectEvidence` produced by the semantic analyzer.
3. **Neutral Central Admission (`admission.ts`):** `admitAuthoritativeProofBackedCalls` validates every call claim against the repository's `SymbolRegistry`:
   - Enforces exact byte span containment within source callable symbols (`function`, `method`, `component`, `hook`, `test`).
   - Enforces existence and matching of target callable symbols.
   - Stamps deterministic confidence (`high` for intra-file, `low` for cross-file) and authoritative proof provenance (`direct_binding`, `origin_flow`).

### Tier 3: High-Performance WebAssembly Engine
Semantic analysis for CBM languages is executed in a sandboxed, high-performance WebAssembly module compiled from C11 sources (`third_party/cbm-semantic/`) with Emscripten:

* **64-Byte POD ABI:** Relationships, definitions, and diagnostics are exported as fixed-width, memory-aligned 64-byte C structures (`SatoriSemanticResultV1`, `SatoriSemanticDefinitionV1`, `SatoriSemanticDiagnosticV1`) with static compile-time assertions on struct sizes and field offsets.
* **String Table Offsets:** All strings cross the WASM/TS boundary as 32-bit byte offsets into a contiguous UTF-8 buffer, eliminating dynamic string allocation overhead.
* **Dynamic Memory & Resource Budgets:** Linear memory growth is bounded (up to 1 GiB), session handles are capped at 64, aggregate source bytes at 100 MiB, auxiliary bytes at 10 MiB, and total input at 110 MiB with deterministic error codes.

---

## 3. Critical Invariants

1. **Symmetrical Fail-Closed Target & Caller Binding:**
   - **Target Binding:** Target symbols are matched strictly by `{ targetFile, startByte, endByte }`. Same-name decoys at differing byte spans are rejected.
   - **Caller Binding:** Call spans must be strictly contained within the byte span of a callable symbol (`function`, `method`, `component`, `hook`, `test`). If no callable symbol encloses the call, the binder **abstains** (`undefined`), producing zero synthetic edges.
2. **Three-Way Decoupling of Capabilities:**
   - **Descriptor Registration:** Language exists in `semantic-languages.json`.
   - **Compiled Native Availability:** Language grammar and resolver are compiled into `satori-semantic-engine.wasm` and listed in `semantic-engine.manifest.json`.
   - **Public Satori Promotion:** Controlled by `isLanguageCapabilitySupportedForLanguage(lang, 'callGraphBuild')`. Unpromoted languages can be tested in `qualification` mode without exposing unverified edges in production.
3. **Single Registry Composition:**
   - A single `SemanticLanguageRegistry` instance is instantiated per runtime composition and threaded through `IndexGenerationWorkflow` $\to$ `buildRelationshipsForRegistry` $\to$ `LanguageResolutionStrategyRegistry` $\to$ `CbmSemanticContributionEngine`.
4. **Incremental Rebuild Freshness:**
   - During sync deltas (`rebuildNavigationArtifactsForSyncDelta()`), when any source or semantic auxiliary file of a CBM language changes, the complete source snapshot for that language is re-read and re-analyzed, and all relationships for that language are updated in the navigation delta.

---

## 4. Extension Runbook: Adding a New Language (e.g. Rust / TypeScript)

Adding a second or third CBM-backed language to Satori requires **zero changes to the TypeScript dispatch and builder pipeline**:

1. **Vendor Tree-sitter Grammar and Type Evaluator:**
   - Add Tree-sitter C parser under `third_party/cbm-semantic/grammars/tree-sitter-<lang>/`.
   - Add language type inference logic under `third_party/cbm-semantic/languages/<lang>/`.
   - Wire language parser in `satori_semantic.c`.
2. **Recompile WASM Engine:**
   - Add compile units to `scripts/semantic-engine-build-config.mjs`.
   - Run `pnpm semantic:build` to produce fresh `wasm` and manifest.
3. **Register Language Descriptor:**
   - Add entry in `packages/core/assets/semantic-engine/semantic-languages.json` with `strategy: "cbm_semantic"`, file extensions, and auxiliary patterns (e.g. `**/Cargo.toml`).
4. **Verify & Test:**
   - Run `pnpm semantic:verify`.
   - Add characterization tests in `packages/core/src/relationships/`.
5. **Promote Language:**
   - Enable `'callGraphBuild'` capability in `packages/core/src/languages/capabilities.ts`.
