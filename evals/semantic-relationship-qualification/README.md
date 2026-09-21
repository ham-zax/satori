# Semantic Relationship Qualification Lab

This lab compares relationship-resolution providers against one provider-neutral evidence contract. It is evaluation-only: Jev is a qualitative judge here and is **not** an authoritative runtime `CALLS` provider.

The corpus is `evals/semantic-relationship-qualification/corpus.json`. It currently contains 12 cases covering direct calls, class-field receivers, constructor parameter properties, constructor assignment/origin flow, aliases, optional receivers, inheritance, interface dispatch, overload ambiguity, branch-conflicted origins, unresolved/dynamic constructs, and wrong-target decoys.

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

Every `status: "ok"` observation must include an exact call-site span and exact source symbol location. Resolved observations must identify the canonical target ref from the corpus. Ambiguous observations should put the competing canonical refs in `alternatives`. Unsupported cases must be emitted explicitly with `status: "unsupported"`, an `unsupportedReason`, and concrete `unsupportedEvidence`; do not silently omit them.

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
- semantic exactness: decision + relationship type + exact target/abstention + exact candidate set + decoy avoidance;
- strict case exactness: semantic exactness + accepted authority + accepted strategy + all required evidence kinds;
- authority agreement, strategy agreement, and evidence-contract exactness;
- safe-abstention exactness for ambiguous/unresolved cases;
- candidate-set exactness;
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

Agent T should emit a TypeScript-provider report; Agent P should emit a Python-provider report. If either provider genuinely cannot represent a corpus case, it should return an explicit unsupported result with actionable evidence rather than fabricate a relationship or omit the case. Provider-specific diagnostics can be carried as `provider_specific` evidence, but deterministic scoring depends only on the neutral contract.

The output report is then consumed unchanged by the same deterministic scorer, blind Jev evaluator, and performance summarizer used for every other provider.
