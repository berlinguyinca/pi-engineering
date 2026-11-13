# FINAL_AUDIT addendum — B00–B05 back-filled (2026-11-05)

`FINAL_AUDIT.md` (commit 05b730fd) recorded one structural gap: "B00–B05 carry no handoff record
at all." That gap is now closed. The original audit is left untouched; this addendum supersedes
only its missing-artifact ledger for the B family.

## What was done
No record was pasted onto today's tip. Each unit's own landed commit was checked out in a detached
worktree and the unit's **declared** verify commands were re-run there, and only then was a record
emitted against that commit:

| unit | commit (resultSha) | base | re-run at that commit | record hash (first 12) |
|---|---|---|---|---|
| B00 | `cf1aaf12` (new, branch `backfill/b00-baseline-20261108`) | `c2b75dc9` | `git status --short` empty, `git rev-parse HEAD`, `npm run typecheck` exit 0 | `d9cc71da…` |
| B01 | `be581d1d` | `c2b75dc9` | typecheck 0; 3 tests / 0 fail | `ae3c2f9c…` |
| B02 | `bcfee3b0` | `be581d1d` | typecheck 0; 3 / 0 | `fbf3f7df…` |
| B03 | `bfffb539` | `bcfee3b0` | typecheck 0; 2 / 0 | `a1d6030e…` |
| B04 | `7e7157c7` | `bfffb539` | typecheck 0; 4 / 0 | `4c4c0866…` |
| B05 | `36cab891` | `7e7157c7` | typecheck 0; 3 / 0 | `064b4e71…` |

The chain is the real landed chain, not a reconstruction: each commit's parent is the base the
previous record names, and `B05.nextBaseSha = 36cab891c696…` equals `E01.baseSha`, so the back-filled
prefix joins the already-landed chain at the same commit (verified by comparison, printed in the
conductor log). Records live in `<unit>/out-backfill/`; raw logs in `<unit>/logs/`.

## Corrections to earlier statements
1. **B00's deliverable never existed.** The manifest declares
   `docs/specs/harness-reliability-bootstrap/BASELINE.md` as B00's production path and no commit in
   the repository ever added that file (`git log --diff-filter=A` finds nothing). It was written from
   the re-run observations and is the result of the back-fill commit; it also reached the lineage via
   cherry-pick `43c65fd3`.
2. **Mode contradiction, not operator error.** B00 is declared `mode: read-only`, but
   `src/bootstrap/diffGuard.ts:62` rejects *any* changed path under `read-only`, so the declared
   deliverable cannot be produced in the declared mode. B00 is recorded `isolated-change`, bounded to
   that one declared path (63 lines of a 100 ceiling). Same class of plan defect as R01/H01/H03/V05/V06.
3. **The full suite does not terminate at the B-series base.** `npm test` at `c2b75dc9` was
   conductor-terminated after ~20 minutes with no `tests/pass/fail` summary ever printed; the captured
   partial stream (20728 lines) contains 4615 `✔` and 1223 `✖` test names. The earlier
   `BASELINE-unit-suite-at-c349613b.txt` (2180 pass / 150 failure lines) is a *different* base and must
   not be quoted as this commit's total. "Never green" understates it: there is no completed baseline.
4. **`engineering.yaml` routing comment disagrees with its own values.** The rev-5 comment
   (`.pi/engineering.yaml:36-52`) says the text/vision roles pin logical gateway route IDs
   (`coding-planning`, `coding-implementation`, `coding-review`); every `model:` value in that block is a
   concrete model ID. Recorded as observed, not resolved.

## Still true from the original audit
- Full-suite verification remains absent (see 3); every unit is verified by its declared targeted commands.
- `operatorApproval.approved` is conductor-written under the operator's standing delegation
  (`02-HANDOFF-PROTOCOL.md:19` — hash detects accidental modification, not authorization).
- R03–R08 shipped and tested but not wired into live runtime paths (see `ROLLOUT.md`).
- Back-filled records are temporally out of order: they were emitted ~2 days after the work they
  describe, and B00's result commit sits on a side branch because a back-fill cannot be inserted into
  an already-landed chain. Both are stated in each record's `operatorApproval.notes`.
