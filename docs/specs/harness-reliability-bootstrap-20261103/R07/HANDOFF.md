# R07 — Enable one safe recovery behind opt-in

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/R07/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/R06/R06.handoff.json (sha256:9b3364a5187027ee7347dd4d2c4603b99a4542842cf5b1680c3d82bf2112ba34, status PASS, resultSha 16d35ecb020a70a2f1d9ee3cc83a84251d969c6c = your base).
Base commit: 16d35ecb020a70a2f1d9ee3cc83a84251d969c6c. Mode: isolated-change.

## Objective (plan delta, verbatim)
Integrate only one demonstrated idempotent retry class with feature flag default-off, existing retry owner, hard attempt cap; no other fallback changes.
Evidence: Flag off unchanged, on bounded and logged, duplicate owner prevented.

## Read first — the owner you must defer to, and the flag pattern to copy
- **The existing retry owner is `src/guard/transient.ts`** (`docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md` conflict 1: `transient.ts` and `src/inference/recovery.ts` disagree about which statuses retry at all; conflict 3: they disagree about 503; conflict 4: 404 counts are granted twice). Its public surface: `TransientErrorCategory` (`:29`), `classifyError` (`:172`), `isTruncatedStream` (`:408`), `BackoffConfig` (`:449`), `DEFAULT_TRANSIENT_RETRY_CONFIG` (`:462`), `resolveTransientRetryConfig` (`:471`, env-driven), `backoffDelayMs(attempt, config, rand)` (`:499`, rand **injectable**), `RetryOutcome<T>` (`:512`), `RetryOptions<T>` (`:523`) and the executor `retryOnce` used by `test/unit/transient.test.ts`. You may **import types from it and consume its decision as input**; you may not modify it, and you must not become a second executor.
- `src/inference/recovery.ts` is the *other* owner (`decideRecoveryStep` `:213`, `RecoveryStep` `:154`, `LadderBreaker` `:71`): do not import it, do not add a ladder step, do not touch fallback.
- The flag pattern to copy is env-injected-with-default, exactly as `resolveTransientRetryConfig(env)` (`:471`) and `resolveToolCallGuardConfig(env = process.env)` (`src/guard/toolCallGuard.ts:49`) do it: the **parameter** carries the env, the default is off.
- The primitives you compose (all pure, all at your base): `evaluateRetryBudget` (R03), `evaluateEndpointCircuit` (R04), `classifyReplaySafety` (R05), `recommendRecovery` (R06). `src/inference/retryDelay.ts` `exponentialBackoffMs` is available if you need backoff math, but R03 already returns `waitMs`.

## Scope (hard limits)
- Production file 1: `src/inference/resilientStream.ts` (**new**).
- Test file 1: `test/unit/recovery-optin.test.ts` (**new**).
- Nothing else may change. `src/guard/**`, `src/inference/recovery.ts`, `src/inference/failureClassifier.ts`, `src/inference/retryBudget.ts`, `src/inference/retryTrace.ts`, `src/inference/endpointCircuit.ts`, `src/inference/recoverySafety.ts`, `src/inference/retryDelay.ts`, `src/incidents/**`, `src/ledger/**`, `src/models/**`, `src/resilience/**`, `src/plannerWorker/**`, `src/gateway/**`, `src/workers/**`, `src/orchestration/**`, `src/runtime/**`, `src/scheduler/**`, everything under `scripts/**`, `templates/**`, `manifests/**`, `test/support/**`, `package.json` and `.gitignore` are denied. Total changed lines ≤ 100, at most 2 production and 2 test files.
- **One class only**: `incomplete_stream`. Any other `TransientErrorCategory` or `InferenceFailureClass` must be refused with `reason: "class_not_enrolled"`. No new fallback, no model switch, no catalog refresh, no ladder step, no status table.
- **No execution, no I/O**: no fs, no timers, no telemetry import, no transport, no `Math.random` (the owner owns jitter), no clock (`nowMs` is a parameter). Reading env happens **only** through an injected parameter with `process.env` as its default, matching the two resolvers above. Logging means **returning a structured entry**; nothing is written.

