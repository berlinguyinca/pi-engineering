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
