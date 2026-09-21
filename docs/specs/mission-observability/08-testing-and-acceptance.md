# 08 — Testing and Acceptance Criteria

## Unit tests

Cover:

- weighted progress calculation,
- dynamic DAG expansion,
- measurable unit progress,
- clamp below 100 before verification,
- completion gate transition,
- health state derivation,
- waiting reason handling,
- heartbeat vs meaningful progress,
- loop heuristics,
- event projection,
- reconnect/idempotency.

## Integration tests

### Active mission output

Given an EXECUTING mission,
when the user sends an ordinary question,
Pi can answer while the mission remains active.

### Progress

Given a DAG with weighted nodes,
when tasks advance,
the mission percentage updates deterministically.

### Tests

Given a task running 81 tests,
when test results advance from 34 to 35,
the mission records meaningful progress.

### Waiting

Given an InferWeave admission wait,
the mission renders WAITING with a reason and is not labeled STALLED.

### Stall

Given recurring heartbeat but no meaningful progress beyond the task threshold,
the mission becomes STALLED and records a recovery attempt.

### Review

Given implementation complete but review still running,
the mission cannot display 100% or VERIFIED COMPLETE.

### Reconnect

Reload Pi-Web during an active mission.
The current progress, activity, worker state, and history must reconstruct correctly.

### Multiple missions

Run two missions concurrently.
Progress/output for one must not suppress or corrupt the other.

## UI tests

Test at desktop/tablet/phone widths.

Verify:

- progress bar visible,
- text health indicator visible,
- current activity visible,
- last progress visible,
- inspector opens,
- tabs render,
- task/worker updates stream,
- long text truncates safely,
- keyboard navigation,
- ARIA progress values,
- no color-only state representation.

## End-to-end scenario

Create a synthetic mission:

1. planning,
2. 3 implementation tasks,
3. one worker waits for model admission,
4. tests run with measurable counts,
5. one worker intentionally loops,
6. stall detector triggers,
7. recovery reassigns work,
8. implementation completes,
9. reviewer finds blocker,
10. repair executes,
11. re-review succeeds,
12. final validation succeeds,
13. CompletionGate passes.

The UI and activity stream must make every phase understandable.

## Acceptance criteria

The feature is accepted only when:

- the generic `MISSION` output is replaced by useful mission status;
- active missions no longer suppress ordinary Pi communication;
- all active missions show approximate progress;
- current activity is visible;
- last meaningful progress is visible;
- waiting has an explicit reason;
- stalls can be detected despite healthy heartbeats;
- recovery is observable;
- Mission Inspector provides task/worker/activity/test/review detail;
- progress survives reconnect/restart;
- 100% appears only after CompletionGate pass;
- existing mission/review/autospec behavior remains functional.
