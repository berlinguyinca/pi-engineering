# R03 — Implement retry budget evaluator pure function

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/R03/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/R02/R02.handoff.json (sha256:d92f98bb7efd76cf1f74a590a29c8f0eaa8cad0425a01efcb9d5353ebd062f49, status PASS, resultSha ec19e5102cd057bc66242c06837c3f5f44a67472 = your base).
Base commit: ec19e5102cd057bc66242c06837c3f5f44a67472. Mode: isolated-change.

## Objective (plan delta, verbatim)
Evaluate max attempts, elapsed time, backoff bounds and exhaustion per incident; zero automatic retries in bootstrap mode.
Evidence: Exhausted budget stops, zero budget never retries.

## Read first — what already exists, so you extend instead of duplicating
- `docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md` (R01, at your base) is the catalog of every retry budget in this repo and its current ceiling: gateway `maxRetries: 8` (`src/gateway/config.ts:69`), transient guard `maxAttempts: 4` (`src/guard/transient.ts:467`), `streamRetryMaxAttempts: 4` (`src/inference/resilienceConfig.ts:74`), admission `max_attempts: 50` (`src/inference/admissionConfig.ts:97`), stream resume 3 (`src/inference/streamResume.ts:52`), mission `max_attempts ?? 3` (`src/orchestration/missionStore.ts:1686`). Your evaluator must be able to **express** these ceilings as data; it must not hard-code any of them or import any of those modules.
- `src/inference/retryDelay.ts` already owns backoff **math**: `exponentialBackoffMs(attempt, baseBackoffMs, maxBackoffMs)` (line 89, `base * 2^(attempt-1)`, capped) and the `RetryDelayBounds` interface (line 43: `maxDelayMs`, optional `maxBackoffMs`, `jitterRatio`). **Import and use it — do not write a second backoff formula.**
- `src/inference/retryTrace.ts` owns failure identity and the per-layer trace (R02/E07): `failureIdentity(input)` (`:92`), `RetryTrace` (`:34`), `actingLayers` (`:58`). Your budget decision is **per incident**, so take the incident's `failure_id` (or the `FailureIdentityInput`) as the budget key and never invent a second identity scheme.
- There is **no** bootstrap-mode flag anywhere in `src` (verified: no `bootstrapMode` / `BOOTSTRAP_MODE` / `bootstrap_mode` symbol). So bootstrap mode is an **input field of your evaluator**, not a global or env read.

## Scope (hard limits)
- Production file 1: `src/inference/retryBudget.ts` (**new**).
- Test file 1: `test/unit/retry-budget.test.ts` (**new**).
- Nothing else. `src/inference/retryDelay.ts`, `src/inference/retryTrace.ts`, `src/gateway/**`, `src/guard/**`, `src/orchestration/**`, `src/workers/**`, `src/runtime/**`, `src/plannerWorker/**`, `src/errors/**`, `src/incidents/**`, everything under `scripts/**`, `templates/**`, `manifests/**`, `test/support/**`, `package.json` and `.gitignore` are denied. Total changed lines ≤ 100, at most 2 production and 2 test files.
- **Pure function only**: no I/O, no timers, no `Date.now()`, no `Math.random()`, no env reads, no scheduler/telemetry imports. Every time input arrives as an argument (an injected clock, or explicit `elapsedMs` / `deadlineAtMs` plus a `nowMs` you are handed); every bound arrives as an argument. Jitter, if you expose it at all, must be caller-supplied — the same input must always give the same output.
- **Do not wire this into any caller.** No existing file may change: consumers (`src/guard/transient.ts`, `src/workers/PiWorkerExecutor.ts`, `src/orchestration/scheduler.ts`) are out of scope for this unit and are deny-listed.

