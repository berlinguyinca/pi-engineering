# FIX-3B / FIX-3B2 report — schema validation in the writer, mkdir on write

**Status: PASS, merged.** `fix/fix3-handoff-schema-validator` fast-forwarded into
`harness-reliability-bootstrap-20261103`: `24f42fba` → `22c17b58` (FIX-3B) → `0ddf2771` (FIX-3B2).

| unit | commit | lines | handoffHash | taskAuthorityHash |
| --- | --- | --- | --- | --- |
| FIX-3B validator + defect-class tests | `22c17b582b3e342cf9ea30c7ef7e63037a8b80f1` | 44 + 52 = 96 | `sha256:973583781db0fef35011892e9004a670e5f8e705c91404f2de6c5db97d2a0b18` | `sha256:0e62b39b22a4545af354ea2474c4e99981d2d480f50d4ac239c4832c57348927` |
| FIX-3B2 mkdir on write + totality tests | `0ddf27714f80a8e98d01d4662c0242b789de15c7` | 7 + 19/4 = 30 | `sha256:d2435ac27847bd8f2354d0db9211dd12489d8e4be21dcd1ab75be3e0512f5a8a` | `sha256:9250a03d6c394c53ce1eb7052107f0db5fb022751035e202e3f4cfc8e7cd2be8` |

`src/bootstrap/handoffWriter.ts` is a **new** file: `validateHandoffSchema(record, schema) → string[]`
(pure, total; `type` unions incl. `null`, `required`, `properties`, `items`, `enum`, `const`,
`additionalProperties: false`; every blocker names its path `$.commands[0].exitCode`; the top-level
`handoffHash` is exempt only from `required`/`additionalProperties`, still type-checked) and — in FIX-3B2 —
`writeHandoff(dir, …)` which is `resultGate.writeHandoff` plus `mkdirSync(dir, { recursive: true })`.

## How it was executed

Worker pane `fix3` (pane `w0:p4`, `pi --provider metabolomics --model qwen3.8-flash_next --thinking medium`)
on `fix/fix3-handoff-schema-validator`, contract `FIX-3B/HANDOFF.md`. It delivered one 117-line commit
(`de003ea9`) with 8/8 tests passing. **The conductor split it into the two commits above**, because the B01
manifest contract caps every bootstrap unit at 100 changed lines (`limits.maxChangedLines … exceeds
bootstrap ceiling 100`) and cannot express per-file limits — see `FIX-3/DOCS-COMMIT.md`. `git diff de003ea9
HEAD` is a 5-line test header comment; nothing else changed.

## Conductor verification (detached worktrees `/tmp/fix3b-verify`, `/tmp/fix3b2-verify`, clean trees)

| commit | command | exit | log |
| --- | --- | --- | --- |
| `22c17b58` | `npm run typecheck` | 0 | `FIX-3B/logs/05-typecheck-at-commit.txt` |
| `22c17b58` | writer suite (6/6) | 0 | `FIX-3B/logs/06-unit-writer-at-commit.txt` |
| `22c17b58` | `test/unit/bootstrap-*.test.ts` (44/44) | 0 | `FIX-3B/logs/07-unit-bootstrap-all-at-commit.txt` |
| `0ddf2771` | `npm run typecheck` | 0 | `FIX-3B2/logs/01-typecheck-at-commit.txt` |
| `0ddf2771` | writer suite (8/8) | 0 | `FIX-3B2/logs/02-unit-writer-at-commit.txt` |
| `0ddf2771` | `test/unit/bootstrap-*.test.ts` (46/46) | 0 | `FIX-3B2/logs/03-unit-bootstrap-all-at-commit.txt` |

Independent cross-check (`FIX-3B/logs/04-conductor-schema-cross-check.txt`, conductor-written script against
the worker's code, never the worker's own tests):

* the three real stamped handoffs `E02`, `FIX-1`, `FIX-2` → **`[]` blockers** each;
* `status: "DONE"` → `$.status: "DONE" is not one of enum ["PASS","ALREADY_SATISFIED","BLOCKED"]`;
* `commands: [{command:"x"}]` → missing `exitCode` + `outputArtifact` at `$.commands[0]`;
* an extra key → `$.sneaky: disallowed additional property`;
* `writeHandoff` into `/tmp/…/a/b/c` created the tree, wrote exactly one file, no `.tmp`, and the hash stayed
  `sha256:ee686bb1d72…` — identical to the FIX-2 handoff hash, proving the wrapper delegates rather than
  re-implementing the canonical-hash rule.

Stamping: FIX-3B `gate=accepted` with `parentHandoffHash: null` (documented deviation — the intervening `24f42fba`
documentation commit is not a bootstrap unit); FIX-3B2 `gate=accepted` **with** `parent=FIX-3B accepted
sha256:973583781db…`, i.e. the parent chain is now verified at stamp time by the code FIX-2 fixed.

## Findings / follow-ups

1. **Two `writeHandoff` entry points exist** (`resultGate.ts` and `handoffWriter.ts`). `scripts/bootstrap-one.ts`
   still imports the `resultGate` one, so the mkdir fix is not yet in the CLI path and no validation happens
   before stamping. **FIX-3C** must: import from `handoffWriter.ts`, require `--handoff-schema <path>` for
   `--emit-handoff`, run `validateHandoffSchema` before writing, and fold blockers into the gate (exit 5, nothing
   written).
2. The unit-size ceiling forced a split of a coherent change (117 lines). Recorded in `FIX-3/DOCS-COMMIT.md`.
3. `limits.maxLinesPerFile` / `maxFilesPerFileBudget` remain inexpressible in a manifest (defaults 2000 / 10
   always apply) → **FIX-4**.
4. Handoff `status` is still unchecked in the parent chain: a `BLOCKED` parent would be accepted → **FIX-5**.
