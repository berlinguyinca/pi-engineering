# HANDOFF FIX-3C — the emit path must schema-validate the record before it stamps

You are a **single microtask worker** on branch `fix/fix3c-schema-gate-at-stamp`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix3c-schema-gate-20261104` (base SHA
`0ddf27714f80a8e98d01d4662c0242b789de15c7`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Defect (already proved, do not re-derive)

`src/bootstrap/handoffWriter.ts` now exports `validateHandoffSchema` and a `writeHandoff` that creates its
directory (FIX-3B / FIX-3B2, both verified), but **nothing calls them**: `scripts/bootstrap-one.ts` still
imports `writeHandoff` from `../src/bootstrap/resultGate.ts`, so `--emit-handoff` stamps any record it is
given with zero schema validation, and the ENOENT-on-missing-directory bug FIX-3B2 fixed is still reachable
from the CLI. Evidence: `../FIX-3B/TASK_REPORT.md` finding 1.

## Required change (exactly two files)

In `scripts/bootstrap-one.ts`:

1. Import `validateHandoffSchema` and `writeHandoff` from `../src/bootstrap/handoffWriter.ts` (drop the
   `writeHandoff` import from `resultGate.ts`; keep `hashArtifact`/`evaluateResultGate`/`Proof` imports as
   they are — do **not** modify `resultGate.ts` or `handoffWriter.ts`).
2. Add one CLI flag `--handoff-schema <path>` and make it **required when `--emit-handoff` is given**,
   resolved relative to `--cwd` the same way `--proofs`/`--handoff-record` are. Update the file's
   documentation header (usage line) to include it. No other flag changes.
3. In the `--emit-handoff` branch, before anything is written: read + parse the schema, run
   `validateHandoffSchema(JSON.parse(recordText), schema)` and fold the resulting blockers into the existing
   `blockers` list, so a non-conforming record yields `REJECT gate: <blocker>` lines, exit 5 and **no file**.
   Unreadable or non-JSON schema input must produce a blocker (fail-closed), never an uncaught exception.
   A missing `--handoff-record` and a missing `--handoff-schema` are blockers too (do not crash).
4. When the record conforms, print exactly one line `schema=<taskId> conforms <schemaFile>` before the
   existing `handoff=… checksum=… gate=accepted …` line, so the log proves validation happened.
5. Keep everything else intact: exit-code semantics (0/2/3/4/5/64/66), the FIX-2 parent verification, the
   gate call, the canonical-hash rule, no model call, no scheduler import, read-only apart from writing the
   handoff file.

## Files you may change (nothing else — the merge is rejected otherwise)

- `scripts/bootstrap-one.ts`
- `test/unit/bootstrap-one.test.ts`

Budget: **1 production file, 1 test file, at most 85 changed lines total (added + deleted)**. This is not
advice — the B01 manifest contract caps every bootstrap unit at 100 changed lines and the gate measures
`git diff --numstat HEAD^1 HEAD`; at >100 lines your own commit can never be gated. Keep the diff tight.

## Acceptance criteria (each proved by output you paste)

1. `--emit-handoff` **without** `--handoff-schema` → `REJECT gate:` naming the missing schema, exit 5, no
   `<taskId>.handoff.json` in the output directory.
2. Record that violates the schema (e.g. `status: "DONE"`, or a missing `commands[].exitCode`) + the **real**
   schema `docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json` → `REJECT gate:`
   with the validator's path-named blocker, exit 5, nothing written.
3. `--handoff-schema` pointing at a non-existent file, or at a file containing `not json` → `REJECT gate:`,
   exit 5, nothing written, **no stack trace**.
4. Conforming record + real schema → exit 0, file written, stdout contains `schema=FIX-3C conforms` (or the
   task id under test) and `gate=accepted`.
5. The existing tests in `test/unit/bootstrap-one.test.ts` keep passing **unmodified**, and
   `test/unit/bootstrap-package.test.ts` keeps passing unmodified. Do not weaken, skip or delete assertions.

Tests must build their inputs with `mkdtempSync(join(tmpdir(), …))` and clean up; for the clean-tree
requirement of the emit path you may reuse the existing repo checkout read-only via `--cwd .` **only if** the
worktree is clean — otherwise assert the blocker path instead. **Do not create or remove git worktrees.**

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts
git diff --numstat HEAD~1 HEAD
```

All must exit 0 and the last must show only your two files, total ≤ 85 lines. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened tests, no scope widening.

## Commit and report

1. `git add` only your two files; one commit: `fix(bootstrap): schema-validate handoffs at stamp time (FIX-3C)`.
2. Write `FIX-3C/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-3C/`:
   what changed, commands with exit codes, numstat totals, commit SHA, risks, and anything you think is wrong
   or risky — including in the diagnosis itself.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git reset`, `git worktree`, checking out another
branch, editing `package.json`, installing dependencies, editing `src/bootstrap/*.ts`,
`templates/handoff.schema.json` or any existing test assertion, `--no-verify`, or any state mutation outside
your worktree.
