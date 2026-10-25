# Dependency refresh test follow-ups, 25 October 2026

Status: proposals only. The dependency upgrade does not implement these changes.

## Real-model LateOn test entry

Owner: MCP test commands and the LateOn worker launch.

The source test run passes 25 LateOn tests. Enabling the two real-model tests fails
with a worker exit. A direct encoder launch reports `ERR_MODULE_NOT_FOUND` for
`src/server/lateon-reranker-encoder.js`. The unchanged worker requests that JavaScript
entry, which exists only in the build output. Both real-model oracles pass from
`dist/server/lateon-reranker.test.js` on Node 22.22.0, with Transformers 4.3.1.

Proposal: provide an explicit command that builds and runs the real-model tests from
the compiled output. Preserve the existing score and ranking assertions. Document
the local model requirement. Stop when that command runs both real-model tests
without source-file resolution errors or model downloads.

## Node executable path in installer assertions

Owner: `packages/cli/src/install.test.ts`.

Four installer tests reject any configuration text containing `node_modules`.
An npm-provided Node executable legitimately contains that directory in its path.
The configuration correctly uses `process.execPath`, but the broad assertion fails.
Copying the identical Node 22.22.0 binary to a temporary ordinary path makes all
482 CLI tests pass. No production code or assertion changes in this upgrade.

Proposal: inspect the parsed launcher command and arguments. Allow the Node
executable path while retaining the rejection of direct runtime module paths.
Check both executable locations and a deliberately invalid direct runtime entry.
