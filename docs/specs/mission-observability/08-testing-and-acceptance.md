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
- orphan/deadlock/controller-disconnect classification,
- wait deadline expiry,
- acceptance coverage independent of workflow progress,
- recovery fingerprint exhaustion,
- stale execution fencing.

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

### Wrong workspace and blocked repair

Start a mission at a meta-root while its explicitly named repositories live in
another authorized workspace. Preflight binds the real repositories. If a role
cannot access candidate evidence, classify and repair the scope once; repeated
unchanged failure stops with a precise actionable reason.

### Timeout checkpoint recovery

Interrupt a worker after two of three bounded deliverables. Preserve and verify
the checkpoint, fence the old execution, split the remaining deliverable, and
resume without replaying completed work.

### Revision-bound gates

Change the candidate after green validation/review. Old evidence becomes invalid
and completion is refused until the final candidate is revalidated and
re-reviewed.

### Incumbent immutability

Cause an integration conflict and a validation failure in separate runs. In both
cases the incumbent HEAD, index, and tree remain byte-for-byte unchanged.

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

Run an additional real local-only scenario using `local/local`: interrupt the
mission, recover its checkpoint under the same mission ID, perform a fresh
same-model review with the reduced-independence warning, and complete with
revision-bound evidence.

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
- primary percentage reflects verified acceptance coverage,
- workflow progress remains separately visible,
- workerless missions are never generically ACTIVE,
- every wait and recovery has a next action/deadline,
- blocked missions can resume safely without losing mission identity,
- stale evidence and late worker results cannot authorize completion.
