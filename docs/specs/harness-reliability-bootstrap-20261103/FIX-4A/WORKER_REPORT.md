# WORKER_REPORT FIX-4A — derive the task authority from the manifest and require it at stamp time

- Worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix4a-task-authority-20261104`
- Branch `fix/fix4a-task-authority`; base `5d000abc2403189b0fc83b0685d504af220a79e9`
- **Commit `e58a4376495dd814060c400cdfcfa338e9ac33e0`** — `fix(bootstrap): derive task authority from the manifest (FIX-4A)` (one commit, not pushed; `HEAD~1` is the approved base)
- Model for the whole unit: `metabolomics/qwen3.8-flash_next` (`PI_PROVIDER=metabolomics`, `PI_MODEL=qwen3.8-flash_next`,
  `PI_REASONING_LEVEL=medium`). **The gateway never switched the model away** — the environment reads the same at the end of the unit as at the start.
- Worktree clean after the commit (`git status --porcelain` empty); only the three permitted files changed.
- Budget: `git diff --numstat HEAD~1 HEAD` = 83 added + 13 deleted = **96 / 100** lines, three files, 2 production + 1 test.

## What changed

**`src/bootstrap/resultGate.ts`** (+9, -0)

```ts
export const taskAuthorityHash = (manifest: TaskManifest): string => canonicalHash(manifest);
```

with a doc comment stating the contract (authority **is** the canonical hash of the *parsed* manifest — the
normalized object `parseTaskManifest` returns, defaults applied and unknown keys dropped from it). One
type-only import added (`import type { TaskManifest } from "./taskManifest.ts";`). `canonicalHash`,
`evaluateResultGate`, `hashArtifact`, `writeHandoff`, the verdicts and every other export are byte-identical.

**`scripts/bootstrap-one.ts`** (+12, -3) — the `--emit-handoff` branch only, plus one header line and the import name:

```ts
function taskAuthority(manifest: TaskManifest | null, record: Record<string, unknown> | null): { hash: string | null; blockers: string[] } {
  if (manifest === null || record === null) return { hash: null, blockers: [] };
  const hash = taskAuthorityHash(manifest); const claimed = record.taskAuthorityHash;
  return { hash, blockers: claimed === hash ? [] : [`$.taskAuthorityHash: the record says ${String(claimed)} but manifest ${manifest.taskId} derives ${hash}`] };
}
```

called once as `taskAuthority(parsed.ok ? parsed.manifest : null, schema.record)`; `authority.blockers` is appended
to the existing blocker list, and the accept branch prints exactly one
`authority=<taskId> <derived hash>` line immediately before the untouched `schema=… conforms …` line.
Exit codes, FIX-2 parent verification, FIX-3C schema validation, the gate call, the no-model property and
read-only behaviour (only the handoff file is written) are unchanged; total function, so an unreadable record or
an unparsed manifest yields no extra blocker (the existing blockers already report both).

**`test/unit/bootstrap-one.test.ts`** (+62, -10) — fixture values adapted, no existing assertion changed,
weakened, skipped or deleted (`git diff -U0 | grep ^- | grep -c "assert\."` → **0**). The deletions are: the
resultGate import line, the `Stamp3`/`stampRun` signature and its doc comment, three fixture-write lines, the
`return` line, the `CONFORMING` const and two `record:` call sites.

- `stampRun` now writes the fixture **manifest before the record**, derives
  `derived = taskAuthorityHash(manifestOf(manifestJson))` and returns `derived` + `manifestJson`; the default
  record and the record factory carry it, so every accept path (FIX-2's permissive-schema run and FIX-3C's
  real-schema run) stamps on a *derived* authority instead of `sha256:aaa…`/`sha256:ccc…`.
- `CONFORMING` became `(authority: string) => Record<string, unknown>`; `Stamp3.record` accepts an object **or**
  a factory receiving the derived authority. Call sites that mutated it are now
  `record: (authority) => ({ ...CONFORMING(authority), … })`.
- five new tests: derivation identity + field-sensitivity + defaults-invisible + unknown-key rejection;
  accept path prints exactly one `authority=` line with the independently recomputed value before the schema
  line and stamps it into the file; permissive-schema accept path; wrong authority → exit 5, nothing written;
  missing authority → exit 5, nothing written.

## Verification (worktree root, committed clean tree)

| command | exit |
| --- | --- |
| `npm run typecheck` | 0 |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts` | 0 (18/18) |
| `… test/unit/bootstrap-result-gate.test.ts` | 0 (3/3) |
| `… test/unit/bootstrap-handoff-writer.test.ts` | 0 (8/8) |
| `… test/unit/bootstrap-package.test.ts` | 0 (15/15) |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts` | 0 (55/55) |

```
$ npm run typecheck
> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json
exit=0

$ node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-one.test.ts
ℹ tests 18
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 8232.351334
exit=0

$ node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-*.test.ts
ℹ tests 55
ℹ pass 55
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 12013.957
exit=0