## Required shape (name things exactly, keep it small)
- `export const RESILIENT_STREAM_FLAG = "PI_RESILIENT_STREAM";`
- `export const RESILIENT_STREAM_MAX_ATTEMPTS = 2;` (hard cap) and `export const RESILIENT_STREAM_CLASS = "incomplete_stream";`
- `export function resilientStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean` — true only for `"1"` / `"true"` (case-insensitive, trimmed) of `env[RESILIENT_STREAM_FLAG]`; absent or anything else → **false**.
- `export interface ResilientStreamInput` — `ownerGranted: boolean` (what `transient.ts` already decided for this attempt), `category: TransientErrorCategory` (R01's owner category), `attempt: number`, `maxAttempts: number`, `elapsedMs: number`, `baseBackoffMs: number`, `nowMs: number`, `action?: ToolAction`, `circuit?: EndpointCircuitSnapshot`, `retryAfterMs?: number`, `mode?: "bootstrap" | "normal"`.
- `export type ResilientStreamReason = "flag_off" | "class_not_enrolled" | "owner_granted" | "not_replayable" | "circuit_denied" | "budget_exhausted" | "cap_reached" | "granted";`
- `export interface ResilientStreamLogEntry` — `flag: typeof RESILIENT_STREAM_FLAG`, `enabled: boolean`, `class: string`, `attempt: number`, `cap: number`, `ownerGranted: boolean`, `reason: ResilientStreamReason`, `waitMs: number | null`.
- `export interface ResilientStreamDecision` — `retry: boolean`, `waitMs: number | null`, `cap: number`, `reason: ResilientStreamReason`, `log: ResilientStreamLogEntry`.
- `export function decideResilientStream(input: ResilientStreamInput): ResilientStreamDecision`.
Order, and it is the whole contract: flag off → `retry: false`, `reason: "flag_off"`, `waitMs: null`, `cap: RESILIENT_STREAM_MAX_ATTEMPTS` — **and the decision must be identical to "do nothing" for every input when the flag is off, including when `ownerGranted` is true** (the owner's own retry is untouched: this unit never cancels or adds); flag on but `category !== RESILIENT_STREAM_CLASS` → `reason: "class_not_enrolled"`; `ownerGranted === true` → `retry: false`, `reason: "owner_granted"` (**the owner already retries; a second grant here would be the duplicate-owner defect**, so this unit never retries alongside the owner); `action` supplied and `classifyReplaySafety(action).replayAllowed === false` → `not_replayable`; `circuit` supplied and its `allowAttempt === false` → `circuit_denied`; `attempt >= Math.min(maxAttempts, RESILIENT_STREAM_MAX_ATTEMPTS)` → `cap_reached`; then delegate to `evaluateRetryBudget` with `maxAttempts: Math.min(maxAttempts, RESILIENT_STREAM_MAX_ATTEMPTS)` — stop → `budget_exhausted`, retry → `retry: true` with R03's `waitMs` and `reason: "granted"`. `cap` in the returned decision is always `Math.min(maxAttempts, RESILIENT_STREAM_MAX_ATTEMPTS)`, `retry` is true only for `reason === "granted"`, and `log` is always populated with the values above.

## Write tests for exactly these properties (one `it()` per property, dense, no narrative comments)
1. **Flag off is unchanged.** With `env: {}` and with `env: { PI_RESILIENT_STREAM: "0" }` / `"yes"` / `""`, `decideResilientStream` returns `retry: false`, `reason: "flag_off"`, `waitMs: null` for a table of at least 12 inputs including `ownerGranted: true`, `attempt: 1`, an open circuit and a non-replayable action; and `resilientStreamEnabled` is true only for `"1"`, `"true"`, `" TRUE "`.
2. **Flag on is bounded.** With `env: { PI_RESILIENT_STREAM: "1" }`: a valid grant returns `retry: true`, `reason: "granted"`, `cap === 2` even when `maxAttempts: 10`, and `waitMs` equal to R03's wait for the same numbers; `attempt: 2` → `cap_reached`; `maxAttempts: 1` → `cap_reached` at `attempt: 1`; and a `bootstrap` mode → `budget_exhausted` (never granted).
3. **Duplicate owner prevented.** With the flag on, `ownerGranted: true` and otherwise perfectly grantable inputs → `retry: false`, `reason: "owner_granted"`; assert this for every combination of enrolled class × replayable × circuit-allowed (and that flipping `ownerGranted` to false on the same input does grant) — this is the property that keeps this unit from becoming a second retry owner.
4. **Only the enrolled class is integrated.** `category: "rate_limited"`, `"network_interruption"`, `"server_error"`, `"timeout"` and `""` → `retry: false`, `reason: "class_not_enrolled"`; only `incomplete_stream` proceeds.
5. **Safety gates win over the flag.** `{ name: "bash", writes: true }` and `{ name: "mystery_tool" }` actions → `not_replayable`; a closed-circuit snapshot whose evaluation denies the attempt → `circuit_denied`; both with `retry: false` and `waitMs: null`, and the log entry records the same reason.
6. **Logging is data, and the module executes nothing.** Assert `log` equals the decision's observable fields on three different paths (granted, owner_granted, flag_off) — same `flag`, `enabled`, `class`, `attempt`, `cap`, `ownerGranted`, `reason`, `waitMs`; and read the module's own source with `readFileSync` asserting none of `writeFile`, `appendFile`, `console.`, `setTimeout`, `Math.random`, `Date.now`, `fetch`, and that `process.env` appears exactly once (the parameter default).

## Verify (must be green at the commit you produce)
1. `npm run typecheck`
2. `node --test --import ./test/support/isolatedState.ts test/unit/recovery-optin.test.ts`
Then report per-suite counts for `test/unit/recovery-recommend.test.ts`, `test/unit/retry-budget.test.ts`, `test/unit/transient.test.ts` (40 tests — the existing owner's suite must stay green). Note: `npm run lint` (biome) already fails repo-wide at this base — do not chase it.

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 16d35ecb020a70a2f1d9ee3cc83a84251d969c6c HEAD`, exit codes for both verify commands, the three per-suite regression counts, the decision order as implemented, and one paragraph explaining why `ownerGranted === true` must return `retry: false` (RETRY_OWNERS.md conflicts 1 and 3) instead of a second grant. Commit as `feat(inference): opt-in bounded recovery for one enrolled class behind the existing retry owner (R07)`.
