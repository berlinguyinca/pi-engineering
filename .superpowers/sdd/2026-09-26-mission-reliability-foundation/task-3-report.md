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
