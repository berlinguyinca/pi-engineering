# Pi-Engineering Mission Observability

This package specifies a first-class mission observability system for Pi-Engineering.

The current problem is that an active mission can collapse user-visible output into a generic `MISSION` state. That makes it impossible to distinguish productive long-running work from a stalled worker, a model loop, a queue wait, a failed subprocess, or a legitimate validation/review phase.

The target behavior is:

> A mission may prevent itself from falsely claiming completion, but it must never prevent Pi from communicating what it is doing.

Every active mission must expose:

- approximate weighted progress,
- current phase,
- current objective,
- current activity,
- active/waiting workers,
- last heartbeat,
- last meaningful progress,
- recent observable activity,
- explicit waiting reasons,
- health/stall state,
- test/review progress,
- completion verification state,
- and a drill-down Mission Inspector.

## Documents

1. `00-master-spec.md` — architecture and invariants
2. `01-progress-model.md` — weighted DAG progress
3. `02-live-activity-and-output.md` — live observable work and user-facing updates
4. `03-health-stall-and-recovery.md` — hang/loop/stall detection
5. `04-mission-ui.md` — Pi-Web mission header, progress bar, inspector, responsive behavior
6. `05-events-and-telemetry.md` — event model and persistence
7. `06-orchestrator-integration.md` — Mission Controller / workers / AutoSpec / subprocess integration
8. `07-completion-gates.md` — communication vs action vs completion gates
9. `08-testing-and-acceptance.md` — tests and acceptance criteria
10. `09-rollout-and-migration.md` — migration and deployment
11. `IMPLEMENTATION_PROMPT.md` — execution prompt

## Non-goals

- Do not expose hidden chain-of-thought.
- Do not let models self-report arbitrary completion percentages.
- Do not make a running mission modal or block unrelated user interaction.
- Do not replace Pi-Web.
- Do not require manual `/engineer` or review commands to make observability work.
