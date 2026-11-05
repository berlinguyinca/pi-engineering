# R04 — Add endpoint circuit-breaker state machine

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/R04/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/R03/R03.handoff.json (sha256:85724fdd4105bd973b4e3a0d4f4423f57959af7361dc3d089e9f32a3f69d7bd2, status PASS, resultSha 389f678b8eed809bc74ff740e9b984263eb5fbe9 = your base).
Base commit: 389f678b8eed809bc74ff740e9b984263eb5fbe9. Mode: isolated-change.

## Objective (plan delta, verbatim)
Pure closed/open/half-open decisions for repeated model_not_found, upstream failures, unhealthy response; bounded memory and cooldown; no network calls.
Evidence: Repeated 404 opens circuit, cooldown enables one probe.

## Read first — what already exists, so you align instead of duplicating
- `src/resilience/MissionSupervisor.ts` already contains a **mission-scoped** `CircuitBreaker` (class at `:55`, used at `:94`, gated at `:158-171` with `tryHalfOpen()` / `recordSuccess()` / `recordFailure()`). Read it so your state names and transitions are compatible in *spirit*, but **do not import it and do not modify that file** — it is one breaker for one mission's supervisor, held as mutable instance state; yours is per endpoint and must be a **pure transition function over immutable snapshots**.
- `src/models/health.ts` is the endpoint-health analogue: `ModelHealthProvider` with `DEFAULT_HEALTH_TTL_MS = 30_000` (`:47`), `DEFAULT_HEALTH_ERROR_BACKOFF_MS = 60_000` (`:48`) and `freshUntil` recomputed from the error backoff at `:115`. Your cooldown should be expressible against that idea but arrive as **data**, never as an import of that module or its constants.
- `src/inference/retryBudget.ts` (R03, at your base) is the sibling pure evaluator: input-only, no clock, no RNG, ordered stops. Match its style: `evaluate…(input) → decision`, and let a caller-supplied `nowMs` be the only time.
- `src/inference/retryTrace.ts` owns failure identity (`failureIdentity` `:92`) and the layer union; `src/resilience/classify.ts` maps HTTP statuses to failure classes. Use their *vocabulary* for the failure classes named in the delta (`model_not_found` for 404, upstream failure, unhealthy response); do not import status tables or re-derive classification.
- `docs/specs/harness-reliability-bootstrap/RETRY_OWNERS.md` (R01) documents that 404 retry counts are currently granted in two places (`src/guard/transient.ts:127` and `src/inference/recovery.ts:263-268`) — your circuit must not become a third place that decides whether to retry; it decides only **whether the endpoint may be attempted at all**.

## Scope (hard limits)
- Production file 1: `src/inference/endpointCircuit.ts` (**new**).
- Test file 1: `test/unit/endpoint-circuit.test.ts` (**new**).
- Nothing else may change. `src/resilience/**`, `src/models/**`, `src/inference/retryBudget.ts`, `src/inference/retryTrace.ts`, `src/inference/retryDelay.ts`, `src/guard/**`, `src/workers/**`, `src/orchestration/**`, `src/runtime/**`, `src/plannerWorker/**`, everything under `scripts/**`, `templates/**`, `manifests/**`, `test/support/**`, `package.json` and `.gitignore` are denied. Total changed lines ≤ 100, at most 2 production and 2 test files.
- **Pure and network-free**: no I/O, no `Date.now()`, no `Math.random()`, no env reads, no timers, no telemetry/network imports. The only imports allowed are type-free local helpers you write yourself in this file. Every state transition returns a **new** snapshot; inputs are never mutated.
- **No wiring**: no existing file may be touched, and nothing here may call `evaluateRetryBudget`, `ModelHealthProvider`, `CircuitBreaker` or any transport.

