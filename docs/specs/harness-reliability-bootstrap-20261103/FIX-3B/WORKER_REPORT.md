# FIX-3B — WORKER REPORT

Worker branch `fix/fix3-handoff-schema-validator`, worktree
`/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix3-schema-validator-20261104`, base
`24f42fba3f711dbf62a2c61d58a5545b0234865d`, repo `berlinguyinca/pi-engineering-runtime`.
Nothing was pushed, merged, rebased, amended; no worktree was created; nothing was installed.

## Commit

```
de003ea9c6f3c1de8e6bc7a587cbb17f192d7a9b  fix(bootstrap): schema validator for handoffs + mkdir on write (FIX-3B)
parent 24f42fba3f711dbf62a2c61d58a5545b0234865d   (== the approved base; SHA continuity holds)
```

`git status --porcelain` after the commit is empty (worktree clean). `git add` took exactly the two allowed paths.

## Diff scope

```
$ git diff --numstat HEAD^1 HEAD
51	0	src/bootstrap/handoffWriter.ts
66	0	test/unit/bootstrap-handoff-writer.test.ts
```

Totals: **2 files, 117 lines added, 0 deleted** — inside the 120-line budget the HANDOFF states, and
**outside** the 100-line bootstrap ceiling the code enforces (see Risk R4).

## What changed

1. **`src/bootstrap/handoffWriter.ts` (new).**
   - `export function validateHandoffSchema(record: Record<string, unknown>, schema: unknown): string[]` —
     pure, total, never throws. Recursive descent over `properties`/`items`; every blocker names its
     JSON pointer-like path (`$.commands[0].exitCode`). Interprets `type` (object/array/string/number/integer/
     boolean, unions, and the `null` union member), `required`, `properties`, `items`, `enum`,
     `additionalProperties: false` — plus `const`, which `templates/handoff.schema.json` uses for `specVersion`
     although the HANDOFF's subset list omits it (see Risk R5). An unrecognised `type` keyword constrains
     nothing (no invented semantics). `handoffHash` is exempt **at the top level only**, and only for the two
     rules the writer's own stamping breaks: it is not required, and it is never reported as a disallowed
     additional property. It is still type-checked when present. Nothing else is exempt.
   - `export function writeHandoff(dir, taskId, record)` — `mkdirSync(dir, { recursive: true })` then delegates
     to `resultGate.writeHandoff` (imported, **not modified**): same canonical-hash rule (hash of the record
     minus `handoffHash`), same tmp-then-rename, same "refusing to overwrite an existing handoff", same return
     value `{ path, handoffHash }`.
2. **`test/unit/bootstrap-handoff-writer.test.ts` (new).** 8 tests: real schema + conforming record (and the
   committed `examples/handoff-example.json`) → `[]`; missing required (top level + nested); enum / wrong scalar
   type; wrong array-item type; `bogusKey`; `exitCode: 1.5` (and `exitCode: 1` conforming); `null` exactly where
   allowed (`nextTaskId`/`nextBaseSha`/`approvedBy`/`approvedAt` are `["string","null"]`) and rejected where not;
   `handoffHash` absent / present-as-string / present-as-number; hostile schema and hostile record input;
   `writeHandoff` into a non-existent nested directory.

No file other than those two was touched; `resultGate.ts`, `diffGuard.ts`, `pathPolicy.ts`, `taskManifest.ts`,
`scripts/bootstrap-one.ts` and `templates/handoff.schema.json` are untouched (verified by numstat).

## Verification (verbatim tails, exit codes)

`npm run typecheck` → **exit 0**

```
> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json
```

`node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-handoff-writer.test.ts` → **exit 0**

```
✔ writeHandoff creates a missing nested directory and leaves exactly one immutable handoff (1.5453014ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 229.910708
```

`node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts
test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-package.test.ts
test/unit/bootstrap-diff-guard.test.ts test/unit/bootstrap-task-manifest.test.ts
test/unit/bootstrap-path-policy.test.ts` → **exit 0**

