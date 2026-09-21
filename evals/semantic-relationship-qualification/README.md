# Semantic Relationship Qualification Lab

This lab compares relationship-resolution providers against one provider-neutral evidence contract. It is evaluation-only: Jev is a qualitative judge here and is **not** an authoritative runtime `CALLS` provider.

The common corpus is `evals/semantic-relationship-qualification/corpus.json`. Its 12 v1 case IDs and meanings remain unchanged: direct calls, class-field receivers, constructor parameter properties, constructor assignment/origin flow, aliases, optional receivers, inheritance, interface dispatch, overload ambiguity, branch-conflicted origins, unresolved/dynamic constructs, and wrong-target decoys. Language/provider overlays are additive and use the same case/result vocabulary rather than changing the common cases.

## Provider report contract

Each provider adapter emits one JSON report:

```json
{
  "version": 1,
  "corpusVersion": 1,
  "provider": {
    "id": "provider-id",
    "version": "provider-version",
    "adapterVersion": "qualification-adapter-version"
  },
  "language": "typescript",
  "cases": [
    {
      "caseId": "direct_call",
      "status": "ok",
      "observation": {
        "decision": "resolved",
        "relationshipType": "CALLS",
        "callSite": {
          "file": "fixture/direct.ts",
          "span": {
            "startLine": 5,
            "endLine": 5,
            "startByte": 120,
            "endByte": 128,
            "startColumn": 4,
            "endColumn": 12
          },
          "text": "alias()"
        },
        "source": {
          "ref": "caller",
          "label": "run",
          "file": "fixture/direct.ts",
          "span": {
            "startLine": 4,
            "endLine": 6,
            "startByte": 100,
            "endByte": 140,
            "startColumn": 0,
            "endColumn": 1
          }
        },
        "target": {
          "ref": "target.primary",
          "label": "helper",
          "file": "fixture/helper.ts",
          "span": {
            "startLine": 1,
            "endLine": 1,
            "startByte": 0,
            "endByte": 20,
            "startColumn": 0,
            "endColumn": 20
          }
        },
        "alternatives": [],
        "mechanism": {
          "authority": "direct_binding",
          "strategy": "direct_call",
          "detail": "Imported alias binds directly to helper."
        },
        "evidence": [
          {
            "kind": "call_site",
            "subject": "alias()",
            "file": "fixture/direct.ts"
          },
          {
            "kind": "alias_binding",
            "subject": "alias -> helper",
            "file": "fixture/direct.ts"
          },
          {
            "kind": "target_provenance",
            "subject": "helper",
            "file": "fixture/helper.ts"
          }
        ],
        "unresolvedEvidence": []
      },
      "measurements": [
        {
          "wallMs": 4.2,
          "cpuUserMs": 2.1,
          "cpuSystemMs": 0.4,
          "peakRssBytes": 50000000,
          "inputBytes": 900,
          "outputBytes": 1300
        }
      ]
    }
  ],
  "runMeasurements": [
    {
      "wallMs": 52.1,
      "cpuUserMs": 31.2,
      "cpuSystemMs": 4.9,
      "peakRssBytes": 70000000
    }
  ]
}
```

Every `status: "ok"` observation must include an exact call-site span and exact source symbol location. Exact resolved or candidate-set oracle cases identify the canonical refs supplied by their corpus case. Observation-only cases intentionally have no canonical target truth and may report whichever identity the provider observes. Ambiguous observations should put competing canonical refs in `alternatives` when the oracle supplies them. Unsupported cases must be emitted explicitly with `status: "unsupported"`, an `unsupportedReason`, and concrete `unsupportedEvidence`; omission remains visible as `missing` coverage rather than being treated as support.

The accepted mechanism authorities are `direct_binding`, `origin_flow`, `heuristic_reference`, `ambiguous`, `unresolved`, `unsupported`, and `unknown`. The accepted strategies are `direct_call`, `type_dispatch`, `embed_dispatch`, `interface_dispatch`, `inheritance_dispatch`, `overload_resolution`, `dynamic_dispatch`, and `unknown`.

Evidence atoms use the lab's neutral vocabulary: `call_site`, `caller_identity`, `direct_symbol_binding`, `alias_binding`, `receiver_type`, `constructor_origin`, `assignment_origin`, `field_origin`, `flow_hop`, `inheritance`, `interface_contract`, `overload_candidate`, `branch_origin`, `target_provenance`, `candidate_set`, `ambiguity`, `unresolved_dependency`, `dynamic_construct`, `optional_receiver`, and `provider_specific`.

## Run deterministic + performance qualification

No Jev credential is needed:

```sh
node scripts/jev-retrieval-lab.mjs \
  --mode relationship \
  --report /path/to/provider-report.json \
  --out /path/to/qualification.json \
  --deterministic-only
```

The deterministic section reports:

