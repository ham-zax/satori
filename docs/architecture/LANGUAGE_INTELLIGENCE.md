# Satori Language Intelligence & Semantic Architecture

This document is the current architecture reference for Satori's language analysis, symbol navigation, relationship resolution, capability admission, and semantic-engine extension boundaries.

---

## 1. Executive Summary

Satori does not force every language through one parser or one resolver. The public contract is capability-driven: a language is promoted only for the slice the repository can prove, and unsupported receiver/dynamic/build-context semantics abstain instead of producing guessed edges.

Current production surface:

| Language | Structural backend | CALLS backend | Public calls | Test references |
|---|---|---|---|---|
| TypeScript | OXC | `typescript_semantic` (Satori compiler claims) | `type_receiver_aware` | production |
| JavaScript | OXC | Satori syntactic | `calls_v0` | production |
| Python | Satori Tree-sitter WASM | `python_native` | `calls_v0` | production |
| Go | CBM WASM | `cbm_semantic` | `calls_v0` | production |
| Java | structural symbols + CBM project analyzer | `cbm_semantic` | `calls_v0` | none |
| C# | structural symbols + CBM project analyzer | `cbm_semantic` | `calls_v0` | none |
| C++ | structural symbols + CBM project analyzer | `cbm_semantic` | `calls_v0` | none |
| Rust | structural symbols + CBM project analyzer | `cbm_semantic` | `calls_v0` | none |
| Scala | Satori Tree-sitter WASM | Satori syntactic | `calls_v0` | none |

`calls_v0` is a conservative navigation claim, not a promise of compiler-complete dynamic dispatch. TypeScript is separately promoted as `type_receiver_aware`: it uses configured compiler projects and exact OXC caller/target binding, retaining ambiguity for open-world interface dispatch, mutable origins, and unresolved/dynamic constructs. Java/C# currently admit exact static bindings inside proved project authority; C++ admits exact same-translation-unit direct calls; Rust requires Cargo ownership and excludes unmodeled `cfg`/receiver cases; Scala admits unique direct non-member calls and abstains on member or ambiguous targets.

The generic relationship pipeline is decoupled into descriptors, strategy dispatch/admission, and backend-specific evidence. CBM-backed languages additionally use an isolated WebAssembly semantic engine:

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
Relationship construction in `packages/core/src/relationships/builder.ts` is strategy-driven. Language-specific semantics stay in the selected analyzer/resolver rather than leaking into generic relationship admission:

1. **Resolution Strategy Selection:** Each source file is routed to its designated strategy (`python_native`, `typescript_semantic`, `cbm_semantic`, `syntactic`). Python uses the native Python resolver; TypeScript uses project-scoped compiler evidence; JavaScript and Scala use the built-in syntactic resolver; descriptor-registered languages use the CBM semantic path.
2. **TypeScript Project Evidence:** `TypeScriptSemanticProjectAnalyzer` owns configured/inferred TypeScript project sessions, project/config freshness, and provider-neutral `ResolutionClaim`s. The TypeScript relationship path admits those claims through the same central canonical-binding boundary used for publication.
3. **Generic CBM Contribution Engine (`cbm.ts`):** Handles any CBM-backed language uniformly by consuming `SemanticProjectEvidence` produced by the semantic analyzer.
4. **Neutral Central Admission (`admission.ts`):** `admitAuthoritativeProofBackedCalls` validates every call claim against the repository's `SymbolRegistry`:
   - Enforces exact byte span containment within source callable symbols (`function`, `method`, `component`, `hook`, `test`).
   - Enforces existence and matching of target callable symbols.
   - Stamps deterministic confidence (`high` for intra-file, `low` for cross-file) and authoritative proof provenance (`direct_binding`, `origin_flow`).

### Tier 3: CBM WebAssembly Engine
Go, Java, C#, C++, and Rust semantic project analysis is executed in a sandboxed WebAssembly module compiled from C11 sources (`third_party/cbm-semantic/`) with Emscripten. TypeScript uses its separate compiler-backed project analyzer; JavaScript, Python, and Scala do not use this CBM semantic path:

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
4. **Publication Freshness and Coverage Truth:**
   - Relationship output and semantic-provider coverage are part of the same immutable Publication as search and symbol state. Sync/reindex may reuse bounded analysis work internally, but readers never observe mixed-generation claims.
   - Optional semantic-provider failure is sealed as `degraded` or `unavailable` coverage with no authoritative claims from that failed provider. A searchable Publication may still activate; call-graph capability projection must consume the persisted coverage and must not report `ready` for an unavailable provider.
   - Source-integrity drift, policy drift, corrupt registry/ownership, vector finalization, and Publication activation remain fail-closed and are not converted into semantic degradation.
   - TypeScript semantic environment identity includes compiler/config/project inputs such as `tsconfig.json`/`jsconfig.json`, `extends`, path mappings, project references, relevant package/module controls, provider version, and the active semantic resource budget.
5. **TypeScript Structural Authority:**
   - OXC/Satori remains authoritative for public symbol identity, byte spans, lexical ownership, and the Publication symbol registry. Compiler semantic output is evidence only until it maps to exact canonical caller/target instances.
   - Central admission remains fail-closed: unresolved, ambiguous, non-indexable, or non-canonical evidence does not become a public CALLS edge.

---

## 4. Extension Runbook: Adding Another CBM-Backed Language

The compiled CBM semantic engine currently supports Go, Java, C#, C++, and Rust. Scala is intentionally outside this list: upstream CBM provides its grammar and generic extraction but no dedicated Scala semantic resolver, while Satori already has a production Scala Tree-sitter analyzer and routes its qualified direct-call slice through the existing syntactic strategy. Adding another CBM-backed language does not require a language branch in the TypeScript relationship builder:

1. **Vendor the grammar and resolver closure:**
   - Add the generated Tree-sitter parser/scanner and matching generated headers under `third_party/cbm-semantic/grammars/tree-sitter-<lang>/`.
   - Add the CBM resolver and only the supporting source files it requires under `third_party/cbm-semantic/languages/<lang>/`.
2. **Wire the native bridge and build:**
   - Add the language to `third_party/cbm-semantic/satori_semantic.c` and `scripts/semantic-engine-build-config.mjs`.
   - Run `pnpm semantic:build` to regenerate the WASM engine and manifest.
3. **Register the descriptor:**
   - Add the language to `packages/core/assets/semantic-engine/semantic-languages.json` with `strategy: "cbm_semantic"`, its extensions, semantic revision, grammar, and any build-context auxiliary files.
4. **Qualify the runtime boundary:**
   - Run `pnpm semantic:verify` and add focused relationship characterization/qualification coverage under `packages/core/src/relationships/`.
   - Admit only resolver results whose target, caller, and required build context are proven. Keep receiver/dynamic dispatch and configuration-dependent cases fail-closed until separately modeled.
5. **Promote the proven public slice:**
   - In `packages/core/src/languages/capabilities.ts`, set `callsCapability` to `production_ready` and `publicClaim` to `calls_v0` only for the qualified slice. `callGraphBuild` and `callGraphQuery` derive from `callsCapability`; import/export, receiver-aware, and test-reference capabilities remain independent.
