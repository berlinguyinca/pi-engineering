# Mission Live Activity Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the bounded lanes below. All lanes share an isolated feature worktree and have distinct file ownership.

**Goal:** Keep every mission progress surface visibly current and inspectable while limiting HerdR attention notifications to finished, crashed, and stalled transitions.

**Architecture:** Reuse the existing mission observability projection as the source of truth. Refresh display projections independently of incoming worker events, preserve the distinction between liveness and meaningful progress, and gate attention notifications at their delivery boundary.

**Tech Stack:** TypeScript, Pi extension UI, Node test runner, existing mission event store and HerdR integration.

**Spec:** User-approved design in this conversation; existing docs/specs/mission-observability/02-live-activity-and-output.md and 03-health-stall-and-recovery.md.

## Global Constraints

- No dependencies added, fabricated progress, synthetic worker heartbeats, or raw secret-bearing output.
- Preserve legitimate waits, operator pauses, provider/model identity and independent worker state.
- Local activity refreshes must not create attention notifications.
- Stop timers on close and terminal mission states; reconnect must not replay notifications.
- Work only in this worktree; preserve other agents' edits.

## Task 1: Live telemetry and health

Owner: mission_telemetry. Files: src/orchestration/observability/**, src/orchestration/orchestrator.ts, src/runtime/EngineeringRuntime.ts and dedicated backend tests.

- [x] Add regression tests proving timers refresh elapsed/health without inventing progress, emit clear stalls, and stop on completion/close.
- [x] Extend RuntimeMissionActivityEvent with optional observedAt, waitingReason, waitingSince, workersDetail and recentActivity, preserving existing callers.
- [x] Publish bounded per-worker task, model/route, activity and timestamps from the existing projection.
- [x] Update orchestrator progress lines on the active display timer and expose genuine waits and loop/deadline stalls.
- [x] Run targeted mission observability/orchestrator tests and typecheck.

## Task 2: Shared displays and inspection

Owner: mission_ui. Files: extensions/index.ts, src/status/**, src/panel/**, src/tools/missionReport.ts, src/orchestration/missionSnapshot.ts, UI tests and docs/usage.md.

- [x] Add regression tests for active/waiting/stalled output, aging clocks and an inspect command with worker activity.
- [x] Render current action, elapsed time, output/progress freshness and route identity before low-priority metadata.
- [x] Reuse projection details for inspect output: worker activity, recent events, tests, changed files and blockers; indicate unavailable data honestly.
- [x] Ensure existing footer/panel and snapshot mission bars consume the same activity state and do not emit routine notifications.
- [x] Document commands and run changed renderer/command tests.

## Task 3: HerdR attention policy

Owner: mission_notifications. Files: notification integration modules and dedicated tests, avoiding files owned above.

- [x] Trace and document the real attention delivery path separately from inspector telemetry.
- [x] Add tests rejecting routine activity/phase/wait notifications and accepting finished, crashed and stalled transitions.
- [x] Deduplicate repeated observations, permit a new stall episode after recovery, suppress historical replay.
- [x] Integrate at the delivery boundary or provide the narrow integration callback to the leader when shared-file edits are needed.

## Task 4: Integration and verification

Owner: leader.

- [x] Review each lane against the user request and existing contracts, resolve interface mismatches.
- [x] Run affected tests, core/scripts typechecks, changed-file Biome, diff checks and package-load smoke checks.
- [x] Obtain independent review, resolve material findings and rerun affected checks.
- [ ] Commit feature branch and open a PR with exact validation and deployment limits. Preserve the separately open refresh PR #374.

## Additional engine coverage

Owner: planner_visibility. Files: src/plannerWorker/** and dedicated planner-worker tests.

- [x] Feed actual worker events into bounded per-worker live snapshots and persistent mission widgets, with one-second display ticks.
- [x] Expose persisted activity through engineering-status and engineering-workers inspection.
- [x] Replace routine event notifications with persistent activity updates; retain finished/crashed/stalled transition notices.
- [x] Verify watchdog/wait behavior, event redaction, timers and notifications with targeted tests.

## Execution evidence

- Baseline: observability-service, control-plane-ingest and orchestration-snapshot-observability tests passed (25/25).
- Ruling: implement both mission engines because normal orchestration and planner-worker have separate execution/display paths; covering only one would violate the request.
- Ruling: keep the optional inspector telemetry feed separate from attention events. HerdR mission.updated ingress updates its dashboard; it does not prove OS/browser attention delivery.
- Review fixes: explicit per-worker capacity waits prevent false stalls; per-worker health prevents a busy peer masking a stalled worker; clock ticks use persistent displays instead of notices.
- Inspection output: capture only bounded, redacted tool output previews. Never expose model reasoning or raw tool arguments. When no tool output has been captured, inspection says so explicitly.
- Initial integration evidence: both TypeScript projects and package-load smoke checks pass. The combined 184-test run had one outdated SLOW expectation for a confirmed repeated-read loop; that expectation was strengthened to STALLED and the owning 50-test suite passed.

- Final consolidated evidence: 191/191 tests across 19 affected test files; core and scripts TypeScript checks pass; Biome checks 39 changed TypeScript files; diff whitespace check clean.