- provider coverage: ok, unsupported, error, missing, and ok rate;
- decision exactness and relationship-type exactness;
- semantic exactness: for exact relationship cases, decision + relationship type + exact target/abstention + exact candidate set + decoy avoidance; for exact unsupported cases, the explicit unsupported status;
- strict case exactness: semantic exactness + accepted mechanism/evidence requirements; exact unsupported cases additionally require the configured unsupported evidence kinds;
- authority agreement, strategy agreement, and evidence-contract exactness;
- safe-abstention exactness for ambiguous/unresolved cases;
- candidate-set exactness and ambiguous-candidate exactness;
- exact unsupported-boundary correctness;
- wrong-target decoy avoidance and decoy-hit count;
- false-resolved count and wrong-target count;
- resolved-target true positives, false positives, false negatives, precision, recall, and F1.

Performance/resource measurements stay in their own section. For any supplied metric, the lab reports sample count, min, max, mean, p50, and p95. Supported measurements are wall time, user CPU time, system CPU time, peak RSS, input bytes, and output bytes; user + system CPU is also summarized as total CPU time.

## Run blind Jev qualification

Set `TYPESAFE_API_KEY` and omit `--deterministic-only`:

```sh
TYPESAFE_API_KEY=... node scripts/jev-retrieval-lab.mjs \
  --mode relationship \
  --report /path/to/provider-report.json \
  --out /path/to/qualification.json \
  --repeats 2
```

Jev receives only the case scenario and normalized provider observation. Provider identity/version, incumbent or baseline status, expected target truth, decoy labels, deterministic scores, and performance/resource measurements are excluded. Canonical scoring refs such as `target.primary` and `target.decoy` are remapped to neutral symbol IDs before the prompt is built.

Jev reports these qualitative dimensions independently of deterministic correctness:

- `evidence_sufficiency`;
- `relationship_usefulness`;
- `resolution_mechanism_quality`;
- `mechanism_classification`;
- for ambiguous, unresolved, or unsupported results: `ambiguity_unsupported_quality` and `actionable_unresolved_evidence`.

## Adapter handoff for Agent T and Agent P

Agent T and Agent P do not need to change this scorer. Each should provide a thin language/provider adapter plus fixtures for all corpus case IDs. The adapter must map its provider-native result into the report contract above, including canonical target/candidate refs, normalized evidence atoms, exact source/call/target spans, and optional performance samples.

Agent T should emit a TypeScript-provider report; Agent P should emit a Python-provider report. If either provider genuinely cannot represent a corpus case, it may return an explicit unsupported result with actionable evidence. Overlay cases may also be omitted when a provider does not claim that overlay capability; omission remains visible as missing coverage. Provider-specific diagnostics can be carried as `provider_specific` evidence, but deterministic scoring depends only on the neutral contract.

The output report is then consumed unchanged by the same deterministic scorer, blind Jev evaluator, and performance summarizer used for every other provider. J1 report version 1 remains the report contract; overlays do not require a new provider-report version.

## Overlay corpus format

An overlay is another corpus-v1 JSON object. It keeps the same `family`, case shape, neutral evidence vocabulary, and provider-report case results, but adds top-level qualification metadata:

```json
{
  "version": 1,
  "family": "semantic_relationship_qualification",
  "relationship": "CALLS",
  "qualification": {
    "family": "language_development",
    "id": "python-development-v1",
    "language": "python",
    "description": "Python-specific development-visible qualification cases."
  },
  "cases": [
    {
      "id": "python.lexical_function_local_import",
      "construct": "lexical function-local import",
      "scenario": "A function-local import uniquely binds the called symbol.",
      "oracle": {
        "mode": "exact",
        "claim": "source_declaration"
      },
      "expected": {
        "decision": "resolved",
        "relationshipType": "CALLS",
        "targetRefs": ["target.local_import"],
        "candidateRefs": [],
        "forbiddenTargetRefs": ["target.decoy"],
        "authorities": ["direct_binding"],
        "strategies": ["direct_call"],
        "requiredEvidenceKinds": ["call_site", "direct_symbol_binding", "target_provenance"]
      }
    }
  ]
}
```

Overlay case IDs must be globally unique across the composed run. The qualification `family` and `id` are metadata, not scorer-specific semantics. Recommended families are `language_development`, `language_held_out`, and `real_repository_sample`; provider-specific overlays may also set `qualification.provider`. New families can be introduced without changing the scorer.

Compose zero or more overlays at runtime:

```sh
node scripts/jev-retrieval-lab.mjs \
  --mode relationship \
  --report /path/to/provider-report.json \
  --corpus evals/semantic-relationship-qualification/corpus.json \
  --overlay /path/to/python-development.json \
  --overlay /path/to/python-held-out.json \
  --overlay /path/to/python-real-repository-sample.json \
  --out /path/to/qualification.json \
  --deterministic-only
```

