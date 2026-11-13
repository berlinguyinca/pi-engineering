# FIX-1 report — scope guard must see the committed paths

**Status: PASS, merged.** Branch `fix/fix1-diff-scope-commit-paths` fast-forwarded into
`harness-reliability-bootstrap-20261103`: `cc036f2f` → `04846ae2`.
Handoff: `FIX-1/FIX-1.handoff.json`, `handoffHash = sha256:942da49b0ab334eacf3164210b6c303c8a02d3103914599bb7250cefbc2f7586`,
`taskAuthorityHash = sha256:420a9c7cabdfae889541e33727fc3e1e7961e86de925851276e1f38d0d9f991b`
(derivation: `canonicalHash(parseTaskManifest(manifest-fix1.json).manifest)`).

## How it was executed (new rule, first run of the loop)

Worker = a separate interactive **pi** pane (`fix1`, pane `w0:p2`) pinned to the conductor's model
(`pi --provider metabolomics --model qwen3.8-flash_next --thinking medium`; the worker's own status line
confirmed `qwen3.8-flash_next`). Contract = `FIX-1/HANDOFF.md` (2 allowed paths, 1 prod / 1 test file,
100 lines, prohibitions, acceptance criteria). Worker work was **not** trusted: everything below was
re-run by the conductor in the worker's worktree.

## Change

`src/bootstrap/diffGuard.ts` (+5/−1): `changedPaths` is now the sorted union of porcelain paths and the
paths named by `numstat` (the commit under review), de-duplicated —
`[...new Set([...porcelainPaths(porcelain), ...rows.map(r => r.path)])].sort()`. Path grants, generated-file
checks, the read-only check and both per-file budgets therefore apply to committed files. No signature,
`DiffMetadata` shape, or git-invocation change; still pure and read-only.
`test/unit/bootstrap-diff-guard.test.ts` (+36/−4): union + denial + budget + de-duplication cases; the one
pre-existing expectation was made **stricter** (the numstat-only path `src/assets/logo.png` now also joins
`changedPaths`, `productionFiles` 5 → 6, an extra `unexpected-path` violation appears). Suite grew 2 → 5 tests.

## Conductor verification (worker worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix1-diff-scope-20261103`)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` | 0 | `logs/01-typecheck.txt` |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-diff-guard.test.ts` (5/5) | 0 | `logs/02-unit-diff-guard.txt` |
| `node --test … bootstrap-one + result-gate + package + path-policy + task-manifest` (28/28) | 0 | `logs/03-unit-bootstrap-regression.txt` |
| scope/budget `git diff --numstat HEAD~1 HEAD` | 2 files, 38 insertions / 4 deletions | within budget |
| **negative control** — manifest that omits `test/unit/bootstrap-diff-guard.test.ts` from `allowPaths` and denies `test/**`, stamped at the task commit | **5 REJECT** `diff scope rejected (denied-path): denied by "test/**"` | `logs/04-negctl-must-reject.txt` |
| stamping run at `04846ae2` (`--emit-handoff`) | 0 `gate=accepted` | `logs/05-cli-stamp.txt` |
| hash recompute + `templates/handoff.schema.json` validation | 0 MATCH, 0 schema errors | this report |

The E02 control that used to be **accepted** is now **rejected** — that is the proof the defect is closed.

## Deviations & findings recorded

1. **Plan-order deviation (deliberate, recorded).** `E02.handoff.json` declares `nextTaskId = E03`, so
   chaining FIX-1 to E02 would assert a sequence that does not hold; the operator re-ordered the plan on
   2026-11-04 (fix the discovered defects first). `FIX-1` therefore carries `parentHandoffHash: null` and
   continuity is enforced instead by `baseSha == E02 resultSha` plus the gate's `commitParentSha ==
   approvedBaseSha` check. FIX-1 → FIX-2 → FIX-3 → FIX-4 → E03 are hash-chained normally afterwards.
2. **Worker environment action (outside its file scope, disclosed).** The fresh worktree had no
   `node_modules`, so the worker's first typecheck failed with `TS2688: Cannot find type definition file
   for 'node'`; the worker symlinked `node_modules` from `pi-b05-result-gate-20261103` (gitignored, nothing
   installed). Reproducible-bootstrap consequence: a worker worktree needs a provisioned `node_modules`;
   record this in the E-phase provisioning task.
3. **Worker-raised risks, still open (queued as FIX-2/FIX-3 or noted):**
   `numstat` can quote paths containing special characters (porcelain unquoting is handled, numstat is not);
   rename post-image only; a merge commit's first-parent diff is empty, so `HEAD^1..HEAD` numstat on merged
   bases needs thought; `biome` is red at baseline (not part of the bootstrap gate).
4. `writeHandoff()` still needs `mkdir` of the output dir (it wrote a tmp file into a non-existent dir and
   crashed with ENOENT) and still performs no schema validation → **FIX-3**.
