# FIX-5 report — a parent handoff may only be a base if its status is an accepted result

**Status: PASS, merged.** `fix/fix5-parent-status` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`7f983ee0` → `ba22f28a6b540de74eb49a88a3e4fd62a08af1b4`.

| item | value |
| --- | --- |
| diff | `scripts/bootstrap-one.ts` 6/4, `test/unit/bootstrap-one.test.ts` 37/0 → 47 lines (budget 1 production / 1 test / ≤70) |
| handoffHash | `sha256:1e87cb429e78d7c38d2b5261bcc35ca533e91378d33e1174f6e87fe165fa844a` (recomputes identically, 0 schema errors) |
| taskAuthorityHash | `sha256:0acff3d81505194e970132cdf8df86ffcf2f3320f49a19f1be50526f67935fcc` |
| parent | **strictly verified**: `parent=FIX-4B accepted sha256:9d8b3fd9264…` (nextTaskId FIX-5, nextBaseSha == this baseSha) |
| base / result / next | `7f983ee05c0d…` / `ba22f28a6b54…` / `E03 @ ba22f28a6b54…` |

`validateParentHandoff` now rejects any parent whose `status` is not `PASS` or `ALREADY_SATISFIED`, so a blocked
unit can no longer be the base of the next task; the `parent=<taskId> accepted …` line is now only printed on an
accepted status.

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` | 0 | `logs/01-typecheck.txt` |
| `test/unit/bootstrap-one.test.ts` (22/22, was 18) | 0 | `logs/02-unit-one.txt` |
| `test/unit/bootstrap-*.test.ts` (62/62) | 0 | `logs/03-unit-all.txt` |

Conductor negative controls (conductor-authored; each control re-derives the parent hash over the mutated
parent and re-derives the record authority from the control manifest, so the **only** differing factor is the
parent status):

| parent status | exit | files written | decisive line | log |
| --- | --- | --- | --- | --- |
| `BLOCKED` | 5 | 0 | `REJECT gate: parent handoff FIX-4B reports status BLOCKED; only PASS or ALREADY_SATISFIED may be a base` | `logs/04-control-blocked-parent.txt` |
| key absent | 5 | 0 | `REJECT gate: parent handoff FIX-4B reports status undefined; only PASS or ALREADY_SATISFIED may be a base` | `logs/05-control-status-absent.txt` |
| `ALREADY_SATISFIED` | 0 | 1 | `parent=FIX-4B accepted sha256:0c4af6c5a3e…` … `handoff=…/FIX-5.handoff.json checksum=sha256:34ff1e2c…` | `logs/06-control-already-satisfied.txt` |

## Conductor-side deviations (disclosed)

1. **FIX-4B forward pointer amended.** FIX-4B's stamped handoff declared `nextTaskId: FIX-4C`, but the assumed
   FIX-4C defect turned out not to exist: `TaskLimits.maxLinesPerFile` / `maxFilesPerFileBudget` appear nowhere
   in `src`, `test` or `templates` (`grep -rn` over the unit tree returns nothing), so no unit was created for
   it. FIX-4B's record was re-stamped (into `FIX-4B/out2/`, the earlier file preserved as
   `out/FIX-4B.handoff.SUPERSEDED-nextFIX4C.json`) with `nextTaskId: FIX-5` and a note recording this. Its
   base/result SHAs, diff and verdict are unchanged; its handoffHash is now
   `sha256:9d8b3fd9264c8626a2aa6595c403c260b9d233d323554f08e5e9349ccbbb387e` (recomputes identically). That is
   why this unit's manifest pins that hash instead of the earlier one.
2. **Manifest deny list corrected.** The first stamp attempt was rejected because the conductor's standard
   deny list included `scripts/**`, which denied the unit's own production file
   (`REJECT gate: diff scope rejected (denied-path): denied by "scripts/**"`, exit 5, nothing written —
   evidence that deny-over-allow precedence holds). The manifest was rebuilt with a deny list that excludes the
   unit's own files; authority was re-derived from the corrected manifest, and the accepted stamp is in
   `logs/07-stamp.txt`.

## Chain state after this unit

`B00 → … → FIX-3C → FIX-4A → FIX-4B → FIX-5`, with `parentHandoffHash` verified end-to-end for the last three
links (FIX-3B and earlier carry `parentHandoffHash: null`, documented in their reports). `nextTaskId: E03` —
the first planned spec task, now running on a gate that has survived negative controls for diff scope, parent
chain, parent status, schema conformance and task authority.
