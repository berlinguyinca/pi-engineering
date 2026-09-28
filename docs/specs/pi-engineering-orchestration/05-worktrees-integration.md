# 05 — Worktree Isolation and Integration

## Goal

Make parallel coding safe.

## Policy

Read-only tasks may share the main worktree.

Mutating tasks:

- trivial sequential tasks may use the primary worktree,
- parallel mutating tasks should use dedicated Git worktrees,
- tournament/candidate tasks must use separate worktrees.

## Worktree lifecycle

```text
allocate
 -> prepare base ref
 -> execute worker
 -> record patch/commit
 -> handoff
 -> integrate
 -> validate
 -> cleanup
```

Cleanup must not destroy evidence needed for debugging/replay.

## Workspace manifest

Allocate worktrees only from repository bindings in the mission's durable
workspace manifest. Each binding records canonical root, remote identity, base
SHA, write domains, and validation profile. Absolute paths explicitly named by
the user may be authorized autonomously after canonicalization and safety
validation; discovery cannot escape an authorized root.

Preflight implementer, validator, integrator, and reviewer access through the
actual tools they will use. Mentioning a path in a prompt is not proof of access.

## Integration role

Create an explicit `integrator` task/role.

Responsibilities:

- gather worker handoffs,
- inspect overlapping edits,
- combine candidate changes,
- resolve merge conflicts,
- reject incompatible changes when needed,
- run fast integration checks,
- produce one integrated candidate for review.

Workers implement.
Integrator integrates.
Reviewers review.

Do not make the parent manually stitch together large parallel patches unless required.

Integration occurs in an isolated candidate worktree/ref. It must not merge
worker branches directly into the incumbent checkout before validation and
review. Conflict, cancellation, validation failure, and review failure leave the
incumbent HEAD, index, and tree unchanged.

All repository mutations require a durable repository-scoped lease and fencing
token. Late results from superseded executions cannot mutate the candidate.

Multi-repository missions record a repository-head vector and promotion order.
Push, PR, review, check, and merge actions carry durable idempotency keys and
must reconcile existing external state before retry.

## Candidate/tournament mode

Support multiple independent candidates for difficult tasks.

Example:

```text
candidate A
candidate B
candidate C
   |
   v
independent evaluator/reviewer
   |
   v
selected candidate
```

Candidate selection must be based on explicit acceptance criteria and validation evidence.
