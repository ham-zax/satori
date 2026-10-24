# Search miss triage: r7, p6, r1, f5, 25 October 2026

Status: complete and read-only. No product code change. r7 and p6 need no work.
r1 is a vocabulary gap with an existing caller-side repair. f5 needs an oracle
or intent decision, not a retrieval change.

## Scope and method

The four cases come from the 28-query set in
`evals/real-repo-quality/cases.json` (`sha256
6144f67803cbd12f4bb19f5e57b776a4d4ae867f02feb7c24b71aa02c1e9be09`). The run
under test is `/tmp/satori-voyage-projection-20261024/out/result.json`:

| Item | Value |
|---|---|
| Workspace | `0a2aa66c8a9d1071c04b1b32467bdd95eae2de68` plus the tree that became `fb125738` |
| Dirty tree | `sha256 5f84567b8f1c3c6d317dfe78e8468d2a74d3e3b374c20a1ae9fa0f564ef22bfa` |
| React | `7c6ac13e19fef500b7f669a16bbd01ecc95965ca` |
| Polars | `74dd736d655c` |
| FlatBuffers | `b8431fbcd7a5` |
| React publication | `b49c7aa9-6505-4cb4-ad04-bb9a43446976` |
| Polars publication | `cc8167fe-81fa-426e-9e66-4ee429b71c78` |
| FlatBuffers publication | `c50132d4-4016-4d8e-81ba-5f5629718f44` |
| Reranker | Voyage `rerank-3` |
| Query projection | `search_rerank_query_v2` |
| Document projection | `search_rerank_document_v5`, committed as `fb125738` |

Method: read-only probes against each Publication's LanceDB table and
navigation sidecars, plus one Voyage replay. No source files were edited. The
dense probe embeds the exact production query with the Publication's Potion
model. The lexical probes use the production term builder and LanceDB match
modes. The fallback probe uses the faithful OR fallback. The `/tmp` paths are
transient evidence. The numbers and method stay in this note.

| Case | Run symptom | Accepted owner | Mechanism | Work |
|---|---|---|---|---|
| r7 | absent in the pre-projection arm; rank 1 after `fb125738` | `ReactHooksWithNoopRenderer-test.js` `useEffect` | input rank 9; canonical document moves provider 46 to 1 | none |
| p6 | rank 2 | `parquet/builder.rs` `build_file_reader` | input rank 19; provider moves it to 2 | none |
| r1 | absent | `ReactFiberCommitEffects.js` `commitHookEffectListUnmount`, `safelyCallDestroy` | query says `cleanup`; owner says `destroy`, `unmount` | none in retrieval; caller `alt_terms` |
| f5 | absent | `src/idl_parser.cpp` `DoParse`, `ParseDecl` | no accepted symbol enters the pool; the supplement skips the file; Voyage prefers `ParseFile` | oracle or intent decision |

## r7: the canonical projection already fixes it

Query: `where are the tests for useEffect`. Focus: `tests`. The accepted path
is `packages/react-reconciler/src/__tests__/ReactHooksWithNoopRenderer-test.js`
or `ReactHooks-test.internal.js`; the accepted result carries the symbol
`useEffect`.

The accepted chunk at lines 25-25 enters rerank at rank 9 in both measured
arms. The arms then diverge:

| Arm | Rerank input | Provider | Final |
|---|---:|---:|---|
| Native document plus symbol metadata (`/tmp/satori-voyage-native-metadata-20261025`) | 9 | 46 | absent |
| Canonical projection (`/tmp/satori-voyage-projection-20261024`) | 9 | 1 | rank 1 |

The native arm's top result is the `describe("useEffectEvent") callback` in
`useEffectEvent-test.js`. The canonical arm returns
`ReactHooksWithNoopRenderer-test.js` `useEffect` at visible rank 1. `fb125738`
ships the canonical projection for Voyage, so the shipped path is the passing
arm.

Limit: the arms also differ in the symbol-metadata pass
(`symbol_metadata_bm25` on in the native arm, off in the projection arm), so
this is not an isolated document-only experiment. The shared input rank and
the 45-rank provider gap make the document the dominant factor.

