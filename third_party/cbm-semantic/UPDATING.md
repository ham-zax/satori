# CBM Semantic Engine Synchronization & Maintenance Runbook

This document describes how to maintain, update, compile, and verify the WebAssembly semantic engine in Satori (`third_party/cbm-semantic` and `packages/core/assets/semantic-engine`).

---

## 1. Architecture & Invariants

The Satori Semantic Engine is a self-contained, native C/WASM semantic resolution module compiled using Emscripten.

### Key Invariants:
1. **ABI Stability**:
   - Fixed 64-byte POD structures for relationships (`SatoriSemanticResultV1`), definitions (`SatoriSemanticDefinitionV1`), and diagnostics (`SatoriSemanticDiagnosticV1`) with static assertions on sizeof/offsets.
   - String values across the WASM boundary are represented as `uint32_t` byte offsets into a contiguous UTF-8 string table.
2. **Resource Boundaries**:
   - Up to 64 concurrent session handles (`SATORI_MAX_HANDLES`).
   - Up to 20,000 source files per session (`SATORI_MAX_SOURCES`).
   - Up to 1,000 auxiliary files per session (`SATORI_MAX_AUXILIARIES`).
   - Up to 100 MiB aggregate source bytes and 10 MiB auxiliary bytes (110 MiB total input ceiling).
   - Strict linear memory ceilings (64 MiB initial, 1 GiB max memory growth).
3. **Reproducibility & Verification**:
   - `scripts/semantic-engine-build-config.mjs` defines the authoritative build units, include directories, flags, and exports.
   - `scripts/verify-semantic-engine-reproducibility.mjs` verifies SHA-256 digests of all sources, compiled artifacts, descriptors, and logical recipes without requiring Emscripten locally.

---

## 2. Toolchain Requirements

To rebuild the WASM artifacts, you must use the pinned Emscripten SDK version:
* **Emscripten Version**: `3.1.64`
* **C Standard**: `C11` (`-std=c11 -D_GNU_SOURCE`)

### Installing Pinned Emscripten:
```bash
git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk
cd /tmp/emsdk
./emsdk install 3.1.64
./emsdk activate 3.1.64
source ./emsdk_env.sh
```

---

## 3. Upstream Synchronization Steps

When updating upstream CBM code from [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp):

1. **Pull and inspect changes**:
   - Compare upstream commits against `PINNED_UPSTREAM_COMMIT` in `scripts/semantic-engine-build-config.mjs`.
   - Copy relevant source updates in `common/`, `languages/go/`, or add new language directories under `languages/<lang>/`.
2. **Update Build Configuration**:
   - If new source files were added, update `COMPILE_UNITS` and `INCLUDE_DIRS` in `scripts/semantic-engine-build-config.mjs`.
   - Update `PINNED_UPSTREAM_COMMIT` to the new upstream SHA.
3. **Compile the WASM Binary**:
   ```bash
   pnpm semantic:build
   ```
   This invokes `emcc` with pinned flags, generates `packages/core/assets/semantic-engine/satori-semantic-engine.wasm` and `satori-semantic-engine.js`, and writes `semantic-engine.manifest.json`.
4. **Verify Reproducibility & Integrity**:
   ```bash
   pnpm semantic:verify
   ```
5. **Run Test Suites**:
   ```bash
   pnpm --filter @zokizuan/satori-core test
   ```

---

## 4. Adding a New Language Grammar & Resolver

To add a new language (e.g. Rust, TypeScript, Java) to the compiled semantic engine:

1. **Vendor Tree-sitter Grammar**:
   - Place Tree-sitter parser C files under `third_party/cbm-semantic/grammars/tree-sitter-<lang>/`.
2. **Vendor Language Resolver**:
   - Place language LSP / type-evaluator under `third_party/cbm-semantic/languages/<lang>/`.
3. **Update Satori Bridge (`satori_semantic.c`)**:
   - Register language parser and AST extractor in `satori_semantic_create()`.
4. **Declare in `semantic-languages.json`**:
   - Add language descriptor in `packages/core/assets/semantic-engine/semantic-languages.json` specifying extensions, auxiliary file patterns, revision, and grammar name.
5. **Compile and Verify**:
   - Run `pnpm semantic:build` then `pnpm semantic:verify`.
