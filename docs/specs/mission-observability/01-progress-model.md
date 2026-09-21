# 01 — Weighted Mission Progress Model

## Principle

Mission progress is calculated by Pi-Engineering from the mission DAG. Models must not provide authoritative progress percentages.

## DAG node schema

```ts
interface MissionTaskProgress {
  taskId: string;
  title: string;
  state:
    | "pending"
    | "ready"
    | "running"
    | "waiting"
    | "blocked"
    | "failed"
    | "completed";

  weight: number;

  units?: {
    completed: number;
    total: number;
  };

  startedAt?: string;
  completedAt?: string;
  lastMeaningfulProgressAt?: string;
}
```

## Calculation

Let total mission weight be the sum of all task weights.

For each task:

- `completed`: contributes 100% of task weight.
- `running` with measurable units: contributes `(completedUnits / totalUnits) * weight`.
- `running` without measurable units: may contribute only a conservative phase fraction based on deterministic lifecycle events.
- `pending`, `blocked`, `failed`: contributes 0 until resolved.

Mission progress:

```text
sum(taskContribution) / sum(taskWeight) * 100
```

Clamp active, non-complete missions to `< 100`.

## Weight generation

Weights should be based on work type and the actual mission plan.

Default phase guidance:

| Phase | Typical share |
|---|---:|
| Planning / decomposition | 5–10% |
| Implementation | 35–55% |
| Integration | 5–15% |
| Validation/tests | 10–20% |
| Independent review | 5–15% |
| Repair | dynamic |
| Final validation | 3–8% |

These are defaults, not hardcoded universal values.

## Dynamic repair work

Review findings may add repair nodes to the DAG. When new required work appears, the denominator may grow and the displayed progress may move backward.

That is acceptable and truthful.

UI copy should use `~68%`, not `68% complete`, before verification.

## Measurable unit examples

Use real units where possible:

- tests: `34 / 81`,
- files migrated: `8 / 14`,
- packages built: `3 / 5`,
- review findings repaired: `4 / 7`,
- AutoSpec issues completed: `12 / 19`,
- worktree merges: `2 / 3`.

## Completion

`100%` is reserved for a mission whose CompletionGate passed.

A mission in final validation should display at most `~99%`.

## Persistence

Progress data must survive:

- Pi restart,
- Pi-Web reconnect,
- worker restart,
- browser reload,
- orchestrator restart.

Reconstruct progress from persisted mission/task state and events rather than browser-local state.
