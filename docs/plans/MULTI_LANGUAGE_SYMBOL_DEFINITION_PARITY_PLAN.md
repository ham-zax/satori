# Multi-Language Symbol Definition Parity Plan

**Status:** complete; D0-D6 recorded terminal decisions and the final program decision is `definition_parity_pass`
**Recorded:** 2026-07-23
**Repository baseline:** `4c134922f4dacb43ffda3f56f007f8055a1bc20f`
**Primary decision:** improve deterministic definition coverage for Satori's
existing structural language analyzers without reopening call-graph resolution,
adding MCP tools, or creating a generic parser framework.

## 1. Outcome

For supported structural languages, Satori should expose the
repository-navigable
definitions that developers reasonably expect to find through:

- symbol-owned `search_codebase` groups;
- deterministic `file_outline` results; and
- exact `read_file(open_symbol)` navigation.

This plan is about definition and ownership coverage. It is not a call-graph,
import-resolution, ranking, embedding, or language-count project.

The implementation must continue to use Satori's existing authorities:

```text
language router
    -> Oxc or pinned Tree-sitter WASM analyzer
    -> ExtractedSymbol
    -> canonical symbol registry
    -> owner assignment
    -> existing navigation publication
```

Official Tree-sitter tag queries and GitHub's code-navigation categories are
behavioral references. They are not a replacement runtime and do not authorize
copying an upstream framework into Satori.

## 2. Relationship To Existing Plans

This plan supersedes only:

- Phase 6, its language-order open question, and its language-expansion handoff
  in `docs/plans/SYMBOL_OWNED_RETRIEVAL_IMPLEMENTATION_PLAN.md`; and
- the stale `Current Baseline`, `First Batch`, `Implementation Sequence`, and
  `Handoff` execution guidance in
  `docs/plans/LANGUAGE_CAPABILITY_MATRIX_AND_SYMBOL_EXTRACTOR_HARNESS_PLAN.md`.

Those documents remain historical authority for the architecture and work they
record as completed. Their old descriptions of Go, Rust, Java, C#, C++, and
Scala as languages still awaiting basic symbol extraction are no longer current.

This plan does not supersede or reopen:

- the completed R1-R6 operational remediation;
- Phase 5B0/5B1 Python receiver-aware `CALLS`;
- Phase 5B2 typed-receiver work;
- relationship publication or call-graph semantics;
- index publication atomicity;
- Potion, LanceDB, Milvus, Voyage, ranking, or retrieval qualification; or
- public language capability tiers.

Every implementation batch below requires separate authorization. Completion
of one batch does not authorize the next.

## 3. Scope

### In scope

- Audit current repository-navigable definition extraction against pinned upstream
  tag-query behavior.
- Add missing owner-worthy definitions through the existing Oxc and
  Tree-sitter adapters.
- Preserve stable names, parent paths, spans, ordering, owner assignment, and
  exact symbol identity outside explicitly approved container-reparenting or
  defect-correction allowlists.
- Classify every existing identity change introduced by a new lexical container
  as an explicit, fixture-allowlisted compatibility change rather than silently
  treating it as preservation or regression.
- Extend the internal extracted-symbol vocabulary only where the persisted
  registry already has an established compatible kind.
- Add focused language-analysis, registry, outline, exact-open, and grouped
  ownership fixtures.
- Update capability and product documentation only after behavior is proven.
- Record the truthful C versus C++ parser boundary.

### Out of scope

- New MCP tools or response schemas.
- Call-reference extraction or relationship resolution.
- Type inference, receiver resolution, overload resolution, inheritance
  traversal, reflection, or macro expansion.
- Import/export graph changes.
- Query-time symbol inference.
- A general tag-query interpreter or plugin framework.
- Replacing Oxc with Tree-sitter for TypeScript or JavaScript.
- Replacing Satori's registry with GitHub Code Navigation, SCIP, LSIF,
  stack-graphs, codebase-memory, or an LSP.
- Native C support in D1 or D2.
- PHP, Ruby, Kotlin, Swift, or other search-only language promotion.
- New parser dependencies or vendored parser artifacts without a separate
  dependency and provenance decision.
- Ranking, embedding, reranking, Potion, LateOn, or publication-performance
  changes.
- Broad benchmarks, answering agents, judges, or release qualification.

## 4. Current Repository Truth

### 4.1 Analyzer ownership

At the recorded baseline:

| Language | Analyzer | Current capability tier |
| --- | --- | --- |
| TypeScript / TSX | Oxc | `calls_v0` |
| JavaScript / JSX | Oxc | `calls_v0` |
| Python | Tree-sitter WASM | `calls_v0` |
| Go | Tree-sitter WASM | `symbol_only` |
| Rust | Tree-sitter WASM | `symbol_only` |
| Java | Tree-sitter WASM | `symbol_only` |
| C# | Tree-sitter WASM | `symbol_only` |
| C++ | Tree-sitter WASM | `symbol_only` |
| Scala | pinned vendored Tree-sitter WASM | `symbol_only` |
| C | routed as C++ for indexed `.c`/`.h` files | no independent C structural claim |

The active analyzer mapping is owned by
`packages/core/src/language-analysis/service.ts`.

The active capability declarations are owned by
`packages/core/src/languages/capabilities.ts`.

### 4.2 Current extracted definitions

#### TypeScript and JavaScript

The Oxc adapter currently recognizes:

- function declarations;
- class declarations;
- TypeScript interfaces;
- TypeScript type aliases;
- TypeScript enums;
- class methods and constructors;
- callable class fields;
- module-level callable variables; and
- module-level scalar variables;
- TypeScript declaration-only functions and method signatures; and
- TypeScript identifier namespaces with lexical descendant ownership.

It deliberately suppresses variables declared inside callables.

#### Tree-sitter languages

The Tree-sitter adapter currently recognizes:

| Language | Current definitions |
| --- | --- |
| Python | classes, functions, class methods, direct module bindings |
| Go | functions, methods, named types; structs and interfaces receive refined kinds |
| Rust | functions, impl methods, function signatures, structs, enums, traits, modules, aliases, unions, macros |
| Java | classes, interfaces, enums, methods, constructors |
| C# | namespaces, classes, interfaces, structs, enums, methods, constructors |
| C++ | namespaces, classes, structs, enums, unions, types/typedefs, callable declarations and definitions |
| Scala | packages, classes, traits, objects, enums, types, functions, class methods, named package bindings |

`.c` and `.h` remain routed through the C++ parser as a proven common-C subset;
the repository does not contain native C parser authority.

### 4.3 Current identity

The recorded analyzer identities are:

```text
LANGUAGE_PARSER_VERSION =
  oxc-0.139.0
  + web-tree-sitter-0.26.10
  + vscode-grammars-0.3.1
  + scala-0.24.0-sha256-b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3

SYMBOL_EXTRACTOR_VERSION =
  language-analysis-v15 + LANGUAGE_PARSER_VERSION

RELATIONSHIP_BUILDER_VERSION =
  relationship-v5+python-receiver-calls
```

Definition changes alter persisted navigation meaning. The implementation must
bump `SYMBOL_EXTRACTOR_VERSION` in the same change that alters extracted
definitions.

The current publication fingerprint includes the extractor version. Therefore
an extractor-version change is incompatible with an existing publication under
the current compatibility contract and requires a fresh compatible publication
and full reindex. This plan
does not claim navigation-only migration or no-reembedding behavior.

### 4.4 Current symbol vocabulary

`ExtractedSymbolKind` currently includes:

```text
file
class
interface
type
function
method
constructor
struct
enum
trait
module
namespace
macro
constant
variable
```

The persisted `SymbolKind` contract additionally supports:

```text
property
component
hook
config
test
```

The program added internal `namespace` and `macro` extracted kinds by mapping
them to the compatible persisted kinds that already existed. It did not add a
persisted `union` kind; C++, common-C, and Rust unions map to `type`.

Constants and module variables continue to map to the established `property`
registry kind unless a separately authorized public ontology change is proven
necessary.

### 4.5 Reproducible local baseline evidence

D0 must record these existing owners and observations before changing expected
output:

| Current fact | Repository authority |
| --- | --- |
| Oxc versus Tree-sitter selection | `packages/core/src/language-analysis/service.ts`, `BACKEND_BY_LANGUAGE` |
| Current Oxc definition rules | `packages/core/src/language-analysis/oxc-adapter.ts`, `symbolKind`, `symbolName`, and `visit` |
| Current Tree-sitter definition rules | `packages/core/src/language-analysis/tree-sitter-adapter.ts`, `SYMBOL_NODES`, language classifiers, and `extractSymbols` |
| `.c`, `.h`, and `.cpp` routing | `packages/core/src/languages/capabilities.ts` plus language-registry routing tests |
| Extracted kind contract | `packages/core/src/languages/types.ts`, `ExtractedSymbolKind` |
| Persisted kind contract | `packages/core/src/symbols/contracts.ts`, `SYMBOL_KINDS` |
| Extracted-to-persisted mapping | `packages/core/src/symbols/registry.ts`, `toRegistrySymbolKind` |
| Stable key and exact instance inputs | `packages/core/src/symbols/registry.ts`, `createSymbolKey`, `createSymbolInstanceId`, and `buildRecordForExtractedSymbol` |
| Current capability output | `packages/core/src/languages/capabilities.ts` and `packages/core/src/languages/capabilities.test.ts` |
| Publication compatibility fields | `packages/core/src/core/persisted-index-authority.ts`, `INDEX_FINGERPRINT_FIELDS` |
| Relationship binding | `RelationshipManifest.symbolRegistryManifestHash` and `computeSymbolRegistryManifestHash` |
| Parser artifact resolution | `tree-sitter-adapter.ts`, `ASSET_NAMES` and `languageAssetPath`, plus the resolved `@vscode/tree-sitter-wasm` package version |

