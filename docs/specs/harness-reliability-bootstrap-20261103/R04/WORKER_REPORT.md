# R04 — Worker report: pure endpoint circuit state machine

Branch `feat/r04-endpoint-circuit`, base `389f678b8eed809bc74ff740e9b984263eb5fbe9`, parent handoff
`docs/specs/harness-reliability-bootstrap-20261103/R03/R03.handoff.json`
(sha256:85724fdd4105bd973b4e3a0d4f4423f57959af7361dc3d089e9f32a3f69d7bd2).

Commit: `feat(inference): pure endpoint circuit state machine with bounded keys and single-probe cooldown (R04)`.

## Diff against base (`git diff --numstat 389f678b8eed809bc74ff740e9b984263eb5fbe9 HEAD`)

```
44	0	src/inference/endpointCircuit.ts
56	0	test/unit/endpoint-circuit.test.ts
```

100 added lines, 0 deleted, 2 files (both new). Nothing else changed; the deny-listed paths
(`src/resilience/**`, `src/models/**`, `retryBudget.ts`, `retryTrace.ts`, `retryDelay.ts`,
`src/guard/**`, `test/support/**`, `package.json`, …) are untouched, and nothing is wired — no
existing module imports `endpointCircuit.ts`.

## Verification (exit codes at the commit produced)

| command | exit | result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | 0 | clean |
| `node --test --import ./test/support/isolatedState.ts test/unit/endpoint-circuit.test.ts` | 0 | 6 tests, 6 pass, 0 fail |

Per-suite regressions (same `--import ./test/support/isolatedState.ts` loader, run separately):

| suite | exit | tests | pass | fail |
| --- | --- | --- | --- | --- |
| `test/unit/retry-budget.test.ts` | 0 | 6 | 6 | 0 |
| `test/unit/retry-correlation.test.ts` | 0 | 5 | 5 | 0 |
| `test/unit/transient.test.ts` | 0 | 40 | 40 | 0 |

`npm run lint` (biome) already fails repo-wide at this base and was not chased, per the handoff.

## Transition table implemented (`evaluateEndpointCircuit`)

| snapshot state | condition | decision state | allowAttempt | probe | returned snapshot | reason |
| --- | --- | --- | --- | --- | --- | --- |
| any | `nowMs` non-finite, `threshold < 1` / non-finite, `cooldownMs < 0` / non-finite, unknown `state` | `open` if the state is unknown, else the snapshot's own state | false | false | the **same object**, unchanged | `invalid_input` |
| closed | success | closed | true | false | `consecutiveFailures` 0, `openedAtMs` null, `probeInFlight` false, `observedAtMs = nowMs` | `closed` |
| closed | failure, streak + 1 < threshold | closed | true | false | `consecutiveFailures` +1 (clamped to `threshold`) | `closed` |
| closed | failure, streak + 1 ≥ threshold | open | false | false | `consecutiveFailures = threshold`, `openedAtMs = nowMs`, `probeInFlight` false | `opening` |
| closed | neither outcome | closed | true | false | streak preserved, `openedAtMs` null | `closed` |
| open | `nowMs - openedAtMs < cooldownMs`, no outcome | open | false | false | unchanged apart from `observedAtMs` | `cooldown_pending` |
| open | `nowMs - openedAtMs < cooldownMs`, failure reported | open | false | false | `openedAtMs` unchanged (cooldown does not restart) | `opened` |
| open | cooldown elapsed (`openedAtMs` null counts as elapsed) | → half_open branch | | | | |
| half_open | neither outcome, `probeInFlight` false | half_open | true | true | `probeInFlight` true, `openedAtMs` kept (or `nowMs` if absent) | `probe_allowed` |
| half_open | neither outcome, `probeInFlight` already true | half_open | false | false | unchanged apart from `observedAtMs` | `probe_in_flight` |
| half_open | success | closed | true | false | `consecutiveFailures` 0, `openedAtMs` null, `probeInFlight` false | `probe_success` |
| half_open | failure | open | false | false | `openedAtMs = nowMs` (cooldown restarts), `consecutiveFailures = threshold`, `probeInFlight` false | `probe_failure` |

`consecutiveFailures` is clamped into `[0, threshold]` in every returned snapshot. `noteEndpointKey(keys,
id, max = ENDPOINT_CIRCUIT_MAX_KEYS = 64)` appends (no duplicate) and, past `max`, returns
`next.slice(next.length - max)` — FIFO eviction, always a new array. The module has zero imports and reads
no `Date.now`, `Math.random`, `process.env`, `setTimeout` or network call; `nowMs` is the only clock.

## Relation to the existing `CircuitBreaker` (no import, no modification)

`src/resilience/circuitBreaker.ts` (held by `MissionSupervisor` as `this.breaker`, gated around its
retry loop with `tryHalfOpen()` / `recordSuccess()` / `recordFailure()`) is one breaker for one mission's
supervisor: mutable private fields (`state`, `consecutiveFailures`, `openedAtMs`, `halfOpenAfterMs`), its
own `now: () => number` defaulting to the wall clock, and a `halfOpenAfterMs` derived internally from
`openCooldownMs` (default threshold 5, cooldown 10 000 ms). Mine keeps the same three-state vocabulary and
the same essential discipline — a threshold of consecutive failures opens, an open breaker admits nothing
until its cooldown elapses, half-open admits exactly one real request, success closes and a failed probe
reopens with a fresh cooldown — but expresses it as `closed` / `open` / `half_open` data in an immutable
`EndpointCircuitSnapshot` keyed by `endpointId`, with the clock, threshold and cooldown supplied per call as
arguments. Where the mission breaker's `tryHalfOpen()` mutates so a failed real request reopens rather than
storms, my equivalent is `probeInFlight` set in the `probe_allowed` decision: the caller must feed the
returned snapshot back in, and a second concurrent probe then reads `probe_in_flight` with `allowAttempt`
false. Because the caller owns the snapshots (and `noteEndpointKey` bounds how many endpoint ids it tracks),
this decides only whether an endpoint may be attempted at all — it grants no retry, so it does not become a
third 404 retry-count site alongside `src/guard/transient.ts` and `src/inference/recovery.ts`.