The provider report remains one version-1 report with one `cases` array. It may include common and overlay case IDs together. It does not need a new `corpusVersion` value merely because overlays were composed.

Useful Python overlays can cover lexical function-local imports, competing local imports, forward/string annotations, callback propagation, positional service flow, MRO overrides, decorator uncertainty, and callable objects. Useful TypeScript overlays can cover tsconfig/path aliases, structural-typing decoys, reassignment, nested control flow, interfaces with and without concrete origins, configured-project boundaries, project references, and generic receivers. Those language semantics live in their overlay oracle/scenario; they are not hardcoded into the central scorer.

## Oracle semantics

Every case has an oracle mode. Existing J1 cases omit `oracle` and therefore retain the exact relationship oracle by default:

```json
{
  "oracle": {
    "mode": "exact",
    "claim": "runtime_target"
  }
}
```

`claim` is an open evaluation label. The scorer does not switch on language-specific claim names. Common useful claims include `relationship`, `runtime_target`, `runtime_callable`, `source_declaration`, `candidate_evidence`, and `unsupported_dynamic`.

An exact unsupported boundary is evaluation semantics, not a fourth production `ResolutionDecision`:

```json
{
  "oracle": {
    "mode": "exact",
    "claim": "unsupported_dynamic"
  },
  "expected": {
    "resultStatus": "unsupported",
    "requiredEvidenceKinds": ["dynamic_construct", "unresolved_dependency"]
  }
}
```

The provider emits its normal report result with `status: "unsupported"`, an `unsupportedReason`, and matching `unsupportedEvidence`.

When the product contract has intentionally not chosen a target interpretation, use observation-only mode and omit `expected`:

```json
{
  "id": "python.decorator_replacement_uncertainty",
  "construct": "decorator replacement uncertainty",
  "scenario": "A decorator may replace a declared callable before a later call.",
  "oracle": {
    "mode": "observation_only",
    "claim": "callable_identity",
    "perspectives": ["source_declaration", "runtime_callable"],
    "description": "The product contract has not selected which callable identity is authoritative."
  }
}
```

This is the representation for a case such as `@replace def original(): ...; original()` while the source-level-versus-runtime-callable contract remains unsettled. The provider still reports its observed target/evidence, and Jev may judge evidence usefulness, but deterministic target correctness, strict-case correctness, target precision/recall, and decoy correctness do not score that case. The artifact reports it through `observationOnlyCases`.

## Qualification families and held-out workflow

A composed run tags every case with its qualification family. The common corpus defaults to `common/common-v1`; each overlay supplies its own `qualification.family` and `qualification.id`. Deterministic, qualitative, and performance outputs each retain family breakdowns.

This supports separate files for:

- the common 12-case corpus;
- a language-specific development-visible corpus;
- a language-specific held-out corpus;
- a real-repository sampled corpus.

Held-out is workflow separation, not cryptographic secrecy. Keep the held-out JSON outside the development path if desired and pass it only to qualification runs. A provider need not implement every overlay case: unsupported and missing cases remain explicit in that family's coverage.

## Multi-provider comparison

Compare completed qualification artifacts without invoking Jev again:

```sh
node scripts/semantic-relationship-comparison.mjs \
  --input /path/to/typescript-provider.json \
  --input /path/to/python-provider-a.json \
  --input /path/to/python-provider-b.json \
  --out /path/to/provider-comparison.json
```

The comparison artifact preserves three independent lanes.

The deterministic matrix includes coverage, semantic exactness, strict-case exactness, wrong-target count, false-resolved count, safe-abstention exactness, target precision/recall/F1, ambiguous-candidate exactness, reported/expected unsupported cases, and per-qualification-family rows. Precision and recall remain visible independently; the comparison does not select a winner or manufacture an overall score.

The qualitative lane carries each artifact's Jev status/model/repeats/summary without mixing it into deterministic truth. The performance lane carries supplied aggregate case/run resource measurements and family-specific case measurements without turning latency or resource use into a correctness score.

Legacy J1 artifacts without family breakdowns are treated as `common/common-v1`; their existing candidate-set metric is used as the ambiguous-candidate comparison fallback.

## Thin adapter guidance

T and P should not change the scorer for new syntax or language cases. A thin adapter should only:

1. execute its provider over the fixture or sampled repository;
2. map provider-native locations to exact `callSite`, `source`, `target`, and `alternatives`;
3. map provider-native proof facts into the existing neutral mechanism/evidence vocabulary;
4. emit `unsupported` explicitly when that is the provider's claimed capability boundary;
5. leave unsupported or unimplemented overlay cases missing when the run intentionally does not claim them;
6. attach optional performance samples.

If an overlay needs a semantic distinction that cannot be represented by an exact target/candidate oracle, exact unsupported oracle, or observation-only oracle, extend the evaluation schema generically before changing production relationship contracts.
