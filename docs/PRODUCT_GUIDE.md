# Satori Product Guide

Satori is a **local-first code-intelligence layer for developers and coding agents**.

You can ask where behavior lives in natural language without knowing the right filename or identifier first. Satori combines semantic meaning with lexical and exact evidence, then maps the result back to source, symbols, structural spans, supported relationships, source freshness, and the exact repository generation those facts came from.

The result is a queryable repository-intelligence layer that sits between an AI coding agent and a large codebase.

> **Understand any codebase before you touch it.**

Satori does not edit your code. It helps the agent find the right code, understand its owner and surroundings, and read exact evidence before the edit happens.

## The mental model

```text
Repository
    |
    v
Repository intelligence database
    |
    +-- semantic meaning
    +-- lexical / exact identifiers
    +-- symbols and source spans
    +-- file structure
    +-- supported relationships
    +-- source freshness
    |
    v
Ask -> locate owner -> trace -> read exact source
```

A **Publication** is Satori's immutable snapshot of everything it knows about one coherent repository generation.

That matters because search, symbols, navigation, source checkpoints, and relationship evidence should agree about the same version of the repository. Satori prepares replacements away from the active generation and activates a complete Publication rather than intentionally serving a half-updated index.

## What Satori helps with

### Learn an unfamiliar repository

You do not need to know the filenames first.

Ask where behavior lives, which symbol owns it, what the file contains, and which supported relationships are worth inspecting.

Examples:

```text
Where is refresh-token rotation implemented?

What owns index publication?

Find the code responsible for automatic reindexing.

Which module decides whether a repository can be searched?
```

A useful answer path is usually:

```text
plain-English intent
    -> ranked owner-oriented evidence
    -> file / symbol structure
    -> related call evidence
    -> exact bounded source
```

### Investigate a bug

Satori helps turn a symptom into source evidence without making the agent dump whole directories into its prompt.

Useful questions include:

```text
Where does this error message originate?

What code owns the lifecycle of this background operation?

Which direct callers reach this function?

What configuration can change this path?
```

The call graph is intentionally conservative. It is navigation evidence, not a compiler-complete promise that every dynamic or indirect caller has been found.

### Plan a refactor or feature

Before the agent edits, use Satori to establish:

- the concrete owner of the behavior;
- nearby symbols in the same file;
- exact source spans;
- supported callers/callees/imports/exports;
- configuration or policy code associated with the behavior;
- whether the indexed evidence is current enough to trust.

This is especially useful when the change is conceptually simple but the repository is not.

### Spend less model context on repository discovery

Without a repository map, coding agents often reconstruct one repeatedly through broad searches and large file reads.

Satori instead emphasizes:

- owner-oriented search groups;
- exact identifiers and lexical evidence;
- bounded source reads;
- symbol-sized context;
- structural file outlines;
- continuation of an already-frozen search result set.

The design goal is to spend context on the code that matters rather than on rediscovering the repository. Satori does not claim a universal token-reduction percentage across every model, repository, and task.

### Give multiple local agent sessions the same repository intelligence

On the managed offline path, compatible Codex, Claude Code, OpenCode, and subagent sessions can attach to a shared local runtime instead of each booting a separate heavyweight provider/index stack.

The repository intelligence remains a shared product resource; each MCP client still gets its own session boundary.

## What is inside the repository-intelligence database?

Think of Satori as several evidence layers bound to one Publication.

### 1. Source selection

Satori tracks the repository root, index profile, supported file extensions, ignore rules, and the files selected into the current Publication.

Profiles let you choose how broad the source corpus should be:

- `default` — source plus useful documentation, configuration, scripts, infrastructure, queries, and known text files;
- `minimal` — source and documentation text;
- `all-text` — the default profile plus additional bounded UTF-8 text files.

Hard-denied secret/dependency/generated categories remain excluded.

### 2. Semantic evidence

The default managed offline runtime embeds code locally with Potion. Semantic retrieval helps when the user knows the behavior they want but not the exact identifier.

Example:

```text
Find where background mutations are kept alive after an MCP session disconnects.
```

