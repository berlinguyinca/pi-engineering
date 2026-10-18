# Disk-Pressure Recovery — Release Notes (migration / rollback)

## What this change adds

`src/resilience/storagePressure.ts` — a self-contained
`StoragePressureController` that:

1. **Suspends** a mission on a confirmed recoverable storage incident
   (FR-03): transitions the mission to `WAITING_FOR_DISK_SPACE`, stops
   dispatch/builds/tests/snapshot-retries/cache growth at safe quiescence
   points, retains the last durable checkpoint, and never terminally fails
   the mission.
2. **Coalesces warnings** (FR-04): one incident notification per incident plus
   compact status at most once per cooldown (default 10 min); keeps the
   snapshot dirty and tags the last published snapshot stale; jittered
   exponential backoff after recovery.
3. **Waits and auto-recovers** (FR-05): samples the affected mount (not `/`),
   requires consecutive healthy checks plus a bounded write/rename/fsync
   sentinel probe, then auto-resumes (default) and emits one recovered event
   with total wait time; flapping protection via owner + `resumed` latch.

`WAITING_FOR_DISK_SPACE` is introduced as a backwards-compatible substatus
constant. The existing mission state machine, lease/fencing, checkpoints, and
snapshot publisher are preserved and reused.

## Migration

No persisted schema change, no data migration, no breaking API change.

- `src/resilience/index.ts` gains one export (`./storagePressure.ts`). Any
  module importing from `src/resilience` continues to work unchanged.
- The controller is additive and not yet wired into the runtime, so existing
  runtime behavior is byte-for-byte unchanged until the follow-up wiring lands.

## Rollback

To roll back this commit only:

    git revert 3f033d6

`git revert` is safe: the change is purely additive (one new module, one export
line, one new test file, and three spec docs). Removing it restores the exact
pre-change `src/resilience/index.ts` and leaves FR-01 classification intact.

## Verification evidence (this commit)

- `npx tsc --noEmit` → exit 0.
- `npx biome check` on the 3 changed files → clean.
- `node --test ... test/unit/resilience-storage-pressure.test.ts` → 20/20 pass.
- `node --test ... test/unit/resilience-*.test.ts` → 76/76 pass (incl. the
  re-adopted FR-01 classify tests, 17/17).

## Addendum — runtime wiring (follow-up commit)

The snapshot publisher is now connected to the controller via
`SnapshotPressureGuard` (`src/resilience/snapshotPressureGuard.ts`), created
lazily by `EngineeringRuntime` on the first publish error (healthy runs are
behaviorally unchanged):

- **Retries stop**: an ENOSPC-class failure suspends the controller; the
  publisher pauses (no further disk writes, no in-call retry storm) after one
  best-effort stale-tagged attempt, and yields to the recovery probe.
- **Published snapshot tagged stale**: the published file gains the additive
  `storagePressure` substate (dirty / stale / staleAtMs / republished /
  suspended / incident). Older plugins feature-detect and ignore it; contract
  version unchanged. The tag clears only when a post-recovery republish lands.
- **Recovery probe**: while suspended, one probe per `probe_interval_ms`
  (30 s, unref'd timer) samples the AFFECTED mount and runs a bounded
  write/sync/rename sentinel; resume unpauses the publisher and runs the
  forced republish pipeline once.
- **Classification fix**: ENOTDIR (path-shape error, e.g. work dir replaced
  by a file) is no longer treated as auto-recoverable disk pressure — a space
  probe can never clear it. It routes to operator review, preserving the
  pre-existing retry+finding behavior for that failure.
- **Fresh-incident fix**: a same-path incident after recovery re-suspends as a
  NEW incident (the publisher re-pauses on a second disk-full).

### Migration (wiring)

No breaking change. `publishMissionSnapshot` gains an optional
`{ force?: boolean }` argument (additive; existing call sites unchanged). The
snapshot file's `storagePressure` field is additive. Operator diagnostics
reuse the existing `onMissionSnapshotError` hook (coalesced — no flood).

### Verification evidence (wiring)

- `npm run typecheck` → exit 0.
- `npx biome check` on all changed files → clean.
- `test/unit/resilience-snapshot-guard.test.ts` → 12/12 (fault injection only).
- Full suite: `npm test` → 4880 tests, 0 failures (10 pre-existing TODO,
  1 skipped).
- `test/integration/mission-snapshot-publication-error.test.ts` (pre-existing
  error-path contract) → green after the ENOTDIR reclassification.