$ git diff --numstat HEAD~1 HEAD
12	3	scripts/bootstrap-one.ts
9	0	src/bootstrap/resultGate.ts
62	10	test/unit/bootstrap-one.test.ts
```

New test names, all green:

```
✔ FIX-4A: taskAuthorityHash IS canonicalHash(parseTaskManifest(json).manifest) — defaults invisible, fields decisive
✔ FIX-4A: an accepted stamp prints exactly one authority line, the derived value, before the schema line
✔ FIX-4A: the permissive-schema accept path (the FIX-2 fixtures) stamps on the derived authority as well
✔ FIX-4A: a record that names a different authority is rejected at stamp time — exit 5, nothing written
✔ FIX-4A: a record with no taskAuthorityHash is rejected — exit 5, nothing written
```

## Acceptance criteria, proved by direct runs (not only by the suite)

An isolated `mkdtemp` scratch repo (committed-clean, `fixtures/` git-ignored, `parentHandoffHash: null`, real
`templates/handoff.schema.json` copied in) driven through `node --experimental-strip-types
scripts/bootstrap-one.ts … --emit-handoff <mkdtemp>`; all scratch directories removed afterwards.

AC 1 — derivation, computed two independent ways:

```
[AC1] derived      = sha256:985965374a2c68eb8d578bc15b2ba63093117b44297f562554ee01f72b4df57d
[AC1] independent  = sha256:985965374a2c68eb8d578bc15b2ba63093117b44297f562554ee01f72b4df57d
[AC1] equal        = true
[AC1] objective change moves it = true
[AC1] taskId change moves it    = true
[AC1] explicit DEFAULT_LIMITS    = true      # limits omitted vs limits == DEFAULT_LIMITS -> same authority
[AC1] unknown key parses?        = true      # parseTaskManifest({...json, note:"x"}).ok === false
```

AC 2 — a record naming another task's authority, a fabricated one, and one without the field:

```
[AC2 wrong authority (other task's)] exit=5 files=[]
REJECT gate: $.taskAuthorityHash: the record says sha256:aaaa…aaaa but manifest DEMO derives sha256:01367fe8aa9ccef557afd39efaa11fe24409e58a0b6d7b60bfbb85e6855c8204

[AC2b fabricated authority] exit=5 files=[]
REJECT gate: $.taskAuthorityHash: the record says sha256:cccc…cccc but manifest DEMO derives sha256:01367fe8…

[AC2c no taskAuthorityHash] exit=5 files=[]
REJECT gate: $.taskAuthorityHash: required property missing
REJECT gate: $.taskAuthorityHash: the record says undefined but manifest DEMO derives sha256:01367fe8…
```

AC 3 — the record carrying the derived authority:

```
[AC3 correct derived authority] exit=0 files=["DEMO.handoff.json"]
authority=DEMO sha256:01367fe8aa9ccef557afd39efaa11fe24409e58a0b6d7b60bfbb85e6855c8204
schema=DEMO conforms fixtures/schema.json
handoff=/tmp/…/DEMO.handoff.json checksum=sha256:977b46f73bea5c355d318907d917e83617310c83c01ce3029fdfac8947fc1ef2 gate=accepted (…)
[AC3 correct derived authority] stamped taskAuthorityHash=sha256:01367fe8aa9ccef557afd39efaa11fe24409e58a0b6d7b60bfbb85e6855c8204
```

(the `REJECT baseline: HEAD … != manifest baseSha` line printed above those gate lines in every stamping run is
pre-existing behaviour: the plan line describes the pre-task state, the gate checks `HEAD^1 == approved base`.)

## Risks, limits of the fix, and things I disagree with

1. **"two manifest files that differ only by … unknown keys carry the same authority" is vacuous as written.**
   `parseTaskManifest` *rejects* unknown top-level and `limits.*` keys (`unknown field: x` → exit 2), so two
   manifests differing only by an unknown key never both reach the hash. The property that does hold is the one
   I could test: unknown keys cannot enter the authority because they cannot enter the parsed object. I wrote the
   doc comment as the contract asked and added that caveat explicitly rather than leaving an untrue sentence.
2. **The fix covers the record being stamped, not the parent handoff already on disk.** FIX-2's parent
   verification checks `handoffHash`, `nextTaskId` and `nextBaseSha`; nothing checks that the parent's own
   `taskAuthorityHash` equals the authority its own manifest derives — and it cannot be derived at stamp time
   without the parent task's manifest being committed and passed in. The existing `PARENT` fixture therefore still
   carries the placeholder `sha256:aaa…`. That half of the defect class is still open and looks like a separate
   unit (needs a `--parent-manifest`, or the authority stored in the manifest chain).
3. **A record with a missing `taskAuthorityHash` now prints two blockers** (`required property missing` from the
   FIX-3C schema stage, plus the derivation blocker `the record says undefined …`). Exit stays 5 and nothing is
   written; I judged two honest blockers better than suppressing one, but the log for that case is noisier.
   A non-string claim (e.g. a number) is likewise a mismatch, not a crash.
4. **No cross-manifest collision test**: two different manifests of the *same* taskId derive different authorities,
   which is intended (the authority identifies the task definition, not its id). A record stamped for taskId `T1`
   against manifest `T1'` is rejected; a record stamped against manifest `T1'` that claims `T1'`'s authority is
   accepted even if some other file also calls itself `T1` — that ambiguity is inherent to `taskId` reuse, not new.
5. **`npm run lint` (`biome check .`) fails at the base commit too** (docs-spec JSON fixtures under
   `docs/specs/…/B00/logs/`, plus the project's deliberately dense one-statement-per-line style). My three files
   produce no new diagnostics beyond the pre-existing `format` ones on untouched lines (`npx biome check` on each
   reports `format` only, and the same reports fire on `git show HEAD:<file>`). Lint is not in FIX-4A's
   verification list and `docs/**` is out of scope, so I left it alone rather than widening scope.
6. `resultGate.ts` now imports `taskManifest.ts` (type-only, erased at runtime), so there is no runtime cycle with
   `diffGuard.ts`, which already imports it.
7. Nothing was pushed, merged, rebased, amended or reset; no worktree was created or removed; no dependency was
   installed; `package.json` untouched.
