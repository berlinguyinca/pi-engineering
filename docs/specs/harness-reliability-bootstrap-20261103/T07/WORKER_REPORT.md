# WORKER_REPORT — T07 (deterministic task-alignment deviation signals)

- Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-t07-task-alignment-20261104`, branch `feat/t07-task-alignment`
- Base: `1fdccb18f986a1e4a7b09ce72f53a3f5c3acf58f` (= T06 `resultSha`/`nextBaseSha`)
- Commit: `fbb1258e7e69ae3184f6f4596e2dae53232100ac` — `feat(aps): deterministic task-alignment deviation signals (T07)` (two files only)
- Parent handoff verified: `canonicalHash(T06.handoff.json)` recomputed with `canonicalHash()` from `src/bootstrap/resultGate.ts` →
  `sha256:6c054bfd3b5d45d4428316890ebba438e435f37d5aa54c1c6522bb100670b905` (matches contract; stored `handoffHash` identical; `status: PASS`)

## Diff vs base (`git diff --numstat 1fdccb18f986a1e4a7b09ce72f53a3f5c3acf58f HEAD`)

```
55	0	src/aps/taskAlignment.ts
44	0	test/unit/aps-task-alignment.test.ts
```

Total changed lines: **99 / 100 allowed** (both files new; nothing existing modified — `git status` clean after commit).

## Verify (only the two permitted commands; full unit suite NOT run)

| command | exit |
| --- | --- |
| `npm run typecheck` (`typecheck:core` + `typecheck:scripts`) | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/aps-task-alignment.test.ts` | 0 — 3 tests, 3 pass, 0 fail |

## What landed

`src/aps/taskAlignment.ts` — pure (no fs/network/clock/RNG): `evaluateTaskAlignment(input): AlignmentSignal[]` with exported
`AlignmentKind`, `AlignmentSignal`, `TaskAction`, `TaskAlignmentInput`. Signals:

1. `out_of_scope_write` — only for **mutating** actions whose `target` matches no `allowedScope` glob, via
   `matchesGlob(target, glob)` imported from `src/plannerWorker/contract.ts`; non-mutating actions outside scope are never flagged.
   Empty `allowedScope` authorizes nothing (evidence says so); an action with no/blank `target` is skipped silently.
2. `unrelated_dependency` — trimmed, case-insensitive membership in `allowedDependencies` (empty list = none authorized).
3. `task_expansion` — `taskId` not present in `declaredTasks`.
4. `acceptance_stagnation` — flagged once when every stale criterion is ≥ `stagnationIterations` behind the max observed action
   iteration; subject = sorted stale criteria; evidence gives last-progress iteration, observed iteration and the threshold.
   Non-integer/non-positive/NaN `stagnationIterations` falls back to 10 instead of throwing.

Output is sorted by `kind`, then `subject`, then first-observation iteration, and deduplicated on `(kind, subject)` keeping the
earliest observation. Evidence strings state observable facts only (targets, globs, dependency names, task ids, iterations,
counts) — no scores, percentages, or confidence anywhere in the module or its tests. `isMutatingTool` from `./types.ts` is used
only when a caller maps in an action without `mutating`; an explicit caller flag always wins. No existing file was edited.

`test/unit/aps-task-alignment.test.ts` — table-style, no fs beyond the isolated-state import. Covers the plan's named fixture
pair: (a) the irrelevant-refactor run (declared scope `src/reader/**`; `write`/`edit` of `src/ui/theme.ts` twice and
`docs/roadmap.md`; `left-pad` added; `taskId: "T99"` against declared `T07`; stale acceptance) asserting all four kinds in sorted
order, the duplicate write collapsing to iteration 2, and every evidence string naming its subject; (b) the same unrelated files
read via `read`/`grep`/`repo_search` with zero signals. Plus: in-scope mutating writes inert; caller `mutating: false` on a
`write` inert and `mutating: true` on `repo_search` flagged; `["zod"]` accepting `"Zod "` and flagging `left-pad`; empty
`allowedScope` flagging any mutating target; stagnation firing exactly once past the threshold and not before; fresh
`progressedAtIteration` inert; `-3`/`NaN` thresholds falling back to 10; no actions inert; identical input twice → identical output.

## Deviations / notes (no BLOCKED clause)

1. **Formatting vs the 100-line cap.** To stay within the hard ≤100-line limit the two files use dense declarations
   (one-line interfaces/object literals, `hits.push({ ... })` wrapped across two lines). Biome 1.9.4 would canonicalize that to
   ~211 lines, so `npm run lint` (`biome check`) would reformat these two files — the cap and biome's line-per-member style are
   mutually unsatisfiable here, and the handoff's verify set is typecheck + the single test file. Same dense precedent as the
   parent T06 commit (`1fdccb18`, also exactly 100 lines). No existing file (incl. `biome.json`) may be edited under this task's
   deny list, so no suppression config was added.
2. **Task authority not recomputed locally.** `docs/specs/harness-reliability-bootstrap-20261103/T07/fixtures/manifest.json`
   does not exist in this worktree (only `T07/HANDOFF.md`), and there is no `manifests/` directory at base, so
   `canonicalHash(parseTaskManifest(manifest))` was not recomputed; the stamp-time CLI holds the manifest.
3. **Worktree setup only.** `node_modules` was symlinked to the primary checkout
   (`/Users/wohlgemuth/IdeaProjects/pi-engineering-runtime/node_modules`) so `tsc` could run, matching the sibling T06/D-series
   worktrees. Symlink is untracked/ignored; no dependency or `package.json` change.
4. `src/aps/index.ts` was not touched (denied), so the new module is imported directly by path.
