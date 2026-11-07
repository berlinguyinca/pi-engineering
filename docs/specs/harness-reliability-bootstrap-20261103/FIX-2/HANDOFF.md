# HANDOFF FIX-2 — the emit path must validate `parentHandoffHash` before it stamps

You are a **single microtask worker** on branch `fix/fix2-parent-validation-at-stamp`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix2-parent-stamp-20261104` (base SHA
`04846ae2e5346cce8729994d96e870fe2f56015f`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is already provisioned by the conductor (symlink) — never install anything.
Read this whole file before editing anything. Work **only** inside that worktree.

## Defect (already proved, do not re-derive)

`scripts/bootstrap-one.ts` validates the parent handoff **inside `bootstrapOne()`**, after
`if (obs.headSha !== manifest.baseSha) return { exitCode: 3, … }`. Stamping a task commit always runs
with `HEAD == taskCommit != manifest.baseSha`, so the plan returns exit 3 and **parent validation never
runs** — and exit 3 is not a gate blocker (the emit path only blocks on exit 2 and 4). Proof:
`../E02/logs/05-cli-accepted.txt` (stamping, no `parent=` line, `gate=accepted`) versus
`../E02/logs/06-parent-accepted.txt` (parent verified only in a separate plan-only run at the base commit).
Consequence: the handoff chain is asserted in the record but never verified at the moment the handoff is
written.

## Required change

1. Extract the parent-handoff checks into one **exported pure function** in `scripts/bootstrap-one.ts`,
   e.g. `export function validateParentHandoff(manifest: TaskManifest, parentHandoffText: string | null): string[]`
   returning blocker strings (empty array = valid, and when `manifest.parentHandoffHash === null` it must
   return `[]`). It must cover exactly the checks that exist today: missing parent text when the manifest
   declares a hash; parent not valid JSON; stored `handoffHash != canonicalHash(parent)`; canonical hash
   `!= manifest.parentHandoffHash`; `parent.nextTaskId !== manifest.taskId`;
   `parent.nextBaseSha !== manifest.baseSha` (only when it is a string).
2. `bootstrapOne()` must call it and keep its **current** behaviour and messages for the plan path
   (exit 4 `REJECT handoff: …`, and the `parent=<taskId> accepted <prefix>…` acceptance line).
3. The `--emit-handoff` path must call it **unconditionally**, independent of `plan.exitCode`, and fold its
   blockers into the existing `blockers` list so a bad or missing parent yields `REJECT gate: …`,
   `process.exitCode = 5`, and **no handoff file is written**. When the parent is valid, print the same
   `parent=… accepted …` line on the stamping run so the verification is visible in the log.
4. Do not change `writeHandoff`, `canonicalHash`, `evaluateResultGate`, `diffGuard.ts`, `pathPolicy.ts`,
   `taskManifest.ts`, exit-code meanings, or the CLI flag surface. No new dependency. Keep the file's
   documented behaviour (no model call, no scheduler import, read-only).

## Files you may change (nothing else — the merge is rejected otherwise)

- `scripts/bootstrap-one.ts`
- `test/unit/bootstrap-one.test.ts`

Budget: at most **1 production file, 1 test file, 100 changed lines total (added + deleted)**.

## Acceptance criteria (all must hold, and be *proved by output you paste in your report*)

1. `validateParentHandoff` is exported and pure: `manifest.parentHandoffHash === null` → `[]`; a correct
   parent fixture → `[]`.
2. **Missing parent at stamp time**: manifest declares `parentHandoffHash`, no `--parent-handoff` supplied,
   clean tree at the task commit → `REJECT gate:` naming the missing parent, exit code 5, and the output
   directory contains **no** `<taskId>.handoff.json`.
3. **Tampered parent**: parent file whose stored `handoffHash` does not equal `canonicalHash(parent)` →
   rejected at stamp time (exit 5, nothing written).
4. **Wrong sequence**: parent whose canonical hash is correct but `nextTaskId` is not the manifest's
   `taskId` → rejected at stamp time.
5. **Valid chain**: a synthetic parent fixture built with `canonicalHash` such that `nextTaskId` equals the
   manifest `taskId` and `nextBaseSha` equals the manifest `baseSha` → stamping succeeds (exit 0) and stdout
   contains `parent=` and `accepted`.
   Build the fixture inside the test (import `canonicalHash` from `../src/bootstrap/resultGate.ts`) — do not
   hand-copy a hash. Use a temporary directory (`mkdtempSync(join(tmpdir(), …))`) for the stamping run and
   clean it up; if you need a git worktree for the clean-tree requirement, use an existing one read-only and
   never mutate it — **do not create or remove git worktrees**.
6. The two existing tests in `test/unit/bootstrap-one.test.ts` keep passing **unmodified**, and
   `test/unit/bootstrap-package.test.ts` keeps passing unmodified. Do not weaken any assertion, do not skip
   or todo anything, do not delete a case.

## Verification (run all from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-diff-guard.test.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-package.test.ts test/unit/bootstrap-path-policy.test.ts test/unit/bootstrap-task-manifest.test.ts
git diff --numstat HEAD
```

All must exit 0 and the last must show only your two files inside budget. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened tests, no scope widening.

## Commit and report

1. `git add` only your two files; one commit: `fix(bootstrap): verify parent handoff at stamp time (FIX-2)`.
2. Write `FIX-2/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-2/`:
   what changed, commands with exit codes, numstat totals, commit SHA, and anything you think is wrong or
   risky — including in the diagnosis itself if you disagree.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git worktree`, checking out another branch,
editing `package.json`, installing dependencies, touching files outside the two allowed paths, deleting or
weakening tests, `--no-verify`, or any state mutation outside your worktree.