D0 evidence is a compact checked-in fixture or test expectation, not a new
evidence framework. It must include:

- current extracted records for the authorized batch;
- stable-key inputs and exact-instance inputs;
- current capability projection;
- parser selection and resolved artifact identity;
- current compatibility comparison result; and
- current kind-consumer behavior.

The baseline revision makes these claims inspectable, but it does not replace
the focused red/green fixture required before implementation.

## 5. Definition Inclusion Contract

### 5.1 Owner-worthy definitions

Include a definition when all of the following hold:

1. It has a deterministic source name.
2. Its source span is recoverable from the parser node.
3. It represents repository-navigable ownership or a named member that users may
   reasonably navigate to directly.
4. Its parent path can be derived without type inference.
5. Repeated analysis of identical bytes produces the same record.

Expected categories:

- named modules, namespaces, classes, interfaces, traits, structs, enums,
  unions-as-types, and type aliases;
- named functions, methods, constructors, and declaration-only signatures;
- named macros where the parser provides a definition node;
- module-level constants and variables when the language's definition model
  makes them useful and deterministic; and
- class or namespace members with direct source definitions.

### 5.2 Exclusions

Do not emit independent symbols for:

- parameters;
- function-local scalar variables;
- anonymous functions or anonymous types without a stable declared owner;
- imports, call sites, type references, or inheritance references;
- compiler-generated or synthetic symbols;
- destructuring elements without a frozen identity rule;
- weak name matches inferred from text;
- dynamic receiver targets;
- every object property merely because it has a name; or
- declarations whose parent path would require semantic type resolution.

### 5.3 Span contract

- Spans are 1-based and inclusive at public boundaries.
- Parser byte offsets remain UTF-8-aware through `Utf8SourceMap`.
- Decorators and annotations follow the existing language-specific canonical
  span policy.
- Declaration-only symbols use the declaration node's complete source span.
- A symbol span must never expand to unrelated sibling declarations.
- Existing source-repair warnings remain fallback diagnostics, not the normal
  output of a newly added fixture.

### 5.4 Parent and qualified-name contract

- Use lexical declaration containers only.
- Preserve the current `parentQualifiedNamePath` representation.
- Class members are owned by the nearest class-like container.
- Namespace and module members include their lexical namespace/module path.
- Rust impl methods retain the implemented type as owner.
- Go methods retain the receiver type as owner.
- C++ qualified out-of-class definitions preserve their declared scope.
- Do not fabricate package, class, or type ownership from filenames.

### 5.5 Container-introduction contract

Adding a namespace, module, or package symbol can change the parent path and
identity of definitions that already exist. Container batches must choose one
mode before implementation:

#### `container_symbol_only`

- Emit the container as a symbol.
- Preserve existing descendant parent paths and identities.
- Document that structural containment is incomplete.

#### `container_reparenting`

- Emit the container.
- Reparent lexical descendants beneath its canonical path.
- Freeze an exact allowlist of existing definitions whose qualified name,
  stable key, exact instance, ownership, or relationship endpoint changes.
- Require a clean compatible publication and rebuild all derived artifacts
  whose inputs changed.
- Prove old IDs are rejected and new exact IDs open the intended source.

This plan chooses `container_reparenting` for TypeScript namespaces, C++
namespaces, C# namespaces, and Scala packages because it preserves truthful
lexical structure. Container work remains separate from ordinary missing-leaf
definitions so its identity delta cannot be hidden.

The normal identity-preservation gate applies to every definition outside the
frozen container-descendant allowlist. Allowlisted container changes are
expected compatibility deltas, not `identity_regression`.

### 5.6 Construct and kind contract

D0 must freeze this mapping and audit every exhaustive consumer before the
first new kind is emitted:

| Construct | Extracted kind | Persisted kind | Parent rule |
| --- | --- | --- | --- |
| TypeScript identifier namespace | `namespace` | `namespace` | lexical namespace; `container_reparenting` |
| TypeScript ambient string module | excluded initially | none | normalization is not frozen |
| TypeScript function signature | `function` | `function` | current lexical container |
| TypeScript method/abstract signature | `method` | `method` | nearest class/interface |
| Existing JS module-level named function/arrow binding | `function` | `function` | current lexical container; no new rule |
| Arbitrary JS member/object/prototype assignment | deferred | none | syntactic ownership not frozen |
| Python simple module assignment | `variable` | `property` | module only |
| C/C++ typedef/type definition | `type` | `type` | file/namespace/class, never callable-local |
| C/C++ named union | `type` | `type` | lexical container, never callable-local |
| C++ namespace | `namespace` | `namespace` | lexical namespace; `container_reparenting` |
| Rust type alias | `type` | `type` | lexical module |
| Rust union | `type` | `type` | lexical module |
| Rust macro definition | `macro` | `macro` | lexical module |
| C# namespace | `namespace` | `namespace` | lexical namespace; `container_reparenting` |
| Scala package | `namespace` | `namespace` | canonical package segments; `container_reparenting` |
| Scala enum | `enum` | `enum` | lexical container |
| Scala type definition | `type` | `type` | lexical container |
| Scala top-level `val` | `constant` | `property` | package/module only |
| Scala top-level `var` | `variable` | `property` | package/module only |
| Scala named `given` | `variable` | `property` | package/module only; anonymous givens excluded |

Python uses `variable`, not `constant`, because ordinary assignment does not
establish immutability. The upstream Tree-sitter capture name
`definition.constant` is treated as a navigation category, not proof of Python
constant semantics. Type aliases and `TypeVar(...)` assignments remain
variables in this program because distinguishing them requires semantic
analysis that is out of scope.

Union-to-`type` is intentionally lossy: the public kind does not distinguish
unions from other named types. Preserve source syntax and span as the evidence;
do not add a parallel grammar-tag metadata field solely for future use.

Consumer audit:

- `ExtractedSymbolKind` exhaustiveness;
- `toRegistrySymbolKind`;
- persisted `SYMBOL_KINDS` validation;
- registry kind ordering;
- JSON and SQLite serialization;
- outline labels and ordering;
- grouped-search owner presentation;
- exact-open lookup;
- schemas and generated contract artifacts; and
- tests or switches that assert exhaustive/unreachable kind handling.

If any required consumer cannot represent the mapping without a public schema
change, stop before extractor implementation.

### 5.7 Duplicate declaration/definition contract

Declarations and definitions may describe the same logical name. The
implementation must not deduplicate them by name alone.

Current identity inputs make the expected rule:

- Same file, language, persisted kind, qualified name, and parent path -> same
  stable `symbolKey`.
- Different repository-relative files -> different stable `symbolKey` values,
  even when the language-level declaration names the same logical entity.
- Different spans or file hashes -> different `symbolInstanceId` values.
- The registry retains multiple instances under one stable key where the
  current same-file model permits it.
- No implicit cross-file canonical declaration/definition merge is claimed.

For every duplicate-risk fixture, D0 must freeze:

| Field | Required expectation |
| --- | --- |
| Extracted occurrence count | exact number of source occurrences |
| Stable key | same or different according to the current path-sensitive rule |
| Exact instance ID | distinct per occurrence |
| Registry representation | exact `symbolsByKey` membership |
| Preferred instance | explicit current behavior; no invented preference |
| `file_outline` | exact instances shown or selected |
| Search grouping | exact current group/instance behavior |
| `open_symbol` | opens the selected exact instance |
| Incremental deletion | deleting one occurrence leaves every other valid occurrence |

Required fixtures:

- TypeScript overload signatures plus implementation;
- same-name interface or abstract signatures in different owners;
- C/C++ declaration plus definition in one file;
- header declaration plus source definition;
- C++ qualified out-of-class method;
- anonymous struct/union named by typedef;
- multiple declarations of one symbol; and
- same-name symbols in different namespaces.

The analyzer must avoid emitting one AST occurrence twice when a declarator is
nested under a definition. If the current registry cannot represent the frozen
same-file multi-instance model, stop with `identity_model_blocked`.

### 5.8 Failure contract

#### Hard analyzer failure

Examples:

- parser asset unavailable;
- parser initialization or parsing throws;
- extraction throws; or
- no valid current contribution can be produced.

Required result:

```text
synthesized file owner only
no previous symbols reused
honest recovered diagnostic
```

#### Recoverable malformed syntax

The current Oxc and Tree-sitter adapters treat a syntax-error result as
non-authoritative and return no source symbols. This plan preserves that
contract:

```text
current bounded chunks remain searchable
synthesized file owner only
no partial source definitions
no previous symbols reused
structuralStatus = recovered
structuralReason = syntax_error
```

