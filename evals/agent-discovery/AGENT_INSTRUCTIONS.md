# Satori Agent-Discovery Evaluation Protocol

Protocol version: `satori-agent-discovery-v1`

This protocol compares two ways an autonomous coding agent can discover and
verify a production code path:

- `native`: iterative repository discovery using the harness's ordinary local
  search, file-listing, and bounded file-read tools.
- `satori`: discovery using only Satori's read-only code-intelligence tools.

This is an agent-efficiency evaluation, not a raw tool-latency benchmark. The
same model must solve the same task independently in both arms. The evaluation
measures the complete model/tool loop: elapsed time, API tokens, visible tool
output, model turns, discovery steps, and correctness.

The harness supplies exactly four run values:

```text
REPO_ROOT=<absolute canonical repository root>
TASK_ID=<known-exact-target|unknown-freshness-reuse>
ARM=<native|satori>
NATIVE_TOOL_PROFILE=<JSON profile for native, or null for satori>
```

Do not start until all four values are present. The native profile names the
actual default tools available in that harness and maps each one to an allowed
capability.

## Agent rules

1. Work only on the supplied task and arm.
2. Treat the repository as read-only. Do not edit, generate, format, stage,
   commit, index, synchronize, repair, or clear anything.
3. Do not use prior transcripts, remembered answers, evaluator files, tests,
   documentation, Git history, or another agent.
4. Inspect production TypeScript only under:

   ```text
   packages/core/src
   packages/mcp/src
   ```

5. Exclude every `*.test.ts` file.
6. Make at most 12 tool calls. One tool call is one discovery step.
7. Make exactly one tool call in a model turn. Never call tools in parallel.
8. Stop as soon as all required evidence is established. Extra discovery after
   that point is a protocol failure, because it distorts efficiency.
9. Do not expose private chain-of-thought. Record only the selected evidence
   and its direct relevance in the final step ledger.
10. Never estimate token counts, timings, or response sizes. The harness records
    those values from API and tool events.

If an allowed operation fails, it still counts as one step. Record the failure
and continue only when the remaining budget can still establish the answer.

## Tasks

The harness must pass one of these task IDs and the corresponding prompt exactly
as written. Both arms receive identical task text.

### `known-exact-target`

> Locate the production definition of `runExactRegistryFastPath`. Report its
> repository-relative file, exact symbol name, and complete 1-based inclusive
> source span. Identify one production caller that invokes it and one relevant
> callee used to resolve an exact registry match. Briefly explain the target's
> role in search execution. Verify every claim from source or relationship
> evidence.

This is the known-target case. The identifier is intentionally supplied.

### `unknown-freshness-reuse`

> Find the production code path that decides whether initial prepared-read
> evidence may be reused after source-freshness processing. Report the owning
> file, owning symbol, and its complete 1-based inclusive source span. Identify
> the exact predicate or evidence conditions that permit reuse and the branch
> that forces a second readiness proof. Identify one production caller and the
> relevant helper or relationship. Verify every claim from source or
> relationship evidence.

This is the unknown-target case. No owner path or symbol is supplied. Do not ask
the harness for a hint.

### Task fact contract

In `answer.taskFacts`, return exactly the keys for the selected task.

For `known-exact-target`:

```json
{
  "exactMatchResolver": "symbol name or null",
  "checksEligibility": null,
  "requiresNavigationAuthority": null,
  "handledHitAvoidsSemanticRetrieval": null,
  "handledHitAvoidsReranking": null
}
```

For `unknown-freshness-reuse`:

```json
{
  "acceptedFreshnessModes": ["mode names in source order"],
  "requiresFirstAttempt": null,
  "requiresReadyInitialState": null,
  "requiresExistingObservation": null,
  "requiresInitialObservationMatch": null,
  "requiresStableObservation": null,
  "secondProofSymbol": "symbol name or null"
}
```

The `null` booleans above are schema placeholders. A successful run must replace
each one with `true` or `false` from inspected evidence; incorrect values fail
grading.

## Required evidence milestones

A successful answer must establish all four milestones, in order when
practical:

1. `candidate`: locate the production owner candidate.
2. `implementation`: inspect the owner's source and establish its complete
   inclusive span.
3. `structure`: verify the symbol within its file rather than relying only on a
   search preview.
4. `relationship`: verify at least one production caller and the task-specific
   callee, helper, or second-proof relationship.

A search result alone is not a complete answer. A relationship result alone is
not proof of the implementation or its span.

