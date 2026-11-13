# Task index

| # | ID | Phase | Task | Depends | Repository |
|---:|---|---|---|---|---|
| 1 | B00 | Safe baseline and microtask runner | Capture exact baseline | START | pi |
| 2 | B01 | Safe baseline and microtask runner | Define static microtask manifest schema | B00 | pi |
| 3 | B02 | Safe baseline and microtask runner | Implement path allowlist matcher | B01 | pi |
| 4 | B03 | Safe baseline and microtask runner | Implement diff-scope and size validator | B02 | pi |
| 5 | B04 | Safe baseline and microtask runner | Create single-task bootstrap CLI wrapper | B03 | pi |
| 6 | B05 | Safe baseline and microtask runner | Add result gate and immutable handoff writer | B04 | pi |
| 7 | E01 | Error capture | Inventory all existing error sources | B05 | pi |
| 8 | E02 | Error capture | Define normalized error event types | E01 | pi |
| 9 | E03 | Error capture | Build deterministic error normalization | E02 | pi |
| 10 | E04 | Error capture | Add sanitization before durable error capture | E03 | pi |
| 11 | E05 | Error capture | Record normalized error occurrences per session | E04 | pi |
| 12 | E06 | Error capture | Capture worker/tool failures at single stable seam | E05 | pi |
| 13 | E07 | Error capture | Capture gateway and inference failures | E06 | pi |
| 14 | D01 | Read-only diagnosis | Read-only merged host error reader | E07 | pi |
| 15 | D02 | Read-only diagnosis | Stable cross-session error fingerprint | D01 | pi |
| 16 | D03 | Read-only diagnosis | Aggregate occurrences into issue clusters | D02 | pi |
| 17 | D04 | Read-only diagnosis | Classify recovery outcome accurately | D03 | pi |
| 18 | D05 | Read-only diagnosis | Read-only diagnose-errors CLI | D04 | pi |
| 19 | D06 | Read-only diagnosis | Register /diagnose-errors Pi command | D05 | pi |
| 20 | D07 | Read-only diagnosis | Produce bounded diagnostic evidence bundle | D06 | pi |
| 21 | D08 | Read-only diagnosis | Add bounded local-model diagnostic adapter | D07 | pi |
| 22 | T01 | Task discipline and drift | Persist canonical original task identity | D08 | pi |
| 23 | T02 | Task discipline and drift | Fail closed on dropped deny patterns | T01 | pi |
| 24 | T03 | Task discipline and drift | Constrain malformed-plan fallback | T02 | pi |
| 25 | T04 | Task discipline and drift | Improve goal keyword extraction | T03 | pi |
| 26 | T05 | Task discipline and drift | Surface required context omissions | T04 | pi |
| 27 | T06 | Task discipline and drift | Attach task authority to APS actions | T05 | pi |
| 28 | T07 | Task discipline and drift | Detect deterministic goal deviation signals | T06 | pi |
| 29 | T08 | Task discipline and drift | Carry authority through context handoff | T07 | pi |
| 30 | T09 | Task discipline and drift | Add scope-integrity result gate | T08 | pi |
| 31 | R01 | Safe recovery | Catalog current retry ownership by failure | T09 | pi |
| 32 | R02 | Safe recovery | Expose retry correlation ID across layers | R01 | pi |
| 33 | R03 | Safe recovery | Implement retry budget evaluator pure function | R02 | pi |
| 34 | R04 | Safe recovery | Add endpoint circuit-breaker state machine | R03 | pi |
| 35 | R05 | Safe recovery | Define idempotency classifier for recovery | R04 | pi |
| 36 | R06 | Safe recovery | Add read-only recovery recommendation engine | R05 | pi |
| 37 | R07 | Safe recovery | Enable one safe recovery behind opt-in | R06 | pi |
| 38 | R08 | Safe recovery | Record final resolution and regression evidence | R07 | pi |
| 39 | H01 | Herdr visualization | Inventory existing Herdr telemetry surfaces | R08 | herdr |
| 40 | H02 | Herdr visualization | Define normalized diagnostics view model | H01 | herdr |
| 41 | H03 | Herdr visualization | Add read-only host diagnostics transport adapter | H02 | herdr |
| 42 | H04 | Herdr visualization | Render error issue list | H03 | herdr |
| 43 | H05 | Herdr visualization | Render per-session error timeline | H04 | herdr |
| 44 | H06 | Herdr visualization | Render task drift comparison | H05 | herdr |
| 45 | H07 | Herdr visualization | Integrate diagnostics route into existing UI | H06 | herdr |
| 46 | V01 | Validation and rollout | Create benchmark task fixtures | H07 | pi |
| 47 | V02 | Validation and rollout | Create drift detector evaluation runner | V01 | pi |
| 48 | V03 | Validation and rollout | Create quantization benchmark recording schema | V02 | pi |
| 49 | V04 | Validation and rollout | Add isolated live benchmark command | V03 | pi |
| 50 | V05 | Validation and rollout | Add feature flag and rollback checklist | V04 | pi |
| 51 | V06 | Validation and rollout | Final cross-repo acceptance audit | V05 | pi |