The query does not need to contain the exact class or method name.

### 3. Lexical and exact evidence

Semantic similarity is only one part of code discovery. Satori also keeps BM25 and exact identifier/path evidence in the retrieval path so that configuration keys, API names, class names, error text, and other literal clues do not disappear behind embeddings.

### 4. Symbol ownership

Parser-derived symbol records map source evidence back to owners such as functions, methods, classes, and other supported constructs.

That lets Satori answer with the unit that owns the behavior rather than a pile of nearby chunks.

### 5. Structural spans and file outlines

`file_outline` exposes the indexed structure of a file without forcing an agent to read the entire implementation first.

This is useful for questions such as:

```text
What are the main owners in this file?

Which method should I read before modifying this class?
```

### 6. Relationship evidence

Where the language backend can prove supported relationships, Satori stores and traverses qualified navigation evidence.

Current production symbol navigation plus the qualified `CALLS v0` slice covers TypeScript, JavaScript, Python, Go, Java, C#, C++, Rust, and Scala.

Relationship navigation is deliberately conservative. Missing or ambiguous proof is allowed to remain absent rather than being presented as certainty.

### 7. Exact source spans

`read_file` can read an exact indexed symbol or a bounded line range.

That gives the coding agent a natural progression:

```text
search broadly -> identify owner -> inspect structure -> read only the implementation needed
```

### 8. Source freshness

A code index is useful only if the caller understands whether its evidence still matches the working repository.

Satori stores source checkpoints with Publications and can report fresh, changed, unverified, or maintenance-related states rather than silently treating old evidence as current.

### 9. Runtime and navigation compatibility

A Publication also carries enough identity to determine whether the running Satori configuration can safely use it.

If an index format, embedding identity, navigation representation, or rebuild-relevant policy no longer matches the runtime, Satori can require a full replacement instead of pretending incremental sync is sufficient.

## First five minutes

### 1. Install Satori

Requirements for the packaged default path are Node.js 22.13+ and Linux x64. WSL2 is the primary qualified Windows path.

```bash
npx -y @zokizuan/satori-cli@latest install
npx -y @zokizuan/satori-cli@latest doctor
```

The installer can configure supported Codex, Claude Code, and OpenCode clients.

Restart the coding client after installation.

### 2. Create the first repository index

The first Publication is explicit because Satori should not silently decide to ingest an arbitrary workspace.

Tell the agent:

```text
Index /absolute/path/to/repo with Satori.
```

The corresponding MCP operation is conceptually:

```text
manage_index action="create" path="/absolute/path/to/repo"
```

Full creation runs in the background. Status can be inspected while the Publication is being prepared.

### 3. Ask a useful question

For example:

```text
Use Satori to find where auth refresh is handled, identify the owner,
and show me the exact implementation I should inspect first.
```

The normal agent workflow is:

1. `search_codebase` for behavior or ownership;
2. follow the returned owner/navigation hints;
3. use `file_outline` when file structure helps;
4. use `call_graph` for supported relationship evidence;
5. use `read_file` for exact proof;
6. use `continue_search` only when the frozen result set contains more useful groups.

You do not need to manually call each tool yourself if your coding agent understands the MCP instructions. They are the product primitives behind the workflow.

## Practical workflows

### Workflow: understand a subsystem

Start with a broad behavioral question:

```text
Find the indexing lifecycle and explain which component owns full-index publication.
```

Then narrow:

```text
Show me the file outline for the owning file.
```

Then verify exact source:

```text
Read the exact method that activates the new Publication.
```

Use relationship evidence only where it materially helps:

```text
What directly calls this method?
```

### Workflow: investigate an error

Start from the user-visible or logged evidence:

```text
Find where "runtime_owner_conflict" is produced and what condition triggers it.
```

Then inspect the owner and its direct dependencies rather than searching the whole repository for adjacent words.

### Workflow: plan a refactor

Ask Satori for the owner first:

```text
Find the code responsible for search freshness decisions.
```

Then:

```text
Show the file structure around that owner.

Show supported callers/callees for the exact symbol.

Read the exact source span.
```

