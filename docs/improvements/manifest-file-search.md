# Manifest file search — deferred

## Problem

Questions about a project manifest do not return the manifest file in the top five results:

- `codebase-memory-mcp`: "Where does the Go wrapper declare its module path and required Go language
  version?" returns `scripts/setup.sh::check_go_version` first. `pkg/go/go.mod` is not in the top five.
- `opencode2api`: "Which package file declares this project as an ES module and defines its Bun start
  scripts?" returns `scripts/update_cf_ips.py` first. The root `package.json` is not in the top five.

Profile: offline (Potion embeddings, LateOn reranker, LanceDB), `limit=5`, at `6d790275`.

## Cause

The manifests are not searchable on purpose. The index contains 0 documents for each file.

- `go.mod` is a semantic auxiliary file. `config/index-policy.ts` rejects auxiliaries from the search corpus
  before the extension and exact-name checks.
- A root `package.json` is a Publication control (`packages/ownership.ts`). The generation workflow removes
  controls from the searchable files in full and delta indexing, and ownership validation rejects a control
  that is also a searchable file.
- Tests require this partition: `generation/auxiliary-publication.test.ts` (Cargo manifests excluded, zero
  vector rows) and `package-ownership-publication.test.ts`.

## Counterfactual (built output only, not a repair)

With both admission gates removed, each manifest got one chunk, but ranking still missed:

| Query | Dense rank | After fusion | After rerank and definition fusion | Grouped |
|---|---|---|---|---|
| Go module | 3 | 5 | 13 | 13 |
| Bun package | 4 | 1 | 51 | 48 |

With `definition_discovery=false`, Go reached rank 2 and Bun stayed at rank 43.

## Decision

Deferred after the launch. A repair needs two design decisions:

1. Admission: let manifest files be both controls and searchable files through one policy (change the full,
   delta, checkpoint and ownership contracts and their tests), or keep the exclusion and add a separate
   Publication-bound file and manifest retrieval lane.
2. Ranking: give file and configuration questions evidence that the code reranker does not remove.

No query-string or repository-specific exceptions.
