# Satori OpenCode agent-discovery evaluation

Protocol version: `satori-agent-discovery-v3`

## Instruction for the OpenCode agent reading this file

Run the executable command below from the repository root. Do not perform the
native and Satori tasks yourself, do not ask the user for run parameters, and
do not turn the protocol into a conversational checklist. The executable
creates the isolated sessions, supplies the fixed queries, measures both arms,
and prints the final comparison. Wait for it to finish and return its artifact
path and summary table. If it fails, return the exact failing gate and error.

This evaluation compares how a smaller coding model discovers the same
production code path with:

- OpenCode's ordinary `grep`, `glob`, and bounded `read` tools (`native`); or
- Satori's search, exact symbol open, outline, and call-graph tools (`satori`).

The executable harness owns task selection, arm selection, isolation,
measurement, grading, and reporting. A measured agent must never ask the user
for a repository path, task ID, arm, or native-tool profile.

## Run from OpenCode or a terminal

From the Satori repository root:

```bash
pnpm eval:agent-discovery
```

That command automatically runs every versioned task in both arms, with three
fresh paired repetitions and alternating arm order. The pinned default model is
`opencode/deepseek-v4-flash-free`. Override it without an interactive exchange:

```bash
pnpm eval:agent-discovery -- --model provider/model
```

Useful controls:

```bash
# Validate the corpus, current source spans, and run schedule without model calls
pnpm eval:agent-discovery -- --dry-run

# Force the Satori search -> exact open -> outline -> graph coverage sequence
pnpm eval:agent-discovery -- --mode coverage

# Run one fixed task while debugging the harness
pnpm eval:agent-discovery -- --task known-exact-target --repetitions 1
```

The default `natural` mode measures the minimum evidence-gathering work the
agent chooses. `coverage` is a separate tool-integration check; its forced
outline step must not be reported as natural agent overhead.

## Fixed tasks

Tasks are versioned in `evaluator-tasks.json`. The runner executes all of them
unless `--task` explicitly selects a subset. It never generates a random query
inside a measured session and never asks the measured model to choose a task.

The corpus currently contains:

1. `known-exact-target`: locate and trace the supplied exact identifier
   `runExactRegistryFastPath`.
2. `unknown-freshness-reuse`: discover, from a behavioral description, the
   owner that decides whether prepared-read evidence survives freshness
   processing.

The first task measures a known target. The second is a fixed semantic query
whose answer is real in this repository. Both arms receive the exact same task
text. Expected owners, facts, spans, and relationships remain hidden from the
model.

Before any model call, the runner parses the production TypeScript AST and
requires every expected symbol and inclusive span to match the pinned revision.
It aborts on a stale answer key; it never edits the key after seeing a model
result.

## Isolation and arm order

Each task uses this order:

```text
repetition 1: native, satori
repetition 2: satori, native
repetition 3: native, satori
```

Every arm receives a new OpenCode session and a fresh model context. The two
arms share one long-lived headless OpenCode server so Satori's normal process
cache can become warm without sharing conversation history. Session IDs must be
unique. No arm can see another arm's prompt, transcript, result, or answer.

The runner creates isolated agents whose schemas expose only the selected arm's
tools. It disables question, todo, shell, editing, subagent, web, LSP,
codebase-memory, index-management, and unrelated MCP tools. A project plugin
rejects forbidden calls before execution, enforces production-root and read
bounds, removes native test evidence, and caps built-in tool results at 32,768
UTF-8 bytes. OpenCode 1.17 does not expose an MCP result body to its post-tool
hook; Satori requests are therefore bounded by their task arguments and a run
is rejected if the persisted model-visible MCP result exceeds the same cap.

## Rules embedded in every measured prompt

The executable embeds all run values and these rules directly. The measured
agent does not read this file as a tool step.

1. Treat the repository as read-only.
2. Inspect production TypeScript only under `packages/core/src` and
   `packages/mcp/src`.
3. Never inspect `*.test.ts`, docs, evaluator files, Git history, prior results,
   or another session.
4. Make at most 24 tool calls. Parallel calls are allowed and every call is
   measured.
5. Follow visible evidence from one result to the next. Do not jump to a
   remembered path.
6. Stop when the owner source, complete inclusive span, required relationships,
   and task facts are proven.
7. Do not estimate timings, tokens, bytes, or steps. OpenCode records them.
8. Do not ask questions. Repository, task, arm, mode, and allowed tools are
   already present.

### Native arm

The native arm may use only OpenCode's ordinary `grep`, `glob`, and `read`.

- Every operation is confined to an allowed production root.
- A file must be discovered by visible `grep` or `glob` evidence before it is
  read.
- Every read specifies an explicit positive limit of at most 200 lines.
- The first query or pattern comes from the task. Later queries come only from
  the task or immediately visible evidence.
- Test-file evidence is removed before the model can see it.

The native arm has no shell, AST index, semantic index, LSP, Satori,
codebase-memory, call graph, or benchmark helper.

### Satori arm

The Satori arm may use only:

```text
satori_search_codebase
satori_read_file
satori_file_outline
satori_call_graph
```

Its first search arguments are generated from the immutable task manifest:

```json
{
  "path": "<canonical repository root>",
  "query": "<versioned task query>",
  "scope": "runtime",
  "resultMode": "grouped",
  "groupBy": "symbol",
  "rankingMode": "default",
  "limit": 5
}
```

The agent must use returned `target.file` and `target.symbolId` evidence rather
than inventing an identity. In `natural` mode it chooses the fewest relevant
Satori operations. In `coverage` mode it must run search, exact symbol open,
exact outline, and call graph in that order and pass the complete returned
target object into the graph call.

## Compact model response

The model returns only one compact JSON object:

```json
{
  "status": "success",
  "answer": {
    "ownerFile": "packages/example/src/owner.ts",
    "ownerSymbol": "ownerSymbol",
    "ownerSpan": { "startLine": 10, "endLine": 30 },
    "relatedSymbols": [
      {
        "symbol": "callerSymbol",
        "relation": "caller",
        "file": "packages/example/src/caller.ts"
      }
    ],
    "taskFacts": {},
    "behavioralConclusion": "Bounded task-specific conclusion."
  }
}
```

It does not reproduce tool arguments, steps, timings, token counts, or raw
evidence. The harness derives the real ordered ledger from OpenCode events.

## Authoritative output

OpenCode's SQLite event records and the guard plugin provide:

- complete task wall time;
- model API and tool latency;
- provider-reported input, output, reasoning, and cached-input tokens;
- raw and model-visible tool-result bytes;
- model turns and actual tool calls;
- steps and time to the first correct owner and owner source;
- the last tool step needed for the verified answer;
- exact tool inputs, outputs, truncation, and status;
- actual built-in definitions captured by OpenCode and MCP definitions captured
  from Satori's authoritative `tools/list`, with their UTF-8 size and SHA-256.

The runner grades the compact answer and real tool events against the frozen
key. Only correct runs contribute to comparative medians and ranges.

The final report separates retrieval milestones, evidence completion and its
investigation tail, and full autonomous-agent cost. Retrieval and evidence
coverage include failed final answers; paired latency and token comparisons use
correct runs, while a separate all-attempt diagnostic retains failed-run cost.

Artifacts are written under:

```text
.satori/benchmarks/agent-discovery/<suite-id>/
```

The directory contains the immutable run manifest, one result and raw OpenCode
event stream per arm, raw tool and schema ledgers, an isolated OpenCode database,
`summary.json`, and a human-readable `summary.md`. The command prints the final
native-versus-Satori table and artifact path, so the user receives concrete
latency, token, byte, correctness, and step numbers at the end.
