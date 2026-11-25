# MCP Ergonomics Follow-Up & A5 (`hydrateExact`) Default-On Decision

Date: 2026-11-25
Status: Implemented and verified. `A5` (`hydrateExact`) enabled by default (`SATORI_HYDRATE_EXACT=0` or `hydrateExact: false` opt-out); `A1` (`SATORI_RECOMMEND_TEXT_READS=1`) remains off by default.
Supersedes: Default-off decision for `A5` in [phase4a-4b-stabilization-2026-11-24.md](phase4a-4b-stabilization-2026-11-24.md); closes the follow-up items from [agent-first-mcp-ergonomics-plan-2026-11-23.md](agent-first-mcp-ergonomics-plan-2026-11-23.md).

## 1. Diagnosis of the November 24 A/B Gate

In the November 24 Pi gate (Pueue task 20, 27 runs across 3 tasks × 3 reps), both `A5` (`hydrateExact`) and `A1` (`format: "text"`) failed the overall gate despite passing `9/9` strict checks:
- `A5`: `+11.7%` aggregate input tokens, `+9.0%` wall time, `+5.7%` visible bytes.
- `A1`: `+5.6%` aggregate input tokens, `-11.7%` wall time, `+39.4%` visible bytes.

Inspecting all 27 runs in Pueue task 20 alongside surviving `/tmp/pi-mcp-*.txt` truncation dumps and the live MCP code identified four distinct causes:

1. **A5's Nov 24 aggregate regression came 100% from a task where `hydrateExact` never fired:**
   - `A5` won decisively on both exact tasks where hydration ran (`-42.8%` tokens / `-24.5%` wall / `-22.6%` bytes on `known-exact-target`; `-10.9%` tokens / `-13.7%` wall / `-5.3%` bytes on `known-exact-small-target`).
   - On `unknown-freshness-reuse` (conceptual query), `hydrateExact` fired `0/3` times (`hyd=0/0/0`), yet that arm had `+67.1%` tokens due to blocked non-interleaved execution (all 9 Control, then 9 A5, then 9 A1), an unfinished background `sync` at arm startup, and the model voluntarily passing `format: "text"` (`txt=3/5/0`) inside the A5 arm.
   - Taking a single pooled median across 55-line, 139-line, and 450-line tasks amplified that variance into a `+11.7%` aggregate "regression".
2. **Complete A5 hydrations still recommended a redundant source read:**
   - When `hydratedExactSource.completeSymbolReturned === true`, `recommendedNextAction` still emitted `read_file(open_symbol: { context: { preset: "definition" } })`, nudging agents to re-read the symbol body already returned in `search_codebase`.
