# R06 — Read-only recovery recommendation engine (WORKER_REPORT)

Base `62f190ff77c2` (R05 handoff `sha256:e2ab3140e7bdbb3d8b47b9f7ed399776b0b220dc9bea4c12f74428f7008c32e9`, status PASS).
Commit `16d35ecb` on `feat/r06-recovery-recommend`: `feat(incidents): read-only recovery recommendation engine composing budget, circuit and replay safety (R06)`.
Parent spec: `docs/specs/harness-reliability-bootstrap-20261103/R06/HANDOFF.md`.

## Diff (must stay inside 100 changed lines / 2 files)

```
$ git diff --numstat 62f190ff77c2 HEAD
47	0	src/incidents/recoveryRecommend.ts
52	0	test/unit/recovery-recommend.test.ts
```

2 files changed, 99 insertions(+), 0 deletions(-). No denied file was touched (`git status --porcelain` showed exactly the two new paths before commit). This report is deliberately left untracked so the diff stays inside the two-file budget; the `node_modules` symlink in this worktree points at the primary checkout's install and is `.gitignore`d.

## Verification (green at `16d35ecb`)

| command | exit |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | **0** |
| `node --test --import ./test/support/isolatedState.ts test/unit/recovery-recommend.test.ts` | **0** — 6 tests, 6 pass, 0 fail |

Per-suite regressions (same isolated-state loader, each run separately):

| suite | exit | tests | pass | fail |
| --- | --- | --- | --- | --- |
| `test/unit/recovery-safety.test.ts` (R05) | 0 | 6 | 6 | 0 |
| `test/unit/endpoint-circuit.test.ts` (R04) | 0 | 6 | 6 | 0 |
| `test/unit/retry-budget.test.ts` (R03) | 0 | 6 | 6 | 0 |

`npm run lint` (biome) already fails repo-wide at this base and was not chased, per the handoff.

## Decision order as implemented (`recommendRecovery`)

1. **invalid_input** — missing/non-object `failure`, non-finite `nowMs`, or a `class` outside the `InferenceFailureClass` union (checked against a `Record<InferenceFailureClass, true>` mirror that fails the build if `failureClassifier.ts` drifts; `Object.hasOwn` so `"toString"` is not a class) → `stop` / `invalid_input` / `waitMs: null` / `source: "input"`.
2. **permanent_class** — `PERMANENT_CLASSES` (`authentication`, `authorization`, `billing`, `invalid_request`, `model_not_found`, `request_too_large`) → `stop` / `permanent_class` / `source: "class"` regardless of budget, circuit or switch: the "404 does not endlessly retry" clause.
3. **unclassified** — `unknown` → `stop` / `unclassified` / `source: "class"`.
4. **server-wait hold** — `rate_limited` / `queue_saturated` / `model_activating`: the wait is `evaluateRetryBudget`'s, and the advertised floor handed to R03 is the larger of `failure.retryAfterMs` and `budget.retryAfterMs` (finite, ≥ 0 only), so R03's own larger-of rule decides; `stop` / `budget_exhausted` whenever R03 stops, else `hold` with `reason: "server_wait"` when a wait was advertised (`within_budget` when it was not).
5. **circuit** — when `circuit` is supplied, `evaluateEndpointCircuit` is asked with the snapshot's own failure memory (`threshold = max(1, consecutiveFailures)`) and `RECOVERY_CIRCUIT_COOLDOWN_MS`: `allowAttempt: false` + `switchAvailable: true` → `failover` / `circuit_open`; otherwise `allowAttempt: false` → `stop` with the gate's own reason (`no_probe_slot` for `probe_in_flight`, `circuit_open` for a blocked endpoint). A gate that grants its one probe (`allowAttempt: true`) is the caller's attempt, not a recommendation from here. Retry is unreachable behind any `allowAttempt: false`.
6. **not_replayable review** — `classifyReplaySafety(action).replayAllowed !== true` → `review` / `not_replayable` / `source: "recoverySafety"`; a provably read-only action falls through.
7. **budget** — `evaluateRetryBudget` → `retry` with its `waitMs` (`within_budget`, `source: "retryBudget"`) or `stop` / `budget_exhausted`. An absent `budget` is `NO_GRANT` (`maxAttempts: 1, attempt: 1`), so no grant never produces `retry`.

