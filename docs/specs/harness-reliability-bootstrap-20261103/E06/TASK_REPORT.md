# E06 report — capture worker/tool failures at one stable seam (ordinal 12)

**Status: PASS, merged.** `feat/e06-worker-error-events` fast-forwarded into `harness-reliability-bootstrap-20261103`:
`d19553b9` → `9f349bb9c6068a342995dc6bf58d3f7b09b6ecb4`.

| item | value |
| --- | --- |
| diff | `src/workers/PiWorkerExecutor.ts` 49/0, `test/unit/worker-error-events.test.ts` 50/0 → 99 lines (planned budget 2 production / 2 test / ≤100) |
| handoffHash | `sha256:0f66047a4716c0d62f83541553cf45fdcc9667a905ad00a86015afef6be900bb` (MATCH, 0 schema errors) |
| taskAuthorityHash | `sha256:c034387526ece033e813dd6f4c867a210958810ddd07f6998cd7e7ef0c00feaa` |
| parent | **strictly verified**: `parent=E05 accepted sha256:40b04647d4b…` (`nextTaskId: E06`, `nextBaseSha == baseSha`) |
| base / result / next | `d19553b9601f…` / `9f349bb9c606…` / `E07 @ 9f349bb9c606…` |

The audited seam is `src/workers/PiWorkerExecutor.ts:2122`, inside the terminal failure path that assigns
`promptError = err` and is already guarded by `!ownerAborted && !stalled && !unknownToolLoop && !toolLoop` —
exactly the failures that become terminal, with expected aborts excluded. Capture is
`void recordWorkerFailure(this.workerErrorWriter?.(req), workerFailureContext(req, model, attempt), err);`.

**No behaviour change, proven mechanically:** `git diff -U0 HEAD~1 HEAD -- src/workers/PiWorkerExecutor.ts`
contains **zero** removed lines (`grep -c '^-[^-]'` → 0, `logs/04-prod-diff.txt`); the only new surface is
`workerFailureOccurrence()` (identity from the live request + the model id it carries, through E03
`normalizeError` then E04 `sanitizeForPersistence`), `recordWorkerFailure()` (every capture failure — refusal,
throw, absent writer — becomes a return value plus one telemetry notice, never an exception), and an optional
`workerErrorWriter?: (req) => ErrorOccurrenceWriter | undefined` option that defaults to *no writer*, so an
unconfigured executor behaves exactly as before. Call sites: **one** (the second `recordWorkerFailure(` match is
the definition).

## Conductor verification (unit worktree, clean tree)

| command | exit | log |
| --- | --- | --- |
| `npm run typecheck` (spec `verify` 1) | 0 | `logs/01-typecheck.txt` |
| `node --test … test/unit/worker-error-events.test.ts` (7/7) (spec `verify` 2) | 0 | `logs/02-unit-worker-error-events.txt` |
| `node --test … test/unit/generation-guard.test.ts` (37/37, exercises `PiWorkerExecutor` option surface) | 0 | `logs/03-unit-generation-guard.txt` |
| production diff (scope + no-removal check) | 0 | `logs/04-prod-diff.txt` |

Worker's 7 tests cover: injected provider failure emits one valid occurrence with session/role/model identity;
tool exception captured with secret and absolute path gone; builder purity; exactly one occurrence handed to the
writer per failure; writer throw/refusal cannot change the outcome and each swallow is reported once; identity
derived from the live request.

## Deviations

Commit subject is `feat(runtime): capture worker failures as error occurrences` rather than the prescribed
`feat(workers): capture worker failures at one seam (E06)` — same scope and files, noted instead of amended. No
gateway interruptions this unit; the worker finished in one turn.
