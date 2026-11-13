# HANDOFF E04 — sanitization before durable error capture (planned task, ordinal 10)

You are a **single microtask worker** on branch `feat/e04-error-sanitize`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-e04-error-sanitize-20261104` (base SHA
`a0eca33248a368a45ea8208314f048db754bf35e`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Task (from `docs/specs/harness-reliability-bootstrap-20261103/manifests/tasks.json`, id `E04`)

> "Add sanitization before durable error capture" — "Reuse `src/platform/redact.ts`; limit payload size and
> redact tokens, host secrets, env values and paths where appropriate; never store raw prompts in error index."
> Evidence required: "Secret fixtures never appear in persisted representation." `dependsOn: [E03]`.

Read **before writing anything**: `src/platform/redact.ts` (exports `redactSecrets`, `redactDeep`,
`SECRET_RULES`, `SecretKind`), `src/incidents/errorEvent.ts` (E02 `ErrorOccurrence` +
`parseErrorOccurrence`), `src/incidents/errorNormalize.ts` (E03 output you are sanitizing). Do not modify them.

## Required change (two files)

1. `src/incidents/errorSanitize.ts` — export a pure, deterministic, **idempotent** sanitizer, e.g.
   `sanitizeForPersistence(occurrence: ErrorOccurrence, policy?: SanitizePolicy): ErrorOccurrence` that:
   - **reuses** `redactSecrets`/`redactDeep` — do not re-implement secret patterns;
   - enforces payload size caps: bounded summary length, bounded number of artifact refs and correlation ids
     (extras dropped with a count marker, not silently), and a total byte budget for the persisted record
     (document the constants at the top);
   - additionally redacts what `redactSecrets` does not cover: **environment values** (a value of any
     `process.env` entry whose name looks secret-bearing — `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*` —
     appearing anywhere in the text is replaced by a marker naming only the variable *name*), **absolute local
     paths** (`/Users/…`, `/home/…`, `/private/…`, `C:\…` → `<path>`), and **raw prompt/message content**
     (a field or blob that looks like a prompt transcript, or any single string longer than the summary cap,
     is replaced by `<redacted-prompt len=N sha256=…>` — length + digest only, never content);
   - returns something that still passes `parseErrorOccurrence`, never throws on a malformed input, and whose
     second application changes nothing (idempotence).
2. `test/unit/error-sanitize.test.ts` — secret fixtures (an OpenAI-style `sk-…` key, a `Bearer …` token, an AWS
   `AKIA…` id, a PEM private-key line, a fake env value injected via a `process.env` entry your test sets, an
   absolute path, a long raw prompt) asserted **absent** from the persisted representation; plus: size caps hold
   for an oversized input, output validates via `parseErrorOccurrence`, sanitizer is idempotent, and a clean
   occurrence passes through unchanged apart from caps.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/incidents/errorSanitize.ts`
- `test/unit/error-sanitize.test.ts`

Budget: **2 production files, 2 test files, at most 100 changed lines total (added + deleted)**.

Never touch `src/platform/redact.ts`, `src/incidents/errorEvent.ts`, `src/incidents/errorNormalize.ts`,
`src/incidents/types.ts`, `src/bootstrap/**`, `scripts/**`, `package.json`, `test/support/**` or any other test.

## Acceptance criteria (each proved by output you paste)

1. For each secret fixture: after sanitization the exact secret string is not present anywhere in the
   serialized record (assert with `assert.ok(!JSON.stringify(out).includes(secret))` per fixture).
2. A >cap-length prompt becomes `<redacted-prompt len=N sha256=…>`; the raw text is gone, the digest is stable
   across two runs.
3. Absolute local paths are replaced; relative artifact refs (`logs/run-42.jsonl`) survive unchanged.
4. Total persisted size respects the documented budget for a deliberately oversized occurrence.
5. `sanitize(sanitize(x))` deep-equals `sanitize(x)`; output passes `parseErrorOccurrence`; malformed input
   (`null`, string, object with hostile keys) does not throw.
6. `npm run typecheck` and the two `verify` commands exit 0;
   `node --test --import ./test/support/isolatedState.ts test/unit/error-normalize.test.ts test/unit/error-event.test.ts`
   still exits 0.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/error-sanitize.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/error-normalize.test.ts test/unit/error-event.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must list only your two files, total ≤ 100 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened assertions, no scope widening. If the gateway
switches your model away from `metabolomics/qwen3.8-flash_next`, say so in your report. Restore any
`process.env` entry your test mutates.

## Commit and report

1. `git add` only your files; one commit: `feat(incidents): sanitize before durable error capture (E04)`.
2. Write `E04/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/E04/`:
   exported API + constants, the secret fixtures used, commands with exit codes, numstat totals, commit SHA,
   risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, `--no-verify`, or any
state mutation outside your worktree.