## Native arm

The native arm is the control: solve the task with the same default local
discovery means a user of that harness would have without Satori. The agent may
choose its searches, paths, flags, and read windows dynamically.

`NATIVE_TOOL_PROFILE` is authoritative. It may expose actual tools such as
`Grep`, `Glob`, `Read`, or a shell wrapper around ordinary read-only commands.
Every exposed operation must map to one or more of these capabilities:

- `text_search`: literal or regular-expression search over permitted source.
- `file_list`: path or glob discovery under permitted source roots.
- `range_read`: a source read with visible 1-based line numbers.

The supplied profile has this shape:

```json
{
  "profileId": "harness-native-default-v1",
  "tools": [
    {
      "name": "actual tool name",
      "capabilities": ["text_search", "file_list", "range_read"],
      "allowedCommandFamilies": ["only for a shell-capable tool"],
      "maxSourceLinesPerRead": 200
    }
  ]
}
```

`allowedCommandFamilies` is `[]` for a structured native tool. A shell wrapper
may invoke only a listed command family, with arguments chosen dynamically.

Rules:

1. Use only tools and capabilities named in `NATIVE_TOOL_PROFILE`.
2. Search and list only within the two permitted production roots. Exclude
   `*.test.ts` in the operation itself; do not search tests and discard them
   afterward.
3. Read a file only after a native search or list result discovered that path.
4. Read at most 200 source lines per call. Long symbols require adjacent or
   overlapping bounded reads.
5. The first text query, or the pattern of an initial file-list operation, must
   come from the task. Later operations may be refined from task language,
   identifiers, literals, imports, calls, or paths found in earlier visible
   results.
6. Follow evidence from one result to the next. Do not jump directly to an
   unstated owner path or symbol from memory.
7. A shell-capable profile permits one logical read-only discovery operation
   per tool call. A pipeline may only number, bound, or format that one
   operation, such as a numbered range read or a capped search result. It must
   not feed search results into another search or file read. Command chaining,
   write redirection, command substitution, background processes, and scripts
   are forbidden.
8. Do not use AST indexes, semantic search, embeddings, symbol indexes, call
   graphs, codebase-memory, Satori, LSP, IDE navigation, Git history, tests,
   documentation, or evaluator files.
9. Do not use a benchmark-specific helper that combines search, reading, or
   relationship recovery into one call. The native arm must use the harness's
   normal user-facing tools.

For each step, record the actual tool or command and the concrete task or prior
evidence that motivated it. This is selected-evidence provenance, not private
reasoning.

## Satori arm

The Satori arm permits only these read-only tools:

```text
search_codebase
read_file
file_outline
call_graph
```

Do not use a shell, filesystem tools, codebase-memory, `manage_index`,
`list_codebases`, or any other tool.

### Search

The first call must be `search_codebase` with these exact arguments, replacing
only `$REPO_ROOT` and the query:

```json
{
  "path": "$REPO_ROOT",
  "query": "<TASK_QUERY>",
  "scope": "runtime",
  "resultMode": "grouped",
  "groupBy": "symbol",
  "rankingMode": "default",
  "limit": 5
}
```

Use these task queries:

```text
known-exact-target:
runExactRegistryFastPath

unknown-freshness-reuse:
Find the production code path that decides whether initial prepared-read evidence may be reused after source-freshness processing. Identify the exact predicate or evidence conditions that permit reuse and the branch that forces a second readiness proof.
```

Select only a production target under an allowed root. If the first result is
not sufficient, another `search_codebase` call is allowed with the same fixed
arguments. Its query may contain only identifiers or terms copied from the task
prompt or immediately preceding result. Record the derivation. Do not increase
the result limit or switch ranking, grouping, mode, or scope.

### Exact source open

After selecting a grouped target with `target.file` and `target.symbolId`, call
`read_file` exactly once for that target:

```json
{
  "path": "$REPO_ROOT/<target.file>",
  "mode": "annotated",
  "open_symbol": {
    "symbolId": "<target.symbolId>"
  }
}
```

Do not replace a returned symbol ID with a guessed label or span. If no result
has a symbol ID, search again or return `not_found`.

### Exact outline

Call `file_outline` for the same target:

```json
{
  "path": "$REPO_ROOT",
  "file": "<target.file>",
  "resolveMode": "exact",
  "symbolIdExact": "<target.symbolId>",
  "limitSymbols": 20
}
```

### Relationship verification

