# FIX-3C report — the emit path schema-validates before it stamps

**Status: PASS, merged.** `fix/fix3c-schema-gate-at-stamp` fast-forwarded into
`harness-reliability-bootstrap-20261103`: `0ddf2771` → `3881178f963d01cad1e6fcedb95c696f27d3ac5d`.

| item | value |
| --- | --- |
| diff | `scripts/bootstrap-one.ts` 18/5, `test/unit/bootstrap-one.test.ts` 39/3 = 65 lines (budget 1 production / 1 test / ≤85) |
| handoffHash | `sha256:0bc72a82f0e17f712c7a2c9ac134edce17fbf07af0dc4298c8d7f669bf96ee98` |
| taskAuthorityHash | `sha256:5f6183004f02b89ed52c0d3efe5425452f76e316054c7ecb456a36a5cb3b29de` |
| parent | FIX-3B2 `sha256:d2435ac2784…` — `parent=FIX-3B2 accepted` printed at stamp |

`--emit-handoff` now **requires** `--handoff-schema <path>`; `preStampSchema()` reads schema+record fail-closed
(absent, unreadable or non-JSON → blockers, never an exception), the validator's blockers join the gate's
blocker list, and the stamp goes through `handoffWriter.writeHandoff` instead of `resultGate.writeHandoff`.

## Environment incident (first attempt)

The first worker (pane `w0:p4`, `metabolomics/qwen3.8-flash_next`) was killed mid-unit by the gateway:
`no capacity on this deployment` → auto-fallback to `qwen3.8-27b` → `qwen3.8-27b-text` →
`Dispatch to the selected node failed; it was not started.` It left `scripts/bootstrap-one.ts` modified but
uncommitted; that diff is preserved at `logs/01-worker-partial-diff.txt` (19/5). The unit was resumed by a
second worker (`fix3c2`, pane `w0:p6`, same pinned model) which reviewed the partial change, tightened it,
added the tests and committed. **No work was discarded and no history was rewritten.**

## Conductor verification (detached clean worktree `/tmp/fix3c-verify` at `3881178f`)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` | 0 | `logs/02-conductor-typecheck.txt` |
| `node --test … test/unit/bootstrap-one.test.ts` (13/13) | 0 | `logs/03-conductor-unit-one.txt` |
| `node --test … test/unit/bootstrap-*.test.ts` | 0 | `logs/04-conductor-unit-all.txt` |

Conductor-run negative controls (the worker's own tests were not trusted):

| case | exit | REJECT gate line | files in out dir |
| --- | --- | --- | --- |
| no `--handoff-schema` (`logs/05`) | 5 | `--emit-handoff requires --handoff-schema…` | 0 |
| record with `status: "DONE"` (`logs/06`) | 5 | `$.status: "DONE" is not one of enum [PASS, ALREADY_SATISFIED, BLOCKED]` | 0 |
| `--handoff-schema docs/nope.schema.json` (`logs/07`) | 5 | `handoff schema … is unreadable (ENOENT…)` | 0 |
| `--handoff-schema` on `not_json` (`logs/08`) | 5 | `handoff schema /tmp/bad-schema.json is not valid JSON (…)` | 0 |
| conforming record (`logs/09`) | 0 | `schema=FIX-3C conforms docs/…/handoff.schema.json` + `gate=accepted` | 1 |

No stack trace in any negative case. Existing assertions in `bootstrap-one.test.ts` and
`bootstrap-package.test.ts` were left intact (`git diff` shows additions only).

## Follow-up handed to FIX-4

`nextTaskId: FIX-4` — `taskAuthorityHash` is still declared by every record but never derived or checked at
stamp time; `MICROTASK_CEILING.maxChangedLines = 100` contradicts the spec's "Herdr UI ≤120" and the 7 H-phase
tasks that declare 120; `H01` is declared `read-only` yet declares a 120-line budget; `limits.maxLinesPerFile`
and `maxFilesPerFileBudget` remain inexpressible in a manifest.
