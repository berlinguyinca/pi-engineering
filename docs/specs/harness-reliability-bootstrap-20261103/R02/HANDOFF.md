# R02 — Expose retry correlation ID across layers

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/R02/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/R01/R01.handoff.json (sha256:c1edac57d880a06babf48548f8d5926b56ced2e5cfcb5b9d9ec13eff2ac5711a, status PASS, resultSha 9e508548602b78ab9b21bf3082e3dc6aca0e819e = your base).
Base commit: 9e508548602b78ab9b21bf3082e3dc6aca0e819e. Mode: isolated-change.

## Objective (plan delta, verbatim)
Add stable failure correlation ID so duplicate layer actions are detected without treating independent failures as one; keep existing trace format compatible.
Evidence: Same failure across layers correlated; independent requests separate.

## Read this first — most of the capability already exists, and duplicating it is a failure
`src/inference/retryTrace.ts` (extended by E07, commit 8f33cfbb, at base) **already provides** the cross-layer correlation ID and the duplicate-action detector:
- `failureIdentity(input, clock?)` at `src/inference/retryTrace.ts:92` digests `[sessionId, runId, provider, model, originLayer, firstAttempt, normalized error]` into `sha256:<64>`; `FailureIdentityInput` (line 74) deliberately excludes the *observing* layer and its attempt, which is what makes every layer derive the same id for one failure.
- `errorRef()` (line 98) is the same failure reduced to normalized code/layer/severity plus a 32-hex digest.
- `RetryTrace.failure_id` (line 45) is the field that carries it; `recordRetryTrace()` (line 107) publishes it on the `inference.retry.trace` bus.
- `actingLayers(trace)` (line 58) + `actedOn()` (line 52) are the duplicate-layer-action detector (more than one acting layer = retry multiplication).
- Existing coverage lives in `test/unit/retry-error-events.test.ts`.
**Do not reimplement, rename, wrap or parallel these.** Your job is to prove the two evidence properties in the manifest's own test file, and to change production code **only if a test you write exposes a real gap**.

## Scope (hard limits)
- Production file 1: `src/inference/retryTrace.ts` (exists — modify only if a written test proves a gap; otherwise leave it untouched).
- Test file 1: `test/unit/retry-correlation.test.ts` (**new** — this is your deliverable).
- Nothing else. `src/plannerWorker/**`, `src/runtime/**`, `src/orchestration/**`, `src/errors/**`, `src/incidents/**`, everything under `scripts/**`, `templates/**`, `manifests/**`, `test/support/**` and `package.json`/`.gitignore` are denied. Total changed lines ≤ 100, at most 2 production and 2 test files.
- **Format compatibility is a hard requirement**: `RetryTrace` fields (`layer`, `attempt`, `reason`, `next`, `owner`) and `RetryLayer`/`RetryNext` unions must keep their current shape and meaning; existing tests including `test/unit/retry-error-events.test.ts`, `test/unit/gateway-transient-boundary.test.ts` and `test/unit/transient.test.ts` must stay green.

## Write tests for exactly these properties (one `it()` per property, dense, no narrative comments)
1. **One failure, many observers → one id.** Two different observing layers (`resilient-stream` and `worker-transient-retry`) computing `failureIdentity` over the same `FailureIdentityInput` get byte-identical ids; and the ids stay identical when only the observing layer's own `attempt` differs (the attempt is *not* part of the identity).
2. **Independent failures stay separate.** Same session, different error (e.g. a 429 wait object vs a 500 error) → different ids. Same error, different `sessionId` → different ids. Same error, different `runId` → different ids. Two attempts of the *same* request that fail *differently* → different ids (they are different failures, not one failure observed twice).
3. **Duplicate layer action is detected through the correlation.** A trace with two entries carrying the **same** `failure_id` and two different acting layers (`next: "retry"` and `next: "hold"`) → `actingLayers` returns both, and a trace with one acting layer plus `defer` entries for the same `failure_id` returns exactly one. State in one assertion line that a single failure acted on twice is the multiplication signal, without inventing any new detector.
4. **Format compatibility.** A `RetryTrace` literal with only the five original fields is still assignable/valid, and `recordRetryTrace(into, entry)` with no telemetry and no identity still appends and does not throw; when `failure_id` and `error_ref` are present they ride the emitted payload unchanged (use a tiny stub telemetry object recording the event name and payload).
5. **Determinism / no leakage.** Same input twice → same id; the id contains only `sha256:` plus hex; `errorRef` output contains no raw message text (feed an error whose message carries a path like `/Users/secret/personal/token=abc` and assert the ref holds only `code`, `layer`, `severity` and a 32-hex digest).
Do not assert anything about wall-clock, RNG, network or the scheduler.

## Verify (must be green at the commit you produce)
1. `npm run typecheck`
2. `node --test --import ./test/support/isolatedState.ts test/unit/retry-correlation.test.ts`
Then prove compatibility yourself and report it (not required to be green at base): `node --test --import ./test/support/isolatedState.ts test/unit/retry-error-events.test.ts test/unit/gateway-transient-boundary.test.ts test/unit/transient.test.ts` with its pass/fail counts.

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 9e508548602b78ab9b21bf3082e3dc6aca0e819e HEAD` (must show `test/unit/retry-correlation.test.ts` and, only if you had to change it, `src/inference/retryTrace.ts`), exit codes for both verify commands, the pass/fail counts of the compatibility run, and — if you changed production code — the exact assertion that failed before the change and why it was a real gap. Commit as `test(inference): pin cross-layer retry correlation identity and duplicate-action detection (R02)` (use `fix(inference):` only if you genuinely changed production).
