# R08 handoff: the first record is superseded

Canonical record: `R08/out-corrected/R08.handoff.json` → `sha256:3621103302ed7ee7985f0ca9c7b17e3c68ba0a3a25a26abf9c432aa05a0eb569`
Void record: `R08/out/R08.handoff.json` → `sha256:c0a7d0683409f56cb796ef9956ba3e4300216f6b09ca24461af400716603dd51` (kept untouched; handoffs are immutable by construction — `writeHandoff` throws rather than rewriting, so a repair must be a new record, never a mutation).

## What was wrong
Both defects were in the **conductor's** record, not in the worker's commit:

| field | void value | correct value | why it matters |
|---|---|---|---|
| `nextTaskId` | `R09` | `H01` | No task `R09` exists anywhere in the plan (`grep R09` over the spec returns nothing): the sequence is R01–R08, then H01–H07, then V01–V06. A phantom successor is exactly the failure `scripts/bootstrap-one.ts:38` exists to catch — it rejected H01 with `parent nextTaskId R09 != H01`. |
| `nextBaseSha` | `12d47c2f…` (a **pi** commit) | `b5e6903c2f49c462c3e91528c42b5547137921ab` (**herdr** `origin/main`) | H01 lives in `berlinguyinca/herdr-engineering`. `02-HANDOFF-PROTOCOL.md:10`: "For cross-repo transitions, independently obtain target HEAD and use that as `nextBaseSha`." Pointing a herdr task at a pi commit would have made the first cross-repo step unverifiable. |

## What did not change
The task commit `12d47c2f5658f4e154474f4d235c397b43af65b3` (parent `e151794f`), its two-file diff scope (`src/incidents/resolutionEvidence.ts`, `test/unit/incident-resolution-evidence.test.ts`, 98 changed lines), and every proof artifact in `R08/logs/`. The corrective stamp re-ran the gate in a clean detached worktree at that commit — the gate stamps only a clean, committed task commit — and revalidated the parent chain (R07, `sha256:bb491e86…`). Nothing downstream references the void hash.
