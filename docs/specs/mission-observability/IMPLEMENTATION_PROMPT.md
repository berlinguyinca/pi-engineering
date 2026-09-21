# Implementation Prompt

You are in the root of the existing `pi-engineering` repository.

Implement the Pi-Engineering Mission Observability specification package contained in the downloaded ZIP `pi-engineering-mission-observability-specs.zip`.

## First: load the specs

1. Locate the ZIP, normally in `~/Downloads`.
2. Extract/copy its contents into:

```text
docs/specs/mission-observability/
```

Do not overwrite unrelated specs.

3. Read every file in that directory before changing code, especially:
   - `00-master-spec.md`
   - `01-progress-model.md`
   - `02-live-activity-and-output.md`
   - `03-health-stall-and-recovery.md`
   - `04-mission-ui.md`
   - `05-events-and-telemetry.md`
   - `06-orchestrator-integration.md`
   - `07-completion-gates.md`
   - `08-testing-and-acceptance.md`
   - `09-rollout-and-migration.md`

## Then inspect the existing implementation

Before coding, locate and document:

- Mission model/controller/state machine
- DAG/task representation
- current code that emits or renders `MISSION`
- any code that suppresses normal output while a mission is active
- Pi-Web integration points
- worker/subagent/subprocess lifecycle
- AutoSpec integration
- engineering/review workflow
- test/build process event sources
- repository/worktree/commit tracking
- persistence/event infrastructure
- WebSocket/SSE/realtime infrastructure
- InferWeave request/admission metadata if already available
- Slurm job/worker integration if already available

Do not reimplement Pi-Web or external tools. Integrate with the existing architecture.

## Critical architectural rule

An active mission must NOT suppress ordinary user-visible communication.

Separate these concepts:

1. Communication Gate — normally open.
2. Action Gate — authority/safety dependent.
3. Completion Gate — strict and evidence-based.

A mission may block itself from claiming completion, but it must never block Pi from reporting progress, answering the user, or supervising independent work.

## Implement

Implement the specs in dependency order.

At minimum deliver:

### 1. Mission observability data model

Add canonical mission observability state including:

- approximate weighted progress,
- phase,
- health,
- current objective,
- current observable activity,
- worker summary,
- last heartbeat,
- last meaningful progress,
- explicit waiting reason,
- completion verification state.

### 2. Weighted DAG progress

Progress must be calculated by Pi-Engineering.

Do NOT trust an LLM-provided percentage.

Support measurable work units such as tests completed/total.

Do not render 100% until CompletionGate passes.

### 3. Structured mission events

Instrument mission controller, workers, subprocesses, tests, review, repository changes, and model/wait states using the project’s existing event/persistence patterns.

Do not create a parallel architecture unless absolutely required.

### 4. Heartbeat vs meaningful progress

Track both separately.

A live heartbeat without meaningful progress must be capable of becoming SLOW/STALLED.

### 5. Stall/loop detection

Detect repeated no-progress activity such as:

- repeated reads of the same file,
- repeated identical tool calls,
- repeated model/tool cycles,
- no diff changes,
- no DAG transition,
- no test advancement,
- repeated same error/retry.

Use configurable thresholds appropriate to the activity type.

### 6. Automatic recovery visibility

Existing or new bounded recovery actions must emit mission events and be visible in Pi-Web.

### 7. User-facing mission updates

Replace opaque `MISSION` output with concise meaningful status.

Emit updates on significant phase/task/test/review/stall/recovery transitions and at a conservative long-running visibility interval.

Never expose hidden chain-of-thought. Only show observable engineering activity.

### 8. Pi-Web compact mission view

Implement:

- mission title,
- health,
- phase,
- approximate progress bar,
- current activity,
- active/waiting worker count,
- last meaningful progress,
- phase pipeline.

It must work on desktop, tablet, and phone.

### 9. Mission Inspector

Provide:

- Overview
- Tasks
- Workers
- Activity
- Changes
- Tests
- Review
- Artifacts
- Errors

Reuse existing Pi-Web component/design patterns where possible.

### 10. Multiple missions

Ensure an active or blocked mission does not monopolize the session or suppress other mission/conversation output.

### 11. Persistence/reconnect

Mission observability must survive browser reconnect and process restart using persisted mission/task/event state.

### 12. Tests

Implement the unit, integration, UI, and end-to-end scenarios in `08-testing-and-acceptance.md`.

The synthetic E2E flow must include:

planning → execution → queue wait → test progress → intentional stall → recovery → review blocker → repair → re-review → final validation → verified complete.

## Engineering workflow

Use the normal Pi-Engineering engineering and review workflows automatically. Do not require me to invoke `/engineer` or `/review`.

Decompose work into mission tasks/subagents where helpful, but keep the parent mission observable throughout.

Run independent review on the final implementation.

Repair all blocking findings.

Run final validation after repairs.

## UI quality

The UI must be visually coherent with the existing Pi-Web application.

Do not bolt on a debug-looking panel.

Reuse components and design tokens, keep information hierarchy clear, and make the compact mission view readable at a glance.

Avoid UI that relies on color alone.

## Backward compatibility

Existing missions without the new telemetry must still render without crashing.

Use degraded states such as `Progress unavailable` where required.

Do not break stored mission records.

## Final evidence

Do not merely say "done."

At completion, show:

- files changed,
- architecture summary,
- tests executed and results,
- UI/E2E validation evidence,
- review findings and repairs,
- any migrations,
- any remaining non-blocking limitations,
- confirmation that active missions no longer suppress ordinary Pi output,
- confirmation that `100% · VERIFIED COMPLETE` is only produced after the CompletionGate passes.

If implementation reveals architectural conflicts with these specs, prefer preserving the core invariants and document the exact deviation and reason.
