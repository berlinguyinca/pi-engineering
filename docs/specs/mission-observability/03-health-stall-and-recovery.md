# 03 — Mission Health, Stall Detection, and Recovery

## Problem

A process can be alive while making no progress.

Therefore Pi-Engineering must track at least:

```text
lastHeartbeatAt
lastMeaningfulProgressAt
```

These are not equivalent.

## Health states

### ACTIVE

Recent meaningful progress is occurring within expected bounds.

### WAITING

No progress is expected because the mission is knowingly waiting.

Must include a reason.

Examples:

- InferWeave admission queue,
- worker dependency,
- build/test subprocess,
- external service,
- human approval,
- credential,
- rate limit.

### SLOW

Meaningful progress continues but cadence is outside expected baseline.

### STALLED

Worker/process remains alive but no meaningful progress has occurred beyond the configured threshold.

### BLOCKED

The system cannot proceed without resolving an explicit dependency or external condition.

### FAILED

A required task/process failed and automatic recovery is exhausted or impossible.

## Meaningful progress

Examples:

- new source diff,
- task state transition,
- test count advancing,
- test result changed,
- build stage advanced,
- artifact created,
- review finding produced,
- repair finding closed,
- worker produced a new deliverable,
- queue position materially changed,
- model output advanced toward a bounded task.

Heartbeats alone are not progress.

## Loop indicators

Detect repeated behavior such as:

- same file repeatedly read without changes,
- same tool invocation repeated,
- same error repeated,
- repeated model/tool cycle with no new artifact,
- unchanged git diff,
- unchanged test position,
- repeated retries against the same failure,
- excessive output with no DAG state change.

## Example stall event

```text
⚠ POSSIBLE STALL

frontend-worker-2 has been active for 6m 42s without meaningful progress.

Observed:
- same file read 9 times
- no source changes for 6m
- 4 repeated model/tool cycles

Automatic recovery attempt 1/3 started.
```

## Recovery policy

Recovery actions may include:

1. cancel/restart the bounded worker task;
2. rehydrate context from mission state;
3. summarize current evidence;
4. switch compatible model/provider via InferWeave policy;
5. split the task into smaller units;
6. reassign to another worker;
7. clear stale subprocess/lease;
8. escalate to parent orchestrator;
9. mark BLOCKED when external intervention is genuinely required.

All recovery attempts become mission events.

## Config

Thresholds should be configurable per activity type because a test suite, compile, model request, and file edit have different normal latencies.

Do not apply one universal "stuck after N seconds" value.

## UI

Always show:

```text
Last heartbeat: 3s ago
Last meaningful progress: 18s ago
Health: ACTIVE
```

When waiting:

```text
WAITING — InferWeave admission
Waiting: 31s
Requested capability: vision + coding
```
