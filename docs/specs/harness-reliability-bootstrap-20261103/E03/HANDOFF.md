# HANDOFF E03 — deterministic error normalization (planned task, ordinal 9)

You are a **single microtask worker** on branch `feat/e03-error-normalize`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-e03-error-normalize-20261104` (base SHA
`ba22f28a6b540de74eb49a88a3e4fd62a08af1b4`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `E03`)

> Build deterministic error normalization — "Map known HTTP, network, tool, context, worker result and crash
> shapes into E02 schema; unknown category is allowed; preserve original evidence reference."
> Evidence required: "Fixture table covers 429, 404, 400, 5xx, timeout, exit status, missing worker result."

`E02` already landed: read `src/incidents/errorEvent.ts` (the versioned `ErrorOccurrence` schema) and
`test/unit/error-event.test.ts` **before** writing anything, and conform to them exactly — do not modify them.

## Required change (two files; a second test file is allowed but not needed)

1. `src/incidents/errorNormalize.ts` — export a pure, deterministic normalizer, e.g.
   `normalizeError(input: UnknownErrorInput, ctx: NormalizationContext): ErrorOccurrence`, that:
   - maps these shapes to a stable `code`/`category`/`severity` and human summary:
     HTTP **429** (rate limited), **404** (not found), **400** (bad request incl. the gateway's
     `no thinking match for model …` shape), **5xx** (upstream), network failure (`ECONNREFUSED`,
     `ETIMEDOUT`, `EAI_AGAIN`, socket hang up), **timeout**, tool/worker **exit status** (non-zero exit code,
     stderr excerpt), **missing worker result** (a worker that finished with no structured result), and crash
     shapes (`panic`, `SIGSEGV`, `OOMKilled`);
   - anything unrecognised must still produce a valid `ErrorOccurrence` with an explicit *unknown* code — it
     must never throw and must never lose the input;
   - **preserves the original evidence reference**: whatever artifact/path/blob the input carried must appear
     in the output's artifact references, unchanged, alongside any derived ones;
   - is deterministic: same input + same context ⇒ byte-identical output (no `Date.now()`, no `Math.random()`,
     no iteration-order dependence); timestamps come from the context.
   - redacts secrets the way `errorEvent.ts` does (reuse its helpers/types rather than duplicating policy).
2. `test/unit/error-normalize.test.ts` — a fixture table covering at least the seven required shapes above
   (429, 404, 400, 5xx, timeout, non-zero exit status, missing worker result) plus an unknown shape and an
   evidence-reference-preservation case; assert the exact `code`/`severity` and that normalization is
   idempotent (normalizing the same input twice yields deep-equal results).

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/incidents/errorNormalize.ts`
- `test/unit/error-normalize.test.ts`

Budget: **2 production files, 2 test files, at most 100 changed lines total (added + deleted)**. Keep it tight:
a table-driven mapper plus a small fallback is enough; do not build a framework.

Never touch `src/incidents/errorEvent.ts`, `src/incidents/types.ts`, `src/bootstrap/**`, `scripts/**`,
`package.json`, `test/support/**` or any other test. Existing assertions must stay untouched.

## Acceptance criteria (each proved by output you paste)

1. Every row of the fixture table produces the expected `code`, `severity` and a non-empty summary; the table
   includes 429, 404, 400, 5xx, timeout, exit status and missing worker result.
2. An unknown input yields a valid occurrence with an explicit unknown code, and the function does not throw.
3. The original evidence reference appears unchanged in the output's artifact references for at least two rows.
4. Normalizing the same input twice returns deep-equal objects (determinism).
5. `npm run typecheck` and both commands in the `verify` line exit 0, and
   `node --test --import ./test/support/isolatedState.ts test/unit/error-event.test.ts` still exits 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/error-normalize.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/error-event.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must list only your two files, total ≤ 100 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened assertions, no scope widening. If the gateway
switches your model away from `metabolomics/qwen3.8-flash_next`, say so in your report.

## Commit and report

1. `git add` only your files; one commit: `feat(incidents): deterministic error normalization (E03)`.
2. Write `E03/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/E03/`:
   the exported API, the fixture table, commands with exit codes, numstat totals, commit SHA, risks, anything
   you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, `--no-verify`, or any
state mutation outside your worktree.
