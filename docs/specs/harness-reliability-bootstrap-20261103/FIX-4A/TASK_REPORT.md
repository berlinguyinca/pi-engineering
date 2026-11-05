# FIX-4A report — the task authority is derived from the manifest and required at stamp time

**Status: PASS, merged.** `fix/fix4a-task-authority` fast-forwarded into
`harness-reliability-bootstrap-20261103`: `74b54eb1` → `5c5d5a5d6ab8681390c8daf35c1daab542f7051d`.

| item | value |
| --- | --- |
| diff | `src/bootstrap/resultGate.ts` 9/0, `scripts/bootstrap-one.ts` 12/3, `test/unit/bootstrap-one.test.ts` 62/10 → 96 lines (budget 2 production / 1 test / ≤100) |
| handoffHash | `sha256:0194df91874fbe7c68f0a79766b208aa857bf47806155dd4a38d332b8b6a6b50` |
| taskAuthorityHash | `sha256:0b1106cf3b70669e1a61cbf25a693350158ed2336c29f04b3620fef44b908a05` |
| base / result / next | `74b54eb17f51…` / `5c5d5a5d6ab8…` / `FIX-4B @ 5c5d5a5d6ab8…` |

`taskAuthorityHash(manifest) = canonicalHash(parsedManifest)` — the authority of a task is now a real, derived
value, and the emit path refuses a record whose declared authority differs.

## Three-way derivation agreement (the point of the unit)

For the FIX-3C manifest, all three independent computations produced
`sha256:5f6183004f02b89ed52c0d3efe5425452f76e316054c7ecb456a36a5cb3b29de`:

1. the conductor's own tool (`/tmp/handoff-tool.mjs authority`, which computes `canonicalHash(parseTaskManifest(json).manifest)`),
2. `taskAuthorityHash(parseTaskManifest(json).manifest)` from the worker's implementation,
3. `canonicalHash(parseTaskManifest(json).manifest)` evaluated directly.

## Conductor verification (worktree at the commit, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` | 0 | `logs/01-typecheck.txt`, `logs/07-rebased-typecheck.txt` |
| `test/unit/bootstrap-one.test.ts` (18/18, was 13) | 0 | `logs/02-unit-one.txt` |
| `test/unit/bootstrap-*.test.ts` (55/55) | 0 | `logs/03-unit-all.txt`, `logs/08-rebased-unit-all.txt` |

Conductor negative controls (not the worker's tests):

| case | exit | behaviour | log |
| --- | --- | --- | --- |
| record authority `sha256:ffff…` | 5 | `REJECT gate: $.taskAuthorityHash: the record says sha256:fff… but manifest FIX-4A derives sha256:aed83475…`; **0 files written** | `logs/04-control-wrong-authority.txt` |
| `taskAuthorityHash` deleted from the record | 5 | `$.taskAuthorityHash: required property missing` + derivation mismatch; 0 files | `logs/05-control-absent-authority.txt` |

## Conductor-side deviations (disclosed)

1. **Rebase.** The `.gitignore` commit `74b54eb1` (keeping run artifacts untracked so the gate can stamp a
   clean tree) landed *after* the worker had committed `e58a4376`, so the unit branch and the harness branch
   diverged. The conductor rebased the single unit commit onto `74b54eb1` on its own unmerged branch
   (`git rebase --onto 74b54eb1 5d000abc fix/fix4a-task-authority`) to keep history linear. No merge commit,
   nothing pushed, nothing rewritten on a merged branch.
2. **Re-stamp.** Because the commit SHA changed, the first stamp (at the pre-rebase SHA) was superseded; the
   superseded file is preserved as `out/FIX-4A.handoff.SUPERSEDED-pre-rebase.json` and the accepted stamp is
   `out2/FIX-4A.handoff.json`, copied to `FIX-4A/FIX-4A.handoff.json`. Re-stamping into the same directory was
   correctly refused by the writer (`refusing to overwrite an existing handoff`, exit 66,
   `logs/10-stamp-rebased.txt`) — immutability working as designed.
3. **`parentHandoffHash: null`.** FIX-3C declared `nextTaskId: FIX-4` / `nextBaseSha: 3881178f`, and two
   conductor commits (`5d000abc` docs, `74b54eb1` gitignore) intervened, so strict parent continuity was
   impossible for this unit. From FIX-4B onward the chain is strict again: FIX-4A declares
   `nextTaskId: FIX-4B`, `nextBaseSha: 5c5d5a5d…`, which is the branch HEAD.

## Root cause fixed here

Run artifacts (logs, fixtures, handoffs, reports) are now ignored by `.gitignore`, so writing them no longer
dirties a worktree and no conductor commit is needed between units — the condition that broke parent-chain
continuity in FIX-3B/FIX-3C/FIX-4A.