## Required shape (name things exactly, keep it small)
`export interface RetryBudgetInput` with: `maxAttempts: number` (1-based total attempts allowed, so 1 means "no retry"), `elapsedMs: number`, `deadlineMs?: number` (total budget for the incident), `attempt: number`, `baseBackoffMs: number`, `maxBackoffMs?: number`, `retryAfterMs?: number` (server-advertised wait), `mode?: "bootstrap" | "normal"` (absent means normal).
`export type RetryBudgetDecision` = `{ action: "retry"; waitMs: number; attempt: number } | { action: "stop"; reason: RetryBudgetStopReason }` with `RetryBudgetStopReason` = `"attempts_exhausted" | "deadline_exceeded" | "backoff_exceeds_deadline" | "bootstrap_mode" | "invalid_budget"`.
`export function evaluateRetryBudget(input: RetryBudgetInput): RetryBudgetDecision`.
Decide in this order and say so in one short comment block: bootstrap mode → stop (before any arithmetic); invalid budget (non-finite or negative `attempt`/`elapsedMs`, `maxAttempts < 1`, non-finite `baseBackoffMs`) → `invalid_budget`; attempt already at/above `maxAttempts` → `attempts_exhausted`; `elapsedMs` at/over a supplied `deadlineMs` → `deadline_exceeded`; the backoff for the next attempt (via `exponentialBackoffMs`, honouring `maxBackoffMs`, and honouring a server `retryAfterMs` when it is **larger**) would overshoot the remaining deadline → `backoff_exceeds_deadline`; otherwise `retry` with `waitMs` = that backoff (never negative, never above `maxBackoffMs` when given, and equal to `retryAfterMs` when the server wait dominates).

## Write tests for exactly these properties (one `it()` per property, dense, no narrative comments)
1. **Exhausted budget stops.** `maxAttempts: 3, attempt: 3` → `{action: "stop", reason: "attempts_exhausted"}`; and `attempt: 4` gives the same stop (an attempt beyond the ceiling is not a retry).
2. **Zero budget never retries.** `maxAttempts: 1` at `attempt: 1` → stop with `attempts_exhausted`; `mode: "bootstrap"` with a generous budget (`maxAttempts: 8`, `attempt: 1`, no deadline) → `{action: "stop", reason: "bootstrap_mode"}` — and bootstrap mode still stops when the budget input is invalid (mode check precedes validation).
3. **Elapsed time and deadline are honoured.** `elapsedMs` ≥ `deadlineMs` → `deadline_exceeded`; a just-under deadline with a backoff that would overshoot the remainder → `backoff_exceeds_deadline`; the same inputs with a roomy deadline → `retry`.
4. **Backoff bounds come from retryDelay, not from a local formula.** With `baseBackoffMs: 500`, `maxBackoffMs: 4000`: assert `waitMs` at attempts 1..5 equals `exponentialBackoffMs(attempt, 500, 4000)` imported from `../src/inference/retryDelay.ts` (so the evaluator cannot silently diverge), and that a `retryAfterMs: 9000` dominates `waitMs` at every one of those attempts.
5. **Determinism and purity.** Same input twice → identical decision object; call the function 1000 times over a mixed input set and assert the multiset of decisions is unchanged when repeated (no RNG, no clock); the module imports nothing but `retryDelay.ts` and `node:assert`-free (assert the import list by reading the file's own source text with `readFileSync` on `src/inference/retryBudget.ts` and checking it contains no `Date.now`, `Math.random`, `process.env`, `setTimeout` or `import ... from "../`).
6. **Invalid budgets are refused, never guessed.** `maxAttempts: 0`, `attempt: 0`, `elapsedMs: -1`, `baseBackoffMs: Number.NaN` → `{action: "stop", reason: "invalid_budget"}` — none of them may produce `{action: "retry"}`.

## Verify (must be green at the commit you produce)
1. `npm run typecheck`
2. `node --test --import ./test/support/isolatedState.ts test/unit/retry-budget.test.ts`
Then prove nothing regressed and report the counts: `node --test --import ./test/support/isolatedState.ts test/unit/retry-delay.test.ts test/unit/retry-correlation.test.ts test/unit/transient.test.ts` (if a listed file does not exist, say so and report the rest).

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat ec19e5102cd057bc66242c06837c3f5f44a67472 HEAD`, exit codes for both verify commands, the regression run's pass/fail counts, and the exact decision ordering you implemented. Commit as `feat(inference): pure per-incident retry budget evaluator with bootstrap-mode refusal (R03)`.
