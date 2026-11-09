# WORKER REPORT FIX-5 — a parent handoff is only a valid base if its status is an accepted result

- **Branch / worktree:** `fix/fix5-parent-status` @ `/Users/wohlgemuth/IdeaProjects/worktrees/pi-fix5-parent-status-20261104`
- **Base SHA:** `7f983ee05c0d6feb1ee725984070aef31bdcf92c` (unchanged parent of my commit)
- **Commit SHA:** `ba22f28a6b540de74eb49a88a3e4fd62a08af1b4` — `fix(bootstrap): require an accepted parent status (FIX-5)`
- **Files changed (exactly the two allowed):** `scripts/bootstrap-one.ts`, `test/unit/bootstrap-one.test.ts`
- **Model:** `metabolomics/qwen3.8-flash_next` for the whole run (`PI_PROVIDER=metabolomics`, `PI_MODEL=qwen3.8-flash_next`) — no switch occurred.
- Nothing was pushed, merged, rebased or amended; no worktree was created or removed; `package.json`,
  `src/bootstrap/**`, `templates/**` and `docs/**` were not touched; no dependencies installed.

## What changed

### `scripts/bootstrap-one.ts` (+6 / −4)

1. `validateParentHandoff` — after the existing `nextBaseSha` check, and therefore after every existing
   blocker in its existing order (unreadable/non-JSON → stored hash ≠ canonical → canonical ≠ manifest
   `parentHandoffHash` → wrong `nextTaskId` → wrong `nextBaseSha`), a new blocker:

   ```ts
   const status = String(parent.status); // FIX-5: a handoff records its unit's outcome; an absent status reports as "undefined" and is rejected the same way.
   if (status !== "PASS" && status !== "ALREADY_SATISFIED") return [`parent handoff ${String(parent.taskId)} reports status ${status}; only PASS or ALREADY_SATISFIED may be a base`];
   ```

   `String(parent.status)` makes the absent-field case read `… reports status undefined; …`, which the spec
   declares acceptable, and keeps the gate total (a `null`/`123`/object status is a blocker, never a crash).

2. `parentAcceptance` — the line it prints asserts acceptance, so it now returns `[]` unless the parsed
   parent's `status` is `PASS` or `ALREADY_SATISFIED`. **Wording is byte-identical**
   (`parent=<taskId> accepted <hash-prefix>…`); only the condition changed. Both call sites already gate on
   `validateParentHandoff` returning no blocker, so this is a second, local guarantee rather than a behaviour
   change — the log can no longer claim acceptance on a successful `JSON.parse` alone.

3. Two doc comments updated (module header, `validateParentHandoff`/`parentAcceptance`) to state the rule.

No other behaviour change: the exit-code map (0/2/3/4/5/64/66), the FIX-3C pre-stamp schema gate, the FIX-4A
derived-authority check, the gate call, the "no model call" property and read-only-aside-from-the-handoff-file
behaviour are untouched. The status check is reachable from **both** paths: the plan path (exit 4
`REJECT handoff:`) and the stamping path (exit 5 `REJECT gate:`).

### `test/unit/bootstrap-one.test.ts` (+37 / −0 — additions only, no line deleted or modified)

- `stampRun` gained one way to vary the parent's recorded status **without touching any pre-existing fixture
  line or assertion**: a `StampParentStatus` knob read inside `stampRun` immediately *before* the parent's
  checksum is computed, so a parent on an accept path hashes exactly as the CLI later reads it
  (`stampStatus(null)` removes the `status` key entirely). The `Stamp3` type and all FIX-2/FIX-3C/FIX-4A
  fixture lines are byte-identical to HEAD~1.