If the selected grouped result reports `navigation.graph="ready"`, pass its
`target` object to `call_graph` unchanged:

```json
{
  "path": "$REPO_ROOT",
  "symbolRef": "<the complete target object from search_codebase>",
  "direction": "both",
  "depth": 1,
  "limit": 20
}
```

`symbolRef` above denotes the JSON object, not a string. Do not rebuild it from
memory. If graph navigation is unavailable, use one bounded follow-up
`search_codebase` call to verify the relationship and state that the call graph
was unavailable. Never claim that an empty graph proves there are no callers.

## Completion and stopping

Return `success` only when every required milestone is supported by visible
evidence. Otherwise return the most specific non-success status:

- `not_found`: the owner could not be established within 12 steps.
- `tool_error`: an allowed tool failed and the answer could not be verified.
- `budget_exhausted`: 12 calls were used before verification completed.
- `protocol_violation`: any forbidden operation or argument was used.

The measured task ends when the harness receives the final JSON response. Do not
add prose before or after it.

## Final agent JSON

Return one JSON object matching this shape. All spans are 1-based and inclusive.
Use repository-relative paths with `/` separators.

```json
{
  "protocolVersion": "satori-agent-discovery-v1",
  "taskId": "known-exact-target",
  "arm": "native",
  "status": "success",
  "answer": {
    "ownerFile": "packages/example/src/owner.ts",
    "ownerSymbol": "ownerSymbol",
    "ownerSpan": {
      "startLine": 10,
      "endLine": 30
    },
    "relatedSymbols": [
      {
        "symbol": "callerSymbol",
        "relation": "caller",
        "file": "packages/example/src/caller.ts",
        "evidence": "Directly invokes ownerSymbol."
      }
    ],
    "taskFacts": {},
    "behavioralConclusion": "A bounded explanation of the task-specific decision and evidence."
  },
  "steps": [
    {
      "step": 1,
      "operation": "actual native or Satori tool name",
      "request": {
        "arguments": {
          "query": "the exact structured-tool query"
        }
      },
      "derivedFrom": {
        "kind": "task_prompt",
        "step": null,
        "evidence": "exact term copied from the prompt"
      },
      "milestone": "candidate",
      "selectedEvidence": [
        {
          "file": "packages/example/src/owner.ts",
          "symbol": "ownerSymbol",
          "span": {
            "startLine": 10,
            "endLine": 10
          },
          "relevance": "Definition candidate."
        }
      ]
    }
  ],
  "selfCheck": {
    "allowedOperationsOnly": true,
    "oneToolCallPerStep": true,
    "answerKeyNotAccessed": true,
    "violations": []
  }
}
```

For a structured native or Satori tool, use `request.arguments` with the exact
JSON arguments. For a native shell wrapper, use `request.command` with the exact
command. For a failed result, `answer` may use `null` for fields that were not
proven.

Every top-level key in the example is required. Additional field rules:

- `taskId` must equal the supplied task ID.
- `arm` must equal the supplied arm.
- `status` must be one of the five statuses defined above.
- `answer` is always present. An unproven scalar or span is `null`; an unproven
  relationship list is `[]`.
- `taskFacts` contains exactly the selected task's fact keys. Use `null` for an
  unproven string, `[]` for an unproven list, and `false` only when source
  evidence establishes false. A failed run may use `null` for an unproven
  boolean.
- `relation` must be `caller`, `callee`, `helper`, or
  `second_readiness_proof`.
- `operation` must be an operation allowed by the selected arm.
- `request` contains exactly one of `command` or `arguments`.
- `derivedFrom.kind` is `task_prompt`, `prior_step`, or `tool_failure`.
  `derivedFrom.step` is `null` for `task_prompt` and otherwise names the
  1-based earlier step.
- `milestone` is `candidate`, `implementation`, `structure`, `relationship`, or
  `none`.
- A selected-evidence `span` is either a complete `{startLine, endLine}` object
  or `null`.
- `violations` contains short machine-readable strings and is `[]` on a valid
  run.

Constraints on model-authored text:

- `behavioralConclusion`: at most 800 characters.
- Each relationship `evidence`: at most 240 characters.
- Each selected-evidence `relevance`: at most 160 characters.
- At most three selected-evidence entries per step.
- `steps` must match the actual tool event order exactly. Do not omit failed or
  empty calls.

The harness must not send its collection, grading, or hidden-answer rules to the
model. Those rules are defined separately in `HARNESS_PROTOCOL.md`.
