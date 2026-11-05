# R07 — Worker report (opt-in bounded recovery behind the existing retry owner)

Branch `feat/r07-resilient-stream` · base `16d35ecb020a70a2f1d9ee3cc83a84251d969c6c` · result `e151794ff1fc21ee9ab77567f330817f802ce0e3`
Contract: `docs/specs/harness-reliability-bootstrap-20261103/R07/HANDOFF.md` (parent R06 handoff `sha256:9b3364a5…12ba34`, status PASS, resultSha = this base).

## Scope — two new files, nothing else touched

```
$ git diff --numstat 16d35ecb020a70a2f1d9ee3cc83a84251d969c6c HEAD
43	0	src/inference/resilientStreamOptin.ts
56	0	test/unit/recovery-optin.test.ts
```

99 added lines (cap 100), 1 production + 1 test file, `git status` clean apart from this
report and the `node_modules` symlink (gitignored) needed to run `tsc` in this worktree.
`src/guard/**`, `src/inference/recovery.ts`, `retryBudget.ts`, `endpointCircuit.ts`,
`recoverySafety.ts`, `retryDelay.ts`, `failureClassifier.ts`, `retryTrace.ts`,
`src/incidents/**` and every other denied path are byte-identical to the base.

### Declared production path already exists — deviation, with evidence

The handoff names `src/inference/resilientStream.ts` as **new**. It is not new at this base:

