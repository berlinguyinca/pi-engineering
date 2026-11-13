# T09 conductor addendum — evidence-recoverability clause (deterministic, in-scope)

## Review verdict on candidate 11131ece→(worker tip)
The pure `scopeIntegrityCheck` + `PROTECTED_TASK_AUTHORITY_GLOBS` half is accepted as specified
(pure, deterministic, protected-beats-scope, bounded refs, never throws). The **wiring half is not**
the contract's wiring: the candidate blocks *before verification runs*, so
`commitAttempt()` never happens, the worktree is later `reset --hard` onto the integration head by
`resetWorktree()`, and the blocked task's diff is left only in the working tree — unreachable from any
ref. That silently contradicts the plan's second evidence clause ("Unauthorized diff never passes to
integration; **evidence remains recoverable**") and the existing `blockedEvidence()` convention
(`executor.ts:733`, `review.ts:163`) and `superseded/*` preservation (`executor.ts:1472`). The candidate
report does not disclose it.

## Required amendment (still ≤100 total changed lines vs base 11131ece, still exactly the same 2 files)
Move the gate so it runs **after** `commitAttempt()` and after verification, immediately **before**
integration, and make the blocked diff recoverable:
1. Keep `scopeIntegrityCheck` / `PROTECTED_TASK_AUTHORITY_GLOBS` exactly as they are (same signature and
   semantics) — do not touch the predicate.
2. In `attempt()`, after the attempt is committed (so the diff exists as a commit) and before the
   contract can be handed to review/integration, collect the authoritative paths from the committed
   attempt (`git diff --name-only <rt.baseCommit> HEAD`) plus untracked files
   (`git ls-files --others --exclude-standard`), run the gate with `c.scope` and the attempt refs.
   On `ok: false`: do not proceed to review or integration; set
   `rt.state.blocked_reason = "evidence: scope gate: " + refs` (the `evidence: ` prefix is what the
   existing blocked-evidence path at `executor.ts:589` consumes), record the offending paths on the
   state if a suitable existing field exists (do not add fields to `types.ts` — it stays denied),
   `setStatus(rt, "blocked", …)`, emit a `phase` event with the same refs, and return `"done"`.
3. Preserve the diff: before returning, tag or branch the attempt commit so a `resetWorktree()` cannot
   orphan it — reuse the existing `superseded/` naming convention already implemented there (e.g.
   `refs/heads/superseded/<branch>-<stamp>`, collision-suffixed the same way) via `git branch <ref> <own>`
   on `rt.worktree!.path`, and include that ref name in the emitted `phase` event so a human can
   `git show` it. Never delete or reset in this path.
4. If the pre-existing `scopeViolations` review signal at `executor.ts:742` now becomes redundant,
   leave it in place (review still reports it) — do not change review behaviour.
5. Update only the same test file if needed; the predicate tests must remain (all of them), and add one
   assertion that the blocked-reason string starts with `evidence: scope gate: ` by calling the same
   exported helper you use in the wiring (extract a tiny exported pure function
   `scopeGateBlockedReason(refs: string): string` if that keeps it testable without an executor).
