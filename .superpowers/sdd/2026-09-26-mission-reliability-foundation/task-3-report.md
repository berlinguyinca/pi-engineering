# Task 3 Report: Single-writer locking and durable fenced ownership

## Outcome

Implemented a real cross-process JSONL writer lock and replay-backed mission/repository ownership. Local takeover now requires the held JSONL writer lock plus an expired durable lease; fencing epochs remain monotonic across expiry, release, takeover, and restart.

## RED evidence

- `node --test test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts`
  - Failed all four new ownership cases because `src/orchestration/ownership.ts` did not exist.
  - Failed the child-process contention case because the old `openFiles` set only protected one process.
- `node --test test/unit/mission-ownership.test.ts`
  - Failed `assertAuthoritative` expiry regression with `Missing expected exception`; an elapsed current lease was still accepted before explicit reconciliation.
- `node --test test/unit/platform-eventstore.test.ts`
  - Failed missing-parent compatibility with `ENOENT ... events.jsonl.lock`; lock acquisition initially ran before creating the JSONL parent directory.
  - Failed the in-flight-close regression with `Missing expected rejection`; `close()` released the lock before a queued append drained.

## GREEN evidence

- `node --test test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts`
  - 16 passed, 0 failed.
  - Covers live cross-process exclusion, clean release, verified-dead PID recovery, missing-parent compatibility, in-flight append draining, idempotent runtime release, renewal, expiry, monotonic takeover, repoId serialization, restart replay, and stale-token rejection.
- `node --test test/unit/orchestration-missionstore.test.ts test/integration/runtime-mission-live-snapshot.test.ts test/integration/orchestrator-e2e.test.ts`
  - 43 passed, 0 failed.
- `npm run typecheck`
  - Passed (`tsc --noEmit`).
- `npm run lint`
  - Passed (`biome check .`, 578 files checked).

## Full suite

- `npm test`
  - 2,305 tests discovered: 2,304 passed, 0 failed, 1 skipped.
  - The skipped test is the pre-existing OpenViking Postgres round-trip, which requires `TEST_DATABASE_URL`.

## Files

- `src/platform/eventstore/fileLock.ts` — atomic sidecar-file lock with PID/host/opened-at/token diagnostics, same-host dead-PID recovery, token-checked idempotent release.
- `src/platform/eventstore/jsonl.ts` — acquires the lock before replay, exposes local writer authority, and releases on close/open failure.
- `src/orchestration/ownership.ts` — durable mission/repository acquire, renew, fence, release, and authority assertion.
- `src/orchestration/missionStore.ts` — replayed latest epochs and repoId-global repository lease serialization.
- `src/orchestration/orchestrator.ts` — mission ownership acquisition/release and renewal immediately before dispatch.
- `src/runtime/EngineeringRuntime.ts` — per-runtime controller identity and ref-counted shared-store close lifecycle.
- `test/unit/platform-eventstore.test.ts` — real child-process locking, release, stale recovery, and parent creation.
- `test/unit/mission-ownership.test.ts` — lease/fencing/restart/repository/runtime lifecycle coverage.

## Self-review

- The lock is one atomically-created file rather than a directory plus metadata file, avoiding an unverifiable crash window between lock creation and owner publication.
- A live or unverifiable foreign lock is never removed. Recovery occurs only for a same-host PID proven absent with signal 0 semantics.
- Repository authority is indexed globally by `repoId`, so separate missions cannot concurrently mutate the same repository.
- Expired leases fail `assertAuthoritative` even before an explicit renew/acquire reconciliation event.
- Same-process runtime sharing remains supported; only the last runtime close releases the JSONL lock.
- Autonomous repair remains inactive. No database/distributed ownership path was added.

## Concerns / deferred work

- PID reuse intentionally fails closed: a stale lock whose PID now belongs to a live process is not removed automatically.
- Lease renewal is performed at dispatch boundaries, not by a background heartbeat. Long-running worker result fencing is intentionally completed by later reliability tasks that guard every authoritative update.
- The deferred Task 2 Git path-enumeration fail-open boundary was not encountered and was not changed.

## Fix Round 1

### Outcome

