# HANDOFF E06 — capture worker/tool failures at one stable seam (planned task, ordinal 12)

You are a **single microtask worker** on branch `feat/e06-worker-error-events`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-e06-worker-error-events-20261104` (base SHA
`d19553b9601f616be01b65c5041c91ed2e9ff889`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `E06`)

> "Capture worker/tool failures at single stable seam" — "Wire E05 on one verified SDK failure path only;
> record model/role/session identity and tool exception; **do not change retry or failure behavior**. Audit
> actual hook before editing." Evidence required: "Injected worker failure emits one error and preserves
> existing outcome." `dependsOn: [E05]`, `maxChangedLines: 100`.

## Audit before you write (do this first, quote what you find in your report)

`src/workers/PiWorkerExecutor.ts` is ~2500 lines. Find the **one** place where a provider/transport (or tool)
failure becomes terminal for the attempt — the `catch (err)` block near the end of the run loop whose comment
distinguishes an expected abort (`session.abort()` from stall/budget/timeout) from a real provider/transport
error (around the "Capture the error" comment), plus `emitTelemetry(...)`/`emitWorkerActivity(...)` as the
existing non-behavioural reporting channel. Quote the line numbers you chose and why the alternatives (e.g. the
per-tool `catch` sites, `wireResilience`, `scanForTerminatingResult`) are not the single stable seam.

## Required change (two files)

1. `src/workers/PiWorkerExecutor.ts` — add and wire a capture hook, changing **no** control flow:
   - export a pure builder, e.g. `workerFailureOccurrence(ctx, error): ErrorOccurrence | null`, where `ctx`
     carries what the plan demands — `sessionId`, `runId`/`taskId`, `role`, `model` (and quantization if known),
     the tool name/exception when the failure came from a tool call — and the output is produced through
     E03's `normalizeError` and E04's `sanitizeForPersistence` so it satisfies E02's `parseErrorOccurrence`
     (layer `worker` unless the audited seam is genuinely a different layer; stable dotted code);
   - export the emitter, e.g. `recordWorkerFailure(writer | undefined, ctx, error): boolean` which builds the
     occurrence, calls the E05 `SessionErrorWriter` when one is present, **swallows every failure of the capture
     itself** (a broken writer, a refusal, a throw must never escape) and reports that swallow through the
     existing `emitTelemetry`-style channel rather than a new one;
   - call it at exactly **one** site: the audited terminal failure path. No retry logic, no abort logic, no
     return-shape, no message-text, no telemetry-level changes anywhere else in the file; no new option unless
     the writer has to be injected (if you add one, it must default to "no writer" so behaviour is unchanged
     when it is absent).
2. `test/unit/worker-error-events.test.ts` — no real SDK session, no network:
   - the builder turns an injected provider error (e.g. a 503/cut-stream shape) and an injected tool exception
     into occurrences that pass `parseErrorOccurrence`, carry the role/model/session identity you passed, and
     contain no secret/absolute-path/prompt content (put a fake `sk-…` key and an absolute path in the raw error
     and assert they are gone);
   - the emitter with a fake writer records **exactly one** occurrence per failure, returns a value your test
     asserts, and when the fake writer throws or the occurrence is refused it still returns without throwing —
     proving the outcome is preserved;
   - a structural assertion that the seam is single: read `src/workers/PiWorkerExecutor.ts` and assert the
     capture call appears exactly once and inside the audited failure path (count occurrences of the call
     expression, and assert it appears in the same function as the "Capture the error" comment / the terminal
     catch you audited) — keep this assertion honest and commented as a structural check;
   - assert the builder is pure/deterministic (same input twice → deep-equal apart from timestamp, which you fix
     through the injected clock/policy if available, otherwise compare all fields except `timestamp`).

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/workers/PiWorkerExecutor.ts`
- `test/unit/worker-error-events.test.ts`

Budget: **2 production files, 2 test files, at most 100 changed lines total (added + deleted)**. Keep the
production addition small (a builder, an emitter wrapper, one call site).

Never touch `src/runtime/isolation/**`, `src/incidents/**`, `src/bootstrap/**`, `scripts/**`, `package.json`,
`test/support/**` or any other test. Do not add tests that need a real pi SDK session or the network.

## Acceptance criteria (each proved by output you paste)

1. Injected worker failure (provider error and tool exception) emits exactly one sanitized occurrence per
   failure; the occurrence validates against E02 and carries model/role/session identity.
2. Capture failure cannot change the outcome: writer throws / occurrence refused ⇒ emitter returns, nothing
   throws, nothing else is called twice.
3. Single seam: the structural assertion (call appears exactly once, in the audited failure path).
4. No behaviour change: `git diff -U0 HEAD~1 HEAD -- src/workers/PiWorkerExecutor.ts` shows only additions in
   the builder/emitter region and the one call site — paste it, and confirm no `-` lines remove existing logic
   (if any line must change, explain why in the report).
5. `npm run typecheck` and the two `verify` commands exit 0; and
   `node --test --import ./test/support/isolatedState.ts test/unit/generation-guard.test.ts` still exits 0 (it
   exercises `PiWorkerExecutor`'s option surface).

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/worker-error-events.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/generation-guard.test.ts
git diff --numstat HEAD~1 HEAD
git diff -U0 HEAD~1 HEAD -- src/workers/PiWorkerExecutor.ts
```

All must exit 0; the numstat must list only your two files, total ≤ 100 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no behaviour changes smuggled in, no scope widening. If the
gateway drops your turn or switches your model away from `metabolomics/qwen3.8-flash_next`, say so.

## Commit and report

1. `git add` only your files; one commit: `feat(workers): capture worker failures at one seam (E06)`.
2. Write `E06/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/E06/`:
   the audited seam (file:line + why), exported API, how capture failure is swallowed, commands with exit codes,
   numstat totals, commit SHA, risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, changing retry/abort/
timeout/telemetry behaviour, `--no-verify`, or any state mutation outside your worktree.