Treat inbound call-graph results as leads to verify. Repository tests, compiler checks, runtime behavior, and broader literal search remain appropriate when the change needs stronger blast-radius proof.

### Workflow: work with a smaller/local model

Smaller models benefit from an especially strict evidence funnel:

```text
search -> owner -> one outline -> one exact source span
```

Avoid asking the model to ingest an entire repository tree or several long files before it knows which code matters.

### Workflow: multi-agent repository work

When several compatible local agents use Satori, the managed runtime can share provider and index state. Each agent can independently ask repository questions while relying on the same current Publication authority.

This does not make the call graph complete or coordinate the agents' source edits; it gives them a common repository-intelligence layer.

## Freshness and maintenance

The index is not meant to be a static cache you babysit manually.

### Ordinary source edits: sync

When source files change and the current Publication remains compatible, incremental synchronization prepares a replacement generation with changed source/navigation evidence.

Search and navigation can continue from an existing compatible completed Publication while a supervised sync prepares the replacement, with freshness metadata showing that newer work is pending.

### Rebuild-safe incompatibility: automatic managed-offline reindex

On the managed offline runtime, Satori can automatically start or join one background full reindex for an already-tracked repository when the current Publication is rebuild-safe but incompatible—for example a current runtime/format/policy incompatibility, missing compatible navigation, or a missing vector collection covered by the maintenance contract.

The normal experience is:

```text
agent asks a repository question
    -> Satori detects rebuild-required state
    -> one background reindex starts or is joined
    -> caller receives not_ready / indexing metadata
    -> caller retries after maintenance
```

The user should not be asked to approve routine rebuild-safe reindexing on this managed local path.

Automatic failures are classified rather than retried on every subsequent read. Transient provider/network/worker failures retry after bounded exponential backoff. Deterministic configuration/incompatibility failures, resource limits, and cancellation remain suppressed until relevant state changes or a successful manual create/reindex supersedes the failed operation.

### Explicit reindex: recovery override

`manage_index action="reindex"` remains available when:

- automatic maintenance is intentionally unavailable;
- the runtime is connected/remote and a silent full rebuild could have cost or operational consequences;
- automatic maintenance failed and has been suppressed;
- an operator deliberately wants to rebuild.

### Failure containment and degraded intelligence

Create/reindex candidate construction runs in a supervised child process group rather than the MCP control process. A worker crash, cancellation, or no-progress timeout terminates that mutation without force-unlocking the root; a previous completed Publication remains current until a replacement is proven and activated.

Optional semantic-provider failure is different from searchable-payload failure. Satori can activate a searchable Publication with persisted provider coverage marking the affected call graph `degraded` or `unavailable`, instead of discarding completed embeddings or falsely reporting complete relationship coverage. Search admission and compiler semantics also have explicit byte budgets so pathological source files produce partial/degraded status rather than uncontrolled heap growth.

Full-index candidates receive durable ownership receipts before remote/local collection creation. If a process exits before Publication activation, the next same-root create/reindex can prove and reclaim an unreferenced stale candidate; descriptor-backed Publication collections are preserved.

### Clear remains explicit

Clearing index state is destructive lifecycle behavior and is not automatic maintenance.

## Local-first runtime

The qualified default offline path uses:

```text
Potion embeddings
+ BM25 lexical retrieval
+ LateOn query-time reranking
+ LanceDB storage
+ parser-derived language intelligence
```

No model API key is required for that default runtime after installation.

Satori also supports advanced connected configurations, including Voyage embeddings and LanceDB or Milvus/Zilliz storage. Those paths are configuration choices rather than the default product story.

## The 11 MCP tools

