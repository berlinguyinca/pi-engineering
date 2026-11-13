# FIX-4B report — mode-aware microtask ceiling; the H phase becomes schedulable

**Status: PASS, merged.** `fix/fix4b-mode-ceiling` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`5c5d5a5d` → `7f983ee05c0d6feb1ee725984070aef31bdcf92c`.

| item | value |
| --- | --- |
| diff | `src/bootstrap/taskManifest.ts` 12/6, `docs/…/manifests/tasks.json` 7/7, `test/unit/bootstrap-task-manifest.test.ts` 16/1 → 49 lines (budget 2 production / 1 test / ≤100) |
| handoffHash | `sha256:` see `FIX-4B/FIX-4B.handoff.json`; hash MATCH on recomputation, 0 schema errors |
| taskAuthorityHash | `sha256:c0dddacf52c6e3a8076b0fc8788003d4c5c96476b57f2a3af2d5529a2f493667` |
| parent | **strictly verified**: `parent=FIX-4A accepted sha256:0194df91874…` — first unit whose parent chain check passed end-to-end since FIX-3B |

`TASK_MANIFEST_MODES` is now `read-only | isolated-change | herdr-ui`; the line ceiling is 100 for the first two
and **120 for `herdr-ui`**, per `03-TEST-AND-RELEASE-GATES.md` rule 3 ("…target <=100 changed lines (Herdr UI
<=120)"). `H01`…`H07` in `manifests/tasks.json` now declare `mode: "herdr-ui"` (H01 was `read-only` while
declaring a 120-line budget, which `evaluateDiffScope` could never have accepted).

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` | 0 | `logs/01-typecheck.txt` |
| `test/unit/bootstrap-task-manifest.test.ts` (6/6) | 0 | `logs/02-unit-manifest.txt` |
| `test/unit/bootstrap-*.test.ts` (58/58) | 0 | `logs/03-unit-all.txt` |
| every `tasks.json` entry parses | 0 | `logs/04-tasks-parse.txt` → `tasks 51 invalid 0`, `herdr-ui: H01…H07` |

Conductor ceiling controls (`logs/05-conductor-ceiling-controls.txt`, written by the conductor, not the worker):

```
herdr-ui 120 ok: true
herdr-ui 121 errs: ["limits.maxChangedLines: 121 exceeds bootstrap ceiling 120 for mode herdr-ui"]
isolated 120 errs: ["limits.maxChangedLines: 120 exceeds bootstrap ceiling 100 for mode isolated-change"]
herdr-ui prod3 errs: ["limits.maxProductionFiles: 3 exceeds bootstrap ceiling 2"]
bogus mode errs: ["mode: expected one of read-only, isolated-change, herdr-ui"]
```

Stamping (`logs/06-stamp.txt`): `parent=FIX-4A accepted`, `authority=FIX-4B sha256:c0dddacf52c6…`,
`schema=FIX-4B conforms …`, `gate=accepted`; the stamped file re-validates with 0 schema errors and the hash
recomputes identically. `nextTaskId: FIX-4C`, `nextBaseSha: 7f983ee05c0d…` (the branch HEAD after the
fast-forward), so FIX-4C is stamped with a strict parent as well.

No deviations: no history action, no null parent, no out-of-scope path.
