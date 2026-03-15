# Watch-List, Install Flow, and Client Skills Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce idle watcher cost, make Satori easier to install and remove, and ship first-party skills that steer agents onto the six-tool workflow.

**Architecture:** Keep the existing six-tool MCP surface unchanged. Watch state remains MCP-owned and session-scoped inside `SyncManager`, install and uninstall remain CLI concerns in `packages/mcp`, and client skills are packaged assets copied by the installer rather than runtime-generated content.

**Tech Stack:** TypeScript, Node 20, pnpm, MCP SDK, chokidar, GitHub Actions

---

## Assumptions

- Watch-list state is session-only and does not become durable snapshot state.
- Phase 1 ships `install` and `uninstall`; `update` is documented as follow-up unless release automation is trivial after install lands.
- Initial client targets are Claude Code and Codex CLI. Other clients remain future work unless their config format can be added without branching complexity.
- The authoritative six-tool contract in `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md` remains unchanged.

## Chunk 1: Explicit Watch List

### Task 1: Replace blanket watcher startup with session-scoped watch tracking

**Files:**
- Modify: `packages/mcp/src/core/sync.ts`
- Read: `packages/mcp/src/core/snapshot.ts`
- Test: `packages/mcp/src/core/sync.test.ts`

- [ ] **Step 1: Add failing tests for startup behavior**
  Add tests proving `startWatcherMode()` does not automatically watch every indexed codebase from snapshot state, and that only explicitly touched codebases gain active watchers.

- [ ] **Step 2: Add a dedicated in-memory watch-list model**
  Introduce a `watchedCodebases` set plus helpers such as `touchWatchedCodebase(codebasePath)`, `unwatchCodebase(codebasePath)`, and `refreshWatchersFromWatchList()`.

- [ ] **Step 3: Remove snapshot-driven blanket registration**
  Refactor `startWatcherMode()` and `refreshWatchersFromSnapshot()` so startup no longer loops through `snapshotManager.getIndexedCodebases()` to register watchers for every indexed root.

- [ ] **Step 4: Preserve existing debounce and status gates**
  Keep `canScheduleWatchSync()`, debounce timers, and watcher error handling unchanged so the patch narrows watcher scope without changing sync semantics.

- [ ] **Step 5: Run the focused test file**
  Run: `pnpm --filter @zokizuan/satori-core build && pnpm -C packages/mcp exec tsx --test src/core/sync.test.ts`
  Expected: PASS with new watch-list coverage and no regressions in existing sync tests.

- [ ] **Step 6: Commit the watcher-core refactor**
  Run:
  ```bash
  git add packages/mcp/src/core/sync.ts packages/mcp/src/core/sync.test.ts
  git commit -m "refactor: scope watcher mode to touched codebases"
  ```

### Task 2: Touch and unwatch roots from tool handlers

**Files:**
- Modify: `packages/mcp/src/core/handlers.ts`
- Create: `packages/mcp/src/core/handlers.watchers.test.ts`
- Read: `packages/mcp/src/core/handlers.manage_index_preflight.test.ts`
- Read: `packages/mcp/src/core/handlers.index_state_stability.test.ts`

- [ ] **Step 1: Add failing handler tests**
  Create focused tests that prove successful `manage_index create|reindex|sync` operations touch the watch list, successful indexed-root read/search/navigation calls keep that root watched, and `clear` removes the root from the watch list immediately.

- [ ] **Step 2: Wire manage flows to watch registration**
  Update `handleIndexCodebase`, `handleSyncCodebase`, and `handleReindexCodebase` success paths to call `touchWatchedCodebase()`. Update `handleClearIndex` and any codebase-drop path to call `unwatchCodebase()`.

- [ ] **Step 3: Wire read-only indexed operations to touch active roots**
  Touch the watch list from successful `search_codebase`, `file_outline`, `call_graph`, and `read_file` flows when they operate on a valid indexed root. Do not touch for `not_indexed`, `not_ready`, or `requires_reindex` outcomes.

- [ ] **Step 4: Re-run focused handler tests**
  Run: `pnpm --filter @zokizuan/satori-core build && pnpm -C packages/mcp exec tsx --test src/core/handlers.watchers.test.ts`
  Expected: PASS with deterministic watch-touch and unwatch behavior.

