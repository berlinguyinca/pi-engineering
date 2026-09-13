# Evidence — Milestone: Task DAG planning + execution (priority #3)

Decompose a large goal into an ordered, dependency-aware task DAG and execute
each task through the standard pipeline (spec §11, §19).

## What changed

- **`plan(goal)`** — a planner worker decomposes a goal into machine-readable
  tasks (`details.tasks`: title, kind, risk, `depends_on` indices, `scope_paths`),
  recorded as ledger `Task` entities with dependency edges resolved to real task
  ids. A `WorkItemStatus.PARTIAL` status was added.
- **`executePlan(planId)`** — topological sort (Kahn, cycle + unknown-dep
  detection), write-scope conflict detection recorded, and sequential execution
  of each task through `engineer()` in dependency order. Tasks whose dependencies
  failed are marked blocked; executed tasks are linked to their result work item
  (`Task.result_work_item_id`); plan status COMPLETED/PARTIAL/FAILED.
- **Pure DAG helpers** (`src/plan/taskDag.ts`): `topoSort`, `tasksConflict`,
  `blockedByFailure` — deterministic and unit-tested.
- **`/plan` and `/execute`** commands wired into the extension.

## Machine evidence

- `npm run typecheck` — passes.
- `npm test` — **60/60 passing**.
- New tests:
  - `test/unit/taskdag.test.ts`: topoSort ordering, cycle detection, unknown-dep
    detection, write-scope conflict detection, transitive block propagation (5).
  - `test/integration/dag.test.ts`: plan+executePlan runs a 2-task dependency
    DAG (both completed, linked, promoted, plan COMPLETED); a failing root blocks
    downstream tasks (2).

## Real-model dogfood (fresh fixture, `qwen3.8-27b`)

Goal: add `clamp(value,min,max)` then `round(value,digits)` to `src/math.js`,
export both from `src/index.js`, add passing tests.

| Step | Result |
| --- | --- |
| Plan | **3 tasks** with correct edges: T2 depends T1, T3 depends T1+T2 (73s) |
| Execution | all **3 completed**, plan **COMPLETED** (468s) |
| Blocked/failed workers | **0** |
| Fixture tests | **5/5 pass** |
| Tool calls | 99 |
| Max worker context | 17.6k |

Merged result verified: `clamp` and `round` implemented in `src/math.js`,
re-exported from `src/index.js`, covered by passing tests.

## Verification caching + `/verify full` (same batch)

- `CommandVerifier.detect()` caches per-repo keyed on cwd + package.json content
  (invalidated on change). Test: unchanged package.json returns the identical
  cached profile; a change re-derives.
- `detect(cwd, { full })` adds `lint` + `test:full`/`test:all` stages; `/verify
  full` records the broader suite as evidence. Test: full profile includes lint
  and test:full; normal profile does not.

## Tournament refinements (same batch)

- Configurable winner-selection strategy (`findings` | `changes` | `stable`).
  Test: under `findings` the 0-finding 2-file candidate wins; under `changes`
  the 1-file candidate wins.
- Optional clean-room challenger pass over the top two finalists (high/critical
  risk) that can promote the runner-up. Test: challenger promotes the runner-up
  (1-file) candidate over the findings leader.

## Lint/format gate (biome)

- `@biomejs/biome` + `biome.json` (2-space, 120 width). `npm run lint` and
  `npm run format`. Safe fixes + formatting normalization applied across the
  codebase; `noExplicitAny`/`noNonNullAssertion` disabled (intentional style).
- `npm run lint` — clean.