- Parser or extractor failure falls back to the synthesized file owner.
- Partial extraction must not reuse stale symbols from a previous file version.
- Malformed source must not crash indexing.
- Unsupported constructs are skipped rather than guessed.
- A missing parser asset must produce the existing honest unsupported/recovered
  state; it must not silently relabel text extraction as structural support.

## 6. External Reference Authority

The following upstream sources are reference specifications. Exact revisions,
not mutable `master` branches, own this plan's external observations.

| Source | Revision | SHA-256 of reviewed file | Relevant authority | Khiip capture |
| --- | --- | --- | --- | --- |
| [`github/code-navigation`](https://github.com/github/code-navigation/tree/4a8523796389da7c2d1e2ea498e39922f7c72fcb) | `4a8523796389da7c2d1e2ea498e39922f7c72fcb` | `62e46c1bab24460bb5260a7aad607c0e1ad3b1a3a82c37b14fbc018a5e33acca` | `README.md`: tag categories and query conventions | `01KY6K7MGT07YFPM1V2THYQQT5` |
| [`tree-sitter-javascript`](https://github.com/tree-sitter/tree-sitter-javascript/blob/58404d8cf191d69f2674a8fd507bd5776f46cb11/queries/tags.scm) | `58404d8cf191d69f2674a8fd507bd5776f46cb11` | `6ef988cce5a428a15b5460e3ee96f1478705f965fc6e848a91a18bfa6c6f0212` | `queries/tags.scm` | `01KY6K7NMWCQJAWV58C402BN6P` |
| [`tree-sitter-typescript`](https://github.com/tree-sitter/tree-sitter-typescript/blob/75b3874edb2dc714fb1fd77a32013d0f8699989f/queries/tags.scm) | `75b3874edb2dc714fb1fd77a32013d0f8699989f` | `b391288bcc71b513a5df7c9bb232d8bc7418d7e274b125aa0aa4bdd6121a0338` | `queries/tags.scm` | `01KY6K7PNPAMZTDCP1C6WCGSJ8` |
| [`tree-sitter-c`](https://github.com/tree-sitter/tree-sitter-c/blob/b780e47fc780ddc8da13afa35a3f4ed5c157823d/queries/tags.scm) | `b780e47fc780ddc8da13afa35a3f4ed5c157823d` | `774ca67cfe23b0e0d1d3a4f01788049a822beb1311feee72b20a595a37be1e28` | `queries/tags.scm` | `01KY6K7QJWPNNQZN5J85MA6EQ4` |
| [`tree-sitter-cpp`](https://github.com/tree-sitter/tree-sitter-cpp/blob/8b5b49eb196bec7040441bee33b2c9a4838d6967/queries/tags.scm) | `8b5b49eb196bec7040441bee33b2c9a4838d6967` | `029731ca946e32f919491d9f76c85a50e5deb5ad1934e37fd6849312c0d4a705` | `queries/tags.scm` | `01KY6K7RMZ7SC2SNMJF620S9M9` |
| [`tree-sitter-java`](https://github.com/tree-sitter/tree-sitter-java/blob/e10607b45ff745f5f876bfa3e94fbcc6b44bdc11/queries/tags.scm) | `e10607b45ff745f5f876bfa3e94fbcc6b44bdc11` | `bcb22147b8582d92743fc973864cefb894a4c12b3957f16f3d472b2ec7cd4c49` | `queries/tags.scm` | `01KY6K7SMZADQN9E7VAHS4877S` |
| [`tree-sitter-c-sharp`](https://github.com/tree-sitter/tree-sitter-c-sharp/blob/9150f7d56bb47f1a809fa23623f1ba1413e93fa9/queries/tags.scm) | `9150f7d56bb47f1a809fa23623f1ba1413e93fa9` | `4ed08da0162ecd48206ac34bebe7ea9757a8c7b617f6ad8f70c168d685d514fe` | `queries/tags.scm` | `01KY6K7TYFT3AP10G2C0V29KZK` |
| [`tree-sitter-go`](https://github.com/tree-sitter/tree-sitter-go/blob/2346a3ab1bb3857b48b29d779a1ef9799a248cd7/queries/tags.scm) | `2346a3ab1bb3857b48b29d779a1ef9799a248cd7` | `d1a9b1f678fe0278b85054e2dc56a28ef26aa478b8c88fb2b0dd83cdcdb9db35` | `queries/tags.scm` | `01KY6K7VRVVD0QDA0K73JG7472` |
| [`tree-sitter-rust`](https://github.com/tree-sitter/tree-sitter-rust/blob/77a3747266f4d621d0757825e6b11edcbf991ca5/queries/tags.scm) | `77a3747266f4d621d0757825e6b11edcbf991ca5` | `f22867fdebde5cb091861c08d34690dc2540f4318068bf81be9f6b0d348ab8c1` | `queries/tags.scm` | `01KY6K7WV0ZDCV1VYM70N6X9WV` |
| [`tree-sitter-python`](https://github.com/tree-sitter/tree-sitter-python/blob/26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64/queries/tags.scm) | `26855eabccb19c6abf499fbc5b8dc7cc9ab8bc64` | `d0f3e577878167bfabc30e526e497bce58d1699b9bcabf8ab3a50698efb5ca3e` | `queries/tags.scm` | `01KY6K7XSV4SM9S317HSVHQJ8C` |
| [`tree-sitter-scala`](https://github.com/tree-sitter/tree-sitter-scala/blob/2d55e74b0485fe05058ffe5e8155506c9710c767/queries/tags.scm) | `2d55e74b0485fe05058ffe5e8155506c9710c767` (`v0.24.0`) | `f56794ad2bc9ae5c7ffd332a40fa67a3af65880e18ba4124a0053f0bfff54757` | `queries/tags.scm`, matching Satori's vendored parser version | `01KY6K9ZZ08R29M2PPHYJEC5J1` |

The upstream repositories are MIT-licensed at the reviewed revisions.

The exact revision, exact source URL, and reviewed-file SHA-256 are the
reproducibility authority. Khiip captures are supplementary durable provenance,
not a runtime dependency and not required to execute tests. Their local vault
paths may differ between machines.

Reference-only use does not require copied-code attribution. If an
implementation copies or substantially adapts query tables, source, or
fixtures, update `THIRD_PARTY.md` in the same change with the exact revision,
paths, license, and copied scope.

Do not import the upstream query runtime. Translate only the definition rules
that pass Satori's owner-worthiness contract.

## 7. Verified Parity Gaps

### 7.1 TypeScript and JavaScript

Current strength:

- Oxc already provides richer structural ownership than replacing it with a
  generic tag-query runner would provide.

Verified missing candidates:

- TypeScript namespace/module declarations;
- TypeScript function signatures;
- TypeScript method and abstract-method signatures.

Module-level variable declarations, including exported ones, are already
symbols. Do not emit them again or change their kind merely to call them
constants; that would change established identities without adding a missing
definition.

The official JavaScript query also recognizes callable assignments and callable
object properties. They are deferred because member/prototype/object paths are
syntactic ownership assertions rather than ordinary lexical containers.
Existing module-level named function/arrow `VariableDeclarator` behavior must
be audited and preserved, but D1 adds no arbitrary assignment-derived symbol.

Constraints:

- Keep Oxc as the analyzer.
- Do not index function-local variables or every object property.
- Preserve current class, function, method, enum, interface, type, and variable
  identity inputs.
- Split signature additions from namespace/container reparenting.
- Freeze overload signature/implementation identity before adding signatures.
- Do not treat a reference capture as a definition.
- Do not widen call-site extraction in this batch.

### 7.2 C

Current truth:

- The installed `@vscode/tree-sitter-wasm@0.3.1` artifact set used by Satori
  does not contain `tree-sitter-c.wasm`.
- Satori deliberately routes `.c` and `.h` through the C++ language
  declaration and C++ WASM analyzer.
- The separate `c` capability declaration has no extensions and is
  search-only.

Consequences:

- D2 may prove common C constructs through the current C++ parser.
- It must describe the result as a C-compatible subset of the C++ analyzer.
- It must not claim a native C parser or complete C dialect authority.

Native C requires a separate decision covering:

- the parser source and revision;
- a reproducible WASM artifact;
- checksum and license provenance;
- package inclusion and installed-path behavior;
- parser identity changes; and
- independent C fixtures.

No new C parser asset is authorized by D2.

### 7.3 C++

Current definitions omit several categories present in the official tag query:

- function declarations without bodies;
- typedef/type definitions;
- named unions; and
- callable declarators whose terminal name is a `field_identifier`.

`field_identifier` is not itself an inclusion rule. It is accepted only as the
name terminal of a function/callable declarator; ordinary data fields remain
excluded.

Function-local prototypes, typedefs, named structs/unions, variables, and
lambdas are excluded initially. Namespace definitions are a separate
`container_reparenting` batch.

### 7.4 Rust

Current definitions omit official-query categories:

- named unions;
- type aliases; and
- macro definitions.

Mapping:

- union -> `type`;
- type alias -> `type`;
- macro definition -> `macro`.

Only the pinned grammar's named `macro_definition` form is initially included.
Do not add macro invocation edges, exported-macro inference, procedural-macro
semantics, or expansion.

### 7.5 Python

Current definitions omit the official simple module assignment definition.

Initial target:

- a direct module-level simple identifier assignment -> `variable`, including
  annotated assignments when represented by the same pinned assignment-node
  contract.

Exclude:

- assignments inside classes or functions;
- tuple/list destructuring;
- attribute assignment;
- loop targets;
- imports; and
- assignment-expression targets.

Do not infer immutability or type identity from capitalization, the right-hand
expression, `TypeVar(...)`, or assignment naming. The fixture must measure
outline noise before this rule is admitted. If direct module assignments make
ownership materially worse, stop with `scope_noise_fail`; do not replace the
rule with a growing set of name heuristics.

### 7.6 Go

Current function, method, and named-type coverage already matches the official
definition captures that carry explicit definition tags.

The upstream query also captures package, import, variable, and constant names,
but those captures are not all declared as code-navigation definitions.
Therefore Go is audit-only in the first parity program.

Do not emit package clauses, imports, or every package variable merely to make
the symbol count larger. Add a Go behavior change only after a concrete
navigation witness demonstrates missing owner value.

### 7.7 Java

Current Satori coverage already includes:

- official class, interface, and method definitions; plus
- Satori's existing enum and constructor definitions.

The official query's call, implementation, superclass, and object-creation
captures are references and are out of scope.

Possible future definitions:

- records; and
- annotation-type declarations.

They require Satori-native fixtures. Java should otherwise be a no-op parity
result rather than receiving speculative fields or enum constants.

### 7.8 C#

Current Satori coverage already exceeds the official query for structs, enums,
and constructors.

Verified missing official definition:

- namespace declarations.

Possible later definitions requiring independent fixtures:

- records;
- delegates;
- properties;
- indexers; and
- operators.

Only namespace parity belongs in the initial C# batch.

### 7.9 Scala

The pinned Scala tag query includes:

- packages;
- traits;
- enums and enum cases;
- classes;
- objects;
- functions;
- vals, vars, and givens;
- type definitions; and
- class parameters.

Satori currently covers classes, traits, objects, and functions.

Initial owner-worthy additions:

- package/module definitions;
- enum definitions;
- named type definitions; and
- named top-level vals, vars, and givens.

Do not emit function-local vals/vars. Enum cases and class parameters require a
separate usefulness fixture before inclusion because they can dominate
outlines without improving ownership discovery.

Package/type/enum structure and top-level binding definitions are separate
batches. A structural batch may pass even when binding noise requires
`scope_noise_fail`.

## 8. Implementation Order

TypeScript, JavaScript, and Python are first because they are Satori's current
full-navigation core. A missing owner in those languages can affect grouped
retrieval, outline navigation, exact-open entry points, and the identity used
to enter the existing call graph. The remaining order then follows demonstrated
definition gaps and existing runtime authority.

### Adapter mechanics

Tree-sitter:

- Do not add every new node to `SYMBOL_NODES` blindly.
- C/C++ declarators require a context-aware classifier because a
  `function_declarator` may be nested inside a `function_definition`.
- Resolve declarator names through the declarator tree and accept only
  identifier, field-identifier, or supported qualified-identifier terminals.
- Skip a declaration capture when the exact AST occurrence is already owned by
  a definition capture.
- Add `namespace` and `macro` to `ExtractedSymbolKind` only in the batch that
  first emits them, and map them to the existing persisted kinds.
- Include namespace/module kinds in parent-path construction.
- Keep union mapped to `type`; do not expand the persisted schema.

Oxc:

- Extend the existing node classifier rather than adding a second traversal.
- Candidate node types are `TSModuleDeclaration`, `TSDeclareFunction`,
  `TSMethodSignature`, and `TSAbstractMethodDefinition`, subject to the pinned
  Oxc AST actually produced by each fixture.
- Extend name extraction only for those proven nodes.
- Reuse the existing callable-container state to suppress local variables and
  local callable expressions.
- Do not re-emit or reclassify module-level `VariableDeclarator` symbols that
  the adapter already owns.
- Preserve existing call-site extraction byte-for-byte for the fixture.

Python:

- Admit an assignment only when its assignment expression is directly owned by
  the module and its left side is one identifier.
- Reuse the existing Tree-sitter traversal; do not add a text or regex scan.
- Preserve the current decorated class/function span policy.
- Emit the binding as `variable`; do not infer constant or type semantics from
  capitalization, annotations, or the right-hand expression.
- Do not treat class attributes as module variables in this program.

All adapters:

- Use parser nodes, not text matching.
- Preserve one source traversal per file.
- Preserve canonical sorting in the registry rather than depending on parser
  visitation order.
- Keep definition extraction separate from reference/call extraction.

### D0 — Batch-local contract freeze

D0 repeats independently for each separately authorized semantic batch. It
freezes only the fixtures and decisions needed by that batch against the
then-current baseline:

| Contract freeze | Scope |
| --- | --- |
| `D0-D1A` | TypeScript signature/overload identity, current JavaScript declaration audit, affected existing-kind consumers, and publication/relationship invalidation |
| `D0-D1B` | TypeScript namespace forms, descendant reparenting allowlist, new `namespace` kind consumers, and publication/relationship invalidation |
| `D0-D1C` | Python module-binding inclusion, exact noise/exclusion output, existing `variable` consumers, and publication/relationship invalidation |

Shared compatibility evidence may be reused only while its relevant code,
configuration, fixtures, and runtime identity remain unchanged. Each D0 still
records the evidence it depends on.

Authorizing one D0 does not authorize fixture work, expectation changes,
implementation, or decisions for another D0 or for C/C++, Rust, Go, Java, C#,
or Scala.

Scope for an authorized D0:

1. Freeze the current repository revision and analyzer identities.
2. Add one compact source fixture for only the authorized batch containing:
   - existing supported definitions;
   - the intended new definitions;
   - one local/noise construct that must remain excluded; and
   - one duplicate-risk declaration/definition pattern where applicable.
3. Record the expected extracted kind, name, parent path, and source span.
4. Record existing stable and exact identities for unchanged definitions.
5. Freeze every intended construct-to-kind-to-parent mapping.
6. Inventory the exhaustive kind consumers affected by the batch.
7. Prove that extractor identity changes invalidate:
   - publication compatibility;
   - symbol and owner state;
   - relationship artifacts bound to the old symbol registry; and
   - completion/navigation proof for the old generation.
8. Freeze declaration/definition grouping, outline, search-group, exact-open,
   and deletion behavior.
9. For a container batch, freeze the exact reparented descendant allowlist and
   expected old/new identity pairs.

Exit:

- The expected behavior is reviewable before extractor code changes.
- No parser, public contract, or persisted state has changed.
- Current-behavior fixtures pass; proposed future expectations may be recorded
  as contract data but D0 must not leave the default test suite failing.
- The four blocking questions are answered:
  1. the registry can represent the intended duplicate instances;
  2. extractor identity invalidates every affected derived artifact;
  3. every construct has a complete kind/parent/span contract; and
  4. every container reparenting identity delta is explicit.
- If any answer is negative, stop with the matching blocked decision instead
  of beginning extractor implementation.

### D1 — Core TypeScript, JavaScript, and Python parity

D1 contains independently reviewable semantic changes. A failure in one
sub-batch must not be hidden by success in another.

#### D1A — Oxc declaration parity and JavaScript audit

Scope:

- Add TypeScript declaration-only function and method signatures.
- Add TypeScript abstract method signatures.
- Freeze TypeScript overload signatures plus implementation behavior.
- Audit existing JavaScript classes, functions, methods, named function/arrow
  variable bindings, and generator definitions against the pinned query.
- Preserve existing module-variable definitions and their kinds.
- Add no arbitrary JavaScript member, prototype, assignment, or object-property
  symbols.

Required cases:

- interface method signature;
- abstract method signature;
- declared function signature;
- overload signatures plus implementation;
- same member name in different interfaces/classes;
- existing module-level arrow/function variable;
- generator function;
- arbitrary assignment/prototype/object-property exclusions;
- function-local variable exclusion; and
- unchanged existing class, function, method, type, interface, enum, and
  variable identity inputs.

Exit:

- Oxc remains the sole TypeScript/JavaScript analyzer.
- New definitions are navigable through registry, outline, and exact-open.
- Existing call-site output is byte-equivalent for the fixture.
- No duplicate module-variable definitions appear.
- No local-symbol explosion appears in outline or grouped search.
- JavaScript records `definition_parity_noop` unless its existing
  declaration-oriented output fails the frozen audit.
- If the JavaScript audit disproves current declaration-oriented parity,
  record the exact gap and stop that JavaScript portion as a separately
  proposed bounded correction. D1A must not expand to repair it.
- A JavaScript audit failure does not invalidate an independently passing
  TypeScript signature implementation.

#### D1B — TypeScript namespace containers

Scope:

- Add identifier-named TypeScript namespace/module definitions.
- Use `container_reparenting`.
- Reparent lexical descendants to the canonical namespace path.
- Exclude ambient string modules until literal normalization is separately
  frozen.

Required cases:

- one namespace containing class, interface, function, and variable
  definitions;
- nested identifier namespaces;
- merged/reopened namespaces;
- same-name symbols in two namespaces;
- overloads inside a namespace;
- exact old/new identity allowlist for every reparented existing definition;
- old exact IDs rejected after rebuild; and
- new exact IDs open the intended source.

Exit:

- Container and descendant identities match the frozen delta.
- Definitions outside the namespace fixture retain their identity inputs.
- Relationship artifacts bound to the pre-container registry are not reused.

#### D1C — Python module bindings

Scope:

- Add direct simple identifier assignments owned by the module.
- Emit them as `variable` -> persisted `property`.
- Include annotated assignments only when the pinned fixture proves they use
  the same accepted assignment-node contract.
- Preserve decorated-definition spans and current class/method ownership.

Required cases:

- `cache = {}`;
- `MAX_RETRIES = 3`;
- `DEFAULT_TIMEOUT: float = 5.0`;
- `T = TypeVar("T")` remains a variable rather than an inferred type;
- class-attribute exclusion;
- function-local assignment exclusion;
- destructuring exclusion;
- decorated class and function identity preservation; and
- grouped ownership plus exact-open for admitted forms.

D0-D1C must freeze an exact fixture oracle containing:

- the admitted module-binding names and count;
- the excluded class, local, and destructured binding names and counts;
- deterministic outline order;
- the exact owner of every controlled source chunk; and
- the expected lexical-only group and exact-open target for one uniquely named
  module binding.

Exit:

- Only direct simple module bindings become symbols.
- Existing Python symbol identities and call relationships remain unchanged.
- No class/local assignment appears as a new symbol.
- The complete fixture output matches the frozen D0-D1C oracle. Any additional
  admitted binding, missing exclusion, ordering change, or ownership mismatch
  stops with `scope_noise_fail`.

#### D1 decision discipline

D1A, D1B, and D1C are separately frozen, authorized, implemented, verified,
and decided.

Each sub-batch:

- runs the applicable Core/MCP identity, ownership, outline, exact-open,
  incremental-equivalence, and publication-compatibility proof against the
  state that sub-batch would merge;
- changes the development extractor identity relative to its parent when it
  changes extraction semantics; and
- ends with its own decision.

A pass in one sub-batch does not authorize another. A failure in one does not
invalidate an independently passing sub-batch. The release-cadence rules in
Section 10 govern whether several completed, unreleased batches share one final
product extractor identity.

### D2 — C++ parity and honest C-subset proof

#### D2A — Existing-parent C/C++ definitions

Scope:

- Add C++ function declarations, typedef/type definitions, and named unions.
- Accept a `field_identifier` only as the terminal name of a callable
  declarator.
- Prevent double emission when a function definition contains a declarator.
- Exercise representative C syntax through the existing C++ analyzer.
- Preserve the explicit statement that native C authority is absent.
- Exclude function-local prototypes, typedefs, named structs/unions, variables,
  and lambdas.

Required cases:

- C-style function declaration and definition;
- `int first(), second();` with independent bounded spans;
- anonymous typedef struct;
- named struct with a distinct typedef alias;
- named union;
- C++ class declaration and inline method;
- out-of-class qualified method;
- header-only function declaration;
- function-local prototype, typedef, named type, variable, and lambda
  exclusions;
- UTF-8 before and inside a declaration;
- duplicate declaration and definition instances; and
- honest common-C syntax through the C++ parser.

Exit:

- C++ delta output is deterministic.
- Existing C++ method identities do not change accidentally.
- Common C constructs work through the documented C++ subset.
- No native C claim or parser dependency is introduced.

#### D2B — C++ namespace containers

Scope:

- Add namespace definitions using `container_reparenting`.
- Map `namespace A::B::C {}` to canonical path segments `A`, `B`, `C`.
- Preserve lexical paths for reopened namespaces across files.

Required cases:

- nested namespace syntax;
- C++17 compact nested namespace syntax;
- namespace reopened in one file;
- namespace reopened across two files;
- out-of-class method inside and outside namespace syntax;
- same-name definitions in different namespaces; and
- exact expected identity delta for reparented descendants.

Exit:

- Reopened namespaces do not collapse exact instances.
- File-relative stable identity remains truthful across files.
- Old container/descendant artifacts cannot be reused.

### D3 — Rust parity and Go audit

Rust:

- add union, type-alias, and macro definitions;
- keep macro calls and impl resolution unchanged.

Go:

- compare current output with the pinned official definitions;
- make no behavior change unless the frozen fixture disproves parity.

Exit:

- New Rust definitions open exactly from the registry.
- Locals remain excluded.
- Go is recorded as `parity_noop` or receives a separately justified bounded
  correction.

### D4 — C# namespace parity and Java audit

#### D4A — C# namespaces

- add namespace definitions using `container_reparenting`;
- freeze block and file-scoped namespace behavior; and
- prove the descendant identity delta and artifact invalidation.

#### D4B — Java audit

- prove current official-query definition parity;
- do not add fields, enum constants, records, or annotations in this batch.

Exit:

- C# namespace-owned symbols retain correct qualified paths.
- Java records a no-op result unless the fixture disproves current parity.

### D5 — Scala parity

#### D5A — Scala package/type/enum structure

- add package namespaces using `container_reparenting`;
- add enum and named type definitions;
- defer enum cases and class parameters until a focused value fixture exists.

Exit:

- Existing definitions outside the frozen package-descendant allowlist retain
  their identity inputs.
- The package-descendant identity delta is frozen and exact-open passes.

#### D5B — Scala top-level bindings

Scope:

- add named top-level `val`, `var`, and `given` definitions;
- preserve the frozen mapping from Section 5.6; and
- exclude function-local and anonymous definitions.

Exit:

- Top-level bindings are navigable without local-outline noise.
- A noisy fixture stops with `scope_noise_fail` without invalidating D5A.

### D6 — Consolidated documentation and release truth

Scope:

- Each D1-D5 batch updates every behavior description directly invalidated by
  that batch in the same merge.
- Update the tiered language capability matrix only for proven behavior.
- Update public README claims only if user-visible language claims change.
- Record C as a C-compatible C++-analyzer subset, not native C support.
- Add `THIRD_PARTY.md` entries only if implementation material was copied or
  substantially adapted.

Exit:

- No completed batch leaves directly affected documentation stale.
- Documentation matches actual fixtures.
- No language is described as graph-ready because of definition parity alone.
- No broad language-count claim hides capability tiers.

## 9. Implementation Owners

Expected files, changed only when required by a batch:

| Owner | Files |
| --- | --- |
| Oxc definition extraction | `packages/core/src/language-analysis/oxc-adapter.ts` |
| Tree-sitter definition extraction | `packages/core/src/language-analysis/tree-sitter-adapter.ts` |
| Extracted kind contract | `packages/core/src/languages/types.ts` |
| Persisted kind mapping | `packages/core/src/symbols/registry.ts` |
| Persisted kind validation/order | `packages/core/src/symbols/contracts.ts`, registry ordering, and SQLite navigation serialization |
| Analyzer identity | `packages/core/src/language-analysis/versions.ts` |
| Publication compatibility | `packages/core/src/core/persisted-index-authority.ts` and focused compatibility tests |
| Relationship invalidation binding | symbol/relationship manifest builders and focused relationship/navigation tests |
| Capability truth | `packages/core/src/languages/capabilities.ts` |
| Focused analyzer tests | `packages/core/src/language-analysis/service.test.ts` |
| Registry/owner proof | existing focused registry and `context` tests |
| Navigation fixtures | `fixtures/navigation/<language>-basic-symbols/` |
| Outline proof | `packages/mcp/src/core/handlers.file_outline.test.ts` |
| Exact-open proof | `packages/mcp/src/tools/read_file.test.ts` |
| Public docs | only the capability matrix/readmes invalidated by proven behavior |

Do not introduce a new extractor directory, query engine, schema, or plugin
registry unless the existing two adapters cannot express one frozen definition
without duplication. Complexity alone is not sufficient evidence.

## 10. Compatibility And Publication

### Required

- Any semantic change to extracted definitions increments
  `SYMBOL_EXTRACTOR_VERSION`.
- A publication created with an older extractor identity is incompatible and
  must deterministically enter the established `requires_reindex` path.
- The batch cannot pass until an old publication is proven unable to open
  silently under the new extractor meaning.
- Preserve `LANGUAGE_PARSER_VERSION` unless parser bytes or parser selection
  change.
- `RELATIONSHIP_BUILDER_VERSION` may remain unchanged only as the relationship
  algorithm version because this plan does not change construction logic.
- An unchanged relationship algorithm version never authorizes reuse of
  relationship artifacts whose extractor identity, symbol registry hash,
  symbol/owner identities, or relationship endpoints changed.
- The relationship manifest is bound to
  `symbolRegistryManifestHash`; the symbol-registry manifest hash includes
  `extractorVersion`. D0 must prove this chain rejects an old relationship
  artifact after an extractor-version change.
- Preserve embedding and lexical projection versions.
- Never reinterpret old symbol sidecars under a new extractor meaning.
- Rebuild symbol, owner, navigation, and relationship derived state whenever
  their referenced identities or ownership inputs changed.
- The completion/navigation proof for the new generation must bind only the
  newly compatible tuple.

### Not claimed

- Navigation-only migration.
- Reuse of old relationship shards after owner identity changes.
- No-reembedding upgrade.
- Cross-version symbol-instance compatibility.

If a proposed implementation would change existing stable symbol keys for
definitions outside an approved container-reparenting allowlist, stop with
`identity_regression` unless the change fixes a demonstrated incorrect identity
and includes an explicit migration/reindex decision.

### Release cadence and reindex cost

Every released extractor identity intentionally causes one full compatible
reindex. To avoid avoidable user churn:

- development batches use task-owned fixtures and may carry distinct
  development identities;
- multiple completed language batches intended for one product release should
  share one final release extractor identity;
- do not publish intermediate extractor versions merely because the internal
  batches were reviewed separately; and
- if batches are intentionally released separately, disclose that each release
  requires its own full reindex.

Do not weaken compatibility checks to reduce reindex frequency.

## 11. Verification

Use focused fixtures and task-owned state. Do not run paid providers or broad
answer-quality benchmarks.

### Per-language analyzer proof

Verify:

- expected definitions are present;
- excluded locals/noise are absent;
- kinds are correct;
- parent paths and qualified names are correct;
- spans slice the intended source;
- ordering is deterministic;
- repeated analysis is byte-stable after canonical serialization;
- hard analyzer failure and malformed syntax both produce current file-owner
  fallback with no stale or partial source definitions; and
- existing definitions retain their expected identity inputs.

### Registry and owner proof

Verify:

- extracted definitions become canonical registry records;
- chunks resolve to the tightest intended owner;
- file-owner fallback remains available;
- declaration and definition instances do not collide;
- no stale symbol survives an edit or deletion; and
- full rebuild and incremental replacement produce equivalent symbol
  contributions for the fixture.

### Deterministic grouped-search proof

Grouped-search verification uses:

- one isolated local fixture;
- deterministic lexical-only indexing;
- one exact unique symbol-name query;
- no paid provider;
- no semantic embedding model; and
- no assertion about production score or global rank.

Assert only:

- the expected group exists;
- its canonical owner and exact instance match the frozen registry output;
- the selected exact instance opens correctly; and
- no excluded local owner is produced.

This is ownership wiring proof, not retrieval-quality qualification.

### Incremental equivalence matrix

At minimum, the adapter-level or shared integration fixture must prove:

| Operation | Required result |
| --- | --- |
| Add definition | incremental result equals clean rebuild |
| Rename definition | old identity disappears and new identity appears |
| Delete definition | no stale registry or owner contribution remains |
| Change declaration to definition | exact instances and grouping update correctly |
| Move into/out of container | only the frozen identity allowlist changes |
| Introduce syntax error | current file-owner fallback; no old symbol leaks |
| Repair syntax error | incremental and clean outputs converge |

One shared fixture per adapter may cover this matrix. It need not be duplicated
for every language when the same owner and mutation path are unchanged.

### MCP proof

The program must verify:

- `file_outline` contains the new definitions in deterministic order;
- `read_file(open_symbol)` opens the exact intended span;
- grouped search can return the new owner from a controlled lexical fixture;
- no unsupported `call_graph` action is advertised for symbol-only languages;
- full-navigation languages retain their existing call-graph capability; and
- no public tool schema changes.

The same batch updates every directly invalidated behavior document after these
checks pass. D6 is a final consolidated audit, not permission to leave
intermediate documentation stale.

Each batch reruns only the proof invalidated by its changed owner. Green
registry, publication-compatibility, relationship-binding, and language-neutral
MCP evidence remains reusable while its implementation, schema, fixture,
manifest binding, and configuration inputs are unchanged. Shared extractor
changes receive one affected Core package checkpoint, and unchanged MCP
handlers receive one final targeted public-boundary checkpoint rather than a
duplicate matrix per language.

### Focused commands

Use the narrowest repository commands that own the changed files. At minimum:

```bash
pnpm --filter @zokizuan/satori-core test
pnpm --filter @zokizuan/satori-core typecheck
pnpm --filter @zokizuan/satori-mcp test
pnpm --filter @zokizuan/satori-mcp typecheck
pnpm exec eslint <changed TypeScript files>
git diff --check
```

The package-wide test commands may be replaced by narrower documented test-file
commands during iteration. Run one affected package consolidation checkpoint
after related batches sharing an extractor, registry, or identity owner; do not
repeat it after documentation-only changes.

Do not run release smoke, installer qualification, L4, or retrieval benchmarks
for a definition-only batch.

## 12. Mechanical Acceptance Gates

A behavior-changing language batch passes only when its changed boundaries
satisfy the applicable gates below. Unchanged gates may use valid reusable
evidence under Section 11; they are not recreated for every language:

1. Every construct has a frozen extracted kind, persisted kind, parent rule,
   and span rule.
2. Every exhaustive kind consumer accepts the new kind or the batch stops
   before extraction changes.
3. Every frozen positive definition is emitted exactly once per source
   occurrence.
4. Every frozen exclusion, including callable-local named declarations,
   remains absent.
5. Existing identity inputs remain unchanged outside an explicit
   container-reparenting or defect-correction allowlist.
6. Duplicate declaration/definition fixtures retain the frozen stable grouping
   and distinct exact instances.
7. Exact-open returns the correct selected source instance.
8. Outline ordering is deterministic.
9. Owner assignment selects the intended definition.
10. Hard-failure and malformed-source fallback pass without stale or partial
    source symbols.
11. The incremental mutation matrix converges with clean rebuild output.
12. Extractor identity is bumped.
13. An old publication deterministically returns `requires_reindex`; it never
    silently reuses old symbol, owner, relationship, or navigation state.
14. Derived owner and relationship artifacts are rebuilt when their referenced
    identities changed.
15. Relationship algorithm and embedding/lexical projection semantics remain
    unchanged.
16. Grouped-search proof remains isolated and lexical-only.
17. Directly invalidated documentation changes in the same merge.
18. Focused Core and MCP tests pass.
19. The final diff contains no unrelated parser, ranking, graph, or
    publication changes.

An audit-only language records `parity_noop` when current output already
matches the frozen definition contract and no code is changed. When that audit
is embedded in another language's implementation batch, it is supporting
evidence rather than a second authorization decision.

## 13. Stop Decisions

Each authorized D0 or semantic implementation batch ends with exactly one
primary decision. An embedded audit-only language may additionally record a
supporting `parity_noop` result or a bounded gap without changing the batch's
authorization boundary.

### `contract_freeze_pass`

The authorized D0 contract is complete: baseline behavior and mappings are
recorded, required identity behavior is representable, compatibility
invalidation is proven, and any expected identity deltas are exact.

This decision allows the corresponding implementation batch to be considered
for separate authorization. It does not authorize implementation
automatically.

### `definition_parity_pass`

The intended definitions are proven end to end through extraction, registry,
ownership, outline, and exact-open behavior without identity or noise
regression.

### `definition_parity_noop`

Current behavior already satisfies the frozen definition contract. No
implementation change is justified.

### `parser_authority_blocked`

The required grammar or parser artifact is unavailable, incompatible, or would
require a new dependency/provenance decision. Stop rather than using text
heuristics.

### `identity_regression`

The proposed definition change destabilizes existing symbol identities or
collides declaration instances. Stop and report the exact identity owner.

### `identity_model_blocked`

The current registry, grouping, outline, or exact-open model cannot represent
the frozen declaration/definition instances without collapse or ambiguity.

### `publication_compatibility_blocked`

Extractor identity does not mechanically invalidate every affected
publication, owner, navigation, or relationship artifact.

### `kind_consumer_blocked`

A required downstream consumer cannot represent the frozen new kind without an
unapproved public schema or architecture change.

### `container_identity_blocked`

The descendant-reparenting set or its expected old/new identities cannot be
made exact and deterministic under the current registry and parent contract.

### `scope_noise_fail`

The new rule emits locals, trivial members, or duplicate symbols at a level
that makes ownership or outlines worse. Stop and narrow the inclusion rule.

Passing a batch authorizes documentation of that batch only. It does not
authorize call-graph, import/export, typed-receiver, or additional-language
work.

## 14. Initial Authorization Entry (completed)

The original bounded entry was `D0-D1A`:

```text
freeze current TypeScript signature and overload output
    -> freeze current JavaScript declaration output for audit only
    -> freeze TS overload declaration/definition identity
    -> prove the current duplicate-instance registry model
    -> audit affected existing-kind consumers
    -> prove old-publication and relationship-artifact invalidation
    -> stop at the D0-D1A decision without changing extractor behavior
```

`D0-D1A` may add focused fixtures or contract data needed to capture current
behavior. It must not change extractor output, expected production behavior,
TypeScript namespace ownership, Python bindings, C/C++, Rust, Java, C#, Scala,
call relationships, parser dependencies, or user publications.

That entry did not authorize later batches by itself. The subsequent explicit
program authorization and the terminal decisions in Section 16 now record the
completed execution state.

## 15. Final Program Completion

This plan is complete when:

- every existing structural language has a recorded
  `definition_parity_pass` or `definition_parity_noop`;
- C's parser boundary is described truthfully;
- all implemented definitions are proven through extraction, ownership,
  outline, and exact-open behavior;
- no language gains an unproven call-graph or import/export claim;
- extractor and publication identities reflect persisted meaning;
- public language documentation matches the proven capability tiers; and
- the repository contains no speculative parser framework introduced solely
  for this program.

## 16. Execution Record

**Execution start:** `c239d8442aa810b2f27e6210ceb397649f412d09`
on `master`, with a clean worktree and no user changes.

Evidence may be reused only under the rules in Section 10 and Section 11.

| Batch | Decision | Evidence |
| --- | --- | --- |
| `D0-D1A` | `contract_freeze_pass` | Oxc `0.139.0` emits `TSDeclareFunction`, `TSMethodSignature`, and `TSAbstractMethodDefinition` with deterministic identifier keys and UTF-16 spans. Existing registry coverage proves one stable key can retain distinct exact instances. Focused compatibility coverage proves an extractor-version change returns `requires_reindex` and changes the symbol-registry manifest hash, which invalidates relationship artifacts bound to the prior hash. |
| D1A | `definition_parity_pass` | Oxc emits declaration-only functions, interface methods, and abstract methods with frozen names, parents, spans, and distinct overload occurrences. The JavaScript audit recorded supporting `definition_parity_noop`: existing generator, class/method, module callable, and scalar-variable output remained unchanged while prototype/object members remained excluded. Analyzer/registry/compatibility checks passed 72/72; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v5` to `language-analysis-v6`; parser and relationship identities were unchanged. |
| `D0-D1B` | `contract_freeze_pass` | Oxc `0.139.0` represents identifier namespaces as `TSModuleDeclaration` nodes, nested identifier namespaces as nested declarations, and ambient string modules with a non-identifier `Literal` ID. The persisted registry already accepts `namespace`; the extracted-kind union, registry mapping/label parser, and Oxc parent construction are the only consumers requiring synchronization. Existing D0 compatibility evidence remains valid because its implementation and manifest inputs are unchanged. |
| D1B | `definition_parity_pass` | Identifier namespaces are emitted as `namespace`; reopened occurrences retain one stable key and distinct exact instances; only the frozen lexical descendants are reparented; ambient string modules remain excluded as containers; and the outside-definition preservation witness is unchanged. Analyzer/registry/compatibility checks passed 74/74, followed by the complete affected Core suite, Core typecheck, and focused lint. Development extractor identity advanced from `language-analysis-v6` to `language-analysis-v7`; parser and relationship identities were unchanged. |
| `D0-D1C` | `contract_freeze_pass` | The pinned Python grammar represents simple and annotated bindings as `assignment` with an identifier `left`; destructuring uses `pattern_list`, attribute assignment uses `attribute`, and class/local assignments are not directly owned by `module`. Existing `variable` -> `property` consumers require no kind change. The current Python module-binding builder derives relationship input from top-level symbols, so D1C must exclude the new navigation-only variables from that builder to preserve import/export semantics. Existing D0 compatibility evidence remains reusable. |
| D1C | `definition_parity_pass` | Exactly `cache`, `MAX_RETRIES`, `DEFAULT_TIMEOUT`, and `T` are emitted as direct module variables in deterministic source order. Destructured, class, callable-local, and attribute assignments remain excluded; assignment chunks carry the new owner labels; decorated-definition spans remain unchanged; and new variables are absent from relationship/module-binding evidence. Focused analyzer/registry/compatibility checks passed 75/75; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v7` to `language-analysis-v8`; parser and relationship identities were unchanged. |
| `D0-D2A` | `contract_freeze_pass` | The pinned C++ grammar represents bodyless functions as direct `function_declarator` fields of `declaration` or `field_declaration`, typedefs as `type_definition`, and named unions as `union_specifier`. Callable names terminate in `identifier`, class-member `field_identifier`, or a bounded `qualified_identifier`. A baseline probe also proved that current extraction incorrectly emits a function-local named struct; D2A allowlists removal of that local symbol. Existing D0 compatibility evidence remains reusable. |
| D2A | `definition_parity_pass` | C/C++ declarations, independent multi-declarators, typedef aliases, named unions, and class method declarations match the frozen kind/name/parent/span contract. Declaration and definition occurrences of `Worker.run` remain distinct. Callable-local prototype, typedef, named type, variable, and lambda noise is absent, including removal of the previously leaked `LocalType`. The focused analyzer suite passed 51/51; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v8` to `language-analysis-v9`; parser and relationship identities were unchanged. |
| `D0-D2B` | `contract_freeze_pass` | The C++ grammar represents ordinary namespaces with `namespace_identifier` and C++17 compact namespaces with one `nested_namespace_specifier`. Compact `A::B::C` therefore freezes one source-backed namespace occurrence `C` under parent segments `A`, `B`; no synthetic source-less `A` or `B` symbols are invented. Existing free functions inside namespaces must remain `function`, while explicit qualified members combine lexical namespace and declared class scope. Existing D0 compatibility evidence remains reusable. |
| D2B | `definition_parity_pass` | C++ ordinary, nested, compact, and reopened namespaces match the frozen source-backed container contract. Namespace free functions remain functions, explicit qualified members combine lexical namespace and class ownership, and the outside-definition preservation witness is unchanged. The focused analyzer suite passed 52/52; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v9` to `language-analysis-v10`; parser and relationship identities were unchanged. |
| `D0-D3` | `contract_freeze_pass` | The pinned Rust grammar represents aliases as `type_item`, unions as `union_item`, and macro definitions as `macro_definition`, each with a deterministic `name` field. A baseline probe also proved that current Rust and Go extraction emits callable-local named types (`LocalStruct` and `Local`), contrary to the program's local-exclusion contract. D3 therefore includes the bounded correction at the shared Tree-sitter owner while preserving existing module/type/function output. Existing compatibility evidence remains reusable. |
| D3 | `definition_parity_pass` | Rust module/root aliases, unions, and macro definitions now match the frozen kind, parent, and qualified-name contract. Callable-, trait-, and impl-local named definitions remain excluded, including removal of the previously leaked `LocalStruct`. The Go audit required one bounded correction: top-level type/function output remains unchanged while the callable-local `Local` type is no longer emitted. Focused analyzer/registry/compatibility checks passed 79/79; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v10` to `language-analysis-v11`; parser and relationship identities were unchanged. |
| `D0-D4A` | `contract_freeze_pass` | The pinned C# grammar represents block namespaces as `namespace_declaration` and file-scoped namespaces as `file_scoped_namespace_declaration`; each exposes an identifier or qualified-name `name` field. File-scoped namespace ownership applies to following compilation-unit declarations rather than AST children, so D4A must carry that one frozen lexical authority across later siblings without creating source-less prefix symbols. Existing `namespace` consumers and compatibility evidence are reusable. |
| D4A | `definition_parity_pass` | C# block, qualified, reopened, and file-scoped namespaces now match the frozen source-backed container contract. Block ownership remains bounded to the namespace body, file-scoped ownership applies to later compilation-unit declarations, and the top-level preservation witness remains unchanged. Focused analyzer/registry/compatibility checks passed 80/80; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v11` to `language-analysis-v12`; parser and relationship identities were unchanged. |
| `D0-D4B` | `contract_freeze_pass` | The Java audit confirmed existing class, interface, enum, method, and constructor coverage, but also proved that a callable-local class and its members can leak into repository navigation. D4B therefore records a bounded correction under the program-wide local-exclusion contract while adding none of the deferred record, annotation, field, or enum-constant categories. Existing compatibility evidence remains reusable. |
| D4B | `definition_parity_pass` | Java retains its existing class, interface, enum, method, and constructor definitions while callable-local classes and their nested declarations are excluded. No records, annotations, fields, enum constants, package symbols, or reference captures were added. Focused analyzer/registry/compatibility checks passed 81/81; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v12` to `language-analysis-v13`; parser and relationship identities were unchanged. |
| `D0-D5A` | `contract_freeze_pass` | The pinned Scala grammar represents packages as `package_clause` with a `package_identifier` name and an optional `template_body`, enums as `enum_definition`, and aliases as `type_definition`. A bodyless package governs later compilation-unit siblings, while a package with a body governs only that body. Qualified packages are one source occurrence whose final segment is emitted under the preceding segments. Existing namespace/enum/type consumers and compatibility evidence remain reusable. |
| D5A | `definition_parity_pass` | Scala block, flat, qualified, and chained package ownership now follows the frozen source-backed container contract; enums and named type aliases are emitted under the active package; callable-local type/function definitions remain excluded; and the outside-package preservation witness is unchanged. Focused analyzer/registry/compatibility checks passed 82/82; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v13` to `language-analysis-v14`; parser and relationship identities were unchanged. |
| `D0-D5B` | `contract_freeze_pass` | The pinned Scala grammar represents immutable bindings as `val_definition`, mutable bindings as `var_definition`, and givens as `given_definition`. Direct binding names are identifier `pattern` fields for val/var and an optional identifier `name` field for givens. D5B admits only bindings under source/package module authority and freezes an exact noise oracle excluding class fields, callable locals, destructuring, and anonymous givens. Existing property-kind consumers and compatibility evidence remain reusable. |
| D5B | `definition_parity_pass` | Scala admits exactly the frozen named package-level val, var, and given bindings as property-backed navigation definitions. Class-owned, callable-local, destructured, and anonymous bindings remain excluded, while existing structural definitions retain their identities. Focused analyzer/registry/compatibility checks passed 83/83; Core typecheck, focused lint, and diff check passed. Development extractor identity advanced from `language-analysis-v14` to the consolidated release identity `language-analysis-v15`; parser and relationship identities were unchanged. |
| D6 | `definition_parity_pass` | The final focused analyzer/registry/compatibility set passed 84/84, including persisted macro mapping. The complete Core suite, Core build/typecheck, focused lint, MCP file-outline/read-file and grouped-owner boundary checks, MCP typecheck/runtime build, and diff check passed. The known tracked-lexical continuation fixture still produced its recorded pre-existing `not_ready` result when included in a broader MCP selection; its dependency boundary was not changed and it is not claimed green. Public documentation now records proven per-language definition coverage, the common-C/C++ parser boundary, and the separation between definition navigation and graph/type-resolution capability. Capability tiers and public schemas were unchanged; no copied runtime code required a `THIRD_PARTY.md` change. |

### Frozen D1A contract

- `TSDeclareFunction` -> `function`, using its identifier, complete declaration
  span, and current lexical parent.
- `TSMethodSignature` and `TSAbstractMethodDefinition` -> `method`, using their
  identifier/string key, complete declaration span, and nearest current
  class/interface parent.
- Overload signatures and the implementation share a stable key only when the
  current path, language, persisted kind, qualified name, and parent are equal;
  each source occurrence retains a distinct exact instance through its span.
- Existing JavaScript output is audit-only and must remain unchanged.
- Existing call-site extraction is not changed.
- No new extracted or persisted kind is required by D1A.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

Focused D0 evidence:

```text
packages/core/src/core/persisted-index-authority.test.ts
packages/core/src/symbols/registry.test.ts
24 passed, 0 failed
```

### Frozen D1B contract

- Identifier `TSModuleDeclaration` -> `namespace`, complete declaration span,
  and current lexical namespace parent.
- Ambient string modules and qualified-name IDs not represented as a simple
  identifier remain excluded.
- A reopened namespace produces distinct exact occurrences under the same
  path-sensitive stable key.
- The fixture allowlists only these identity-input changes:
  - `Invoice`, `Reader`, `run`, `value`, and overload `parse` occurrences:
    `[]` / unqualified name -> `["Billing"]` / `Billing.<name>`;
  - `Inner`: newly emitted under `["Billing"]` as `Billing.Inner`;
  - `nested`: `[]` / `nested` -> `["Billing", "Inner"]` /
    `Billing.Inner.nested`; and
  - `reopened`: `[]` / `reopened` -> `["Billing"]` /
    `Billing.reopened`.
- A top-level `outside` function is the preservation witness and must retain
  its existing identity inputs.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not. Prior relationship artifacts remain invalid
  through the already-proven symbol-registry manifest binding.

### Frozen D1C contract

- Admit only an `assignment` whose `left` field is one `identifier` and whose
  enclosing `expression_statement` is directly owned by the Python `module`.
- Emit the assignment node's complete span as `variable` with no parent path.
- The exact admitted fixture bindings are `cache`, `MAX_RETRIES`,
  `DEFAULT_TIMEOUT`, and `T`, in source order.
- The exact excluded bindings are destructured `a` and `b`, class-owned
  `class_value`, callable-local `local`, and attribute-owned `value`.
- Every admitted binding owns its controlled assignment chunk; decorated class
  and function symbols retain their existing spans and identities.
- New Python variables do not enter `ModuleBinding` output, so import/export
  and call relationship inputs remain unchanged.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

### Frozen D2A contract

- A direct callable declarator under a repository/class/namespace declaration
  becomes `function` or `method`; declarators inside a callable remain
  excluded.
- A single callable declarator uses its complete containing declaration span.
  Multiple callable declarators in one declaration use their individual
  declarator spans so no sibling is swallowed.
- Only direct identifier, field-identifier, or qualified-identifier callable
  terminals are admitted; pointer variables and lambdas remain excluded.
- `type_definition` aliases and named `union_specifier` nodes become `type`.
  Existing named struct/class/enum definitions remain unchanged.
- The exact positive fixture names are `declared`, `first`, `second`, `Item`,
  `Named`, `Alias`, `Payload`, `Worker`, both `Worker.run` occurrences, and
  `outer`.
- The exact exclusions are `localPrototype`, `LocalId`, `LocalType`, and
  `local`. Removal of the currently emitted `LocalType` is an authorized
  defect-correction identity delta.
- `.c` and `.h` remain routed through the C++ analyzer; this is a common-C
  subset proof, not native C parser authority.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

### Frozen D2B contract

- `namespace_identifier` emits one `namespace` under the current lexical path.
- `namespace A::B::C` emits the source-backed namespace `C` with parent path
  `["A", "B"]`; it does not invent separate source symbols for `A` or `B`.
- Reopened namespace declarations in one file share a stable key and retain
  distinct exact instances. Reopened declarations in different files retain
  the established path-sensitive distinct stable keys.
- Namespace free functions remain `function`, not `method`.
- Explicit `Item::run` inside namespace `A` is owned by
  `["A", "Item"]` as `A.Item.run`.
- The fixture allowlists descendant reparenting for `Item`, `free_fn`, `B`,
  `Nested`, `C`, `Deep`, `deep_fn`, `Item2`, and `Item.run`. Top-level
  `outside` remains the preservation witness.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

### Frozen D3 contract

- Rust `type_item` and `union_item` become `type`; `macro_definition` becomes
  `macro`.
- Rust definitions are admitted only under the source/module lexical
  authority. New aliases, unions, macros, and existing named types inside a
  callable, trait, or impl remain excluded.
- The exact positive Rust fixture names are `storage`, `ItemId`, `Payload`,
  `build`, `load`, `RootId`, `RootPayload`, `root_macro`, and `outer`.
- The exact Rust exclusions are callable-local `Local`, `LocalStruct`, and
  `local_macro`.
- Go preserves top-level `Public` and `outer`; the currently leaked
  callable-local `Local` type is removed as a bounded parity correction.
- Existing Rust impl/trait method ownership, macro calls, Go receiver
  ownership, call-site extraction, and module-binding output remain unchanged.
- `macro` is synchronized through the extracted-kind union and the existing
  persisted `macro` vocabulary; no public schema change is required.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

### Frozen D4A contract

- C# `namespace_declaration` and `file_scoped_namespace_declaration` emit the
  final source-backed segment as `namespace`; preceding qualified segments
  become its parent path without synthetic symbols.
- A block namespace reparents only declarations in its body. A file-scoped
  namespace reparents subsequent declarations in the same compilation unit.
- Reopened block namespaces retain one file-relative stable key and distinct
  exact instances.
- The block fixture allowlists `Invoice` and `Invoice.Run` moving under
  `Billing`; top-level `Outside` remains the preservation witness.
- The file-scoped fixture emits `Billing.Inner` and reparents `Worker` and
  `Worker.Work` under `Billing.Inner`.
- Existing class, interface, struct, enum, method, and constructor kinds and
  call-site extraction remain unchanged.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

### Frozen D4B contract

- Preserve existing top-level/member output for `Public`, `Public.run`,
  `Reader`, `Reader.read`, and `Mode`.
- Exclude callable-local `Local` and every declaration nested under that
  excluded local owner.
- Do not add Java records, annotation declarations, fields, enum constants, or
  reference captures.
- Existing call-site extraction and package handling remain unchanged.
- Extractor identity changes only because the audit demonstrated and corrected
  local-definition leakage; parser and relationship identities do not.

### Frozen D5A contract

- Scala `package_clause` emits its final source-backed segment as `namespace`;
  preceding qualified segments become its parent path without synthetic
  symbols.
- A package with a `template_body` reparents only definitions in that body. A
  bodyless package reparents subsequent compilation-unit definitions; chained
  bodyless packages accumulate deterministic lexical ownership.
- `enum_definition` becomes `enum`; `type_definition` becomes `type`.
- The block fixture allowlists `Invoice` moving under `billing`; top-level
  `Outside` remains the preservation witness.
- The flat `billing.core` fixture emits `billing.core` and reparents `Mode`,
  `ItemId`, `Service`, `Service.run`, and `outer` under it.
- Callable-local named type and function definitions remain excluded. Enum
  cases and class parameters remain deferred.
- Existing class, trait, object, and function kinds and call-site extraction
  remain unchanged.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.

### Frozen D5B contract

- A directly module/package-owned `val_definition` with one identifier pattern
  becomes `constant`; `var_definition` becomes `variable`.
- A directly module/package-owned named `given_definition` becomes `variable`;
  anonymous givens remain excluded.
- The exact admitted fixture bindings are `top`, `mutable`, and `ordering`, in
  source order under `billing.core`.
- The exact exclusions are destructured `left`/`right`, class-owned `field`,
  callable-local `local` and `localTop`, and the anonymous given.
- Existing class, method, function, package, enum, and type symbols retain
  their identities and spans.
- New Scala property definitions do not alter call-site or module-binding
  extraction.
- Extractor identity changes; parser, relationship, embedding, and lexical
  projection identities do not.