```
✔ B01: invalid fixtures are rejected with deterministic, sorted, deduplicated errors (0.660292ms)
ℹ tests 38
ℹ suites 0
ℹ pass 38
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1834.976541
```

`git diff --numstat HEAD` (before commit, with intent-to-add) → **exit 0**, two files only (quoted above).

Acceptance criteria mapping: AC1 (first test, real schema read from `templates/handoff.schema.json` with
`readFileSync`, never stubbed); AC2 (missing-required, enum/wrong-scalar, array-item, `bogusKey`, integer, null,
hostile tests — one test each); AC3 (first test); AC4 (last test: one `<taskId>.handoff.json`, no `.tmp`,
`stamped.handoffHash === canonicalHash(parsed minus handoffHash)` asserted directly); AC5 (vacuous, see F3 —
there were no existing tests in that file; the pre-existing writer tests in `bootstrap-result-gate.test.ts` are
untouched and green, 38/38).

## Findings — the diagnosis in FIX-3/FIX-3B HANDOFF.md is wrong about the code

- **F1. `src/bootstrap/handoffWriter.ts` did not exist, and never did.** At base:
  `git cat-file -e 24f42fba:src/bootstrap/handoffWriter.ts` →
  `fatal: path 'src/bootstrap/handoffWriter.ts' exists on disk, but not in '24f42fba'`, and
  `git log --all --oneline -- src/bootstrap/handoffWriter.ts` is empty. `writeHandoff()` and `canonicalHash()`
  live in **`src/bootstrap/resultGate.ts:14,35`** (unit B05), and `scripts/bootstrap-one.ts:14` imports them
  from `../src/bootstrap/resultGate.ts`. The HANDOFF's "Defect (already proved)" names a file that the repository
  has never contained; the prose looks carried over from a hypothetical layout.
- **F2. Requirement 2 and the forbidden list are mutually unsatisfiable.** Requirement 2 asks `writeHandoff()`
  to create the directory; rule 3 forbids changing `resultGate.ts`, which is the only `writeHandoff` in the
  repository. I resolved it the only way the allowlist permits — a `writeHandoff` in the new file that does
  `mkdir` and delegates, leaving `resultGate.writeHandoff` byte-identical. The alternative readings (edit
  `resultGate.ts`, or rewire `bootstrap-one.ts`) were both explicitly forbidden, and duplicating the writer's
  6 lines in `handoffWriter.ts` would have forked the canonical-hash/atomicity rules across two files, which is
  worse than a delegate. **Consequence: the ENOENT defect is still live in production** (see R1).
- **F3. `test/unit/bootstrap-handoff-writer.test.ts` did not exist either** (same `cat-file` error), so AC5
  ("existing tests keep passing; do not weaken or delete any") was vacuous. The real `writeHandoff` coverage is
  `test/unit/bootstrap-result-gate.test.ts:26-31`, which I could not and did not touch.
- **F4. AC2's `parentHandoffHash: null` clause contradicts both the real schema and the HANDOFF's own rule.**
  `parentHandoffHash` is a **task-manifest** field (`src/bootstrap/taskManifest.ts:2,58-61`), not a handoff
  field: `templates/handoff.schema.json` declares no such property and sets top-level
  `additionalProperties: false`. Under "a record MUST pass iff the schema accepts it", and "Nothing else is
  exempt", a top-level `parentHandoffHash` **must** be a blocker. I implemented the rule and the test asserts
  `["$.parentHandoffHash: disallowed additional property"]` with that reason in the message. I did **not** add a
  second exemption, because doing so would break exactly the equivalence AC1/AC2 rest on.
  During this session an out-of-band message asserted as fact that "`parentHandoffHash: null` at top level is
  legal" and that AC4 was "fully satisfied"; both claims are false against the committed schema and the shipped
  code (see R1), so I treated them as untrusted and recorded them here rather than acting on them.
- **F5. `status: 7` produces one blocker, not two.** The `status` property declares `enum` and **no `type`**, so
  only `$.status: 7 is not one of enum [...]` fires. AC2's "wrong scalar type" is caught through `enum`; the
  test says so explicitly so nobody later "fixes" the validator to invent a `type` check the schema never made.

