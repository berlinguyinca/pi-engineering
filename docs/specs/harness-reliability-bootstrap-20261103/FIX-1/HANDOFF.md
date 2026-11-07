# HANDOFF FIX-1 — the scope guard must see the paths of the commit under review

You are a **single microtask worker** on branch `fix/fix1-diff-scope-commit-paths`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix1-diff-scope-20261103` (base SHA
`cc036f2f8c3b938c80348dff821af77c973fde7b`, repo `berlinguyinca/pi-engineering-runtime`).
Read this whole file before editing anything. Work **only** inside that worktree.

## Defect (evidence, do not re-derive — it is already proved)

`src/bootstrap/diffGuard.ts::evaluateDiffScope()` computes `changedPaths`, `productionFiles` and
`testFiles` **only** from `git status --porcelain`. The handoff-stamping run (`scripts/bootstrap-one.ts
--emit-handoff`) is required to run on a **clean** worktree at the task commit, so porcelain is empty
and every allow/deny path grant and both per-file budgets become vacuous. Only
`added + deleted <= maxChangedLines` (from `git diff --numstat HEAD^1 HEAD`) still bites.

Negative control already run (see
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/E02/logs/08-gate-scope-gap.txt`):
a manifest whose `allowPaths` omitted `test/unit/error-event.test.ts` and whose `denyPaths` contained
`test/**` was **accepted** for a commit that adds exactly that file, while the same manifest with
`maxChangedLines: 50` correctly rejected. So the line budget works; the path/file half does not.

## Required change

`evaluateDiffScope()` must evaluate path grants, generated-file checks, the read-only check and the
**file budgets** over the **union** of working-tree paths (porcelain) and the paths present in `numstat`
(the commit under review), de-duplicated and sorted. `numstat` paths are already parsed into `rows`
(`{ path, added, removed, binary }`) — reuse them; do **not** add a new git invocation, do **not** change
the exported `DiffMetadata` shape, do **not** change the function signature, and do **not** touch
`scripts/bootstrap-one.ts`, `src/bootstrap/resultGate.ts`, `src/bootstrap/pathPolicy.ts` or
`src/bootstrap/taskManifest.ts`.

Implementation must stay pure and read-only exactly as the file header promises. Keep or improve the
existing determinism (violations sorted by kind, path, detail).

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/bootstrap/diffGuard.ts`
- `test/unit/bootstrap-diff-guard.test.ts`

Budget: at most **1 production file, 1 test file, 100 changed lines total (added + deleted)**.

## Acceptance criteria (all must hold, and be *proved by output you paste in your report*)

1. A clean-tree case — `porcelain: ""`, `numstat: "4\t0\ttest/unit/x.test.ts\n"` — with a manifest that
   allows only `src/bootstrap/**` and denies `test/**` yields `report.ok === false` and a
   `denied-path` violation naming `test/unit/x.test.ts`.
2. File budgets count committed paths: a `numstat` listing 3 production paths against
   `maxProductionFiles: 1` yields `production-file-budget`, and `report.productionFiles === 3`.
3. A commit path that is neither allowed nor denied yields `unexpected-path` even with an empty
   porcelain.
4. Union semantics: a path appearing in **both** porcelain and numstat is counted **once**
   (assert `changedPaths` and the file counts).
5. Existing behavior is preserved: binary-change, generated-file, symlink, read-only-mode and
   changed-line-budget behavior unchanged; `changedPaths` stays sorted; metadata stays read-only.
6. Update the expectations of the first existing test *upward* to the union semantics (the numstat-only
   path `src/assets/logo.png` now also appears in `changedPaths`, so `productionFiles` becomes 6 and an
   `unexpected-path:src/assets/logo.png` violation appears). This is the **only** permitted expectation
   change, and it must become **stricter** — never delete an assertion, never weaken `deepEqual` into a
   looser check, never mark anything skip/todo.

## Verification (run all of these, from the worktree root, and paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-diff-guard.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-package.test.ts test/unit/bootstrap-path-policy.test.ts test/unit/bootstrap-task-manifest.test.ts
git diff --numstat HEAD
```

All must exit 0 and the last line must show your two files within budget. If a command fails, **stop and
report the failure verbatim** — do not work around it, do not loosen a test, do not widen your file scope.

## Commit and report

1. `git add` only your two files and commit: `fix(bootstrap): scope guard must see committed paths (FIX-1)`
   (one commit, on your current branch).
2. Write `FIX-1/WORKER_REPORT.md` in **this** directory
   (`/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-1/`):
   what you changed, the exact commands with exit codes, the numstat totals, the commit SHA, and anything
   you believe is wrong or risky — including in the *defect* itself if you disagree with the diagnosis.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git worktree`, `git checkout` of another
branch, editing `package.json`, installing dependencies, touching files outside the two allowed paths,
deleting tests, `--no-verify`, or any command that mutates state outside your worktree.
