# WORKER REPORT FIX-1 — diff scope must see the paths of the commit under review

- Branch: `fix/fix1-diff-scope-commit-paths`
- Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix1-diff-scope-20261103`
- Base SHA: `cc036f2f8c3b938c80348dff821af77c973fde7b`
- Commit SHA (one commit, not pushed, not amended): **`04846ae2e5346cce8729994d96e870fe2f56015f`**
  message: `fix(bootstrap): scope guard must see committed paths (FIX-1)`
- Files changed (exactly the two allowed): `src/bootstrap/diffGuard.ts`, `test/unit/bootstrap-diff-guard.test.ts`
- Working tree after commit: `git status --porcelain` → empty.

## What changed

`src/bootstrap/diffGuard.ts` (one behavioural line + 2 comment lines + 2 inline comment lines):

```diff
-  const changedPaths = porcelainPaths(meta.porcelain);
   const { rows, added, deleted } = numstatRows(meta.numstat);
+  // Committed paths must join the scope set: at the stamping commit the tree is clean, so porcelain
+  // is empty while numstat still names every file the task actually changed.
+  const changedPaths = [...new Set([...porcelainPaths(meta.porcelain), ...rows.map((row) => row.path)])].sort();
```

The union set feeds every existing consumer unchanged: allow/deny path grants, generated-file checks,
the read-only-mode count, `productionFiles` / `testFiles` and therefore both file budgets. No new git
invocation, no new parsing, `DiffMetadata` shape and `evaluateDiffScope()` signature untouched, function
still pure and read-only, violation sorting untouched. `scripts/bootstrap-one.ts`, `resultGate.ts`,
`pathPolicy.ts`, `taskManifest.ts` untouched.

`test/unit/bootstrap-diff-guard.test.ts`: first test's expectations raised to union semantics
(`src/assets/logo.png` joins `changedPaths`, `productionFiles` 5 → 6, `unexpected-path:src/assets/logo.png`
added to the `deepEqual` label list — stricter, nothing deleted or loosened, no skip/todo), plus four new
tests covering acceptance criteria 1–4 and the generated-file / read-only / sortedness consequences of the
union.

## Acceptance criteria — how each is proved by the run below

1. clean tree + `numstat: "4\t0\ttest/unit/x.test.ts\n"`, allow only `src/bootstrap/**`, deny `test/**` →
   `ok === false`, `labels === ["denied-path:test/unit/x.test.ts"]` — test
   `a clean worktree still scopes the commit under review (FIX-1)`.
2. `numstat` naming 3 production paths vs `maxProductionFiles: 1` → `production-file-budget`,
   `report.productionFiles === 3` — test `file budgets count committed paths, not just dirty ones (FIX-1)`
   (also asserts `test-file-budget` for two committed test paths and that union paths stay sorted when
   numstat is unsorted).
3. commit path neither allowed nor denied with empty porcelain → `["unexpected-path:src/other/file.ts"]` —
   same test as (1).
4. path present in both porcelain and numstat counted once → `changedPaths === ["src/bootstrap/diffGuard.ts",
   "src/bootstrap/pathPolicy.ts"]`, `[ok, lines, productionFiles, testFiles, violations] === [true, 13, 2, 0, 0]`
   — test `a path in both porcelain and numstat is scoped once (FIX-1)`.
5. binary / generated / symlink / read-only / changed-line behavior and sortedness: untouched and still
   asserted by the two pre-existing tests (5/5 pass).
6. first test's expectations updated upward only.

## Independent reproduction of the negative control (read-only, real commit data)

Re-ran the E02 negative control against the patched guard, using the real fixture
`E02/fixtures/manifest-e02-negctl.json`, the real commit range and a clean tree (`porcelain: ""`):

```
numstat(0cc5b21c..cc036f2f): "58\t0\tsrc/incidents/errorEvent.ts\n40\t0\ttest/unit/error-event.test.ts\n"
ok: false | changedPaths: [ 'src/incidents/errorEvent.ts', 'test/unit/error-event.test.ts' ] | prod: 1 test: 1
violations: denied-path:test/unit/error-event.test.ts
NEGCTL_EXIT=0
```

Before the patch this same input was `gate=accepted` (`E02/logs/08-gate-scope-gap.txt`). The diagnosis in
the handoff is correct and the defect is closed.

## Verification (run from the worktree root, after the commit)

| command | exit |
| --- | --- |
| `npm run typecheck` | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-diff-guard.test.ts` | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-package.test.ts test/unit/bootstrap-path-policy.test.ts test/unit/bootstrap-task-manifest.test.ts` | 0 |
| `git diff --numstat HEAD` | 0 (empty — the tree is clean after the commit) |
| `git diff --numstat HEAD^1 HEAD` (budget evidence for the commit) | 0 |

Tails:

```
> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json

✔ a diff inside limits passes; oversize, symlink and read-only breaches do not (0.284167ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ skipped 0
ℹ todo 0

✔ B01: invalid fixtures are rejected with deterministic, sorted, deduplicated errors (0.430958ms)
ℹ tests 28
ℹ pass 28
ℹ fail 0
ℹ skipped 0
ℹ todo 0

=== git diff --numstat HEAD (tree is now clean):
(empty)
=== git diff --numstat HEAD^1 HEAD (this commit):
5	1	src/bootstrap/diffGuard.ts
33	3	test/unit/bootstrap-diff-guard.test.ts
added=38 deleted=4 total=42
```

Budget: 1 production file, 1 test file, **38 added + 4 deleted = 42 changed lines** (≤ 100).

## Environment note (the one failure I hit, verbatim)

The worktree had no `node_modules`, so the first `npm run typecheck` failed before any code issue:

```
error TS2688: Cannot find type definition file for 'node'.
  The file is in the program because:
    Entry point of type library 'node' specified in compilerOptions
TYPECHECK_EXIT=2
```

This is a missing-dependencies environment gap, not a test failure of the change. I resolved it the way
the repository policy prescribes (`AGENTS.md`, "One agent, one worktree": *symlink `node_modules` into the
new worktree rather than reinstalling*) and exactly as the sibling FIX-adjacent worktree
`pi-e02-error-event-20261103` already does:

```
node_modules -> /Users/wohlgemuth/IdeaProjects/worktrees/pi-b05-result-gate-20261103/node_modules
```

`git diff --stat 36cab891 cc036f2f -- package.json package-lock.json` is empty, so that install matches this
worktree's lockfile exactly. Nothing was installed, `package.json` was not touched, and `node_modules/` is
gitignored (it does not appear in `git status --porcelain` or in any numstat).

## What I believe is wrong or risky

1. **The diagnosis is right; the fix is only half the harness gap.** At the stamping path in
   `scripts/bootstrap-one.ts` porcelain is empty *by construction* (the run refuses a dirty tree), so the
   union's porcelain half contributes nothing there — the guard is now real only because numstat joined.
   Symmetrically, any caller that passes a dirty tree now sees **strictly more** violations than before
   (working-tree paths were already scoped; committed paths now are too). That is the intent, but it is a
   behavior change for other future callers, not just for the clean-tree case.
2. **numstat paths are not quote-normalized.** `porcelainPaths()` strips surrounding `"` from git-quoted
   paths, while `numstatRows()` keeps `row.path` verbatim. For paths git quotes (non-ASCII, spaces plus
   specials, `core.quotePath` default), a file appearing in both outputs could fail to de-duplicate and
   would be scoped under a quoted literal that no allow pattern can match. I deliberately left `row.path`
   alone because changing it would alter the `binary-change` violation's reported path, which criterion 5
   pins. A follow-up should normalize both sides with one shared helper.
3. **Renames are half-visible at a clean commit.** Porcelain reports `old -> new`, but
   `git diff --numstat HEAD^1 HEAD` names only the post-image. So a task that deletes a denied path and
   adds an allowed one still passes path scope at the stamping commit (the deletion shows only in the
   deleted-line count). Not fixable inside the guard without a new git invocation, which the handoff
   forbids; needs `--name-status` (or `-M`) at the caller — out of FIX-1 scope.
4. **Merge commits.** The caller diffs `HEAD^1..HEAD`; for a merge commit that is a first-parent diff and
   can be empty, which would make the whole guard vacuous again. Not exercised by any test here.
5. **Unrelated defects visible in the same E02 log stay open.** `08-gate-scope-gap.txt` also records that a
   plan exit 3 (`HEAD != manifest.baseSha`) is not a gate blocker, so the emit path can stamp a handoff
   without validating `parentHandoffHash`. FIX-1 does not touch that (it lives in `bootstrap-one.ts` /
   `resultGate.ts`, both outside my scope).
6. **`npm run lint` (biome) is red at baseline for this directory** — `npx biome check` already fails on
   untouched `src/bootstrap/resultGate.ts`, `taskManifest.ts`, `pathPolicy.ts`, and `git show HEAD^:...`
   of both of my files piped through biome reports "The contents aren't fixed" *before* my change. I
   matched the surrounding compact style instead of reformatting, because reformatting would be out-of-scope
   churn inside a 100-line budget; the verification set the handoff specifies does not include lint, and my
   files are no worse than baseline (3 biome findings, all formatter width, same class as the base files).
7. **Scope widening of `productionFiles`/`testFiles` semantics.** Any downstream consumer of
   `DiffGuardReport` (today: `resultGate.ts` via `bootstrap-one.ts`) now sees larger counts. `resultGate`
   only forwards violation kinds, so nothing else regressed — the 28-test bootstrap suite is green — but a
   future consumer that displays `changedPaths` as "uncommitted work" would now be wrong.
