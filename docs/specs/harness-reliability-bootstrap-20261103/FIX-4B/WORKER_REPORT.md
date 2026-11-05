# WORKER REPORT FIX-4B — mode-aware microtask line ceiling

- Branch: `fix/fix4b-mode-ceiling`
- Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix4b-mode-ceiling-20261104`
- Base SHA: `5c5d5a5d6ab8681390c8daf35c1daab542f7051d`
- Commit: `7f983ee0` — `fix(bootstrap): mode-aware microtask line ceiling (FIX-4B)`
- Model: `metabolomics/qwen3.8-flash_next` (`PI_PROVIDER=metabolomics`, `PI_MODEL=qwen3.8-flash_next`) — no gateway switch observed.

## What changed (exactly the three permitted files)

1. `src/bootstrap/taskManifest.ts` (+12 / -6)
   - `TASK_MANIFEST_MODES = ["read-only", "isolated-change", "herdr-ui"]` (`read-only` and
     `isolated-change` unchanged; `TaskManifestMode` derives from it).
   - New `MODE_LINE_CEILINGS: Record<TaskManifestMode, number> = { "read-only": 100,
     "isolated-change": 100, "herdr-ui": 120 }`, with a comment citing
     `03-TEST-AND-RELEASE-GATES.md` rule 3 ("<=2 production files, <=2 tests, target <=100 changed
     lines (Herdr UI <=120)").
   - `MICROTASK_CEILING` keeps its shape and values; `maxProductionFiles` / `maxTestFiles` are still
     capped at 2 for **every** mode — only the `maxChangedLines` ceiling is mode-aware.
   - The `mode` block moved above the `limits` block (mode must be known to pick the line ceiling);
     error emission order is irrelevant because errors are deduplicated and sorted before return.
     When `mode` itself is invalid the strictest ceiling (100) is used and the message omits the
     mode clause — the invalid mode already has its own error.
   - Rejection message now names value, applicable ceiling and mode:
     `limits.maxChangedLines: 121 exceeds bootstrap ceiling 120 for mode herdr-ui`.
   - Still pure, no I/O, no `any`, defaults applied, unknown keys dropped, same field set, same
     return shapes.

2. `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json` (+7 / -7)
   - `"mode"` set to `herdr-ui` for `H01`…`H07` only (one line per task, byte-identical file
     otherwise). `maxChangedLines` stays 120; all 51 entries, all other fields untouched.
   - `H01` was `read-only` while declaring a 120-line budget — under `herdr-ui` it is now both
     line-budget-legal and schedulable (`evaluateDiffScope`'s read-only zero-path rule no longer
     applies to it). `diffGuard.ts` was not touched.

3. `test/unit/bootstrap-task-manifest.test.ts` (+16 / -1)
   - New tests: `herdr-ui` accepted as a mode and `maxChangedLines: 120` accepted under it; 121
     rejected with the mode-named 120 ceiling; 120 rejected against the 100 ceiling under both
     `isolated-change` and `read-only`; unknown mode still rejected; `maxProductionFiles: 3` and
     `maxTestFiles: 3` still rejected under `herdr-ui`.
   - All four pre-existing B01 assertions kept. One expected-string change was forced:
     `mode: expected one of read-only, isolated-change` →
     `... read-only, isolated-change, herdr-ui`. The assertion (exact-array `includes` on the mode
     error) is unchanged in kind; adding a mode necessarily changes the message it pins. See
     "Disagreements".

## Verification (run from the worktree root, after the commit)

| # | Command | Exit |
|---|---|---|
| 1 | `npm run typecheck` | 0 |
| 2 | `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-task-manifest.test.ts` | 0 |
| 3 | `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts` | 0 |
| 4 | `node --experimental-strip-types -e '...parseTaskManifest over tasks.json...'` | 0 |
| 5 | `git diff --numstat HEAD~1 HEAD` | 0 |
| — | `git diff --check HEAD~1 HEAD` | 0 |

Tails:

```
# 1
> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json            EXIT=0

# 2  (tests 6, pass 6, fail 0)
✔ B01: valid JSON fixture is accepted and every schema field is populated
✔ B01: defaults apply when the optional fields (limits, denyPaths, expectedOutputs) are absent
✔ B01: invalid fixtures are rejected with deterministic, sorted, deduplicated errors
✔ FIX-4B: herdr-ui is accepted as a mode with a 120-line ceiling
✔ FIX-4B: 120 changed lines is rejected against the 100 ceiling for every non-herdr-ui mode
✔ FIX-4B: an unknown mode is still rejected and herdr-ui keeps the 2-file caps   EXIT=0

# 3  (tests 58, pass 58, fail 0)                                              EXIT=0

