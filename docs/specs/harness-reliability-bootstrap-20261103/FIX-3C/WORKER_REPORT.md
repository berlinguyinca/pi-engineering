# WORKER_REPORT FIX-3C — schema-validate handoffs at stamp time

- Worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix3c-schema-gate-20261104`
- Branch `fix/fix3c-schema-gate-at-stamp`; base `0ddf27714f80a8e98d01d4662c0242b789de15c7`
- **Commit `3881178f963d01cad1e6fcedb95c696f27d3ac5d`** — `fix(bootstrap): schema-validate handoffs at stamp time (FIX-3C)` (one commit, not pushed)
- Model for the whole unit: `metabolomics/qwen3.8-flash_next` (`PI_PROVIDER=metabolomics`,
  `PI_MODEL=qwen3.8-flash_next`). **The gateway never switched the model away** during this unit.
- Worktree is clean after the commit (`git status --porcelain` empty); nothing else touched.

## Verdict on the cut-off worker's partial diff

I re-derived the defect first: at the base commit `scripts/bootstrap-one.ts` imported `writeHandoff` from
`../src/bootstrap/resultGate.ts`, so `--emit-handoff` stamped any record with **zero** schema validation and
the ENOENT-on-missing-directory path FIX-3B2 closed was still reachable from the CLI. The diagnosis in
HANDOFF.md is correct.

The partial change (`logs/01-worker-partial-diff.txt`, 19 added / 6 deleted) is **correct and was kept**:

- imports `validateHandoffSchema` + `writeHandoff` from `../src/bootstrap/handoffWriter.ts`, drops
  `writeHandoff` from the `resultGate.ts` import while keeping `canonicalHash`/`evaluateResultGate`/
  `hashArtifact`/`Proof`; `src/bootstrap/*.ts` untouched;
- adds `--handoff-schema <path>`, resolved with the same `resolve(cwd, path)` rule as
  `--proofs`/`--handoff-record`, and documents it in the header usage line;
- `preStampSchema()` is total: absent flag, unreadable schema (`ENOENT`/`EISDIR`), non-JSON schema,
  unreadable record and non-JSON record all return blockers, never throw, and a non-object schema JSON is
  caught by the validator itself (`$: schema is not an object`), so it fails closed;
- folds `schema.blockers` into the existing `blockers` list, so a non-conforming record prints
  `REJECT gate: …`, exits 5 and writes nothing;
- prints exactly one `schema=<taskId> conforms <schemaFile>` line before the `handoff=… gate=accepted` line.

Only one thing was changed in it: the `export { canonicalHash};` spacing nit (now byte-identical to the
base line, which also removed it from the diff). I did not restructure the rest — it satisfies all four
acceptance criteria and re-reading the record for the accepted path was already folded into
`preStampSchema`'s parsed value instead of a second `readFileSync`.

## What I added (the missing tests)

`test/unit/bootstrap-one.test.ts`, four tests, one per acceptance criterion, all driving the real CLI
through the existing `stampRun` committed-clean temp-repo helper (`mkdtempSync` + `t.after(rmSync)`; no git
worktrees created):

1. `--emit-handoff` **without** `--handoff-schema` → `REJECT gate: --emit-handoff requires --handoff-schema…`,
   exit 5, output directory empty, no `gate=accepted`.
2. Record violating the **real** `docs/specs/…/templates/handoff.schema.json` (read from the repo and written
   into the fixture repo byte-for-byte, because `--handoff-schema` resolves against `--cwd`): `status: "DONE"`
   → `REJECT gate: $.status: "DONE" is not one of enum ["PASS","ALREADY_SATISFIED","BLOCKED"]`; a second case
   drops `commands[0].exitCode` → `REJECT gate: $.commands[0].exitCode: required property missing`. Exit 5,
   nothing written.
3. `--handoff-schema fixtures/nope.schema.json` (never written) → `REJECT gate: handoff schema … is
   unreadable`; a schema file containing `not json` → `REJECT gate: handoff schema fixtures/schema.json is not
   valid JSON`. Both exit 5, nothing written, and both asserted free of stack-trace frames
   (`/\n\s{2,}at\s+\S+/u` over merged stdout+stderr).
4. Conforming record (all 14 non-exempt required properties, `commands[].exitCode` integer, nullable fields
   null) + real schema → exit 0, `T1.handoff.json` written, stdout contains `schema=T1 conforms
   fixtures/schema.json` and `gate=accepted`, and the stamped file carries `"handoffHash": "sha256:<64 hex>"`.

Helper plumbing (not assertions): `stampRun` gained an optional third argument
`{ schema?, schemaArg?, record? }` and writes a permissive `{"type":"object"}` `fixtures/schema.json` by
default, passing `--handoff-schema` for every run except when `schemaArg: null`. **Every existing assertion in
`bootstrap-one.test.ts` and `bootstrap-package.test.ts` is byte-identical to the base commit** (`git diff`
shows only the helper signature/doc/two fixture lines and the appended block). The default had to become the
permissive schema because the pre-existing FIX-2 record fixture (`{taskId,status,evidence,nextTaskId,nextBaseSha}`)
does **not** conform to the real protocol schema — it lacks `specVersion`, `repo`, `baseSha`, `resultSha`,
`taskAuthorityHash`, `changedFiles`, `commands`, `blockedReasons`, `operatorApproval`, and real-schema
`changedFiles` items are strings while the file-level `PARENT` fixture uses objects. Requiring the real schema
there would have meant rewriting FIX-2 fixtures, i.e. changing what those tests assert.

## Verification (from the worktree root, after the final edit)

```
$ npm run typecheck                          # tsc --noEmit; tsc --noEmit -p tsconfig.scripts.json   exit=0
$ node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts             exit=0
  ℹ tests 13  ℹ pass 13  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0  ℹ duration_ms 3540
$ node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts               exit=0
  ℹ tests 50  ℹ pass 50  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0  ℹ duration_ms 3395
$ git diff --numstat HEAD~1 HEAD                                                              exit=0
  18	5	scripts/bootstrap-one.ts
  39	3	test/unit/bootstrap-one.test.ts
```

Numstat totals: **18 added / 5 deleted / 39 added / 3 deleted = 65 changed lines ≤ 85**, and exactly the two
permitted files. Note the pre-existing FIX-2 "valid parent chain stamps" test *did* fail against the raw
partial diff (it asserts exit 0, and the new required flag made it exit 5 with
`REJECT gate: --emit-handoff requires --handoff-schema`) — that is why the helper now always passes a schema;
the behaviour it proves is unchanged, its assertions are untouched.

## Risks and things I think are wrong or risky

1. **Breaking CLI contract.** `--emit-handoff` now refuses (exit 5) without `--handoff-schema`. Every future
   bootstrap unit's stamp command must add it. The archived commands in
   `docs/specs/harness-reliability-bootstrap-20261103/{E01,E02,FIX-1,FIX-2}/**` (handoff records and fixtures)
   show the old flag set; they are evidence of past runs, not executable callers, so nothing breaks today —
   but the conductor's own templates/replay scripts must be updated or the next stamp will fail closed.
2. **Exit-code drift beyond the brief.** A non-JSON or unreadable `--handoff-record` used to escape as a
   `JSON.parse` throw and land in the `catch` → `REJECT input: …`, exit 66. It is now a gate blocker, exit 5.
   I judged fail-closed-with-a-blocker correct (the brief demands exactly that for the *schema*, and the same
   argument applies to the record), but it is a silent semantic change to exit 66's meaning and no test in
   the repo pins it either way.
3. **An untyped invariant.** The accepted branch does `writeHandoff(outDir, taskId, schema.record as Record<string, unknown>)`.
   `record: null` is only reachable when `recordPath === null`, which always contributes the
   `--emit-handoff requires --handoff-record` blocker, so `blockers.length === 0` ⇒ record non-null. That is
   true but enforced only by reading two distant code paths; a future edit to the blocker chain could turn it
   into `writeHandoff(…, null)` → exit 66 instead of a blocker. I left it rather than spend budget on types.
4. **Validation runs even when another blocker already rejects** the stamp (dirty tree → exit 3, manifest
   invalid → exit 2), so a rejected run prints schema blockers alongside the primary one. Deliberate
   ("validated HERE … whatever the gate's own verdict is") and strictly more fail-closed, but exit-3 output is
   now noisier and the ordering of `REJECT gate:` lines (gate, parent, schema) is positional, not ranked by
   cause.
5. `schema=<taskId> conforms <path>` prints the flag value as given (relative to `--cwd`), not the resolved
   absolute path. Fine for the log contract, slightly weaker as evidence if a caller passes `..`-laden paths.
6. The runtime `usage:` string printed on exit 64 still lists only `--manifest/--parent-handoff/--cwd`
   (pre-existing: it already omitted `--proofs`, `--handoff-record`, `--emit-handoff`). The brief asked only
   for the header doc, so I left it; it is now more incomplete than before.
7. `validateHandoffSchema` is a hand-rolled interpreter of a JSON Schema subset. FIX-3C makes it load-bearing
   for **every** handoff, so its blind spots (`minItems`, `pattern`, `format`, `$defs`/`$ref`,
   `oneOf`/`anyOf`) are now real gate gaps — a record with a malformed SHA-shaped string still conforms.
   Nothing to fix in this unit's budget; the schema would need to grow constraints, or the validator does.
8. Untouched by this unit: `docs/specs/**/handoff.schema.json` and `templates/handoff.schema.json` are the
   only schema in the repo, and nothing in `src/bootstrap/*.ts` calls `validateHandoffSchema` — the gate lives
   only in the CLI, so a caller that stamps through `handoffWriter.writeHandoff` directly still bypasses it
   (same class of defect as FIX-3B's finding 1, one layer down).
