# AutoSpec Autonomous Resolution Slice

**Goal:** Dispatch live Pi incidents into the existing AutoSpec one-issue autonomous conductor and add a reversible, health-gated deployment controller.

**Scope:** AutoSpec issue ingestion gains an explicit repo-directory and autonomous dispatch boundary. Pi gains an injected deployment controller that records immutable deployment/health/rollback events. No direct production deployment command is hard-coded; operators provide the safe adapter.

**Constraints:** Worktree-only edits; no live GitHub or production deployment in tests; no destructive rollback; all external commands use argument arrays; every mutation has a version/commit identity and rollback target.

## Tasks

1. Add failing deployment-controller tests for successful promotion, missing rollback target rejection, failed health check with rollback, and rollback failure evidence.
2. Implement the Pi deployment controller and export it.
3. Add failing AutoSpec dispatch tests for `--repo-dir`, issue-scoped autonomous launch arguments, and dry-run no-launch behavior.
4. Implement live incident dispatch through the existing `autospec autonomous start --issue N` path while preserving dry-run behavior.
5. Run focused Pi/AutoSpec tests, targeted type/build checks, and local dry-run smoke; commit both worktrees.
