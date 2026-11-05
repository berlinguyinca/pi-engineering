# R03 — WORKER_REPORT

Task: implement the per-incident retry budget evaluator (`src/inference/retryBudget.ts`) plus its
property test (`test/unit/retry-budget.test.ts`), per
`docs/specs/harness-reliability-bootstrap-20261103/R03/HANDOFF.md`.

- Branch / worktree: `feat/r03-retry-budget` at `/Users/wohlgemuth/IdeaProjects/worktrees/pi-r03-retry-budget-20261107` (own worktree; no checkout mutation of the primary).
- Base: `ec19e5102cd057bc66242c06837c3f5f44a67472` (verified present as HEAD before the work; equals R02's `resultSha`).
- Commit produced: `389f678b8eed809bc74ff740e9b984263eb5fbe9` — `feat(inference): pure per-incident retry budget evaluator with bootstrap-mode refusal (R03)`.
- Parent handoff: `R02/R02.handoff.json` self-declares `handoffHash: sha256:d92f98bb7efd76cf1f74a590a29c8f0eaa8cad0425a01efcb9d5353ebd062f49`, `status: PASS`, `baseSha/resultSha` → `ec19e510…`, matching the contract. (The sha256 of the file *bytes* is `cd45c658512053e6be0d6b8b6cc5177d11b7fea66f75ead3660e069ac4867773`; the contract value is the canonical handoff hash, not the file hash — no discrepancy.)
- `node_modules` is a symlink to the primary checkout's, per repo policy (no reinstall).

## git diff --numstat ec19e5102cd057bc66242c06837c3f5f44a67472 HEAD

```
50	0	src/inference/retryBudget.ts
48	0	test/unit/retry-budget.test.ts
```

2 files, 98 added lines, 0 deleted — inside the ≤100-line / 2-file budget. No existing file changed
(`retryDelay.ts`, `retryTrace.ts` and every deny-listed path are untouched; `git status` is clean apart
from this intentionally untracked report).

## Verify (exact commands, exit codes)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (`typecheck:core` + `typecheck:scripts`) | 0 | clean |
| `node --test --import ./test/support/isolatedState.ts test/unit/retry-budget.test.ts` | 0 | 6 tests, 6 pass, 0 fail |

## Regression run

| Target | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `test/unit/retry-delay.test.ts` | — | — | **file does not exist at base or now** (`ls` reports No such file or directory) |
| `test/unit/retry-correlation.test.ts` | 5 | 5 | 0 |
| `test/unit/transient.test.ts` | 40 | 40 | 0 |
| both together (the contract's command) | 45 | 45 | 0 |
| `test/unit/inference-admission-delay.test.ts` (the nearest existing pin of `exponentialBackoffMs`) | 15 | 15 | 0 |

`grep -rl exponentialBackoffMs test` → `test/unit/inference-admission-delay.test.ts`,
`test/unit/retry-budget.test.ts`: the backoff math has no dedicated `retry-delay.test.ts`; R03's test now
asserts `waitMs === exponentialBackoffMs(attempt, 500, 4000)` for attempts 1..5, so the evaluator cannot
diverge from it.

## Decision ordering implemented (as in the source comment block)

1. `bootstrap_mode` — returned before any arithmetic, and before validation (a bootstrap incident with a
   broken budget still stops with `bootstrap_mode`).
2. `invalid_budget` — non-finite or negative `attempt`/`elapsedMs`, `maxAttempts < 1`, non-finite
   `baseBackoffMs`, plus any supplied `deadlineMs` / `maxBackoffMs` / `retryAfterMs` that is not a finite
   non-negative number (a broken bound is refused, never defaulted).
3. `attempts_exhausted` — `attempt >= maxAttempts` (so `attempt` beyond the ceiling is a stop, not a retry).
4. `deadline_exceeded` — `elapsedMs >= deadlineMs` for a supplied deadline.
5. `backoff_exceeds_deadline` — the wait for the next attempt exceeds `deadlineMs - elapsedMs`.
6. otherwise `{ action: "retry", waitMs, attempt }`.

`waitMs = Math.max(exponentialBackoffMs(attempt, baseBackoffMs, maxBackoffMs ?? +Infinity), retryAfterMs ?? 0)`:
local backoff comes only from `retryDelay.ts` (no second formula), is never negative, is capped by
`maxBackoffMs` when given, and equals `retryAfterMs` when the server wait dominates (server minima are not
clamped down, matching `retryDelay.ts` semantics).

## Purity and non-duplication evidence

- Only import in `src/inference/retryBudget.ts`: `./retryDelay.ts` (asserted in the test by scanning the
  module's own source and asserting the extracted `from "…"` list equals exactly `["./retryDelay.ts"]`).
- Test asserts the source text contains no `Date.now`, `Math.random`, `process.env`, `setTimeout` and no
  `import … from "../`; no clock/RNG/env/timer/telemetry/scheduler read exists — every time and bound is an
  argument, so the decision is a function of its input.
- Identity is not reinvented: no second identity scheme exists here; the incident key remains
  `RetryTrace.failure_id` from `retryTrace.ts` (R02). The contract's "Required shape" field list is exact, so
  no identity field was added; the module records the key's ownership in its header comment instead.
- No ceiling is hard-coded: gateway 8 / transient 4 / stream 4 / admission 50 / resume 3 / mission 3 arrive
  as `maxAttempts` data (RETRY_OWNERS.md is expressible as input, not constants).
- Not wired to any caller (deny-listed consumers untouched) — R03 is data + a pure function only.

## Tests written (one `it()` per contract property)

1. exhausted budget stops at `attempt === maxAttempts` and beyond it.
2. `maxAttempts: 1` never retries; bootstrap mode stops with a generous budget and still stops on invalid input.
3. `elapsedMs >= deadlineMs` → `deadline_exceeded`; just-under deadline with overshooting backoff →
   `backoff_exceeds_deadline`; same inputs with roomy deadline → `retry`.
4. `waitMs` for attempts 1..5 equals the imported `exponentialBackoffMs`, and `retryAfterMs: 9000` dominates at each.
5. determinism/purity (same input → same decision; 1000 mixed calls, multiset unchanged when repeated; source scan).
6. invalid budgets (`maxAttempts: 0`, `attempt: 0`, `elapsedMs: -1`, `baseBackoffMs: NaN`) all stop with
   `invalid_budget` and none produces `retry`.

## Notes / follow-ups (not in scope here)

- `test/unit/retry-delay.test.ts` is missing in this repo; a dedicated backoff-math test is a gap R03 exposed.
- Wiring (`src/guard/transient.ts`, `src/workers/PiWorkerExecutor.ts`, `src/orchestration/scheduler.ts`) is
  deliberately deferred and deny-listed for R03.
- `biome check` reformats long lines in dense R0x test files (the base files `retry-correlation.test.ts`,
  `transient.test.ts`, `retryTrace.ts` fail it too); the contract's gate is typecheck + `node --test`, both green,
  and the ≤100-line budget forces the dense style.
- This report is intentionally untracked (the gate stamps only clean worktrees); a byte-identical copy sits at
  the gitignored `docs/specs/harness-reliability-bootstrap-20261103/R03/WORKER_REPORT.md`.