| Tool | What it is for |
|---|---|
| `search_codebase` | Find behavior, ownership, identifiers, configuration, and relevant code evidence. |
| `architecture_overview` | Summarize bounded Publication architecture evidence as logical areas, cross-area boundaries, and hotspots. |
| `continue_search` | Reveal more of the same frozen grouped result set without rerunning retrieval. |
| `file_outline` | Inspect indexed owners and structural spans in one file. |
| `call_graph` | Follow supported callers, callees, imports, and exports as conservative navigation evidence. |
| `trace_path` | Find one bounded deterministic path between two exact published symbol IDs over selected persisted relationships. |
| `find_references` | Find ranking-independent exact textual occurrences of one canonical symbol across validated published source. |
| `detect_changes` | Map a Git diff to indexed symbol seeds and bounded transitive callers for change orientation. |
| `read_file` | Read an exact indexed symbol or bounded source window. |
| `list_codebases` | Discover known repository Publications and readiness. |
| `manage_index` | Create, sync, inspect, reindex/recover, cancel an exact live supervised create/reindex/sync operation, or clear index state. |

For exact schemas and operational status payloads, use the [public operational docs](../satori-landing/docs/index.html) or [`packages/mcp/README.md`](../packages/mcp/README.md).

## Language intelligence

Production symbol navigation plus the current qualified `CALLS v0` relationship slice covers:

- TypeScript
- JavaScript
- Python
- Go
- Java
- C#
- C++
- Rust
- Scala

Language capability details and extension rules live in [`architecture/LANGUAGE_INTELLIGENCE.md`](architecture/LANGUAGE_INTELLIGENCE.md).

## What Satori does not promise

### It does not expose source-code write tools

Satori's MCP surface is the intelligence layer. It manages Satori's own index/runtime state and supported client configuration; your editor or coding agent owns repository source mutations.

### It does not prove every possible caller

`call_graph` is conservative repository navigation. Dynamic dispatch, reflection, generated calls, framework wiring, or unsupported language semantics can exceed the qualified relationship model.

### It does not replace tests, compilers, or runtime verification

Satori helps choose and understand code. It does not turn repository search into behavioral proof.

### It does not provide generic long-term chat memory

The durable product state is repository intelligence: Publications, source/navigation evidence, policy, and local index storage. It is not a general memory database for user conversations or project decisions.

### It does not guarantee one benchmark number everywhere

Repository size, storage, CPU, model runtime, query, provider, and cold/warm state all affect performance. Public benchmark numbers should be read with the exact workload and caveats published alongside them.

## FAQ

### Do I have to reindex every time code changes?

No. Ordinary source changes use incremental synchronization. Full reindex is reserved for states that actually require rebuilding the Publication.

### Will Satori ask me before routine reindexing?

On the managed offline path, rebuild-safe automatic maintenance is designed to start or join the background reindex without making the user babysit it. Connected/remote or unsafe recovery remains explicit.

### Does Satori send my source to a model API?

The default offline runtime performs the retrieval stack locally and requires no model API key after installation. Connected Voyage/Milvus configurations are optional and follow their configured provider boundaries.

### Can I use it without Codex?

Yes. The installer supports Codex, Claude Code, and OpenCode, and the server is an MCP product surface that other compatible harnesses can integrate with.

### Is this a replacement for grep or an IDE language server?

No. Exact literal search and language-server/compiler tooling remain valuable. Satori solves a different problem: giving an agent a compact, persistent repository-intelligence layer that combines intent retrieval, exact evidence, structural ownership, bounded source, freshness, and supported relationship navigation.

### Why keep both semantic and lexical retrieval?

Code questions mix concepts and literals. Semantic retrieval helps with “where is this behavior?” while lexical/exact paths keep symbols, configuration keys, errors, and API names precise.

### Why use immutable Publications?

A repository answer can combine search, symbols, navigation, and source freshness. Binding those layers to one generation prevents the system from intentionally presenting a mixture of incompatible index states as if they were one coherent view.

## Where to go next

- [`../README.md`](../README.md) — product overview and installation.
- [`README.md`](README.md) — documentation map.
- [`../satori-landing/docs/index.html`](../satori-landing/docs/index.html) — full public operational documentation.
- [`../satori-landing/architecture.html`](../satori-landing/architecture.html) — architecture and Publication lifecycle.
- [`architecture/LANGUAGE_INTELLIGENCE.md`](architecture/LANGUAGE_INTELLIGENCE.md) — language support and relationship architecture.
- [`RELEASING.md`](RELEASING.md) — release qualification and publication workflow.