- [ ] **Step 5: Re-run the full MCP test suite**
  Run: `pnpm --filter @zokizuan/satori-mcp test`
  Expected: PASS with no regressions in indexing, blocking, or status tests.

- [ ] **Step 6: Commit the handler integration**
  Run:
  ```bash
  git add packages/mcp/src/core/handlers.ts packages/mcp/src/core/handlers.watchers.test.ts
  git commit -m "test: cover explicit watcher registration from handlers"
  ```

## Chunk 2: Install and Uninstall Flow

### Task 3: Extend the CLI command model for installer operations

**Files:**
- Modify: `packages/mcp/src/cli/args.ts`
- Modify: `packages/mcp/src/cli/index.ts`
- Create: `packages/mcp/src/cli/install.ts`
- Create: `packages/mcp/src/cli/install.test.ts`
- Read: `packages/mcp/src/cli/client.ts`
- Read: `packages/mcp/src/index.ts`

- [ ] **Step 1: Add failing parser tests for new subcommands**
  Extend `args.test.ts` or `install.test.ts` to cover `satori-cli install`, `satori-cli uninstall`, `--dry-run`, and unsupported-client usage errors.

- [ ] **Step 2: Add installer command parsing**
  Extend `ParsedCommand` in `args.ts` to support `install` and `uninstall` without changing wrapper semantics for the existing six tools.

- [ ] **Step 3: Implement client-config writers in a dedicated module**
  Build `install.ts` around pure helpers that detect supported client config paths, merge or remove Satori entries idempotently, and copy packaged skills into the expected client skill directory.

- [ ] **Step 4: Dispatch installer commands from the CLI entrypoint**
  Update `runCli()` in `index.ts` to route installer commands before MCP-session startup, since install and uninstall should not require a live server connection.

- [ ] **Step 5: Run focused CLI tests**
  Run: `pnpm --filter @zokizuan/satori-core build && pnpm -C packages/mcp exec tsx --test src/cli/args.test.ts src/cli/install.test.ts src/cli/index.test.ts`
  Expected: PASS with install and uninstall parser plus integration coverage.

- [ ] **Step 6: Commit the CLI installer surface**
  Run:
  ```bash
  git add packages/mcp/src/cli/args.ts packages/mcp/src/cli/index.ts packages/mcp/src/cli/install.ts packages/mcp/src/cli/install.test.ts
  git commit -m "feat: add satori-cli install and uninstall commands"
  ```

### Task 4: Add release metadata and packaging hooks that support installation

**Files:**
- Modify: `packages/mcp/package.json`
- Modify: `.github/workflows/release.yml`
- Create: `packages/mcp/scripts/generate-server-manifest.ts`
- Create: `server.json`
- Read: `README.md`

- [ ] **Step 1: Decide the published install target**
  Standardize on one install target for Phase 1. Preferred order: published npm package with `npx -y @zokizuan/satori-mcp`, then repo-local dev mode as an explicit fallback.

- [ ] **Step 2: Add manifest generation**
  Create a script that emits `server.json` from package version and install command metadata so the manifest is generated, not hand-edited.

- [ ] **Step 3: Include non-code assets in the package**
  Update `packages/mcp/package.json` `files` and build/release hooks so `server.json` and packaged skill assets are included in publishable output or release artifacts.

- [ ] **Step 4: Update release automation**
  Extend `.github/workflows/release.yml` to generate the manifest, verify it in CI, and publish any checksum or install metadata artifact needed by the installer.

- [ ] **Step 5: Run packaging validation**
  Run:
  ```bash
  pnpm --filter @zokizuan/satori-mcp build
  pnpm -C packages/mcp docs:check
  pnpm pack --filter @zokizuan/satori-mcp
  ```
  Expected: build succeeds, docs remain in sync, and the package tarball contains install assets.

- [ ] **Step 6: Commit the packaging changes**
  Run:
  ```bash
  git add packages/mcp/package.json packages/mcp/scripts/generate-server-manifest.ts .github/workflows/release.yml server.json
  git commit -m "build: add install metadata for satori-mcp"
  ```

