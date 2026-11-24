# Phase 4A and 4B stabilization decisions, 24 November 2026

## Phase 4A A/B gate

Pueue task 20 completed the Pi run against revision `40de01fb` and the
working-tree experiment. The control, A5 hydration, and A1 text arms each
passed all nine strict checks across three tasks and three repetitions.
Neither treatment passed the overall gate.

| Treatment | Input tokens vs. control | Wall time vs. control | Visible tool bytes vs. control | Overall gate |
|---|---:|---:|---:|---|
| A5 hydration | +11.7% | +9.0% | +5.7% | Failed input-token budget and lacked complete sufficiency measurements |
| A1 text | +5.6% | −11.7% | +39.4% | Failed visible-byte budget and lacked complete sufficiency measurements |

Keep both `hydrateExact` and `SATORI_RECOMMEND_TEXT_READS` off by default.
A5 used 42.8% fewer input tokens on `known-exact-target` and 10.9% fewer on
`known-exact-small-target`. The missing sufficiency measurements limit what
these results say about time and calls to verified evidence. The three-repeat
experiment does not establish the source of the aggregate token regression.

The run used the scorer available on November 24. The new exploratory
span-endpoint requirement applies to subsequent runs. The frozen v4
acceptance manifest still schedules 40 runs. The small-target task uses the
separate exploratory manifest.

## Phase 4B measurements

The November 24 profiling run observed a 10–14 s warm-restart search penalty
before the watcher became ready. A full source comparison re-hashed 1,368
files in 8.55–9.87 s per observed call. After readiness, exact queries took
11–47 ms and semantic queries 210–380 ms. The initial completion-proof
validation took 3,003–3,479 ms, and the first semantic rerank took 4,404 ms.
The cold index spent 90.4 s between 90% and 98%. These observations are the
baseline for a separate performance pass.

## CBM release boundary

Dart spans with a comment between a function signature and its body remain
deferred to the next CBM WASM rebuild. The atomic bundle exchange requires
GNU Coreutils 9.5 or later and a filesystem that supports atomic exchange.
The package build and CBM manifest checks consume existing artifacts.
The build-script integration test exercises the exchange.

The GitHub `ubuntu-latest` runner migration to Ubuntu 26.04 was scheduled to
complete on November 19. The published 26.04 image lists Coreutils 9.5.
[Runner migration](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/),
[Ubuntu 26.04 runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2604-Readme.md),
[GNU mv 9.5 source](https://github.com/coreutils/coreutils/blob/v9.5/src/mv.c).
