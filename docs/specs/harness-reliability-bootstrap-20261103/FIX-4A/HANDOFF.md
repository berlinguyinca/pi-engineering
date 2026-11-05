# HANDOFF FIX-4A — derive the task authority from the manifest and require it at stamp time

You are a **single microtask worker** on branch `fix/fix4a-task-authority`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix4a-task-authority-20261104` (base SHA
`5d000abc…`, read `git rev-parse HEAD` for the full value; repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Defect (already proved, do not re-derive)

Every handoff record declares `taskAuthorityHash`, and `templates/handoff.schema.json` requires it, but
**nothing derives or checks it**: `src/bootstrap/resultGate.ts` has no derivation and `scripts/bootstrap-one.ts`
passes the record's value straight through to the stamped file. A record that names a different task's
authority (or a fabricated one) stamps cleanly today. Evidence: `../FIX-3B/TASK_REPORT.md`,
`FIX-3C/WORKER_REPORT.md`, and the fixtures in `test/unit/bootstrap-one.test.ts`, which use placeholder
authorities `sha256:aaa…` / `sha256:ccc…` and still pass.

## Required change (exactly three files)

1. `src/bootstrap/resultGate.ts` — export
   `export const taskAuthorityHash = (manifest: TaskManifest): string => canonicalHash(manifest);`
   with a doc comment stating the contract: the authority of a task **is** the canonical hash of the *parsed*
   manifest (the normalized object `parseTaskManifest` returns, i.e. defaults applied and unknown keys dropped),
   so two manifest files that differ only by defaults or unknown keys carry the same authority. Do not change
   `canonicalHash`, the gate verdicts, exit codes or any other export.
2. `scripts/bootstrap-one.ts` — in the `--emit-handoff` branch only: once the manifest parses and a
   `--handoff-record` is present, compute the derived authority and add a blocker when the record's
   `taskAuthorityHash` differs from it:
   `$.taskAuthorityHash: the record says <record value> but manifest <taskId> derives <derived value>`.
   On success print exactly one line `authority=<taskId> <derived hash>` before the existing
   `schema=… conforms …` line. Everything else stays: exit codes, FIX-2 parent verification, FIX-3C schema
   validation, the gate call, no model call, read-only apart from writing the handoff file.
3. `test/unit/bootstrap-one.test.ts` — the fixtures that reach the **accept** path must carry the authority
   derived by rule 1 (compute it in the test from the same manifest, or inline the value you obtained by hand);
   add tests for: (a) the derived value equals `canonicalHash(parseTaskManifest(manifestJson).manifest)`
   computed independently in the test, (b) a record whose `taskAuthorityHash` is wrong → `REJECT gate:` naming
   both values, exit 5, nothing written, (c) a record with no `taskAuthorityHash` → rejected (the schema
   requires it, so this may be asserted through the FIX-3C schema stage).

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/bootstrap/resultGate.ts`
- `scripts/bootstrap-one.ts`
- `test/unit/bootstrap-one.test.ts`

Budget: **2 production files, 1 test file, at most 100 changed lines total (added + deleted)** — the gate
measures `git diff --numstat HEAD^1 HEAD` and a manifest cannot express more than this.

You may adapt **fixture values only** in `test/unit/bootstrap-one.test.ts` so the accept path carries a valid
authority. You may not weaken, skip or delete any existing assertion, and you must not touch
`test/unit/bootstrap-package.test.ts`, `test/unit/bootstrap-result-gate.test.ts`,
`test/unit/bootstrap-handoff-writer.test.ts`, `src/bootstrap/handoffWriter.ts`,
`src/bootstrap/taskManifest.ts`, `templates/handoff.schema.json` or `docs/**`.

## Acceptance criteria (each proved by output you paste)

1. `node -e` or a unit test shows `taskAuthorityHash(manifest)` equals the independently computed
   `canonicalHash(parseTaskManifest(json).manifest)` for the same manifest, and that changing a manifest field
   changes the value.
2. Stamp with a record whose authority is wrong → `REJECT gate: $.taskAuthorityHash: …`, exit 5, no
   `<taskId>.handoff.json` written.
3. Stamp with a record whose authority is correct → exit 0, `authority=<taskId> sha256:…` printed, file
   written, `gate=accepted`.
4. `test/unit/bootstrap-one.test.ts`, `test/unit/bootstrap-result-gate.test.ts`,
   `test/unit/bootstrap-handoff-writer.test.ts` and `test/unit/bootstrap-package.test.ts` all exit 0.

Use `mkdtempSync(join(tmpdir(), …))` for temporary output, clean up, and **do not create or remove git
worktrees**.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must list only your three files, total ≤ 100 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened tests, no scope widening. If the gateway switches
your model away from `metabolomics/qwen3.8-flash_next`, say so in your report.

## Commit and report

1. `git add` only your three files; one commit: `fix(bootstrap): derive task authority from the manifest (FIX-4A)`.
2. Write `FIX-4A/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-4A/`:
   what changed, commands with exit codes, numstat totals, commit SHA, risks, anything you disagree with.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing the files listed above, `--no-verify`, or any
state mutation outside your worktree.
