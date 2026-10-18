# Disk-Pressure Recovery — Traceability (spec §8)

Requirement: *ENOSPC must SUSPEND missions (never crash Pi, corrupt state, or
flood warnings) and resume safely after space is available, without forcing a
new mission or repeating completed work.*

## Requirement → implementation trace

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| FR-03 suspend-don't-fail | `StoragePressureController.suspend(incident, opts?)` transitions to `WAITING_FOR_DISK_SPACE`, stops work (`suspendWork`), retains checkpoint, never terminally fails; refuses operator-required (EROFS/unknown) incidents | `test/unit/resilience-storage-pressure.test.ts` FR-03 suite (6 tests) |
| FR-03 durable blocked-state substatus, backwards compatible | `WAITING_FOR_DISK_SPACE` constant; existing mission state machine preserved (no new enum, no new scheduler) | AUDIT.md reuse matrix |
| FR-04 warning coalescing | One `incident` event per incident + compact `status` events ≤1 per cooldown (default 10 min) | `emitCompactStatus`; FR-04 "exactly one incident" + "periodic compact status" tests |
| FR-04 snapshot behavior | On ENOSPC snapshot marked dirty + stale with `snapshot_stale_at_ms`; `pauseSnapshotRetries()` keeps it dirty; `markSnapshotRepublished()` clears only after the dirty pipeline republishes | FR-04 snapshot tests; `SnapshotPressureState` |
| FR-04 jittered exponential backoff | `postRecoveryBackoffMs(attempt)` — base `probe_interval * 2**(attempt-1)` capped at `post_recovery_backoff_cap_ms` (60s), plus jitter | "postRecoveryBackoffMs" test |
| FR-05 wait-and-auto-recover | `sample(mount, sentinel?)` samples the AFFECTED mount only; requires `recovery_consecutive_checks` consecutive healthy samples + bounded write/rename/fsync sentinel probe; resets streak on unhealthy sample (flapping protection) | FR-05 suite (consecutive-checks, sentinel-fail, streak-reset, affected-path-only tests) |
| FR-05 auto-resume default | `config.auto_resume = true` default; `sample()` auto-resumes; `auto_resume=false` requires explicit `resume()` | "auto_resume=false requires operator sign-off" test |
| FR-05 recovery event | Exactly one `recovered` event with total wait time + sample count | FR-05 "exactly one DISK_RECOVERED event" test |
| FR-05 owner + flapping latch | `resume()` owner check + `resumed` latch; path-scoped incident identity resets counters on fresh incident | `hasResumed` getter; "resets counters when a fresh incident follows a recovery" test |
| No false published acknowledgement | Recovery reported only after sentinel probe succeeds | "does not recover when sentinel probe fails" test |
| Tests via fault injection only | Injectable clock/sleep/rand; sentinel probe abstraction; no real-disk filling | All tests in the new suite |

## Commit log (this mission)

| Commit | Content |
| --- | --- |
| `e0410b5` | Re-adopted FR-01 classification (`classifyStorageIncident`) |
| `2fe61fe` | Re-adopted FR-01 biome format |
| `3f033d6` | `StoragePressureController` + index export + 20 unit tests |

## Execution log

1. Re-adopted and verified FR-01 foundation (17/17 classify tests, typecheck 0).
2. Audited reuse (AUDIT.md) — confirmed no duplicate monitor/retry/supervisor.
3. Implemented `StoragePressureController` (self-contained, injectable deps).
4. Exported it from `src/resilience/index.ts`.
5. Added 20 deterministic fault-injection unit tests; fixed 3 test/impl
   mismatches found by running them (backoff jitter, auto_resume gate
   placement, fresh-incident counter reset).
6. Verified: typecheck 0, biome clean, 76/76 resilience tests pass.
7. Committed the single-concern change.
8. Wrote AUDIT.md / TRACEABILITY.md / RELEASE.md deliverables.

## Remaining follow-up tasks (explicit, not done in this commit)

- [ ] Runtime wiring: call `suspend()` from the snapshot publisher
  (`EngineeringRuntime.ts` snapshot error path) and other storage write points.
- [ ] Runtime wiring: drive `sample()` on `probe_interval_ms` for the affected
  mount with a real sentinel probe.
- [ ] Runtime wiring: on `resume()`, run the dirty-snapshot republish pipeline
  and resume paused tasks from the last safe checkpoint.
- [ ] FR-05 persistence integrity: integrate torn-tail JSONL repair in
  `src/platform/eventstore/jsonl.ts` (ownership-verified only).
- [ ] End-to-end acceptance scenarios (spec §6 tests 1–13) via isolated temp
  filesystems / mocked fs.
