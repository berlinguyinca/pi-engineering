# HANDOFF-2 FIX-3C — finish the unit the previous worker could not commit

Worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix3c-schema-gate-20261104`, branch
`fix/fix3c-schema-gate-at-stamp`, base `0ddf27714f80a8e98d01d4662c0242b789de15c7`.
Read `HANDOFF.md` in this same directory first — it is the contract; this file only states the delta.

A previous worker was killed by a model-capacity failure and left **`scripts/bootstrap-one.ts` modified but
uncommitted** (`git diff` is archived in `logs/01-worker-partial-diff.txt`, 19 added / 6 deleted). It added a
`--handoff-schema` flag, a `preStampSchema()` helper that turns absent/unreadable/non-JSON schema or record
into blockers, folded `validateHandoffSchema` blockers into the gate's blocker list, switched the stamp to
`writeHandoff` from `src/bootstrap/handoffWriter.ts`, and prints `schema=<taskId> conforms <path>` on success.

Your job:
1. Read the current `scripts/bootstrap-one.ts` and judge that change against the acceptance criteria in
   `HANDOFF.md`. Keep it if correct; fix it if not (e.g. the stray `export { canonicalHash};` spacing nit).
2. Add the missing tests to `test/unit/bootstrap-one.test.ts` for the four acceptance criteria: missing
   `--handoff-schema` → exit 5 + nothing written; a record violating the real
   `docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json` → exit 5 with the
   validator's path-named blocker + nothing written; non-existent and non-JSON `--handoff-schema` → exit 5,
   no stack trace, nothing written; a conforming record → exit 0, file written, `conforms` line printed.
   Reuse the existing helpers in that file; use `mkdtempSync` and clean up; **do not create git worktrees**.
3. Existing assertions in that file and in `test/unit/bootstrap-package.test.ts` must stay untouched.

Budget: only `scripts/bootstrap-one.ts` + `test/unit/bootstrap-one.test.ts`; **total changed lines of your
single commit ≤ 85** (the partial diff already uses 25). Verify with the four commands in `HANDOFF.md`
(typecheck, bootstrap-one suite, `test/unit/bootstrap-*.test.ts`, `git diff --numstat HEAD~1 HEAD`), then make
ONE commit `fix(bootstrap): schema-validate handoffs at stamp time (FIX-3C)` and write
`FIX-3C/WORKER_REPORT.md` in the conductor run directory. If the gateway switches your model away from
`metabolomics/qwen3.8-flash_next`, state that in the report. If any verification fails, stop and report it
verbatim — no workarounds. Never push, merge, rebase, amend, reset, create worktrees, install, or widen scope.
