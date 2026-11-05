# WORKER_REPORT T01 — Persist canonical original task identity

- Worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-t01-task-authority-20261104`, branch `feat/t01-task-authority`
- Base `7be362d657c5ed1de8d0a70ce56def5dcc60953f` (parent D08 handoff `sha256:a42ead207e17c03fe228d46c9ab97251fcc1d547d1e6a251d0b58caf55f2e602`, status PASS)
- **Commit `ac65984c777ff9d428ce7c332fe2c73465220f9e`** — `feat(bootstrap): canonical original task authority (T01)`, parent verified `7be362d6…`, one commit, **not pushed**, no PR opened (this unit is a bootstrap microtask stamped by the conductor, not merged by the worker)
- Model for this unit: `metabolomics/qwen3.8-flash_next`. **My predecessor on T01 died because the gateway no longer
  serves `qwen3.7-max-next`**; I ran the whole unit on `qwen3.8-flash_next` and the gateway never switched me away.
  No partial diff of theirs was present in this worktree (`git status` clean at base), so nothing was inherited or kept.

## Diff scope

```
$ git diff --numstat 7be362d657c5ed1de8d0a70ce56def5dcc60953f HEAD
54	0	src/bootstrap/taskAuthority.ts
44	0	test/unit/task-authority.test.ts
```

98 changed lines (54 + 44, all additions, zero deletions) **≤ 100**; exactly the two permitted files. `node_modules` is a
symlink to the primary checkout (per AGENTS.md, instead of reinstalling) and is git-ignored, so the worktree is clean
apart from this untracked report. Nothing else touched: `src/bootstrap/{resultGate,diffGuard,pathPolicy,handoffWriter,taskManifest}.ts`,
`scripts/**`, `package.json`, `test/support/**`, `manifests/**`, `templates/**` are byte-identical to base — this unit is
**not wired into the gate** (no change to `resultGate.ts`, `bootstrap-one.ts`, `taskManifest.ts`, `handoffWriter.ts`);
T04/T05 consume it.

## What the module does (`src/bootstrap/taskAuthority.ts`)

- `deriveTaskAuthority(source)` — authority over the **operator-authored** `goal` / `scope` / `nonGoals` / `tests` only.
  Canonicalizes (trim, drop empties, collapse duplicates keeping the first occurrence, **preserve authored order** — a
  scope list is a contract, not a set) then hashes `{ kind: "operator-task/v1", … }`. Refuses with stable, field-ordered
  reasons: non-object source, non-string member (`scope: member 1 is not a string`), non-array member, empty goal after
  trimming, array empty after canonicalization. Never invents a placeholder.
- `derivePlannerContractHash(contract)` — the **generated** artifact (`plan`, generated `tasks`, optional model
  `restatement`) hashes over a separate canonical form tagged `planner-contract/v1`, so identical words give a different
  digest, and the restatement participates in the hash (recorded, never ignored).
- `verifyAuthority(authorityHash, { source, plannerOutput })` — recomputes authority from the **frozen source only**;
  `plannerOutput` is read solely to report `diverged` (which of goal/scope/nonGoals/tests the planner restated
  differently) plus a mismatch reason. Planner fields are never substituted into the recomputation — a candidate whose
  only content is planner output is refused (`ok: false`, `authorityHash: null`) rather than derived — and `ok` depends
  only on hash equality, so divergence is never a re-authorization.
- Source declaring non-operator origin is refused: `origin: planner-authored content cannot define task authority,
  expected "operator"`.
- Pure and deterministic: no fs, no network, no clock, no RNG, no mutation of inputs. **No second hash**: the digest is
  `canonicalHash` imported from `./resultGate.ts`, so the digests are comparable in form with what the gate already
  prints (`sha256:<64 hex>`).

## Verification (from the worktree root, at commit `ac65984c`)

```
$ npm run typecheck                                                  exit=0
  tsc --noEmit; tsc --noEmit -p tsconfig.scripts.json
$ node --test --import ./test/support/isolatedState.ts test/unit/task-authority.test.ts   exit=0
  ℹ tests 5  ℹ pass 5  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0  ℹ duration_ms 134
$ node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-task-manifest.test.ts
                                                                     exit=0
  ℹ tests 9  ℹ pass 9  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
```

The full unit suite was deliberately **not** run (baselined red, ~25 min here), as the handoff instructs.

Tests cover: the plan's named regression first (planner output edited, including a restatement of all four fields with
different content → authority hash unmoved, `diverged` names exactly `["goal","scope","nonGoals","tests"]`, and the
planner-contract hash *does* move when the restatement is recorded); a hijack attempt where the frozen source is absent
and only planner output carries the words → refused; each of goal/scope/nonGoals/tests changed by one item → different
authority hash; authority ≠ planner-contract hash for identical words; whitespace/duplicate variants canonicalize to the
same hash; reordered scope changes it (order is meaning-bearing); malformed refusals with their exact reason strings; and
input immutability plus re-derivation determinism.

## Deviations

1. **Neighbour paths do not exist as named.** The handoff and my instructions name `test/unit/result-gate.test.ts` and
   `test/unit/task-manifest.test.ts`. Neither exists at base; running them literally fails:
   `node --test … test/unit/result-gate.test.ts test/unit/task-manifest.test.ts` → **exit=1**,
   `Could not find 'test/unit/result-gate.test.ts, test/unit/task-manifest.test.ts'` (log: `/tmp/t01-literal-neighbours.log`). The real neighbours are
   `test/unit/bootstrap-result-gate.test.ts` and `test/unit/bootstrap-task-manifest.test.ts`; those are what I ran
   (**exit=0**, 9/9). This is a spec-path error, not a code problem — later T-units will hit it too, so the conductor
   should fix the HANDOFF wording.
2. **`T01/fixtures/manifest.json` is absent.** The handoff's authority clause names
   `docs/specs/harness-reliability-bootstrap-20261103/T01/fixtures/manifest.json` ("printed by the CLI at stamp time"),
   but `T01/` contains only `HANDOFF.md`, and `manifests/**` is denied to me, so I could not print `canonicalHash(parseTaskManifest(manifest))`
   for this unit's own manifest. The deliverable (the reusable module + tests) is complete; the stamp-time hash must come
   from the conductor's manifest, which lives outside my scope. No clause was dropped for budget reasons (98/100 at the
   original commit; see the follow-up section for the post-amendment count).
3. `resultGate.ts` itself imports `node:fs`/`node:path`; reusing its `canonicalHash` (required by clause 2, and the
   reason there is no second hash) means those modules load transitively. `taskAuthority.ts` calls no fs, network, clock
   or RNG function and is pure; the constraint is honoured in behaviour, not in import-graph closure.
4. No acceptance clause was cut for cost and nothing is BLOCKED; budget headroom after the amendment is 1 line of 100.

## Conductor follow-up (nested planner restatement) — amended

Gap found by conductor verification: `verifyAuthority` read drift only from **top-level** `plannerOutput.goal|scope|nonGoals|tests`,
while this module's own `PlannerContract` puts the model's restatement under `plannerOutput.restatement`. So
`verifyAuthority(h, { source, plannerOutput: { plan, tasks, restatement: { goal: "ship everything", scope: ["everything"], nonGoals: [], tests: ["nothing"] } } })`
returned `diverged: []` where the top-level equivalent returned all four fields.

Fix (same two files): the field holder is now `plannerOutput[field]` when present, **otherwise** `plannerOutput.restatement[field]`
(top level wins; nested is the fallback), so a nested restatement names exactly the same `diverged` fields. Authority
recomputation is unchanged — operator `source` only, planner content never substituted — and `ok` remains `true` in that
case (drift is reported, never re-authorized). Added one assertion: the nested restatement's `diverged` `deepEqual`s the
top-level one's. Net cost: production line count unchanged (54, loop restructured into the same 4 lines), test +1.

```
$ git diff --numstat 7be362d657c5ed1de8d0a70ce56def5dcc60953f HEAD
54	0	src/bootstrap/taskAuthority.ts
45	0	test/unit/task-authority.test.ts
```

**99 changed lines ≤ 100.** Amended in place as instructed: `git commit --amend --no-signoff -m 'feat(bootstrap): canonical original task authority (T01)'`
→ **commit `145549b5061f6b56b8c99645837e8361cd5b9be4`**, parent still `7be362d657c5ed1de8d0a70ce56def5dcc60953f`, still exactly
the two permitted files (previous `ac65984c` superseded, not pushed at any point). Model unchanged: `metabolomics/qwen3.8-flash_next`.

Re-verification at the amended commit (worktree root):

```
$ npm run typecheck                                                  exit=0
$ node --test --import ./test/support/isolatedState.ts test/unit/task-authority.test.ts   exit=0
  ℹ tests 5  ℹ pass 5  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
$ node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-result-gate.test.ts test/unit/bootstrap-task-manifest.test.ts
                                                                     exit=0
  ℹ tests 9  ℹ pass 9  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
```

Full unit suite still deliberately not run (baselined red). Worktree clean apart from this untracked report; deviations 1–3
above stand.