Read-only by construction: the only imports are the `InferenceFailureClass` type plus the three pure siblings (`retryBudget.ts`, `endpointCircuit.ts`, `recoverySafety.ts`); no clock, RNG, timer, env, fs, telemetry, transport or session; `nowMs` is data. Test 6 asserts the four-import limit, the exact permitted specifiers, and the absence of `Date.now`, `Math.random`, `process.env`, `setTimeout`, `setInterval`, `fetch`, `writeFile`, `appendFile`, `console.`, and that the whole 504-combination table (21 classes × circuit × switch × action × budget) never retries behind a closed gate, without a grant, or for a non-replayable action — permanent classes only ever stop.

## How this differs from `classifyRecoveryOutcome` and `InferenceFailureAction`

`classifyRecoveryOutcome` (`src/incidents/recoveryOutcome.ts`, not imported here) is a durable, post-hoc verdict: it reads allowlisted completion records, suppression records and retry traces dated against a failure and answers *whether an incident recovered, is unresolved, was suppressed, or is unknown* — proof about the past, whose inputs are ledger events. `InferenceFailureAction` (`src/inference/failureClassifier.ts`, imported here as a type only) is the recovery-ladder step implied by a *class alone*: 429 says `honor_retry_after`, a stale route says `refresh_catalog_retry`, quota says `fallback`. Neither of those can say what to do *now*: the ladder step ignores whether this incident still has an attempt, whether the endpoint's circuit is open, or whether the action being retried writes. `recommendRecovery` answers exactly that — a forward-looking, side-effect-free recommendation over the class **and** the mutable-ish state handed in as data (R03's budget, R04's circuit snapshot, R05's replay safety). That is why its vocabulary is `retry | hold | failover | stop | review` rather than outcome kinds or ladder steps: `failover` exists only because a circuit and a comparable switch are in scope, and `review` exists only because a non-replayable action must never be re-executed automatically — the "retry happened anyway" condition `RetryTrace.failureIdentity` (R02) exists to expose. It never executes, schedules or records anything; a caller acts on the recommendation, and the durable record of whether that acted-on recovery helped remains `RecoveryOutcome`'s answer, not this one's.

## Judgement calls against the handoff text

- **`hold` carries `source: "retryBudget"`, `reason: "server_wait"`.** The decision-order prose says `source: "server_wait"`, but the normative `RecoveryRecommendResult` union has no `server_wait` member (`source` names which primitive answered: `retryBudget | endpointCircuit | recoverySafety | class | input`). The wait is literally R03's output, so `source: "retryBudget"` is the truthful value and `server_wait` is asserted as the `reason` (test 2). The type union was kept exactly as specified.
- **`failover` precedes `no_probe_slot`.** An open circuit past its cooldown whose probe is already in flight is the only gated past-cooldown snapshot (`evaluateEndpointCircuit` returns `allowAttempt: true` for a free probe slot), so the two clauses overlap. With a switch available the answer is `failover` / `circuit_open`; with none, the more specific `no_probe_slot` names the blocker. Both `allowAttempt: false` snapshots inside the assumed cooldown give the handoff's pair — `failover` with a switch, `stop` / `circuit_open` without (test 4).
- **`RECOVERY_CIRCUIT_COOLDOWN_MS = 60_000`** is exported rather than invented per call: `cooldownMs`/`threshold` are the caller's policy and are not part of `RecoveryRecommendInput`, so the gate is asked with the snapshot's own failure memory and a conservative cooldown. The bias is one-way — this unit can only ever be *stricter* than the caller's own gate, never grant an attempt the caller's circuit would refuse, and never take the single probe on a caller's behalf.
- **Absent `budget` means no grant** (`attempt 1 of maxAttempts 1` → `stop` / `budget_exhausted`), never an unbounded retry; asserted in the test 6 table (`no-budget` half of the 504 combinations).
- `failure` is typed optional so a missing failure is `invalid_input` (property 3) instead of a crash.
