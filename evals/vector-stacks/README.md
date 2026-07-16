# Vector-stack paired comparison

This evaluation compares complete, already-published Satori runtimes on the
same clean Git revision and task suite. It reuses the useful-context recorder
so cold/warm readiness, result identity, latency, context bytes, and logical
provider work have one owner.

Use three arms when all providers are available:

1. `milvus-voyage`: current connected Milvus plus Voyage;
2. `lancedb-voyage`: LanceDB plus the same Voyage model and dimensions;
3. `lancedb-ollama`: the offline LanceDB plus resolved Ollama artifact.

The first pair isolates storage behavior. The second and third arms isolate the
embedding change on LanceDB. The direct Milvus/Voyage to LanceDB/Ollama result
is a full-stack comparison and cannot attribute a delta to either component.

## Recording contract

Build the workspace, use a separate `HOME` and database/snapshot state for each
arm, and publish a complete index of the same clean repository revision before
recording. Do not reuse or relabel an index across fingerprints. Record at least
five warm samples per arm, one arm at a time, with no concurrent indexing.
The recorder freezes one published generation identity per arm. Every task and
cold/warm sample must name the same canonical root, generation, runtime
fingerprint, collection name, completion-marker run ID, index-policy hash, and
policy-document digest, and the preparation sync must report zero added,
removed, and modified files. Separate no-change preparation syncs may have
different operation IDs and timestamps. A republished or changing generation
invalidates the arm rather than being averaged into its measurements.

The recorder inherits its environment. Supply credentials through the process
environment, never through committed files or command arguments. Example after
the selected arm has a completed index:

```sh
node scripts/satori-useful-context-record.mjs \
  --tasks evals/vector-stacks/tasks.json \
  --repo /absolute/path/to/satori \
  --command node \
  --command-arg /absolute/path/to/satori/packages/mcp/dist/index.js \
  --warm-samples 5 \
  --out /tmp/milvus-voyage.observations.json
```

Repeat with isolated runtime state and the exact environments for the two
LanceDB arms. Then compare the immutable observations:

```sh
pnpm eval:vector-stacks -- \
  --tasks evals/vector-stacks/tasks.json \
  --arm milvus-voyage=/tmp/milvus-voyage.observations.json \
  --arm lancedb-voyage=/tmp/lancedb-voyage.observations.json \
  --arm lancedb-ollama=/tmp/lancedb-ollama.observations.json \
  --out /tmp/vector-stack-comparison.json
```

The comparison fails closed when Git revision, task hash, Node identity, Satori
server identity, sample shape, arm generation receipt, zero-change sync proof,
or an arm's runtime fingerprint differs. It reports result overlap/order, cold
and warm latency deltas, owner-quality metrics, actual retrieval-mode counts,
and Satori logical provider operations. Logical operation counts are not
transport-request or retry counts.

Dense-only correctness remains an adapter-level exhaustive-cosine gate because
the public product planner intentionally routes supported user queries through
lexical or hybrid retrieval. The live comparison records the actual route and
retrieval mode instead of inventing a dense-only public query mode.
