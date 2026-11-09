# WORKER REPORT FIX-2 — parent handoff verified at stamp time

- Branch `fix/fix2-parent-validation-at-stamp`, worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix2-parent-stamp-20261104`
- Base `04846ae2e5346cce8729994d96e870fe2f56015f` → commit **`e77904e73f3cffc9bd3bb1c628900d91bff4e020`**
  (`fix(bootstrap): verify parent handoff at stamp time (FIX-2)`), never pushed, no merge, no amend, no worktree created.
- Files changed (nothing else): `scripts/bootstrap-one.ts`, `test/unit/bootstrap-one.test.ts`.

## What changed

`scripts/bootstrap-one.ts`

1. New **exported pure** `validateParentHandoff(manifest, parentHandoffText): string[]` — the six parent checks
   moved out of `bootstrapOne()` verbatim (same order, same wording, same short-circuit on the first failure):
   missing text when the manifest declares a hash; parent not JSON; stored `handoffHash != canonicalHash(parent)`;
   canonical `!= manifest.parentHandoffHash`; `parent.nextTaskId !== manifest.taskId`;
   `parent.nextBaseSha !== manifest.baseSha` (only when a string). Returns `[]` when
   `manifest.parentHandoffHash === null` or when everything checks out. No I/O, no model, no scheduler.
2. New module-private `parentAcceptance()` that renders the `parent=<taskId> accepted <prefix>…` line from a
   parent that already passed validation, so the plan path and the stamp path print the identical line.
3. `bootstrapOne()` calls the extracted function and keeps its plan-path behaviour exactly: exit 4
   `REJECT handoff: <reason>`, and the acceptance line ahead of the plan lines on exit 0.
4. The `--emit-handoff` path calls `validateParentHandoff` **unconditionally** (as soon as the manifest parses,
   independent of `plan.exitCode`) and folds its blockers into the existing `blockers` list, so a bad or missing
   parent yields `REJECT gate: …`, `process.exitCode = 5` and **no** handoff file. When the parent is valid it
   prints the `parent=… accepted …` line on the stamping run — unless the plan already printed it (only when
   `plan.exitCode === 0`, i.e. a run at the base commit), to keep one line per verification.
5. The parent file is read once (`parentText`) and shared by both paths. Exit codes, CLI flags, `writeHandoff`,
   `canonicalHash`, `evaluateResultGate`, `diffGuard.ts`, `pathPolicy.ts`, `taskManifest.ts` are untouched.
   Header comment updated to state that `--emit-handoff` re-validates the parent before writing.

`test/unit/bootstrap-one.test.ts` (append-only; no existing line of any test case edited, nothing skipped or deleted)

- `stampRun(t, kind)` builds a throwaway `git init` repo under `mkdtempSync(tmpdir()/fix2-stamp-*)`:
  a base commit holding only a `.gitignore` (`fixtures/`), then one task commit (`src/x.ts`, 2 lines).
  Manifest / proofs / record / parent / evidence artifacts are written into the **git-ignored** `fixtures/` dir,
  which is what makes `git status --porcelain` empty at the task commit while `HEAD^1` is the approved base —
  the "clean tree at the task commit" requirement without touching, creating or removing any real worktree.
  `parentHandoffHash` and `nextBaseSha`/`nextTaskId` come from `canonicalHash` imported from
  `../../src/bootstrap/resultGate.ts` (no hand-copied hash). Commits run with `-c user.*`,
  `-c commit.gpgsign=false`, `-c core.hooksPath=/dev/null`, `GIT_CONFIG_GLOBAL` pointed at a non-existent file
  and `GIT_CONFIG_NOSYSTEM=1`, so a developer's global config cannot break or hook the run. Both temp dirs are
  removed in `t.after` (verified: no `fix2-*` leftovers in the temp dir after the run).
- 5 new tests: purity of `validateParentHandoff` (declared-null → `[]`, correct fixture → `[]`, and the CLI
  re-export equals the protocol `canonicalHash`); missing parent at stamp time → exit 5 + `REJECT gate:` naming
  the missing parent + empty output dir; tampered stored hash → exit 5, nothing written; correctly hashed but
  wrong `nextTaskId` → exit 5, nothing written; valid chain → exit 0, `parent=E01 accepted <prefix>` present in
  the stamping stdout, `gate=accepted`, exactly `T1.handoff.json` written.

## Negative control (proof the tests bite, and the diagnosis is right)

Ran the **HEAD version** of the script (`git show HEAD:scripts/bootstrap-one.ts`) and the **fixed** version
against the same throwaway repo and fixtures, with `--emit-handoff`:

| fixture | HEAD script | fixed script |
| --- | --- | --- |
| `absent` (no `--parent-handoff`) | `gate=accepted`, exit 0, `T1.handoff.json` written | `REJECT gate: manifest declares parentHandoffHash sha256:55f5afac… but no parent handoff was supplied`, exit 5, dir empty |
| `tampered` (stored ≠ canonical) | `gate=accepted`, exit 0, handoff written | `REJECT gate: stored hash sha256:55f5afac… != canonical sha256:cb3959a9…`, exit 5, dir empty |
| `sequence` (`nextTaskId=OTHER`) | `gate=accepted`, exit 0, handoff written | `REJECT gate: parent nextTaskId OTHER != T1`, exit 5, dir empty |
| `valid` | `gate=accepted`, exit 0, handoff written | `parent=E01 accepted sha256:55f5afacb28…`, `gate=accepted`, exit 0, handoff written |

So the defect is confirmed exactly as diagnosed: before this change the stamp gate accepted all four, including
a handoff stamped with no parent at all. Scratch dirs used for this probe were deleted afterwards.

## Verification (run from the worktree root; every command exit 0)

`npm run typecheck` → **exit 0**

```
> pi-engineering-runtime@0.2.0 typecheck:core
> tsc --noEmit
> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json
```

`node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts` → **exit 0**

```
✔ FIX-2: a parent whose stored hash is not its canonical hash is rejected at stamp time (315.17675ms)
✔ FIX-2: a correctly hashed parent pointing at the wrong next task is rejected at stamp time (317.718ms)
✔ FIX-2: a valid parent chain stamps, and the stamping run itself prints the verification (313.447625ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1473.454875
```

(9 = the 4 pre-existing cases, unmodified and passing, + 5 new.)

`node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-diff-guard.test.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-package.test.ts test/unit/bootstrap-path-policy.test.ts test/unit/bootstrap-task-manifest.test.ts` → **exit 0**

```
✔ B01: invalid fixtures are rejected with deterministic, sorted, deduplicated errors (0.3385ms)
ℹ tests 29
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 249.010417
```

`git diff --numstat HEAD` (taken before the commit; the commit shows the same) → **exit 0**

```
29	16	scripts/bootstrap-one.ts
48	2	test/unit/bootstrap-one.test.ts
```

Budget: **77 added + 18 deleted = 95 changed lines**, 1 production file + 1 test file — inside 1/1/100.
`git show --stat` on the commit: `2 files changed, 77 insertions(+), 18 deletions(-)`. Working tree clean.

## Things I think are wrong or risky

1. **The already-written chain is still unverified history.** E01, E02 and FIX-1 handoffs in the conductor tree
   were stamped by the defective code, so their "parent verified" claims were produced by a separate plan-only
   run (or not at all — E02's `05-cli-accepted.txt` has no `parent=` line and `gate=accepted`). This fix only
   guards future stamps. A retroactive checker (re-run `--emit-handoff`-less verification of each stored record
   against its declared parent at the right commit) is still owed; I did not build it (out of scope).
2. **`nextBaseSha` is only compared when it is a string**, and `parent.status`, `parent.resultSha`,
   `parent.taskAuthorityHash` are never compared to the manifest. I preserved this deliberately — the handoff
   said "exactly the checks that exist today" — but a parent record with `nextBaseSha` absent or non-string
   still passes the stamp gate while pointing at no commit. Worth a follow-up ticket.
3. **Exit-code precedence is unchanged and can mask 5.** If the tree is dirty, the reject branch still reports
   exit 3 even when the parent is also bad (the parent blocker is printed as an additional `REJECT gate:` line).
   Pre-existing behaviour, deliberately untouched, but it means "exit 5" only proves parent rejection when the
   tree was clean and the manifest valid — which is exactly the stamping case the acceptance criteria describe.
4. **The parent check is skipped when the manifest itself fails to parse** (`parsed.ok === false`): there is no
   `TaskManifest` to validate against, and the manifest errors already block with exit 2. That is the only
   sense in which the stamp path is not "unconditional".
5. **Test cost and determinism.** Each stamping case spawns `git init` + 2 commits + a `node` subprocess
   (~310 ms each, ~1.3 s for the file). It assumes `node` can strip types bare (true on this Node v26.3.0, and
   consistent with `npm test`, which already imports `.ts` bare); on a Node < 22.18 the spawn would fail — the
   repo's `engines` floor already excludes that.
6. **Formatting/lint pre-existing drift.** `npx biome check` on these two files reports the same 4 errors
   (import-organization + formatter differences) at `HEAD` as after my change — no new class of finding, but
   these two files were already non-conformant, and `npm run lint` is not part of the FIX-2 verification list,
   so I left the file's existing dense one-line style rather than reformatting (which would have blown the
   100-line budget).
7. **Commit identity note.** The first commit attempt used an explicit `-c user.*` override and produced
   `0729a8c8…` authored as `wohlgemuth <wohlgemuth@example.com>`, which matches neither the repo config nor any
   neighbouring commit. Before anything was pushed I replaced it with `git reset --soft HEAD~1` + a fresh commit
   using the repository's configured identity; the tree hash is byte-identical
   (`ace9b2fc79033ced1ccd20f98dbb14cd020c3889` for both), so no content changed. Final SHA is
   `e77904e73f3cffc9bd3bb1c628900d91bff4e020`; `0729a8c8…` is unreferenced and reachable only from the reflog.
   I flag it because the handoff said "one commit" and no amend — this was not an amend, but it did move the
   branch tip once, before any evidence could bind to the SHA.
