# D07 worker report — bounded sanitized evidence bundle

Branch `feat/d07-evidence-bundle`, base `5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e`, commit `925836054ca7b8def51b4b2a636706e6c375e53b`.
Parent handoff: `docs/specs/harness-reliability-bootstrap-20261103/D06/D06.handoff.json` (sha256:7c4a903f0f483e4bfd9fc49be3f733ca9e439bb233c3b96a74926441d60799ce, resultSha = this base).

## Diff summary (`git diff --numstat 5a5a2a654a78475725a0e56ec4773c9dfa2e3f6e HEAD`)

```
58	0	src/incidents/evidenceBundle.ts
35	0	test/unit/error-evidence-bundle.test.ts
```

2 files, 93 changed lines (budget 100). Nothing else changed; `git status --porcelain` after the commit is empty apart from the untracked report file itself.

## Commands and exit codes (all run at the produced commit)

| command | exit |
| --- | --- |
| `npm run typecheck` (`typecheck:core` + `typecheck:scripts`) | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/error-evidence-bundle.test.ts` | 0 (4 tests, 4 pass, 0 fail) |
| `node --test --import ./test/support/isolatedState.ts test/unit/error-aggregate.test.ts` | 0 (6 pass) |
| `node --test --import ./test/support/isolatedState.ts test/unit/error-sanitize.test.ts` | 0 (6 pass) |
| `node --test --import ./test/support/isolatedState.ts test/unit/retry-error-events.test.ts` | 0 (4 pass) |

The full unit suite was **not** run, per the handoff (baselined red, ~25 min).

## What was built

`buildEvidenceBundle(input, limits)` — pure, read-only, deterministic, non-mutating. Reuses, never copies:
`sanitizeForPersistence` (E04) runs on every occurrence before anything is emitted; `errorFingerprint` (D02) keys the
representative groups; `aggregateErrorOccurrences` (D03) owns grouping, the duplicate fold and every count;
`classifyRecoveryOutcome` (D04) supplies the outcome class (absent evidence → `unknown`, never invented);
`failureIdentity`/`errorRef` (E07) derive retry identities from a caller-held raw failure instead of trusting a
caller-supplied string.

Contract points and where they live:
- Representative sanitized summary, fingerprint, counts, first/last seen: `EvidenceItem` from D03's cluster + the
  earliest occurrence (timestamp, then event id) of the group.
- Affected versions: distinct `runtime` / `model` / `quantization` across the group's rows, sorted, unset dimensions
  absent rather than a fabricated member.
- Linked retries: the group's own `failureIdentity` values plus E07 observations — a `RetryTrace` carrying a safe
  `error_ref`, or a `failures[]` scope whose identity E07 derives and attaches by `eventId`. Linkage rule: the
  observation's `{code, layer, severity}` equals the representative occurrence's, i.e. the same failure through
  E03+E04. Non-`sha256:<64hex>` ids are dropped (`FAILURE_ID`), never truncated into something id-shaped.
- Task/handoff ids: `task:` / `handoff:` correlation ids (`TASK_ID`, `HANDOFF_ID`) from the sanitized occurrences
  only; `mission:`/`run:` stay pointers.
- Privacy: every emitted string is E04 output or an E07 digest; byte accounting happens after sanitization.
- Caps: `maxItems` and `maxBytes` (plus `maxEventIds`), with `dropped: { items, bytes }` counting the item-cap drops
  and the byte-budget drops separately and in total, and `truncated` set. Envelope overhead (`reserve`) is measured
  once so `maxBytes` means the items.
- Determinism: items ordered by fingerprint, then firstSeen, then first eventId; fixed key order, so
  `JSON.stringify` is byte-identical for equal inputs in any input order (asserted against a reversed copy).

## Deviations / notes (none blocking, no BLOCKED condition)

1. The worktree had no `node_modules`, so the first `npm run typecheck` failed with `TS2688: Cannot find type
   definition file for 'node'`. Fixed by the documented convention (AGENTS.md "Symlink `node_modules` into the new
   worktree"): `ln -sfn /Users/wohlgemuth/IdeaProjects/pi-engineering-runtime/node_modules node_modules`. The
   symlink is gitignored and not part of the commit; `package.json` is byte-identical between base and HEAD, so the
   installed `@types/node` is the one this base asks for.
2. `docs/specs/harness-reliability-bootstrap-20261103/D07/fixtures/manifest.json` (named as the task authority
   source in the handoff header) does not exist in this checkout; only `D07/HANDOFF.md` is present. The objective,
   scope and verify commands were taken from `HANDOFF.md` and `tasks/20-D07.md`, which agree. No CLI integration
   point was invented — `scripts/**` is denied and D05's `DiagnoseDeps.evidence` slot stays untouched; D07 is the
   pure builder only, as the handoff's "a pure builder plus one bounded projection is enough" allows.
3. `retryTrace.ts` lives at `src/inference/retryTrace.ts` (the handoff names it by module, not by directory); it is
   imported from there. There is no import cycle: `retryTrace` pulls `errorNormalize`/`errorSanitize`, and
   `evidenceBundle` is a leaf.
4. `maxBytes` is enforced greedily in bundle order (largest-prefix fit, not optimal packing); a too-small budget
   yields zero items with the whole drop counted and reported, never a silently short bundle.

Next: D08, **only** after independent approval and manifest SHA check.