# 4
tasks 51 invalid 0                                 EXIT=0
```

Acceptance criteria, proved directly:

```
AC1 ok= true mode= herdr-ui {"maxProductionFiles":2,"maxTestFiles":2,"maxChangedLines":120}
AC2 ok= false ["limits.maxChangedLines: 121 exceeds bootstrap ceiling 120 for mode herdr-ui"]
AC3 ok= false ["limits.maxChangedLines: 120 exceeds bootstrap ceiling 100 for mode isolated-change"]
AC4 h= H01:herdr-ui:120 H02:herdr-ui:120 H03:herdr-ui:120 H04:herdr-ui:120 H05:herdr-ui:120 H06:herdr-ui:120 H07:herdr-ui:120
AC4 modes= read-only=5 isolated-change=39 herdr-ui=7
```

Criterion 4 note: command 4 prints `tasks 51 invalid 0 ` — with an empty rejection list
`bad.map(b=>b.id).join(",")` renders as the empty string, so the trailing comma in the handoff's
expected `tasks 51 invalid 0 ,` is not reproducible output; the count pair (`51`, `0`) is exact.

## Diff budget

```
7	7	docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json
12	6	src/bootstrap/taskManifest.ts
16	1	test/unit/bootstrap-task-manifest.test.ts
```

Totals: 35 added, 14 deleted, **49 changed lines** (budget 100). Files: 2 non-test (`taskManifest.ts`,
`tasks.json`) + 1 test — inside 2 production / 1 test. Working tree clean after commit; nothing else
modified, nothing installed, no push/merge/rebase/amend/reset/worktree operation.

## Risks

- `herdr-ui` is now accepted by the schema for **any** task, not only the Herdr phase. The manifest
  itself carries no check that a `herdr-ui` task actually touches Herdr UI paths; only the declared
  `allowPaths` and the operator gate constrain that. If the ceiling must be phase-bound, the gate (or
  `diffGuard`) needs a path-shape rule — out of FIX-4B scope by the file allowlist.
- `MODE_LINE_CEILINGS` is a second source of truth alongside `MICROTASK_CEILING.maxChangedLines`
  (which stays 100 as the default/invalid-mode fallback and as the documented "bootstrap hard
  ceiling"). A future mode added to `TASK_MANIFEST_MODES` without a `MODE_LINE_CEILINGS` entry is a
  compile error (`Record<TaskManifestMode, number>`), which is the intended failure mode.
- Downstream consumers that assumed two modes: grep over `src/`, `scripts/`, `test/` found no other
  reader of `TASK_MANIFEST_MODES`/`MICROTASK_CEILING`, and `bootstrap-*.test.ts` (58 tests) is green.
  No runtime integration exists yet for `mode`, per B01's "no runtime integration" contract.
- `npm run lint` (`biome check .`) exits 1 with 59 repo-wide errors **at this base SHA already** —
  the bootstrap files are deliberately dense and do not satisfy biome's 120-column formatter.
  `biome check` on my two `.ts` files reports 2 errors, exactly the same count as the `HEAD` copies
  of the same files, so this change adds no new lint/format debt. I did not reformat (it would rewrite
  untouched lines and blow the budget); lint is not in the FIX-4B verification list.

## Disagreements

- The handoff's example message `limits.maxChangedLines 121 exceeds bootstrap ceiling 120 for mode
  herdr-ui` has no colon after the field name, while every other error in this module is
  `field: reason` (and the retained B01 assertion pins
  `limits.maxTestFiles: 3 exceeds bootstrap ceiling 2`). I kept the module's `field: reason` shape and
  appended the mode clause, which satisfies the stated requirement (names value, applicable ceiling,
  mode) without splitting the error vocabulary in two. If the literal colonless string is a hard
  contract, the change is one line — but it would make `limits.maxChangedLines` the only error whose
  text does not start `limits.maxChangedLines: `.
- Adding a mode forces the pinned mode-list string in the existing B01 rejection assertion to grow;
  "existing assertions must stay" cannot be satisfied literally for that one string. Coverage is kept
  (still an exact-string rejection assertion for `mode: "yolo"`), and a second unknown-mode case
  (`"herdr"`, a near-miss of the new mode) was added so the near-miss path is also pinned.
- `H01`'s original `read-only` + 120-line declaration was self-contradictory (read-only forbids any
  changed path, yet it lists a production deliverable, `HERDR_SURFACES.md`). Retyping it to
  `herdr-ui` as instructed resolves the contradiction, but "Herdr UI" is an odd label for a docs-only
  inventory task; a `documentation` mode with a 120-line ceiling would model it better. Filed here as
  a note, not acted on.