- Mission dispatch now holds a renewable authority session for the complete worker lifetime, stamps the active mission generation/fencing token onto both task and execution records, validates authority at dispatch/result/mutation boundaries, cancels on invalidation, and records late results as rejected.
- Every mutating scheduled, repair, validation, review, and integration execution acquires repository authority by `repoId`, renews it while running, and fences/releases it after settlement. Separate missions/controllers are serialized on the same repository.
- Stale JSONL lock recovery now uses a token-specific atomic recovery claim, revalidates the observed stale owner, quarantines only that exact token, and never unlinks a replacement winner.
- Writer authority is fail-closed unless a backend explicitly proves it. The in-memory JSONL backend explicitly owns its writer boundary.
- Shared-runtime initialization/ref-counting is single-flight and exception-safe; failed initialization rolls back its store reference, while failed close remains retryable and does not mark the runtime closed early.
- Mission release failures are isolated from the already-determined mission outcome.

### RED evidence

- `node --test --test-name-pattern="fails closed" test/unit/mission-ownership.test.ts`
  - Failed with `Missing expected rejection`; backends without `ownsWriterLock()` were implicitly authorized.
- Focused ownership/scheduler runs initially exposed missing long-worker fencing: mission/repository leases expired without renewal, late results were accepted, and no repository lease surrounded mutations.
- The stale-recovery race regression initially demonstrated that rename/unlink recovery could act after the observed stale owner had changed; recovery lacked a token-specific atomic claimant.
- Runtime lifecycle regressions initially exposed dropped concurrent-open references, leaked writer authority after failed initialization, and a permanently closed runtime after a failed flush.
- `node --test test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts test/unit/orchestration-missionstore.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-e2e.test.ts test/integration/runtime-mission-live-snapshot.test.ts`
  - Intermediate result: 108 tests, 106 passed, 2 failed.
  - Failures identified repository leases left behind when expiry was first reconciled by `renew()`, and replay/live `mission.updated_at` divergence for task creation.
- `node --test --test-name-pattern="expires an overdue" test/unit/mission-ownership.test.ts && node --test --test-name-pattern="replays reliability authority" test/unit/orchestration-missionstore.test.ts`
  - After the bounded fixes: 2 passed, 0 failed.

### GREEN evidence

- `node --test test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts test/unit/orchestration-missionstore.test.ts test/unit/orchestration-broker.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-e2e.test.ts test/integration/runtime-mission-live-snapshot.test.ts`
  - 108 passed, 0 failed.
  - Covers lease expiry during a live worker, takeover cancellation/late-result rejection, task/execution fencing stamps, repository mutation serialization across controllers/missions, release-failure outcome isolation, two-contender stale recovery, concurrent runtime opens, failed initialization rollback, and failed-close retry.
- `npm run typecheck`
  - Passed (`tsc --noEmit`).
- `npm run lint`
  - Passed (`biome check .`; 578 files checked, no fixes applied).
- `npm test`
  - 2,315 tests discovered: 2,314 passed, 0 failed, 1 skipped in 30.875s.
  - The sole skip remains the OpenViking Postgres round-trip because `TEST_DATABASE_URL` is unset.

### Files changed

- `src/orchestration/{ownership,missionStore,scheduler,broker,orchestrator}.ts` — renewable mission/repository authority, durable epoch stamping, authority-checked dispatch and settlement, and non-masking release.
- `src/platform/eventstore/{fileLock,jsonl}.ts` — token-specific stale recovery and accurate single-writer documentation.
- `src/runtime/EngineeringRuntime.ts` — exception-safe shared initialization, reference accounting, and retryable close.
- `test/unit/{mission-ownership,orchestration-scheduler,platform-eventstore}.test.ts` — long-run expiry/takeover, actual mutation fencing, runtime lifecycle failures, and stale-recovery race coverage.

### Self-review and concerns