Decision: no work. The hit is present on the shipped path.

## p6: one rank below the old default, still a hit

Query: `where does polars read a Parquet file`. Focus: `implementation`. The
accepted path is under `crates/polars-stream/src/nodes/io_sources/parquet/`.
The accepted result is `builder.rs:116-195` `build_file_reader`.

| Stage (pass with the accepted chunk) | `builder.rs:116-180` rank |
|---|---:|
| Dense, expanded pass | 77 |
| Fusion | 9 |
| Rerank input | 19 |
| Provider | 2 |
| Final grouped | 2 |

The final rank is 2. The earlier 24 October run put p6 at rank 1, so the
current run is one rank lower and still inside the accepted path. The rank-1
result is `polars-sql/src/table_functions.rs` `read_parquet`, which the oracle
excludes because it is the SQL wrapper, not a Parquet reader.

Decision: no work. A one-rank change is within the measured variation and does
not remove the hit.

## r1: a vocabulary gap, not a budget shortfall

Query: `where does React run the cleanup function of useEffect`. Focus:
`implementation`. The accepted path is
`packages/react-reconciler/src/ReactFiberCommitEffects.js`; the accepted
symbols are `commitHookEffectListUnmount` and `safelyCallDestroy`.

| Lane | Best accepted-chunk rank |
|---|---:|
| Dense, exact scan (97,466 chunks) | 5,177 |
| Dense, top score / rank-80 score | 0.77934 / 0.69733 |
| Lexical `all_terms` | 0 rows returned |
| Lexical `any_terms` | outside the top 5,000 |
| Faithful OR fallback | 2,306 |

The two accepted chunks are `248-302` (score 0.49453) and `907-910` (score
0.43387). No recorded stage in the run contains
`ReactFiberCommitEffects.js`; the visible top result is `ReactHooks.js`
`cleanUp`. The native-metadata arm, which turns the symbol-metadata pass on,
also misses r1.

The query word `cleanup` does not occur in the owner. The code says `destroy`
and `unmount`. Dense retrieval cannot translate the word, lexical `all_terms`
returns nothing, and the OR fallback puts the owner at 2,306 of 5,000.

The measured repair is already documented: a caller-supplied `alt_terms` entry
`destroy` moves r1 from absent to rank 1 in both the `definition_alt_terms`
off and on arms (see
[agent alt terms](agent-alt-terms-definition-discovery.md), d1 and d2). That
measurement used the 72-question set and LateOn, not this 28-query Voyage run,
but the admission mechanism is reranker-independent.

Decision: no retrieval work. The existing caller-side `alt_terms` bridge is the
repair. An automatic synonym bridge is a separate product change and has no
measured design here.

## f5: no accepted symbol reaches the pool, and Voyage does not rank it

Query: `where does flatc parse a schema file`. Focus: `neutral`
(`no_focus_signal`). The oracle accepts `^src/idl_parser\.cpp$` with
`^(Parser::)?(DoParse|Parse|ParseDecl)$`. `Parse` does not exist as a symbol in
that file. `ParseDecl` is at 2869-2962 and `DoParse` at 3777-3938.

| Lane | Result |
|---|---|
| Dense, exact scan (39,716 chunks) | 1,638 (score 0.34691) |
| Dense, vector-index order | 9,830 |
| Lexical `all_terms` | 1 row, not the target |
| Lexical `any_terms` | best 258 (chunk 3830-3889), then 802 and 1,022 |
| Faithful OR fallback | 160 |
| Symbol metadata | `StartParseFile` 3615-3625 at rank 4 |
| Rerank input | `StartParseFile` at rank 10 |
| Provider | `StartParseFile` at rank 75 |

