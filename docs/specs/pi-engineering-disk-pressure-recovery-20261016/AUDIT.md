# Disk-Pressure Recovery — Reuse & Re-adoption Audit (spec §1)

This document records what was reused versus newly introduced for the disk
pressure recovery hard requirement (ENOSPC must SUSPEND missions, never crash
Pi, corrupt state, or flood warnings, and resume safely). It is a
pre-implementation audit that traces every storage-error pathway and produces
a reuse matrix, plus a post-implementation record of what the new
`StoragePressureController` reuses.

## FR-01 foundation (re-adopted, NOT recreated)

The typed `StoragePressureIncident` classification is the verified-sound FR-01
foundation. It was cherry-picked from the predecessor branch
`pi-eng-orch-TSK-px3nvH` at `8f03070` (safety tag `salvage-fr01-8f03070`) and
re-verified here:

- `e0410b5` — `resilience: add typed StoragePressureIncident disk-pressure
  classification (re-adopt 6f15177)` — 2 files, +280/-1.
- `2fe61fe` — `style(resilience): biome format for StoragePressureIncident
  additions (re-adopt 5442bdc)` — 2 files, +3/-14.

Verification: `test/unit/resilience-classify.test.ts` passes 17/17;
`npx tsc --noEmit` exits 0. No classification logic was rewritten.

## Reuse matrix

| Pathway | Existing code | Verdict | How the new work reuses it |
| --- | --- | --- | --- |
| Storage-error classification | `src/resilience/classify.ts` `classifyStorageIncident` | reuse (adequate) | Controller consumes `StoragePressureIncident` (category, `autoRecover`, `path`, `freeBytes`, `requiredBytes`, `freeInodes`) |
| Mission state machine / durable blocked-state substatus | `src/orchestration/types.ts` `MissionStatus` (WAITING_*, PAUSED_INFRASTRUCTURE, BLOCKED) | extend | `WAITING_FOR_DISK_SPACE` defined as a backwards-compatible substatus constant; controller transitions through the existing hook |
| Supervisor pattern (injectable clock/sleep/RNG, probe, jitter, state transitions) | `src/resilience/MissionSupervisor.ts` | reuse (pattern) | `StoragePressureController` follows the same shape; does NOT duplicate its retry machinery |
| Probe shape | `src/resilience/probe.ts` `ProbeResult` / `RecoveryProbe` | reuse (pattern) | Sentinel probe follows the bounded-probe contract |
| Wall-clock retry budget persisted across restarts | `src/resilience/retryWindow.ts` | reuse | Controller timing uses the same wall-clock discipline; no attempt-counter duplicate |
| Duration parsing | `src/resilience/duration.ts` `parseDurationMs` | reuse | Config durations accept ms / human strings |
| Checkpoint retention | `src/resilience/checkpoint.ts` | reuse | Controller never mutates checkpoints; resume returns to caller for its own last safe checkpoint |
| Snapshot publication | `src/runtime/EngineeringRuntime.ts` snapshot publisher | reuse | `pauseSnapshotRetries()` / `markSnapshotRepublished()` gate the existing dirty-snapshot pipeline; no duplicate publisher |
| Disk monitor | (none existed) | new (single, shared) | `StoragePressureController.sample()` is the ONE shared storage monitor; no duplicate monitors added |
| Torn-tail JSONL repair | `src/platform/eventstore/jsonl.ts` | reuse (extend) | Identified as the FR-05 persistence-integrity follow-up; controller does not reimplement it |

## What is intentionally NOT created

- No independent mission scheduler.
- No duplicate disk monitor / retry loop / supervisor class / event type /
  dashboard / worktree cleaner.
- No new persisted mission-state enum that would break the existing state
  machine (WAITING_FOR_DISK_SPACE is a substatus constant).
- No real-disk fault injection (tests use injectable clock/sleep/rand).

## Post-implementation record

- `src/resilience/storagePressure.ts` — new, self-contained controller.
- `src/resilience/index.ts` — one-line export addition.
- `test/unit/resilience-storage-pressure.test.ts` — 20 deterministic tests.

### Known remaining scope (FR-05 persistence integrity + runtime wiring)

The controller implements the suspend/coalesce/recover state machine, snapshot
dirty/stale/republished semantics, and the sentinel probe contract. The
runtime wiring (calling `suspend()` from the snapshot publisher and other
storage write points, driving `sample()` on an interval, and hooking the
dirty-snapshot republish pipeline) plus the JSONL torn-tail repair integration
are the explicit follow-up tasks; they are tracked in TRACEABILITY.md and were
left out of this commit to keep the change single-concern and reviewable.