## Required shape (name things exactly, keep it small)
- `export type EndpointCircuitState = "closed" | "open" | "half_open"`.
- `export type EndpointFailureClass = "model_not_found" | "upstream_failure" | "unhealthy_response"`.
- `export interface EndpointCircuitSnapshot` — `state`, `endpointId`, `consecutiveFailures: number`, `openedAtMs: number | null`, `probeInFlight: boolean`, `observedAtMs: number`. Keep `endpoints` bounded *by the caller*: expose `export const ENDPOINT_CIRCUIT_MAX_KEYS = 64` and a `export function noteEndpointKey(keys: readonly string[], endpointId: string, max?: number): string[]` that appends and, when over `max`, evicts the oldest keys (FIFO) so memory stays bounded — pure, returns a new array.
- `export interface EndpointCircuitInput` — `snapshot: EndpointCircuitSnapshot`, `failure?: EndpointFailureClass | null`, `success?: boolean`, `nowMs: number`, `threshold: number` (consecutive failures that open the circuit), `cooldownMs: number`, `probeLimit?: 1` (the number of concurrent probes allowed while open, default 1).
- `export interface EndpointCircuitDecision` — `state: EndpointCircuitState`, `allowAttempt: boolean`, `probe: boolean`, `snapshot: EndpointCircuitSnapshot`, `reason: "closed" | "opening" | "opened" | "cooldown_pending" | "probe_in_flight" | "probe_allowed" | "probe_success" | "probe_failure" | "invalid_input"`.
- `export function evaluateEndpointCircuit(input: EndpointCircuitInput): EndpointCircuitDecision`.
Rules to implement and test: a `closed` snapshot accumulates `consecutiveFailures` on failure and opens when it reaches `threshold` (reason `opening`/`opened`, `openedAtMs = nowMs`, `allowAttempt` false in the same decision that opens); while `open` and `nowMs - openedAtMs < cooldownMs` → `cooldown_pending`, `allowAttempt` false; once the cooldown has elapsed → `half_open` with `probe: true`, `allowAttempt: true` and `probeInFlight: true` — and a **second** concurrent probe while `probeInFlight` is already true → `probe_in_flight` with `allowAttempt` false; in `half_open` a success → `closed` with `consecutiveFailures` reset to 0, `openedAtMs` null, `probeInFlight` false (reason `probe_success`); in `half_open` a failure → `open` again with `openedAtMs = nowMs` and cooldown restarting (reason `probe_failure`); a `success` while `closed` resets `consecutiveFailures` to 0 and reports `closed`; non-finite `nowMs`, `threshold < 1`, negative `cooldownMs`, or a snapshot whose state is not one of the three → `invalid_input` with `allowAttempt` false and the snapshot returned unchanged; `consecutiveFailures` must never exceed `threshold` in a returned snapshot (clamp at the threshold).

## Write tests for exactly these properties (one `it()` per property, dense, no narrative comments)
1. **Repeated 404 opens the circuit.** Three `model_not_found` failures with `threshold: 3` → the third decision is `state: "open"`, `allowAttempt: false`, `openedAtMs` equal to that call's `nowMs`, and the first two decisions were `closed` with `consecutiveFailures` 1 and 2; a fourth failure while open keeps it open with `openedAtMs` unchanged.
2. **Cooldown enables exactly one probe.** At `openedAtMs + cooldownMs - 1` → `cooldown_pending`, `allowAttempt: false`; at `openedAtMs + cooldownMs` → `state: "half_open"`, `probe: true`, `allowAttempt: true`; and a second evaluation against the **resulting** snapshot while `probeInFlight` is true → `probe_in_flight`, `allowAttempt: false`.
3. **Probe outcome closes or reopens.** `half_open` + `success: true` → `closed`, `consecutiveFailures` 0, `openedAtMs` null, `probeInFlight` false, reason `probe_success`; `half_open` + `failure: "upstream_failure"` → `open`, `openedAtMs` equals that call's `nowMs` (cooldown restarts), reason `probe_failure`, and the next `nowMs - 1` is `cooldown_pending` again.
4. **All three failure classes open it, and success while closed clears the streak.** For each of `model_not_found`, `upstream_failure`, `unhealthy_response`: `threshold: 2` opens on the second failure; and `closed` with failures 1 then `success: true` returns `consecutiveFailures` 0 while staying `closed`.
5. **Memory is bounded and inputs are not mutated.** `noteEndpointKey` over 70 distinct ids with default max keeps exactly 64 and drops the oldest (assert first-evicted id and that the array is a new object, and that `max: 3` gives the documented FIFO trio); and the snapshot passed into `evaluateEndpointCircuit` is byte-identical after the call (`structuredClone` comparison) while the returned snapshot is a different object.
6. **Invalid input fails closed, and no clock or RNG is read.** Non-finite `nowMs`, `threshold: 0`, `cooldownMs: -1`, `state: "halfopen"` → `invalid_input` with `allowAttempt: false` and the unchanged snapshot; plus read the module's own source with `readFileSync` and assert it contains none of `Date.now`, `Math.random`, `process.env`, `setTimeout`, `fetch`, `import ` (zero imports is the point of a pure state machine here).

## Verify (must be green at the commit you produce)
1. `npm run typecheck`
2. `node --test --import ./test/support/isolatedState.ts test/unit/endpoint-circuit.test.ts`
Then report per-suite counts for the three suites that exist: `test/unit/retry-budget.test.ts`, `test/unit/retry-correlation.test.ts`, `test/unit/transient.test.ts`. Note: `npm run lint` (biome) already fails repo-wide at this base — do not chase it; typecheck plus the two test commands are the gate.

## Report
Write `WORKER_REPORT.md` in the worktree root (untracked is fine; the conductor copies it): `git diff --numstat 389f678b8eed809bc74ff740e9b984263eb5fbe9 HEAD`, exit codes for both verify commands, the three per-suite regression counts, the transition table you implemented, and one paragraph on how your state names relate to `MissionSupervisor`'s existing `CircuitBreaker` without importing it. Commit as `feat(inference): pure endpoint circuit state machine with bounded keys and single-probe cooldown (R04)`.
