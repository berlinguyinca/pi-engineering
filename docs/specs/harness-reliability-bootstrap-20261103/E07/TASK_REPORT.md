# E07 report — capture gateway and inference failures (ordinal 13)

**Status: PASS, merged.** `feat/e07-retry-error-events-squashed` fast-forwarded into
`harness-reliability-bootstrap-20261103`: `9f349bb9` → `8f33cfbb6cd0ce4f4a3b5f24e02965a1776cd447`.

| item | value |
| --- | --- |
| diff | `src/inference/retryTrace.ts` 58/1, `test/unit/retry-error-events.test.ts` 40/0 → 99 changed lines (budget ≤100) |
| handoffHash | `sha256:5c2b097b2cc87c0e0c33851a46e34040ec19cccaf2d28dbb7a30422a8f25b3fe` (MATCH, 0 schema errors) — regenerated once, see the correction below |
| taskAuthorityHash | `sha256:cdbb9347e24049a34d74557f1294e4d0576ced5e25bc1c190cbe47b5ea659048` |
| parent | **strictly verified**: `parent=E06 accepted sha256:0f66047a471…` (`nextTaskId: E07`, `nextBaseSha == baseSha`) |
| base / result / next | `9f349bb9c606…` / `8f33cfbb6cd0…` / `E08 @ 8f33cfbb6cd0…` |

Additive only: `failureIdentity(input, clock?)` digests scope + failure (session/run/provider/model/origin error)
and deliberately **excludes** the observing layer and that layer's attempt number, which is what makes
"one upstream failure with three layer observations" collapse to one occurrence; `RetryTrace` gained optional
`failure_id` (and `error_ref` on the emitted payload) built through E03 `normalizeError` + E04
`sanitizeForPersistence`, so telemetry carries `code`/`layer`/`severity`/`summary_digest` and never raw message
text, paths, secrets or prompts. `actedOn`, `actingLayers` and old-arity `recordRetryTrace` are unchanged; single
owner semantics are untouched and still asserted.

## Conductor verification (unit worktree, clean tree, before and after the budget trim)

| command | exit | log |
| --- | --- | --- |
| gate probe at the worker's first commit | **5 — REJECT** `changed-line-budget: 100 added + 1 deleted > limit 100` | `logs/04-gate-probe.txt` |
| `npm run typecheck` after the trim | 0 | `logs/05-typecheck-after-trim.txt` |
| `node --test … test/unit/retry-error-events.test.ts` (4/4, same tests before and after) | 0 | `logs/02…`, `logs/06-unit-retry-error-events-after-trim.txt` |
| neighbours: `gateway-stream-retry`, `resilience-retry-window`, `worker-error-events`, `session-error-writer` (47/47) | 0 | `logs/03…`, `logs/07-unit-neighbours-after-trim.txt` |

The 4 tests are exactly the evidence the plan asks for:
`E07 evidence: one upstream failure observed by three layers stays one occurrence with one acting owner`,
distinct/deterministic ids, payload safety (fake `sk-…`, absolute path and long prompt absent), and old-API
compatibility.

## Conductor-side history actions on this unit (disclosed)

This is the first unit where the conductor mutated history, and it includes a conductor mistake:

1. My stamping script ran `git merge --ff-only` **unconditionally after** the stamp step, so the two-commit E07
   branch got merged while the stamp had **rejected** it (`commit parent 3154642a != approved base 9f349bb9`,
   `logs/08-stamp.txt`). Caught immediately from the same output.
2. Undo: `git reset --hard 9f349bb9` on the local, never-pushed integration branch (nothing was lost — the
   commits remain on `feat/e07-retry-error-events`, tagged `e07-unstamped-two-commits`).
3. The gate requires `HEAD^ == approved base`, which a two-commit unit cannot satisfy without falsifying the
   manifest's `baseSha` (unacceptable — it would change the task authority hash). So the conductor squashed the
   worker's two commits into `8f33cfbb` with parent `9f349bb9`, message preserved, and **content proved
   byte-identical** for both files (`git diff --quiet a427f03e HEAD -- <both files>` → clean). Only then was the
   handoff stamped (PASS) and fast-forwarded.
4. The stamping script is now guarded: merge runs only if `STAMP=0` and the handoff validates (fixed for E08 on).

## Correction: wrong `nextTaskId` in the first stamped record

The first PASS record for E07 (handoffHash `sha256:d1bdf042eb15d8aae39c4d099a789867303296800b91cbb3cea887cd16d41da1`)
declared `nextTaskId: E08`, but the 51-task manifest has no E08 — the Error phase ends at E07 (ordinal 13) and
ordinal 14 is **D01**. The conductor regenerated the record from the same base, result, parent, proofs and log
set with `nextTaskId: D01` (`logs/10-stamp-nexttask-D01.txt`, STAMP=0), giving
`sha256:5c2b097b2cc87c0e0c33851a46e34040ec19cccaf2d28dbb7a30422a8f25b3fe`; the merged code is untouched
(`8f33cfbb6cd0…`), only the handoff metadata changed. The strict parent check will therefore accept D01.

## Deviations

Three gateway interruptions cut the worker's turns mid-edit (`Error: Dispatch to the selected node failed; it was
not started.`) and the model drifted to `metabolomics/qwen3.8-27b`; the unit was completed by instructing
one-file-per-turn. The worker's line-budget breach was caught by the deterministic gate, not by review.
