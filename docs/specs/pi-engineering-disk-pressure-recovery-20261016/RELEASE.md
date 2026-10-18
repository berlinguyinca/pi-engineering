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

## Operational notes for the follow-up wiring

- The controller never touches the operator's real disk in tests (fault
  injection only). Runtime wiring must also use isolated temp filesystems /
  mocked fs.
- `auto_resume=false` requires an explicit operator `resume()`; the controller
  keeps the healthy streak so a later operator sign-off can complete.