## Risks

- **R1 (highest): nothing validates or mkdir's in production yet.** Rule 3 forbade wiring
  `scripts/bootstrap-one.ts`, so `grep -rn handoffWriter src scripts test` shows **no importer** outside the new
  test. `bootstrap-one.ts` still calls `resultGate.writeHandoff`, which still validates nothing and still fails
  `ENOENT` on a missing `--emit-handoff` directory. FIX-3C must import **both** `validateHandoffSchema` and the
  new `writeHandoff` from `src/bootstrap/handoffWriter.ts`; wiring only the validator leaves the ENOENT defect
  unfixed while looking fixed.
- **R2: the schema may be the thing that should change.** If FIX-3C intends to stamp handoffs carrying
  `parentHandoffHash` (the manifest already declares it), then `templates/handoff.schema.json` needs the
  property — a schema-owner decision. A validator exemption would silently decouple "schema-conforming" from
  "accepted by the gate", which is the whole point of this unit.
- **R3: `const` is implemented although the HANDOFF excluded it from the subset.** Without it,
  `specVersion: "9.9.9"` would conform against the real schema. Additive: a conforming record still yields `[]`.
  If FIX-3C expects `specVersion` drift to be accepted, that expectation is wrong.
- **R4: 117 lines is legal per the HANDOFF's 120 budget but impossible for a bootstrap manifest.**
  `src/bootstrap/taskManifest.ts:5` sets `MICROTASK_CEILING = { ..., maxChangedLines: 100 }` and `parseTaskManifest`
  is fail-closed, so no FIX-3B manifest can carry 117 — if this commit is gated by `bootstrap-one`/diff-guard it
  is REJECTED as `changed-line-budget` (the same ceiling/contract gap FIX-3's `DOCS-COMMIT.md` handed to FIX-4;
  `manifests/tasks.json` contains no FIX-3 or FIX-3B entry at all). Merging it as a conductor commit, or
  splitting the test file into a second unit, are both cleaner than amending (amend is forbidden here).
- **R5: the validator is a JSON Schema subset interpreter, not a validator library.** It ignores `$ref`,
  `anyOf`/`oneOf`, `minimum`, `pattern`, `format`, `$schema` (draft 2020-12 is declared but not honoured), and
  does not honour `additionalProperties` as a schema (only the literal `false`). Safe for *this* schema; if the
  template grows, silence is the failure mode — AC1's "iff the schema accepts it" would then be false. No new
  dependency was permitted, so this is the accepted trade-off, not an oversight.
- **R6: formatting.** `npx biome check src/bootstrap/handoffWriter.ts` reports width/format diffs. The
  neighbouring bootstrap files already fail `biome check` at base (5 errors across `resultGate.ts`,
  `diffGuard.ts`, `bootstrap-one.ts`), and `npm run lint` is not in this unit's verification list; I matched the
  local dense style deliberately, because reformatting to biome's preference would have cost ~30 lines and
  broken the 120-line budget.
- **R7: first drafts of the two files were 157 lines** (over budget). I compressed comments and packed asserts
  before committing; no assertion was weakened or removed to get there, and `status: 7`'s single-blocker
  expectation was corrected to match the schema (F5), not the validator loosened to match the test.

## Suggested next actions (for the conductor, not executed by me)

1. FIX-3C: import `validateHandoffSchema` **and** `writeHandoff` from `src/bootstrap/handoffWriter.ts` into
   `scripts/bootstrap-one.ts`; validate before `canonicalHash`/stamp, reject the stamp on any blocker.
2. Decide R2: add `parentHandoffHash` to `templates/handoff.schema.json`, or forbid it in handoff records (the
   latter is what today's code enforces).
3. Fix the diagnosis text in `FIX-3/HANDOFF.md` and `FIX-3B/HANDOFF.md`: name `src/bootstrap/resultGate.ts` as
   the original home of `writeHandoff`, and drop the `parentHandoffHash` AC clause (F4).
4. Resolve R4 before merge (manifest ceiling is 100).