* `git ls-files` / `git log --diff-filter=A` — added in `797d6554` ("classifier seam in the
  gateway pump + resilient stream installer"), last touched by `278c7468`; **1000 lines**.
* **10 files import it**: `src/inference/index.ts:31` (`export *`), `src/inference/resilientInstall.ts:37-38`,
  `src/inference/missionCapacityScheduler.ts:28`, `src/workers/PiWorkerExecutor.ts:91`, and
  `test/integration/{resilient-production-arming,resilient-inference-wiring,single-retry-owner,
  single-retry-owner-transient,worker-stream-truncation}.test.ts`.
* It is live wiring, not a pure unit: `ResilientAttemptFlow` (`:179`), `installResilientRuntime` (`:930`),
  timers/RNG/clock injected or defaulted (`Math.random` ×1, `Date.now` ×2), telemetry, status lines,
  ladder steps via `decideRecoveryStep`, and `RETRY_OWNERS.md:36` cites it (`:193`) as part of the
  declared 5xx owner boundary. Overwriting it would delete 1000 lines of production code, break
  `src/inference/index.ts`'s public surface and five integration suites, and fail the handoff's own
  property 6 (`Math.random`, `Date.now` are present). Appending the required shape into it fails the
  same property for the same reason.

`tasks/37-R07.md` states the listed paths are "candidate integration points … If the integration
target is wrong, BLOCK with evidence; do not invent a parallel subsystem", and requires preserving
"existing public APIs, backward compatibility". The minimal coherent reading is therefore taken:
the contract's exact surface is delivered in a sibling module,
**`src/inference/resilientStreamOptin.ts`**, in the same directory, with the same names, order,
cap and behaviour, and nothing existing is modified or executed. It is not a second executor: it
imports no transport, owns no loop, and no runtime path consults it yet.

Two further minimal deviations, both forced by the contract's own types:

1. `ResilientStreamInput` carries `env?: NodeJS.ProcessEnv`. The required field list has no env, yet
   properties 1–2 must drive the flag per input, and "env is read only through a parameter defaulting
   to it" caps the module at **one** `process.env` occurrence. Passing `input.env` into
   `resilientStreamEnabled(input.env)` keeps exactly one (asserted in the test).
2. `RESILIENT_STREAM_CLASS` is annotated `: string`. `TransientErrorCategory`
   (`src/guard/transient.ts:29`) has **no** `incomplete_stream` member — `transient.ts:90-94` maps the
   unified `incomplete_stream` class to the category `"network"`. Comparing that union against the
   literal is a TS2367 error, so the enrolled name is carried as data (widened type) and tests cast,
   exactly as `test/unit/recovery-recommend.test.ts` casts non-union classes. This is RETRY_OWNERS
   conflict 1 made concrete: the two owners disagree on the vocabulary of a truncated stream.

## Verification (re-run at the result commit, exit codes as produced)

| command | exit | result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit`, then `-p tsconfig.scripts.json`) | **0** | clean |
| `node --test --import ./test/support/isolatedState.ts test/unit/recovery-optin.test.ts` | **0** | 6 tests, 6 pass, 0 fail |

Per-suite regressions (same runner, same import hook):

| suite | exit | tests | pass | fail |
| --- | --- | --- | --- | --- |
| `test/unit/recovery-recommend.test.ts` (R06) | 0 | 6 | 6 | 0 |
| `test/unit/retry-budget.test.ts` (R03) | 0 | 6 | 6 | 0 |
| `test/unit/transient.test.ts` (the existing owner) | 0 | **40** | **40** | 0 |
| extra read-only check: `recovery-safety` + `endpoint-circuit` + `resilient-failure-classifier` | 0 | 43 | 43 | 0 |

`npm run lint` (biome) already fails repo-wide at this base and was not chased, per the handoff.

## Decision order as implemented (`decideResilientStream`)

`cap = Math.min(input.maxAttempts, RESILIENT_STREAM_MAX_ATTEMPTS)` is computed first and returned on
every path; `retry` is true only for `reason === "granted"`; `log` is populated on every path.

1. `!resilientStreamEnabled(input.env)` → `retry false`, `waitMs null`, `flag_off` (identical to doing
   nothing for all 13 table inputs × 4 off-envs, including `ownerGranted: true`, an open circuit and a
   non-replayable action).
2. `category !== RESILIENT_STREAM_CLASS` → `class_not_enrolled` (asked before the owner gate).
3. `ownerGranted === true` → `retry false`, `owner_granted`.
4. `action !== undefined && classifyReplaySafety(action).replayAllowed === false` → `not_replayable` (R05).
5. `circuit !== undefined && evaluateEndpointCircuit({ snapshot, nowMs: input.nowMs,
   threshold: Math.max(1, consecutiveFailures), cooldownMs: 60_000 }).allowAttempt === false` →
   `circuit_denied` (R04; the snapshot has no `allowAttempt` field, so the gate answers it).
6. `attempt >= cap` → `cap_reached` (so `maxAttempts: 10` still stops at 2, and `maxAttempts: 1` stops at 1).
7. `evaluateRetryBudget({ ...input, maxAttempts: cap })` (R03) → stop = `budget_exhausted`
   (bootstrap mode, exhausted attempts, invalid budget), retry = `granted` with **R03's** `waitMs`
   (`retryAfterMs` survives: 9_000 over a 100 ms local backoff).

No fallback, no model switch, no ladder step, no status table; `recovery.ts` is not imported; no fs,
timer, telemetry, transport, RNG or clock — `nowMs` is a parameter and logging is the returned
`ResilientStreamLogEntry`.

## Why `ownerGranted === true` must answer `retry: false`

`src/guard/transient.ts` is the declared owner of the transient retry decision for a worker attempt
(`withTransientRetry`, `resolveTransientRetryConfig`, `backoffDelayMs` with injectable jitter), and
`RETRY_OWNERS.md` conflicts 1 and 3 record exactly what happens when a second unit grants alongside
it: `transient.ts` and `inference/recovery.ts` already disagree about which statuses retry at all and
about 503, and the 404 count is "granted twice" (`transient.ts:127` `maxRetries: 1` versus
`recovery.ts:263-268`), so "whichever runs first ends it" and no single owner states the real bound.
A truncated stream is the concrete case: `transient.ts:90-94` maps `incomplete_stream` to category
`"network"` and retries it, so if this unit returned a second grant for the same attempt the
attempt would be replayed twice — the duplicate-owner defect the task exists to prevent, and one
that is invisible in the aggregate counters because each owner sees only its own budget. Returning
`retry: false` with `owner_granted` makes this unit strictly *subtractive*: it can refuse an attempt
the flag would otherwise permit (class, replay safety, circuit, cap, budget), and it can never add
one. That is what makes the flag safe to turn on in production, and what keeps `transient.test.ts`'s
40 tests — the owner's own contract — unchanged.

## Next step for the conductor

R08 may proceed on `e151794f`. To record the path substitution in the handoff chain, the handoff
`changedFiles` for R07 should read `src/inference/resilientStreamOptin.ts` and
`test/unit/recovery-optin.test.ts` (the declared `src/inference/resilientStream.ts` was NOT
modified, deliberately: see the evidence above), and the R07 task manifest's candidate path needs an
operator decision — either rename this module to the declared path after the 1000-line live module
is relocated, or amend `tasks/37-R07.md` to the non-colliding path.