## Chunk 3: First-Party Client Skills

### Task 5: Extract and package the first three Satori skills

**Files:**
- Create: `packages/mcp/assets/skills/satori-search/SKILL.md`
- Create: `packages/mcp/assets/skills/satori-navigation/SKILL.md`
- Create: `packages/mcp/assets/skills/satori-indexing/SKILL.md`
- Read: `examples/pi-extension/satori-bridge/skills/satori-cli/SKILL.md`
- Read: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

- [ ] **Step 1: Split the current bridge skill into three focused skills**
  Define one skill for semantic search defaults, one for symbol navigation (`file_outline`, `call_graph`, `read_file`), and one for index lifecycle and remediation (`manage_index`, `list_codebases`).

- [ ] **Step 2: Keep each skill contract-bound**
  Ensure every skill uses only the six shipped tools and the exact status and remediation semantics from the authoritative behavior spec.

- [ ] **Step 3: Add installer copy rules**
  Update the installer module to copy these skill assets into supported client skill directories during install and remove only Satori-owned skills during uninstall.

- [ ] **Step 4: Add focused install-skill tests**
  Extend `packages/mcp/src/cli/install.test.ts` to verify skills are copied, overwritten safely on reinstall, and removed cleanly on uninstall without deleting unrelated files.

- [ ] **Step 5: Run focused installer tests**
  Run: `pnpm --filter @zokizuan/satori-core build && pnpm -C packages/mcp exec tsx --test src/cli/install.test.ts`
  Expected: PASS with idempotent skill-copy coverage.

- [ ] **Step 6: Commit the packaged skills**
  Run:
  ```bash
  git add packages/mcp/assets/skills packages/mcp/src/cli/install.ts packages/mcp/src/cli/install.test.ts
  git commit -m "docs: package first-party Satori client skills"
  ```

### Task 6: Update docs and authoritative specs to match the shipped behavior

**Files:**
- Modify: `README.md`
- Modify: `packages/mcp/README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md`

- [ ] **Step 1: Document watcher scope changes**
  Update architecture and behavior docs to state that watcher mode tracks active-session codebases, not all indexed roots on startup.

- [ ] **Step 2: Document install and uninstall workflows**
  Add supported client targets, config locations, dry-run behavior, and packaged-skill behavior to the root and MCP READMEs.

- [ ] **Step 3: Document the first-party skill set**
  List the three shipped skills, their intended trigger patterns, and the fact that they preserve the six-tool surface without adding new tools.

- [ ] **Step 4: Run documentation verification**
  Run:
  ```bash
  pnpm -C packages/mcp docs:check
  pnpm -r run typecheck
  pnpm --filter @zokizuan/satori-mcp test
  ```
  Expected: PASS with docs regenerated and all type and test checks green.

- [ ] **Step 5: Run a manual smoke test**
  Run:
  ```bash
  pnpm --filter @zokizuan/satori-mcp build
  node packages/mcp/dist/cli/index.js install --dry-run
  node packages/mcp/dist/cli/index.js uninstall --dry-run
  ```
  Expected: deterministic text or JSON output describing the config and skill changes without mutating the machine.

- [ ] **Step 6: Commit docs and final polish**
  Run:
  ```bash
  git add README.md packages/mcp/README.md ARCHITECTURE.md docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md
  git commit -m "docs: record watcher install and skill workflows"
  ```

## Final Verification Gate

- [ ] Run:
  ```bash
  pnpm --filter @zokizuan/satori-core run test:integration
  pnpm --filter @zokizuan/satori-mcp test
  pnpm -r run typecheck
  pnpm -C packages/mcp docs:check
  ```
  Expected: all commands pass before merge or PR creation.

- [ ] Validate install and uninstall on a clean temp config directory for both supported clients.

- [ ] Confirm no new MCP tools were added by checking `packages/mcp/src/tools/registry.ts` and `packages/mcp/src/tools/registry.test.ts`.

- [ ] Prepare a PR summary organized as:
  1. explicit watch-list behavior
  2. installer and packaging
  3. packaged skills