- 4 new tests (18 → 22 in this file; every pre-existing test name is still present):
  1. `FIX-5: validateParentHandoff reads the parent's status …` — pure-function proof that `BLOCKED` and an
     absent `status` yield exactly the required blocker strings (with the stored `handoffHash` recomputed over
     the mutated parent, so **only** the status can reject it), that `ALREADY_SATISFIED` yields `[]`, and that
     the plan path rejects a blocked parent with exit 4.
  2. `FIX-5: a parent whose status is BLOCKED blocks the gate, exits 5, is never logged accepted, writes no handoff`.
  3. `FIX-5: a parent with no status key is rejected the same way, and the run fails closed rather than throwing`
     (also asserts no stack-trace frame via the existing `NO_TRACE`).
  4. `FIX-5: a parent whose status is ALREADY_SATISFIED is accepted, stamped, exit 0, and the acceptance line is unchanged`.
- The existing `status: "PASS"` fixtures (`PARENT`, `stampRun`'s default parent, `CONFORMING`) are unchanged,
  and the pre-existing assertion that a `status`-mutated-but-not-rehashed parent is caught by
  `stored hash … != canonical` still passes — the status check runs after the hash checks, so that ordering
  assertion is unaffected.

## Acceptance criteria — evidence

### 1–3. Direct CLI evidence

`/tmp/fix5-demo.mjs` builds the same committed-clean fixture repo as `stampRun` (temp dirs under `tmpdir()`,
removed afterwards) and runs `scripts/bootstrap-one.ts --emit-handoff` once per parent status:

```
===== parent.status="BLOCKED" =====
REJECT baseline: HEAD b168011d8f774a6111c1902c4a48ea9260332eb2 != manifest baseSha b5c40cc1ace5c4849b7a4ab898a15ba5586c8d18
plan exit=3; no model invoked (B04 stops here)
REJECT gate: parent handoff E01 reports status BLOCKED; only PASS or ALREADY_SATISFIED may be a base
exit=5 written=[]

===== parent.status=<key absent> =====
REJECT baseline: HEAD 972dc8bec11e9f4753fc1121107651fc38aa5764 != manifest baseSha 504db9535a7885416107ab22a85d3c48309a94da
plan exit=3; no model invoked (B04 stops here)
REJECT gate: parent handoff E01 reports status undefined; only PASS or ALREADY_SATISFIED may be a base
exit=5 written=[]

===== parent.status="ALREADY_SATISFIED" =====
REJECT baseline: HEAD 972dc8bec11e9f4753fc1121107651fc38aa5764 != manifest baseSha 504db9535a7885416107ab22a85d3c48309a94da
plan exit=3; no model invoked (B04 stops here)
parent=E01 accepted sha256:1387e214ca4…
authority=T1 sha256:480398baca4686d69e1f82e210857a1c72d645822b47679991ea49faa9a442a6
schema=T1 conforms fixtures/schema.json
handoff=/var/folders/m_/…/fix5-demo-out-aFAC5J/T1.handoff.json checksum=sha256:cd8e014ca140c3c6f993251338042e6b04af98b472e4aed0ce90f653a3d21ad1 gate=accepted (clean tree + proofs + diff scope + HEAD^1 == approved base; the plan baseline line above describes the pre-task state)
exit=0 written=["T1.handoff.json"]
```

Criterion 1 ✓ (`REJECT gate: parent handoff E01 reports status BLOCKED; only PASS or ALREADY_SATISFIED may be
a base`, exit 5, `written=[]`), criterion 2 ✓ (absent key → `status undefined`, exit 5, `written=[]`, no
exception), criterion 3 ✓ (`parent=E01 accepted sha256:1387e214ca4…`, exit 0, `T1.handoff.json` written).
The `REJECT baseline:` line is the pre-existing, expected plan-path line at stamp time (HEAD is the task
commit, not the approved base); it is not a FIX-5 change.

### 4. Verification commands (run from the worktree root, after the commit)

```
== npm run typecheck ==
EXIT=0
> pi-engineering-runtime@0.2.0 typecheck:scripts
> tsc --noEmit -p tsconfig.scripts.json

== node --test bootstrap-one ==
EXIT=0
✔ FIX-4A: a record with no taskAuthorityHash is rejected — exit 5, nothing written (308.32825ms)
ℹ tests 22
ℹ pass 22
ℹ fail 0
ℹ duration_ms 5309.317417

== node --test bootstrap-* ==
EXIT=0
✔ FIX-4B: an unknown mode is still rejected and herdr-ui keeps the 2-file caps (0.880292ms)
ℹ tests 62
ℹ pass 62
ℹ fail 0
ℹ duration_ms 5500.858291

== git diff --numstat HEAD~1 HEAD ==
6	4	scripts/bootstrap-one.ts
37	0	test/unit/bootstrap-one.test.ts
EXIT=0
```

Totals: **43 added + 4 deleted = 47 changed lines**, two files only, budget 70.
Worktree after the commit: `git status --porcelain` empty.
Test-name audit: 18 `test(` at HEAD~1, 22 at HEAD; `comm` over the sorted test titles shows no pre-existing
title missing, and the file's diff is `37 / 0` (additions only).

## Risks

1. **A stricter chain is a behavioural break for in-flight missions.** Any parent handoff already on disk with
   `status: "BLOCKED"` (or missing `status`) now blocks its child at exit 4/5 instead of stamping. That is the
   intent, but a conductor that treats exit 5 as "retry the same child" would loop; the correct response is to
   re-run the parent unit.
2. **`status` is read as a string via `String(...)`.** A non-string status (`null`, `true`, `{"x":1}`) is a
   blocker whose text prints the coerced value (`null`, `true`, `[object Object]`). Fail-closed and total, but
   the message is less legible for exotic values; the FIX-3C schema gate names those precisely anyway when a
   real schema is supplied.
3. **Ordering puts status last.** A parent that is both rehashed-but-blocked and sequence-broken reports the
   sequence/`nextBaseSha` blocker first. Required by "keep the existing blockers and their order", and it keeps
   the existing `stored hash … != canonical` assertion green, but it means one run can surface a less severe
   blocker before the status one.
4. **`ALREADY_SATISFIED` as a base is accepted without proof it was verified.** The rule only recognises the
   two accepted statuses; whether an `ALREADY_SATISFIED` parent really re-verified its target is the result
   gate's and the operator's problem, not this check's.
5. Not covered here: the **child's own** record status. `--emit-handoff` still stamps whatever accepted status
   the record carries (FIX-3C validates it against the schema, which permits `BLOCKED`). A `BLOCKED` child
   handoff can therefore still be written — it simply cannot become a base after this change.

## Disagreements / notes

- I agree with the defect and the fix. Two things I would do differently if the scope were wider:
  (a) stamp-time rejection should arguably be a distinct exit code (or at least a distinct line) from a hash
  failure, since "parent recorded a non-accepted outcome" and "the chain is corrupt" need different operator
  actions; (b) `templates/handoff.schema.json` allowing `BLOCKED` while a `BLOCKED` handoff can never be a base
  means the schema and the chain rule encode different contracts — a follow-up could add a
  `parentAcceptance`-aware check in `src/bootstrap/resultGate.ts` or document the asymmetry in
  `02-HANDOFF-PROTOCOL.md`. Both are outside the two allowed files.
- The one thing I find awkward is forced by the "additions only" rule on the test file: the FIX-5 parent-status
  knob is carried on the existing `Stamp3` options object through a small `StampParentStatus` type plus an
  assertion inside `stampRun`, instead of being a normal `Stamp3` field. It is deliberate — adding the field to
  `Stamp3` would have modified three pre-existing lines, making `git diff` show deletions. A future cleanup
  should fold `parentStatus` into `Stamp3` properly.
- `npm run lint` (`biome check`) fails on both of these files **at HEAD as well** (4 formatter diagnostics on
  the pre-existing dense one-line style — verified by running biome on the `git show HEAD~1:` copies). I did
  not reformat, because that would blow the line budget and rewrite assertions the spec says must stay
  untouched; my added lines follow the surrounding style.
