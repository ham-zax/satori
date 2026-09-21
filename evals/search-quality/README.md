# Search-quality evaluation

This harness is the durable behavioral retrieval benchmark for Satori's search product contract.

## F2 behavioral-owner provenance

Relationship Evidence Recovery F2 searched repository history for the previously reported
`inferPhase` behavioral-owner fixture with both content pickaxe and regex history searches
(`git log --all -SinferPhase` and `git log --all -G inferPhase`). Neither search found a
historical repository fixture or benchmark case to replay directly.

The committed `behavioral_owner_infer_phase` workload is therefore the smallest durable
equivalent of that missing case. It models a behavioral question whose implementation owner
(`inferPhase`) is initially ranked behind a normalizer, caller/explainer, and orchestration
candidate. The acceptance criterion is product-facing owner recovery within the ordinary
top-3 budget, measured by the same search-quality harness as the rest of the corpus.

This benchmark is intentionally separate from semantic relationship qualification. A passing
relationship resolver qualification does not substitute for a passing behavioral retrieval
replay.