The only `src/idl_parser.cpp` candidate in the pool is `StartParseFile`, which
is not accepted. The file→symbol supplement is gated on
`answerFocus === "implementation"` in
`packages/mcp/src/core/search-execution.ts:1136`, so a `neutral` query never
receives it. Opening the gate is not enough. A direct call to
`supplementSearchFileSymbols` with the run's candidate lists adds four symbols
in `include/flatbuffers/flatc.h` and `scripts/generate_code.py`, and none from
`src/idl_parser.cpp`. The supplement inspects the first three distinct
candidate files, then up to three declaration files ranked by path context and
symbol-name matches. `src/idl_parser.cpp` is not in the first three. It has no
path context, and it ranks below three `tests/ts/reflection/schema-file.*`
files that match `schema` and `file` in the path, so the supplement never
inspects it. When the file is forced into the lane, the supplement adds both
`DoParse` and `ParseDecl`.

To test whether the gate is the cause, the replay rebuilt the run's rerank
documents and added two `DoParse` probes:

- 88 of 89 run documents rebuilt byte-exact against `documentSha256`, using the
  canonical projection and the full relationship sidecar (9,526 records across
  1,527 shards). The one miss is
  `derived:["tests/ts/reflection/schema-file.ts",12,91]`, whose span is absent
  from the registry.
- The replay's top-10 set is identical to the run's provider top-10 set.
- The full-symbol probe (3777-3938) and the 80-line probe (3777-3856) both
  score 0.4785 and rank 51 and 52 of 90.
- Position 10 has score 0.6406. The margin is 0.162, about 16 times the ±0.01
  replay variation from Voyage score quantization.

So opening the supplement gate would still need the file lane to select
`src/idl_parser.cpp`, and even then Voyage would place `DoParse` around rank
51. The gate change does not fix f5.

The provider's top answer is `ParseFile` in `src/flatc.cpp` and
`include/flatbuffers/flatc.h`. For "where does flatc parse a schema file", that
is a defensible answer: `flatc` calls the parser from `ParseFile`. The eval
rejects it because the oracle names only the parser methods in
`src/idl_parser.cpp`.

Decision: f5 is an oracle or intent mismatch, not a retrieval defect. Either
accept the miss or widen the oracle to include `flatc.cpp` `ParseFile`. The
second option is eval-only and needs no product change.

## Limits

- One Publication per repository and one host. The figures do not establish
  cross-host or cross-build stability.
- Voyage scores quantize near 0.01 on replay. The r7 and f5 margins are much
  larger, but a near-cutoff case would need repeated calls.
- The f5 dense lane has two ranks: 1,638 for the exact scan and 9,830 for the
  vector-index order. Both are far outside the 80-row dense window, so the
  conclusion does not depend on which rank production serves.
- The f5 replay omits one derived TypeScript test document. That omission can
  move a position by at most one and cannot explain a 41-position gap.
- The r7 comparison confounds the document with the symbol-metadata pass, as
  noted above.
- The r1 `alt_terms` repair comes from an earlier 72-question LateOn run. This
  note did not re-run it on the Voyage path.

## Evidence

- `/tmp/satori-voyage-projection-20261024/out/result.json` and `summary.md`:
  the Voyage run, per-stage candidates, and final scores.
- `/tmp/satori-voyage-native-metadata-20261025/out/result.json` and
  `summary.md`: the r7 native arm.
- `/tmp/satori-dense-rank-20261025/probe.mjs`: exact dense rank.
- `/tmp/satori-dense-rank-20261025/probe-f5-dense-variants.mjs`: exact and
  index-ordered f5 dense ranks.
- `/tmp/satori-dense-rank-20261025/probe-lexical.mjs`: both lexical modes.
- `/tmp/satori-dense-rank-20261025/probe-fallback.mjs`: faithful OR fallback.
- `/tmp/satori-dense-rank-20261025/probe-rerank-doparse.mjs` and
  `voyage-f5-doparse.json`: the 88-document rebuild and Voyage replay.
- `/tmp/satori-dense-rank-20261025/probe-f5-supplement-stages.mjs`: the
  supplement over four run stages; it adds no `src/idl_parser.cpp` symbol.
- `/tmp/satori-dense-rank-20261025/probe-f5-supplement-files.mjs`: the
  supplement's file-lane ranking.
- `/tmp/satori-dense-rank-20261025/probe-f5-supplement-direct.mjs`: the
  supplement with `src/idl_parser.cpp` forced into the lane; it adds `DoParse`
  and `ParseDecl`.
