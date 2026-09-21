# 04 — Pi-Web Mission UI

## Scope

Implement Mission observability in the existing external Pi-Web integration. Do not reimplement Pi-Web.

## Compact mission header

Replace opaque `MISSION` UI with:

```text
┌───────────────────────────────────────────────────────────────┐
│ ● Console UI Refactor                           EXECUTING     │
│ ████████████████████████░░░░░░░░░░  ~68%                    │
│                                                               │
│ Implementing event timeline + detail drawer                   │
│ 2 workers active · tests 34/81 · last progress 3s ago         │
│                                                               │
│ ✓ Plan ✓ Core ● UI ○ Tests ○ Review ○ Finish                 │
└───────────────────────────────────────────────────────────────┘
```

## Required compact fields

- mission title,
- health indicator,
- phase,
- approximate progress bar,
- current objective/activity,
- active/waiting worker counts,
- last meaningful progress age,
- high-level phase pipeline.

## Health visual semantics

Must visually distinguish:

```text
ACTIVE
WAITING
SLOW
STALLED
BLOCKED
FAILED
COMPLETE
```

Do not rely on color alone; use text/icon semantics for accessibility.

## Mission Inspector

Clicking/tapping the compact header opens a detailed inspector.

### Overview

```text
MISSION: Console UI Refactor
~68%                                      ACTIVE

Current phase
EXECUTION

Current objective
Implement event timeline and event-detail drawer

Current activity
frontend-worker-2
Editing apps/console/components/EventDrawer.tsx

Started 18m 42s ago
Last heartbeat 3s ago
Last meaningful progress 3s ago
```

### Tasks

Show DAG nodes with:

- status,
- title,
- percent/units when measurable,
- worker,
- elapsed time,
- dependencies,
- blocker/waiting reason.

### Workers

Show:

- worker ID,
- state,
- current task,
- model/runtime,
- host/node if known,
- elapsed task time,
- last heartbeat,
- last meaningful progress.

### Activity

Chronological observable engineering events.

### Changes

Show repository/worktree mutations:

- files changed,
- diff summary,
- commits,
- branches/worktrees,
- integration state.

### Tests

Show:

- running suites,
- progress,
- pass/fail/skip,
- failures,
- retries,
- final validation result.

### Review

Show:

- reviewer worker/model,
- status,
- findings,
- severity,
- repair state,
- re-review state.

### Errors

Show grouped errors/retries/recovery attempts.

## Tabs

Recommended:

```text
Overview | Tasks | Workers | Activity | Changes | Tests | Review | Artifacts | Errors
```

## Progress history

Include a small trend/history view:

```text
10:58 Mission created
11:00  8% planning
11:04 22% backend implementation
11:09 41% frontend implementation
11:13 53% tests
11:15 53% InferWeave queue
11:17 54% resumed
11:21 68% UI implementation
```

A flat segment must make prolonged no-progress periods visually obvious.

## Responsive behavior

### Desktop
- compact mission card in primary conversation/workspace view;
- inspector can use side panel or full-width detail view.

### Tablet
- compact header remains fully usable;
- inspector uses drawer/full-screen panel.

### Phone
Prioritize:
1. title,
2. progress,
3. health,
4. current activity,
5. last progress,
6. expand control.

Avoid dense worker/task tables; render stacked cards.

## Multiple missions

A session may show multiple active missions.

One mission must not become a modal state that prevents:
- asking questions,
- steering another mission,
- opening another mission,
- ordinary Pi conversation.

## Accessibility

- keyboard navigable,
- screen-reader labels for progress and health,
- no color-only states,
- progress uses `aria-valuenow`,
- live updates use non-disruptive ARIA live regions.