3. **Opaque `symbolId`-only relationships in `symbol_context` + Pi 20 KB `call_graph` truncation:**
   - `RelationshipEvidenceItem` (`packages/mcp/src/core/relationship-evidence.ts`) carried only `symbolId` and `sites`—no `symbolLabel` or defining `file`. Agents opening `open_symbol` still had to invoke `call_graph` to name callers/callees.
   - On Nov 24, `call_graph` payloads hit `20.6–22.1 KB` (just above Pi 1.6.0's 20 KB truncation threshold), truncating JSON mid-payload so `ergonomics-scorer.mjs` could not parse the graph and reported `sufficient_evidence_unobserved` on 14/18 exact runs. (Commit `ec3ed63d` subsequently trimmed redundant `node.freshness` metadata, bringing those `call_graph` responses down to `5.5–15.4 KB`.)
4. **Two standalone `read_file` hygiene gaps:**
   - Default `>40`-line ordinary range reads still auto-wrapped source in a one-line JSON `compactEnvelope` and duplicated it into `structuredContent`, violating the single-block `content` cross-host contract.
   - `open_symbol.contractVersion` rejected string `"2"`, causing avoidable Flash schema-validation retries (observed in the Nov 23 benchmark).

## 2. Changes Made

### A. `read_file` & `open_symbol` Hygiene
- **`packages/mcp/src/tools/read_file.ts`**: Removed `READ_FILE_AUTO_COMPACT_MIN_LINES` auto-compacting on default `>40`-line ordinary range reads (raw multiline source is now default; `presentation: "compact"` remains opt-in) and removed `structuredContent` from plain `read_file` responses.
- **`packages/mcp/src/core/symbol-context-public-contract.ts`**: Added `normalizeExactContractVersion` to coerce `"2"` (trimmed) to integer `2` in `openSymbolRequestSchema` and `exactSymbolOpenRequestSchema` while keeping all frozen Phase 0 rejection cases intact.

### B. Named `symbol_context` Relationships & A5 Follow-Up Ergonomics
- **`packages/mcp/src/core/relationship-evidence.ts`**, **`symbol-context-composer.ts`**, **`symbol-context-text-renderer.ts`**: Added optional `symbolLabel` and `file` to `RelationshipEvidenceItem`, populated from `snapshot.registry.symbolsByInstanceId` in `projectRelationshipPage`, and rendered them in `Callers`/`Callees` sections of `format="text"`.
- **`packages/mcp/src/core/search-exact-registry-hit.ts`**, **`search-exact-fast-path.ts`**, **`packages/mcp/src/tools/search_codebase.ts`**:
  - Added `resolveHydrateExact()` with env toggle `SATORI_HYDRATE_EXACT` and explicit boolean argument precedence.
  - Updated `attachHydratedExactSource` so complete hydrations (`completeSymbolReturned: true`) upgrade a redundant `preset: "definition"` `recommendedNextAction` to `preset: "call_context", include: { source: false }`.
- **`evals/agent-discovery/ergonomics-scorer.mjs`**: Added `symbol_context` (JSON and `format="text"`) relationship witnessing in `structuredGraphWitnessesRelation`, and fixed `observeOwnerSpan` to read `result.displayLabel` on hydrated exact search results.

## 3. Clean Interleaved A/B Gate (25 November 2026)

Ran 27 interleaved Pi 1.6.0 runs (`opencode2api/deepseek-v4.1-flash-free`, thinking `xhigh`, offline `Potion` + `LanceDB` + `LateOn-Code-edge` on CPU, pre-synced index, rotated arm order across 3 reps: `control → a5 → a1`, `a5 → a1 → control`, `a1 → control → a5`, Pueue task 34). All `call_graph` responses stayed between `5.5 KB` and `15.4 KB` (zero Pi truncation).

| Scope | Arm | Strict Pass | Calls (med) | Input Tokens (med) | Wall Time (med) | Visible Bytes (med) | First Suff Call (med) |
|---|---|---|---:|---:|---:|---:|---:|
| **`known-exact-target`** *(450 lines)* | Control | 2/3 | 7 | 58,276 | 69.6 s | 52,607 B | — |
| | **`a5_hydrate`** | **3/3** | **5 (-28.6%)** | **39,045 (-33.0%)** | **57.1 s (-18.0%)** | **36,911 B (-29.8%)** | 4 |
| | `a1_text` | 3/3 | 7 | 52,384 (-10.1%) | 84.3 s (+21.1%) | 41,636 B (-20.9%) | 6 |
| **`known-exact-small-target`** *(55 lines)* | Control | 3/3 | 6 | 40,587 | 43.7 s | 23,222 B | 4 |
| | **`a5_hydrate`** | **3/3** | **5 (-16.7%)** | **33,340 (-17.9%)** | 46.7 s (+6.9%) | **22,528 B (-3.0%)** | **3 (-25.0%)** |
| | `a1_text` | 3/3 | 6 | 31,066 (-23.5%) | 43.6 s (-0.4%) | 20,681 B (-10.9%) | 3 |
| **`unknown-freshness-reuse`** *(semantic)* | Control | 3/3 | 6 | 56,811 | 56.4 s | 33,313 B | 4 |
| | **`a5_hydrate`** | **3/3** | 6 | **55,324 (-2.6%)** | **53.4 s (-5.3%)** | 37,564 B (+12.8%) | **4** *(suffMs -22.6%)* |
| | `a1_text` | 3/3 | 6 | 56,742 (-0.1%) | 58.1 s (+3.1%) | 38,993 B (+17.1%) | 4 |
| **OVERALL (9 runs/arm)** | Control | 8/9 (88.9%) | 6 | 56,811 *(mean 53,150)* | 60.3 s | 33,313 B | — |
| | **`a5_hydrate`** | **9/9 (100%)** | **5 (-16.7%)** | **44,002 (-22.5%)** *(mean 49,825)* | **53.4 s (-11.4%)** | 35,156 B (+5.5%) | — |
| | `a1_text` | 9/9 (100%) | 6 | 52,384 (-7.8%) *(mean 58,909)* | 58.1 s (-3.6%) | 38,993 B (+17.1%) | — |

## 4. Decision & Reasoning

### Flip `A5` (`hydrateExact`) ON by default
- **Why:** In clean interleaved trials, `A5` improved strict pass rate (`9/9` vs `8/9`), reduced overall median input tokens by **-22.5%** (`mean -6.3%`), median wall time by **-11.4%**, and median tool calls by **-16.7%** (`6 → 5`). It won on both exact tasks (`-33.0%` tokens / `-29.8%` bytes on the 450-line target; `-17.9%` tokens / `4 → 3` calls to sufficiency on the 55-line target) and passed every `evaluateErgonomicsGate` check on the non-exact `unknown-freshness-reuse` control task (`tok -2.6%`, `wall -5.3%`, `suffMs -22.6%`).
- **Safety & rollback:** Hydration remains strictly bounded (`12 KiB` / `200` lines, clean unique `publication_hash_matched` exact hits only, fails closed on ambiguity/dirty/stale/budget overflow). Callers can opt out per request with `hydrateExact: false` or globally with `SATORI_HYDRATE_EXACT=0`.

### Keep `A1` (`SATORI_RECOMMEND_TEXT_READS`) OFF by default
- **Why:** Even with named relationships, `A1` still failed the `<= 1.15` visible-byte gate (`+17.1%` overall and on `unknown-freshness-reuse`), regressed `known-exact-target` wall time (`+21.1%`), and raised mean input tokens (`58,909` vs `53,150`) due to a `130,548`-token outlier run. `format: "text"` remains available as an opt-in parameter on `read_file` and via `SATORI_RECOMMEND_TEXT_READS=1`.

## 5. Limits & Verification
- **Limits:** 3 repetitions × 3 tasks on one repository (`satori`) with one model (`deepseek-v4.1-flash-free`, `xhigh`) and scripted Call 1; transient `/tmp/satori-ab-v6-*` artifacts were removed after recording results.
- **Verification:** `@satori-code/mcp` full unit suite (`1,411` tests across `154` files), `evals/agent-discovery/ergonomics-scorer.test.mjs` (`22/22`), `evals/agent-discovery/bounded-symbol-context-phase-0.test.mjs` (`11/11`), `pnpm run check` (lint, 4 typecheck targets, `versions:check`, `scope:check`), and `@satori-code/core` + `@satori-code/mcp` builds all passed.
