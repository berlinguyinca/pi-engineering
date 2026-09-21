# 09 — Rollout and Migration

## Phase 1 — Instrumentation

- define event schemas,
- add worker activity/heartbeat/progress emission,
- add projection service/read model,
- instrument Mission Controller,
- instrument tests/review/subprocesses.

No UI dependency should be required to validate instrumentation.

## Phase 2 — Compact UI

Replace generic `MISSION` presentation with:

- title,
- progress bar,
- phase,
- health,
- current activity,
- worker count,
- last meaningful progress.

## Phase 3 — Mission Inspector

Add detailed:

- tasks,
- workers,
- activity,
- changes,
- tests,
- review,
- artifacts,
- errors.

## Phase 4 — Stall/recovery UX

Enable health derivation, stall warnings, and recovery events.

Start with conservative thresholds to avoid false positives.

## Phase 5 — Multi-mission and distributed visibility

Validate:

- parallel missions,
- subprocesses,
- AutoSpec,
- InferWeave waits,
- Slurm workers.

Prepare the projection schema for Herdr aggregation.

## Backward compatibility

Existing missions lacking new event data should render degraded but useful state, e.g.:

```text
Mission · Legacy task
Progress unavailable
EXECUTING
Last activity unavailable
```

Do not crash or hide the mission.

## Migration

Prefer additive schema migrations.

Do not invalidate existing mission records.

If old missions have no weights:
- derive fallback weights from task count/type,
- mark progress basis as inferred,
- preserve completion state.

## Feature flag

A temporary feature flag is acceptable during rollout, but the end state should make mission observability the default behavior.

## Documentation

Update project docs explaining:

- mission phases,
- progress semantics,
- health semantics,
- meaning of "last heartbeat" vs "last meaningful progress",
- completion verification,
- how workers emit activity.
