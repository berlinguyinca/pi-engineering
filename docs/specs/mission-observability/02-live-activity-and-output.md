# 02 — Live Activity and User-Facing Mission Output

## Goal

Show what Pi-Engineering is actually doing without exposing hidden chain-of-thought.

## Observable activities

Allowed activity types include:

```text
planning
reading_file
editing_file
creating_file
deleting_file
running_command
running_test
building
linting
typechecking
waiting_for_model
waiting_for_queue
waiting_for_worker
waiting_for_dependency
model_request
worker_started
worker_completed
tool_invocation
artifact_created
git_diff
git_commit
integration
review_started
review_finding
review_completed
repair_started
repair_completed
validation
retry
error
recovery
```

## Not allowed

Never expose:

- hidden chain-of-thought,
- private scratchpad reasoning,
- raw internal reasoning tokens,
- unsupported guesses about what a model is "thinking."

Convert internal work into concise observable summaries.

Example:

```text
frontend-worker-2 · Editing apps/console/components/EventDrawer.tsx
```

not:

```text
The model is thinking through whether state should be...
```

## Mission activity stream

Persist and render events such as:

```text
11:20:51  frontend-2   Editing EventDrawer.tsx
11:20:48  frontend-2   Added event detail tabs
11:20:43  test-1       Component tests 34/81
11:20:39  backend-1    Completed event summary endpoint
11:20:33  reviewer-1   Waiting for implementation
11:20:23  orchestrator Assigned console-event-drawer → frontend-2
```

## User-facing progress messages

An active mission should periodically produce concise normal assistant output.

Trigger messages on:

- mission phase transition,
- major DAG node completion,
- worker start/stop/failure,
- validation start/end,
- material test failure,
- review start/end,
- repair start,
- blocking condition,
- stall detection,
- recovery attempt,
- meaningful progress after a prolonged quiet period,
- configurable long-running visibility interval.

Do not emit a message for every low-level event.

### Example

```text
Mission · Console UI Refactor · ~74%

Event timeline implementation finished.
Component tests: 61/81 passed; one currently failing.
The frontend worker is repairing the drawer-state test.
```

## Quiet-period updates

If a mission remains active but no transition-level event has occurred for a configurable interval, emit a health summary if the user is attached to the session.

Example:

```text
Mission · Console UI Refactor · ~76%

Still running integration tests: 418/827.
Last meaningful progress 18s ago; health is ACTIVE.
```

## Current activity selection

When several workers are active, choose the most mission-relevant activity for the compact view, while the inspector shows all workers.

Priority guidance:

1. blocker/failure/recovery,
2. validation/review,
3. primary critical-path implementation task,
4. integration,
5. secondary parallel work.

## Output channel rule

Never implement:

```ts
if (mission.state !== "COMPLETE") suppressUserOutput();
```

Instead, terminal-completion wording must pass CompletionGate while ordinary output remains available.