- Repository mutation authority is keyed by `repoId`; same-repository mutators serialize even when declared write domains are disjoint.
- Authority is rechecked before execution creation/start, dispatch, result acceptance, worktree harvest, and authoritative task settlement. Renewal failure invalidates the session and cancels the active execution.
- The lock is intentionally a local-filesystem primitive. Correct stale-owner proof requires every contender to share the same filesystem, hostname, and PID namespace. Network filesystems and containers with differing PID namespaces require a separate distributed/advisory ownership design and are unsupported here.
- A release/flush failure cannot rewrite a successful or failed mission result; repository authority then fails closed until its durable expiry.
- The deferred Task 2 Git path-enumeration fail-open boundary was not encountered and remains unchanged.

## Fix Round 2

### Outcome

- Recovery claims now carry claimant PID, hostname, opened-at time, and owner token. A later contender fails closed for a live or unverifiable claimant and reaps only an exact-token claimant proven dead in the shared host/PID namespace.
- Repository and mission lease cleanup failures no longer disappear. They produce a durable, replayable `ownership_release` finding with mission/task/repository scope, generation, fencing token, owner, renewal deadline, and error details while preserving the already-settled task or mission result.
- Dispatch-authority close diagnostics cover scheduled workers and single-task repair/integration/validation/review paths; final mission release diagnostics cover both initial orchestration and resume.

### RED evidence

- `node --test --test-name-pattern="recovery claimant|release failure" test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts test/unit/orchestration-scheduler.test.ts`
  - 3 tests, 0 passed, 3 failed.
  - Dead recovery claimant timed out instead of recovering; repository and mission release failures had no durable visible finding.
- `node --test --test-name-pattern="live process" test/unit/platform-eventstore.test.ts`
  - 1 test, 0 passed, 1 failed.
  - A live recovery claim timed out in the retry loop instead of failing closed while preserving the claimant.

### GREEN evidence

- `node --test --test-name-pattern="recovery claimant|live process|release failure" test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts test/unit/orchestration-scheduler.test.ts`
  - 4 passed, 0 failed.
- `node --test test/unit/platform-eventstore.test.ts test/unit/mission-ownership.test.ts test/unit/orchestration-missionstore.test.ts test/unit/orchestration-scheduler.test.ts test/integration/orchestrator-e2e.test.ts`
  - 80 passed, 0 failed.
- `npm run typecheck`
  - Passed (`tsc --noEmit`).
- `npm run lint`
  - Passed (`biome check .`; 578 files checked, no fixes applied).
- `npm test`
  - 2,318 tests discovered: 2,317 passed, 0 failed, 1 skipped in 29.617s.
  - The sole skip remains the OpenViking Postgres round-trip because `TEST_DATABASE_URL` is unset.

### Files changed

- `src/platform/eventstore/fileLock.ts` — dead-claim recovery and live/unverifiable claimant fail-closed diagnostics.
- `src/orchestration/missionStore.ts` — durable ownership-release finding with bounded lease context and flush retry/visibility behavior.
- `src/orchestration/scheduler.ts` — records repository authority close failures after task settlement.
- `src/orchestration/orchestrator.ts` — records single-task and final mission release failures without altering outcomes.
- `test/unit/platform-eventstore.test.ts` — killed claimant recovery plus live claimant/winner preservation.
- `test/unit/mission-ownership.test.ts` — completed-mission preservation and durable release evidence.
- `test/unit/orchestration-scheduler.test.ts` — successful mutation preservation and durable repository release evidence through the real `DispatchAuthority.close()` path.

### Self-review and concerns

- A live or foreign-host recovery claimant is never removed; recovery requires a same-host PID proven absent and the same claimant token on re-read.
- Diagnostic findings use `major`, not `blocking`, so recording cleanup damage cannot retroactively invalidate a task or mission outcome. The unreleased lease itself remains fail-closed until reconciled or expired.
- If persistence is temporarily unavailable, the diagnostic event remains in the MissionStore ordered retry queue and the persistence failure is immediately operator-visible through `persistenceDiagnostics()`; a later successful flush makes it durable.
- Authority loss still leaves the task `RUNNING` for the explicit orphan-reconciliation work in Tasks 8/9. This round preserves the typed late-result rejection and does not falsely mark the task successful.
- Local recovery still assumes one shared filesystem, hostname, and PID namespace. The deferred Git path-enumeration fail-open boundary remains unchanged.
