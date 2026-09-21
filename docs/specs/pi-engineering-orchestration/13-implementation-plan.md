# 13 — Implementation Plan

## Phase 0 — Repository discovery

Before changing code:

- inspect current Pi Engineering architecture
- identify existing engineering/review workflow implementations
- identify child/subagent support
- identify current process runner
- identify storage/event patterns
- identify PI WEB integration points
- identify tests
- document what can be reused

Do not rebuild existing functionality.

## Phase 1 — Mission core

Implement:

- mission model
- task model
- execution model
- durable state
- append-only events
- state transition validation

Tests:

- state machine
- persistence/restart
- invalid transition rejection

## Phase 2 — Intent and policy

Implement:

- semantic intent classifier
- deterministic policy engine
- repository mutation event handling
- auto-enforcement of validation/review

Tests:

- natural language routing
- workflow escalation
- hard policy gates

## Phase 3 — Unified execution broker

Implement adapters for:

- Pi child/tracked sessions or current equivalent
- `pi-subagents` if already installed/appropriate
- subprocess supervisor

Tests:

- launch
- status
- cancellation
- output/artifacts
- failure mapping

## Phase 4 — Scheduler

Implement:

- dependency resolution
- concurrency limits
- write domains
- retry policies
- cancellation propagation
- background execution

Tests:

- parallel independent tasks
- conflicting writes
- retry
- cancel

## Phase 5 — Worktrees and integration

Implement:

- worktree allocator
- cleanup
- worker handoff
- integration task
- conflict handling

Tests:

- parallel modifications
- conflict detection
- integration validation

## Phase 6 — Automatic engineering workflow

Connect:

- request -> mission
- scout/plan
- workers
- integration
- validation
- review
- repair
- completion

Prove `/engineer` is not required.

## Phase 7 — Review/completion gates

Implement:

- fresh reviewers
- structured findings
- specialty routing
- repair cycles
- deterministic completion gate
- completion evidence artifact

Prove models cannot mark a failing mission complete.

## Phase 8 — PI WEB integration

Integrate with existing `jmfederico/pi-web`.

Prefer plugin/provider APIs.

Display:

- mission
- task graph
- agents
- processes
- worktrees
- review findings
- validation
- completion state

Add controls for steering/cancel/retry where supported.

Do not rebuild PI WEB.

## Phase 9 — Metrics and optimization

Add:

- model usage
- duration
- tokens
- queue time
- review/rework metrics
- adaptive model routing hooks
- InferWeave capability-based selection

## Acceptance tests

### Scenario A — Simple feature

User:

```text
Add a health endpoint.
```

Expected:

- engineering mission automatically created
- implementation occurs
- tests run
- fresh review occurs
- completion evidence returned

### Scenario B — Investigation escalates

User:

```text
Find out why login fails.
```

Expected:

- starts investigation
- mutation triggers engineering/review requirements
- final validation and review happen automatically

### Scenario C — Parallel feature

User:

```text
Add backend and frontend support for feature X.
```

Expected:

- decomposition
- non-overlapping workers run concurrently
- worktrees where required
- integration task
- validation/review

### Scenario D — Reviewer finds defect

Expected:

- mission does not complete
- repair task created
- validation reruns
- re-review occurs as policy requires

### Scenario E — user steering

While active:

```text
Do not change the database schema.
```

Expected:

- mission constraint updated
- affected child is steered/canceled
- stale work invalidated
- task graph adjusted

### Scenario F — PI WEB

Expected:

- parent remains primary session
- child session/task links are visible
- mission progress survives restart
