# HANDOFF E07 — capture gateway and inference failures (planned task, ordinal 13)

You are a **single microtask worker** on branch `feat/e07-retry-error-events`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-e07-retry-error-events-20261104` (base SHA
`9f349bb9c6068a342995dc6bf58d3f7b09b6ecb4`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `E07`)

> "Capture gateway and inference failures" — "Extend existing retry telemetry with correlatable occurrence
> identity and safe normalized error reference; **preserve single-owner retry semantics and existing APIs**."
> Evidence required: "One upstream failure with three layer observations remains one occurrence."
> `dependsOn: [E06]`, production `src/inference/retryTrace.ts`, tests `test/unit/retry-error-events.test.ts`.

## Read first (modify none of them)

- `src/inference/retryTrace.ts` (62 lines, pure data + one emitter: `RetryLayer`, `RetryNext`, `RetryTrace`,
  `actedOn`, `actingLayers`, `recordRetryTrace(into, entry, telemetry?, identity?)`). Its doc comment is the
  contract: one failure, one acting owner; more than one acting layer is a multiplication bug.
- `src/incidents/errorNormalize.ts` (E03 `normalizeError`), `src/incidents/errorSanitize.ts` (E04
  `sanitizeForPersistence`), `src/incidents/errorEvent.ts` (E02), `src/runtime/isolation/SessionErrorWriter.ts`
  (E05), `src/workers/PiWorkerExecutor.ts`'s E06 seam (`workerFailureOccurrence`, `recordWorkerFailure`) — that
  is how worker failures already enter the stream; gateway/inference failures must become correlatable with it.
- Consumers that must keep compiling unchanged: `src/inference/resilientStream.ts`, `src/workers/PiWorkerExecutor.ts`,
  anything else importing `retryTrace.ts` (`npm run typecheck` proves it).

## Required change (two files)

1. `src/inference/retryTrace.ts` — **additive only**, no signature breaks:
   - a correlatable identity for the *upstream failure*, e.g.
     `failureIdentity({ sessionId, runId?, provider?, model?, error, originLayer, firstAttempt }, clock?) => string`
     returning a stable digest (sha256 hex or `sha256:…`) that depends on the failure and its scope but **not**
     on which layer is observing it or on that layer's attempt number — so three layers observing one upstream
     failure derive the same id;
   - an optional field on `RetryTrace` (e.g. `failure_id?: string`) plus an optional normalized reference in the
     emitted telemetry (e.g. `error_ref?: { code; layer; severity; summary_digest }` — produced through E03
     `normalizeError` and E04 `sanitizeForPersistence`, carrying **only** normalized/short-safe values, never raw
     message text, absolute paths, secrets or prompt content);
   - `recordRetryTrace` keeps its current parameter list and behaviour (push + emit) while including the identity
     and the safe reference in the emitted payload when available; if you need extra inputs, take them as
     additional **optional** parameters or an optional options object appended last — existing callers must work
     untouched;
   - keep single-owner semantics untouched: do not change `actedOn`/`actingLayers`, do not add acting behaviour,
     do not touch retry/hold/failover logic anywhere.
2. `test/unit/retry-error-events.test.ts` — pure, no network:
   - **the evidence test**: one upstream failure (e.g. a 503/cut-stream error) observed by three layers
     (`resilient-stream` retry, `worker-gateway-hold` defer, `model-takeover` failover, each with its own attempt
     numbering) yields the **same** `failure_id` on all three entries, and `actingLayers(trace)` still reports
     exactly one acting owner — one occurrence, one owner;
   - a second, different failure (different error or different scope) yields a **different** id, and the same
     failure re-derived twice is byte-identical (determinism);
   - the emitted telemetry payload carries `failure_id` + `error_ref`, and a fake secret (`sk-…`), absolute path
     and long prompt placed in the raw error appear **nowhere** in the payload;
   - existing API compatibility: `actedOn`, `actingLayers`, `recordRetryTrace` still work when called with the
     old argument lists (an entry without `failure_id` records and emits as before) — assert it.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/inference/retryTrace.ts`
- `test/unit/retry-error-events.test.ts`

Budget: **2 production files, 2 test files, at most 100 changed lines total (added + deleted)**.

Never touch `resilientStream.ts`, `PiWorkerExecutor.ts`, `src/incidents/**`, `src/runtime/isolation/**`,
`src/bootstrap/**`, `scripts/**`, `package.json`, `test/support/**` or any other test.

## Acceptance criteria (each proved by output you paste)

1. Three layer observations of one upstream failure → one identical `failure_id`, one acting owner (the evidence
   requirement, asserted in the test you name explicitly in your report).
2. Distinct failures → distinct ids; derivation deterministic across repeated calls.
3. `error_ref` is normalized and safe: no secret / absolute path / prompt text in the emitted payload.
4. Existing APIs intact: old-arity calls still push and emit; `actedOn`/`actingLayers` unchanged.
5. `npm run typecheck` and the two `verify` commands exit 0, and these existing retry-suite files still exit 0:
   `test/unit/gateway-stream-retry.test.ts`, `test/unit/resilience-retry-window.test.ts`.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/retry-error-events.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/gateway-stream-retry.test.ts test/unit/resilience-retry-window.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must list only your two files, total ≤ 100 lines. If an existing retry test is red
**at the base commit**, say so and paste proof (`git stash`-free method: run it, note the failure, and state that
you did not touch that file) rather than "fixing" it. If the gateway drops your turn or switches your model away
from `metabolomics/qwen3.8-flash_next`, say so.

## Commit and report

1. `git add` only your files; one commit: `feat(inference): correlate retry traces with error occurrences (E07)`.
2. Write `E07/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/E07/`:
   the identity derivation rule (what it includes/excludes and why), the payload shape, commands with exit codes,
   numstat totals, commit SHA, risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, changing retry/hold/
failover behaviour or single-owner semantics, `--no-verify`, or any state mutation outside your worktree.
