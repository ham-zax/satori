# Satori CodeMode implementation plan

## Outcome

One MCP call runs agent-written JavaScript, performs several dependent or independent operations, and returns selected results. The tool is enabled by default. `SATORI_CODEMODE=0` disables its advertisement and execution.

Scripts can compute without using a tool. They can also use Satori's repository discovery tools and explicitly configured downstream MCP tools. The calling client's own tool catalog stays with that client. The first downstream transport is stdio, using the SDK client already in the MCP package.

The implementation starts from `5d50d987` on `origin/master`. Satori's MCP package owns the tool, configuration, admission, and adapter. The existing tool dispatcher owns workspace policy and continuation scope. Reuse `@earendil-works/pi-codemode` 1.5.2 and adapt the WebHarness `run_script` pattern. The runner loads only when called.

## Token measurement

The first comparison replayed matching T3 search and read results on the pushed baseline. The standalone arm counts tool arguments and full results. The batched arm counts the script and selected evidence. Both contain all 21 preselected facts. Counts use `o200k_base` as a proxy for model tokens.

| Workflow | Standalone calls | Script calls | Standalone tokens | Script tokens |
|---|---:|---:|---:|---:|
| Workspace policy dispatch | 2 | 1 | 1,382 | 409 |
| Semantic search cancellation | 3 | 1 | 1,794 | 542 |
| Continuation admission | 3 | 1 | 1,553 | 580 |
| **Total** | **8** | **3** | **4,729** | **1,531** |

This is a 67.6% reduction in the measured tool context. The sample counts requests and returned evidence. It excludes the shared tool catalog, model reasoning and final answers. A live agent comparison should include those costs and assess answer quality independently.

## Implementation

Apply the repository's failure-first test guidance to cancellation, workspace authorization, and tool registration. Keep user-visible contracts and generated material consistent with the implementation.

1. Add `run_script({ code })` to the MCP registry. Validate bounded source, run general JavaScript, and return bounded output with tool errors visible inside the script. Use the WebHarness defaults as the starting point for time, memory, call count, parallelism, and worker limits. Disable the tool through the existing runtime configuration path and keep the cached tool list consistent with that flag on direct stdio and shared runtime.
2. Share the existing MCP invocation path for nested Satori calls. Preserve argument validation, published-read authorization, measurement, and the same session-owned continuation coordinator. Expose all ten Satori read and discovery tools and `manage_index` with `action: "status"`. Keep index mutation actions on direct calls. Use the script's bounded capacity for nested calls and preserve host operation accounting until they drain.
3. Load optional operator configuration from an absolute path supplied by `SATORI_CODEMODE_MCP_CONFIG`. Define a `mcpServers` map with `command`, optional `args`, and explicit `allowedTools`. Expose configured names as `tools["server__tool"]` and reject invalid names or collisions. Resolve commands and arguments only from this file. Lazily open at most one stdio client per used server for a script. Bound connection and call time and close the clients on success, failure, and cancellation. A script can use only the explicitly configured tool names.
4. Track QuickJS worker slots with the Pi worker-lifetime API. Track the nested Satori promises separately and settle them before the request releases its resources. Cancel queued work on timeout or transport close. Clear all script-owned resources, including connections after partial startup. Advertise the tool through the current registry and update the generated manifest and docs.

## Acceptance checks

- The default stdio session lists and runs `run_script`. A disabled session omits it and rejects a direct call.
- Plain arithmetic and JSON transformation succeed with no MCP calls. A script invokes a locally configured non-Satori MCP fixture and combines its result with a second operation, using one outer call.
- Nested Satori reads honor the originating workspace scope. A configured server's undeclared tool cannot be called. A paginated search can consume its continuation inside the same script.
- A deterministic abort stops queued work and leaves the request owned until a gated in-flight call settles. Parallel work stays within limits, unhandled code errors report a bounded diagnostic, and a subsequent script can run.
- Package verification checks that the lazy-loaded worker and WASM resolve in a packed install. Run `pnpm run check`, focused MCP tests, manifest and docs checks, and the packed MCP smoke.

Prototype evidence and later live measurements should distinguish model-visible reductions from MCP wire bytes and downstream tool work.

## Implementation verification

- Workspace checks, the generated documentation and manifest checks, and all 84 focused MCP tests passed on Linux.
- The focused tests exercised direct and shared stdio, disabled-tool dispatch, session-scoped continuations, a real downstream MCP fixture, and cancellation through to session drain.
- The packed MCP smoke installed the tarball in an isolated runtime, connected over the legacy stdio protocol, and ran `run_script` to produce `[4,9]`. This exercised the lazy QuickJS worker and WASM loading from the installed package.
