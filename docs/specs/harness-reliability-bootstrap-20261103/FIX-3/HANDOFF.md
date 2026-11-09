# HANDOFF FIX-3 — validate handoffs against the schema, in the writer (part 1 of 2)

You are a **single microtask worker** on branch `fix/fix3-handoff-schema-validator`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix3-schema-validator-20261104` (base SHA
`e77904e73f3cffc9bd3bb1c628900d91bff4e020`, repo `berlinguyinca/pi-engineering-runtime`).
`node_modules` is provisioned (symlink) — never install anything. Read this whole file before editing.

## Defect (already proved)

`src/bootstrap/handoffWriter.ts::writeHandoff()` stamps a canonical hash into any record it is given and
never validates it against `docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json`;
the only proof used so far was an external throwaway script. It also wrote its temp file into a
non-existent directory and crashed with `ENOENT … .<taskId>.handoff.<pid>.tmp`, leaving a stale `.tmp`.

## Required change (exactly two files)

1. Add to `src/bootstrap/handoffWriter.ts` an exported **pure** validator
   `export function validateHandoffSchema(record: Record<string, unknown>, schema: unknown): string[]`
   returning blocker strings (`[]` = conforms). It must interpret the subset of JSON Schema actually used by
   `templates/handoff.schema.json`: `type` (object/array/string/number/integer/boolean and unions),
   `required`, `properties`, `items`, `enum`, `additionalProperties: false`, and the `null` member of a union
   type. Rules that must hold:
   - traversal is recursive over `properties`/`items`, and every blocker message names the JSON pointer-like
     path (e.g. `$.commands[0].exitCode`).
   - `handoffHash` is **exempt** at the top level: the writer injects it *after* validation, so a record
     without it must still conform, and an extra `handoffHash` key must never be reported as a disallowed
     additional property. Nothing else is exempt.
   - `integer` accepts only integral numbers; `number` accepts any number; a `type` union accepts any member.
   - The function must never throw on hostile input (non-object schema, `null` values, arrays where objects
     are expected) — it reports a blocker instead.
2. In `writeHandoff()`, create the output directory when missing (`mkdirSync(dir, { recursive: true })`)
   before writing the temp file, so the `ENOENT` above cannot recur. Change nothing else in `writeHandoff`
   (same canonical-hash rule, same temp-file-then-rename discipline, same return value).
3. **Do not** wire the validator into `scripts/bootstrap-one.ts` — that is a separate unit (FIX-3B). Do not
   change `resultGate.ts`, `diffGuard.ts`, `pathPolicy.ts`, `taskManifest.ts`, `templates/handoff.schema.json`,
   or any other file. No new dependency.

## Files you may change (nothing else — the merge is rejected otherwise)

- `src/bootstrap/handoffWriter.ts`
- `test/unit/bootstrap-handoff-writer.test.ts`

Budget: at most **1 production file, 1 test file, 120 changed lines total (added + deleted)**.

## Acceptance criteria (each must be proved by output you paste)

1. The **real** schema + a **real** conforming record → `[]`. Build the record in the test by importing the
   schema from `../../docs/specs/harness-reliability-bootstrap-20261103/templates/handoff.schema.json` (or
   reading it with `readFileSync` relative to the repo root) and filling every required field with
   schema-legal values; do not stub the schema.
2. Each defect class is caught, one test each: missing required field; wrong scalar type
   (`status: "DONE"` — not in the enum — plus `status: 7`); wrong array-item type (`commands: ["npm test"]`);
   disallowed additional property (`bogusKey`); `integer` violation (`exitCode: 1.5`); a `null` where the
   schema allows it (`blockedReasons: []` plus `parentHandoffHash: null` at top level is **not** a blocker);
   hostile schema input (e.g. `schema = null`, `schema = "x"`, `items` present on a non-array value) yields
   blockers and **no exception**.
3. A record without `handoffHash` conforms; a record with an extra `handoffHash` string also conforms.
4. `writeHandoff()` into a **non-existent nested directory** succeeds and leaves exactly one
   `<taskId>.handoff.json`, no `.tmp` file behind; the written file's `handoffHash` still equals
   `canonicalHash(parsed minus handoffHash)` (keep the existing equivalent assertion if one is already there).
5. Existing tests in `test/unit/bootstrap-handoff-writer.test.ts` keep passing; do not weaken or delete any.

## Verification (from the worktree root; paste the tail of each)

```sh
npm run typecheck
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-handoff-writer.test.ts
node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-package.test.ts test/unit/bootstrap-diff-guard.test.ts test/unit/bootstrap-task-manifest.test.ts test/unit/bootstrap-path-policy.test.ts
git diff --numstat HEAD
```

All must exit 0 and the last must show only your two files within budget. If anything fails, **stop and
report the failure verbatim** — no workarounds, no loosened tests, no scope widening.

## Commit and report

1. `git add` only your two files; one commit: `fix(bootstrap): schema validator for handoffs + mkdir on write (FIX-3)`.
2. Write `FIX-3/WORKER_REPORT.md` in
   `/Users/wohlgemuth/IdeaProjects/worktrees/pi-bootstrap-conductor-20261103/docs/specs/harness-reliability-bootstrap-20261103/FIX-3/`:
   what changed, commands with exit codes, numstat totals, commit SHA, risks, and anything you think is wrong
   or risky — including in the diagnosis itself.
3. Reply with at most 5 lines: commit SHA, numstat totals, each command's exit code, report path.

## Forbidden

`git push`, `git merge`, `git rebase`, `git commit --amend`, `git worktree`, checking out another branch,
editing `package.json`, installing dependencies, editing `templates/handoff.schema.json`, touching files
outside the two allowed paths, deleting or weakening tests, `--no-verify`, or any state mutation outside your
worktree.
