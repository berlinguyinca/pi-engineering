# 07 — Git Isolation and Integration
Long independent engineering workers should use isolated worktrees. Persist repo/base/branch/worktree/worker/task. Prevent accidental shared mutable checkouts. Workers create candidate commits but do not merge themselves to main. Add integration/conflict-resolution/test/review phase. Worktree creation/cleanup must be idempotent and crash-safe.
