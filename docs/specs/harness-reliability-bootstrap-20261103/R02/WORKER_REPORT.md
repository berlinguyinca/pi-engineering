# WORKER_REPORT — R02 (cross-layer retry correlation identity)

- Branch: `feat/r02-correlation` · Base: `9e508548602b78ab9b21bf3082e3dc6aca0e819e` · Commit: `ec19e510`
- Commit message: `test(inference): pin cross-layer retry correlation identity and duplicate-action detection (R02)`
- Parent handoff: `docs/specs/harness-reliability-bootstrap-20261103/R01/R01.handoff.json` (sha256:c1edac57…ac5711a, PASS, resultSha = base).

## Diff (`git diff --numstat 9e508548602b78ab9b21bf3082e3dc6aca0e819e HEAD`)

```
73	0	test/unit/retry-correlation.test.ts
```

1 file, 73 changed lines (budget: ≤ 100 lines, ≤ 2 files). **`src/inference/retryTrace.ts` is untouched** — no test I
wrote exposed a real gap; all five properties hold against the API as it exists at base. `RetryTrace` keeps its five
original fields (`layer`, `attempt`, `reason`, `next`, `owner`) plus the existing optional `failure_id` / `error_ref`,
and the `RetryLayer` / `RetryNext` unions are byte-identical (`git diff` proves it). No reimplementation, rename or
wrapper: the test imports `failureIdentity`, `errorRef`, `actingLayers`, `recordRetryTrace` directly.

## Verify (at commit ec19e510)

| Command | Exit |
| --- | --- |
| `npm run typecheck` (typecheck:core + typecheck:scripts) | **0** |
| `node --test --import ./test/support/isolatedState.ts test/unit/retry-correlation.test.ts` | **0** — 5 tests / 5 pass / 0 fail |

## Compatibility run (contract-required, green)

`node --test --import ./test/support/isolatedState.ts test/unit/retry-error-events.test.ts test/unit/gateway-transient-boundary.test.ts test/unit/transient.test.ts`
→ exit **0**, 51 tests / **51 pass** / **0 fail**.

Per file (same exit 0 each): `retry-error-events` 4 pass / 0 fail · `gateway-transient-boundary` 7 pass / 0 fail ·
`transient` 40 pass / 0 fail (4+7+40 = 51, matches the combined run).

## Properties pinned (one `it()` each, no narrative comments, no clock/RNG/network/scheduler assertions)

1. `resilient-stream` and `worker-transient-retry` derive byte-identical `failureIdentity` over one
   `FailureIdentityInput`; the two trace entries carry different `attempt` values yet the same id, and the identity
   keys are pinned to exactly `error, firstAttempt, model, originLayer, provider, runId, sessionId` (no observing
   layer, no observing attempt).
2. Same session + different error (429 wait object vs 500 error), different `sessionId`, different `runId`, and
   attempt-3-500 vs attempt-4-429 each produce different ids; re-deriving one failure is byte-identical.
3. Two entries sharing one `failure_id` with `next: "retry"` + `next: "hold"` → `actingLayers` returns both; one
   acting layer plus `defer` entries on the same `failure_id` → exactly one; all five entries correlate to one
   failure, so `actingLayers().length > 1` **is** the multiplication signal — no new detector invented.
4. A five-original-field `RetryTrace` literal is assignable and `recordRetryTrace(trace, entry)` with no telemetry
   and no identity appends without throwing; with `failure_id` + `error_ref` present they ride the
   `inference.retry.trace` payload unchanged (recorded by `Probe`, a three-line `InferenceTelemetry` subclass that
   captures event name + payload).
5. Same input twice → same id; id matches `^sha256:[0-9a-f]{64}$`; `errorRef` over an error whose message carries
   `/Users/secret/personal/token=abc` holds only `code`/`layer`/`severity` + a 32-hex digest
   (`gateway.5xx.upstream` / `gateway` / `error`) and none of the raw text.

## Non-vacuity check (temporary, reverted)

Three throwaway mutations of `src/inference/retryTrace.ts`, each run then restored, each caught by exactly one test:

| Mutation | Result |
| --- | --- |
| drop `sessionId` from the identity digest | 4 pass / **1 fail** (property 2) |
| drop `error_ref` from the emitted payload | 4 pass / **1 fail** (property 4) |
| `actingLayers(...).slice(0, 1)` | 4 pass / **1 fail** (property 3) |

`src/inference/retryTrace.ts` was restored byte-identical (sha256 `1d03ba2d…c3ae6db6` before and after; `git diff` clean).

## Notes

- `assert` from `node:assert/strict` carries assertion signatures here, so `ref` is declared `const ref: ErrorRef | null` and narrowed by `assert.ok(ref !== null, …)` instead of a `!` assertion.
- `node_modules` is a local symlink to the main checkout's install (per repo policy) and is gitignored — not part of the diff.
- `npm run lint` (`biome check .`) reports 119 pre-existing errors at base, including the sibling
  `test/unit/retry-error-events.test.ts` whose dense one-line style this file follows; formatting is not a contract
  gate and no unrelated file was reformatted.
- No push/PR performed: R02 is `isolated-change` mode on its own worktree/branch; the commit is on `feat/r02-correlation`.
