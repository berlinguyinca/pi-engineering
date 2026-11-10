# Release review — harness-reliability-bootstrap

Reviewed against `e5fbd8c7` (`fix/handoff-lineage-reachability`, on `4ffa82f3`), 2026-11-05,
node v26.3.0. Every number below is labelled with how it was obtained: **[now]** measured in this
review, **[log]** read from a retained log file, or **[doc]** asserted by a tracked document with its
line. Measurements marked **[now]** were taken at `8dd30a22`; the only commits since then touch docs
and this audit directory, so no measurement was invalidated by them.

## Verdict: NOT RELEASABLE

Nothing in this bootstrap chain is fit to promote, and the chain cannot currently *prove* that it
is not, which is the actual finding. Three independent reasons, any one of which is disqualifying:

1. **The repository's own gate cannot be evaluated.** `npm test` never terminates. Two integration
   files never settle, so the runner waits on them — even with `--test-force-exit` — and no final
   tally is printed. **[now]** both reproduce, each still running at a 150 s budget
   (exit 124): `mission-interrupt-pause.test.ts` → 1 test, 0 pass, 1 cancelled, *"Promise resolution
   is still pending but the event loop has already resolved"*; `mission-merge-queue-flow.test.ts` →
   6 tests, 0 pass, **5 fail**, 1 cancelled, `AssertionError {"status":"BLOCKED","findings":[]}`.
   A release decision cannot rest on a gate that does not produce an answer.
   Mechanism and exact next steps: `AUDIT/suite-termination-blocker-20261105.txt`.
2. **Every suite run that did produce an answer was red.** The most recent whole-suite tally
   (`/tmp/v06_npmtest_tip.log`, run at `4ffa82f3`): **tests 7735, pass 6927, fail 799, cancelled 3,
   skipped 6** **[log]**. `FINAL_AUDIT.md:69` records an earlier baseline of *150 ✖ / 2180 ✔*
   **[doc]**; those two totals are not directly comparable (different suite sizes and globs), so
   this review does not claim a failure-rate trend — only that neither run is green, and no green run
   is recorded anywhere in this chain (`FINAL_AUDIT.md:69`: B00 exit 1, baseline non-green, tip run
   non-green **[doc]**).
3. **No human approved anything.** `FINAL_AUDIT.md:64` (G6): 63/63 `approved=true` written by the
   conductor under blanket delegation, no independent validator and no signature artifact. The
   protocol requires the human gate *before* the next task, so the chain has been advancing past its
   own stop condition.

## Gate status

| Gate | Status | Source |
|---|---|---|
| G1 authority / predecessor / clean base | met, recorded exception | `FINAL_AUDIT.md:59` — 42/43 pairs continuous; FIX gaps `24f42fba`, `74b54eb1` |
| G2 allowlist, zero unauthorised edits | met, recorded exception | `:60` — E01/E02 have no fixture; mode labels deviate (R01, H01, V05) |
| G3 diff-size caps | met, recorded exception | `:61` — measured 73–100 / 86–118; FIX-4A/4B 3 files each, no manifest ceiling defined |
| G4 declared tests + exit codes + logs | met, recorded exception | `:62` — exit 0 in 50/52 canonical records (FIX-1/FIX-2 record exit-5 reproductions) |
| **G5 background processes / teardown** | **not met** | `:63` — no artifact records teardown for any unit |
| **G6 no model self-approval** | **not met** | `:64` — see reason 3 |
| G7 never edit main, isolated worktree | met | `:65` |
| **S2 "later full `npm test` once safe"** | **not met** | `:69`, re-confirmed **[now]** |
| S1 flags OFF by default | met, recorded exception | `:68` — `ROLLOUT.md` declares flags, no runtime proof. Flag-default unit file passes **[now]**: `test/unit/resilience-default-off.test.ts` 3/3, exit 0 |
| **E2 reproducibility from git** | **partially cleared — measured** | `:71` asserted "43/52 canonical records and 524/696 evidence files are untracked; cannot be reproduced from git". Re-run now **[now]**: the tracked set went from **0** records at the merge-base with `main` (`c2b75dc9`) to **95**, **95/95 `handoffHash` values recompute exactly from their committed bytes**, and **505/505 declared evidence paths are present in the same tree** (0 absent). What E2 still does not cover is *completeness* — plan tasks with no record at all (`:70`) — and no runtime behaviour. Re-check: `AUDIT/record-reproducibility.mjs` |
| E3 lineage | now gated | was `:72` "met with recorded exception"; see below |
| **G1/S2 whole-suite green** | **open** | `AUDIT/suite-termination-blocker-20261105.txt` |

## Lineage: fixed at the root cause, and now enforced (`8dd30a22`, `e5fbd8c7`)

Earlier audits proved commit pointers by *object existence* (`git cat-file -e`), which is the wrong
test: an object can exist locally with **no ref carrying it**, and a fresh clone only contains what
refs carry. Scanning all three pointer fields of all 95 tracked `*/out*/*.handoff.json` — 285
pointers — at `4ffa82f3`: **244 reachable, 12 schema-legal `null`, 29 broken** **[now]**:

| broken pointer | count | records |
|---|---|---|
| `baseSha` object_missing | 7 | `H01`–`H07` |
| `resultSha` object_missing | 7 | `H01`–`H07` |
| `nextBaseSha` object_missing | 7 | `H01`–`H06`, `R08/out-corrected` |
| `nextBaseSha` unreachable_from_any_ref | 8 | `V02`–`V05`, `X01`–`X04` |

The first cut of this gate looked only at `nextBaseSha` and reported 15 breaks; widening to all
three fields is what surfaced the other 14, including `H07`, which the narrower scan never touched.

Nothing was re-stamped, because `handoffHash` binds the pointers to the record's log paths
(`02-HANDOFF-PROTOCOL.md:15`; `canonicalHash`, `src/bootstrap/resultGate.ts:30` — the line moved from 15 when
X13 reformatted the file to make `npm run lint` pass) — verified by
recomputing all 95 above. `AUDIT/lineage-superseded.json` declares each break in one of two kinds
that are deliberately not interchangeable:

- **`superseded` (8)** — a reachable commit with a byte-identical subject, provably the same commit
  rewritten; usable as the pointer. Cross-check validating the rule: it derives `fc471225` for `V04`
  and `d44672d4` for `V05`, exactly the shas their own `out-final` records already name.
- **`unresolvable` (21)** — `replacement: null`. No live commit is provably the declared value: the
  per-unit commits were lost when the generation was batch-committed (`9cf164fa` *"H01–H07 handoff
  evidence trees"*). `annotatedBy` names the reachable commit carrying the record and its evidence,
  so the *generation* is reproducible even though the *pointer* is not. Claiming a replacement here
  would have been false — the commit that adds a record is not the commit the record names as its
  base.

`AUDIT/lineage-scan.mjs` re-verifies every entry on each run and fails on
`UNCOVERED`/`STALE`/`DEFECT_GONE`/`BAD_REPL`/`BAD_ANNOTATION`/`DUPLICATE`. **Every branch was
provoked against real objects, not asserted** **[now]**, including both `BAD_REPL` branches and an
`UNCOVERED` pointer aimed at `4e011af4`, a real commit whose `for-each-ref --contains` count is 0.

Two defects in the gate's own first version were found by running it, both worth repeating: subject
matching via `git log --grep` with regex escaping silently matched nothing (subject parentheses
became groups), losing all 8 twins — now `-F` plus exact comparison; and one control was run against
a hand-typed 40-hex id whose tail was wrong, so it proved the wrong branch. **Derive every sha from
command output, never from memory** — a plausible-looking hash in prose is exactly as dangerous as
the decorative pointers this gate exists to catch.

## What is safe to rely on

- Typechecking is clean **[now]**: `npm run typecheck` exit 0 at `8dd30a22`.
- The unit-level proof for the flag-default safety property passes **[now]** (3/3).
- Individual task evidence is internally consistent: 52/52 declared SHAs resolve, `evidence` paths
  resolve 52/52 **[doc]** `:62`,`:72`.
- The lineage gate now exists, so this class of defect cannot recur silently.
- Every tracked record verifies from its committed bytes, and every file it vouches for is in the
  tree **[now]** (95/95, 505/505) — so the evidence that exists is trustworthy evidence; the gap is
  evidence that was never recorded, not evidence that was recorded wrongly.

## What must happen before any release decision

In order — 1 and 2 are the gate; 3 is the audit that tells you whether the rest is reproducible:

1. **Break the hang, in production code if that is what it turns out to be.** Trace
   `interruptibleRun` / `orchestrator.resume(..., { signal, interrupt: 'pause' })` into
   `realBackends.runWorker` for the fixture's mission. `WorkerRequest.signal` is optional
   (`src/workers/WorkerExecutor.ts:143`) and `src/orchestration/realBackends.ts:582` is its only
   producer, so if the interrupt never aborts, that is a defect in interrupt/pause propagation and
   the fix belongs in `src/orchestration`, not in the test. Then make the stub fail fast on a bounded
   timer so a regression is a failure, not a suite that never ends.
2. **Re-run the whole suite to a tally** and record the counts against a like-for-like baseline.
   Until this prints a number, no gate can be called green and no rate can be compared.
3. ~~Re-run the integrity/reproducibility scan (E2) at the current tip.~~ **Done in this review**
   (`AUDIT/record-reproducibility.mjs`, 95/95 hashes, 505/505 evidence paths). What remains is the
   *completeness* half of E2: give the plan tasks that have no record at all a record, or amend
   `FINAL_AUDIT.md:71` so the two halves of E2 are tracked separately instead of one line doing both.
4. **Attach teardown evidence for G5** and a real human approval for G6 — the latter is a
   policy decision the conductor cannot make for you.
5. `V07` does **not** exist in the tracked manifest (`manifests/tasks.json` has 51 tasks ending at
   `V06`; no X-series entries either), so the X-series work is not covered by tracked scope.

## Outstanding operator decisions (not mine to make)

- **There is no remote mismatch.** `origin` is `https://github.com/berlinguyinca/pi-engineering-runtime`
  while every record declares `repo=berlinguyinca/pi-engineering`, which looked like two repositories
  claiming to be authoritative. They are one: the repository was renamed, and GitHub redirects.
  `gh repo view berlinguyinca/pi-engineering-runtime` now reports
  `nameWithOwner=berlinguyinca/pi-engineering`, and a push to the old URL lands in the new one.
  Nothing to decide — but records and docs should cite `pi-engineering`, since the old name only
  survives as a redirect. **[now]**
- **Merged, and what that merge does and does not mean.** This unit landed as **PR #603**
  (`e513ff60`, merged 2026-11-05) against `harness-reliability-bootstrap-20261103`, the base PRs
  #600 and #601 use; #600 landed alongside it. `main` is untouched. Both gates were re-run against
  the **merged** chain tip, not just the branch, and pass there: `healthy=244 nullDeclared=12
  broken=29` and `505/505 evidence paths`, exit 0 each.
  A model reviewed the diff before the merge (PR comment `#issuecomment-6670235815`), found three
  defects in the gate itself, and they were fixed and reproduced — see `AUDIT/lineage-scan.mjs`
  header for the `refs/stash` case. **That review is not G6.** It is a model reading a model's
  work, labelled as such in the comment, and no `approved` flag, record, or manifest was changed to
  imply otherwise. G6 above still reads **not met**, and this review's verdict still stands:
  **not releasable.**
  Deleting the merged `fix/handoff-lineage-reachability` branch is safe for this unit's own
  invariant — measured, not assumed: **0** of the 244 pointers are carried solely by it, so no
  declared pointer loses its last carrier. Do that measurement (`AUDIT/lineage-scan.mjs` plus
  `for-each-ref --contains`) before deleting any chain branch, because a branch can be the only ref
  carrying a pointer this audit depends on.
- The tracked manifest carries **no `status` and no accepted-sha field** on any of its 51 tasks, so
  accepted/rejected state lives only in the conductor's working copy. Whether that state becomes
  tracked data is a design decision.
- Obsolete local branches from superseded integrations (e.g.
  `harness-reliability-v05-integration-20261108`, whose commits re-create work the chain already
  carries at `d44672d4`/`fc471225`) should be deleted once you agree they are superseded; nothing
  has been deleted by this review.

## Corrections, 2026-11-09, measured at `main` = `e008b3dc`

This section is additive. The verdict above is a point-in-time judgement and is left standing; three
of its disqualifiers were measured again today and two of them no longer hold, in detail, so that
anyone reading the verdict knows which parts still do.

1. **"The repository's own gate cannot be evaluated. `npm test` never terminates."** -- **no longer
   true for the named files.** `test/integration/mission-interrupt-pause.test.ts` and
   `test/integration/mission-merge-queue-flow.test.ts` now complete and pass when run alone --
   **18 tests, 0 fail, exit 0**, measured at `e008b3dc` on both **Node v26.3.0** and **v22.22.3**
   **[now]** -- and the Woodpecker pipeline's `test-integration` step runs to completion: pipelines
   **41, 43, 44, 45** report every step (`install`, `lint`, `typecheck`, `test-unit`,
   `test-integration`, `smoke`, `roadmap-structural`) as `success` **[ci-log]**, while the pipeline at
   `e008b3dc` itself (**48**) is red on the `treeHash` fingerprint defect that PR **#658** fixes, not
   on any of the files this review named. What fixed the original hang is **not identified in this
   correction**: I could not attribute it to a commit, and an attribution I could not verify would be
   the same class of error this file's caveats exist to stop. The first draft of this correction
   claimed the hang was cross-file cache state fixed by #654; that was wrong on both counts
   (#654's diff touches no cache file, and #627 is an unrelated refactor), and it is removed here
   rather than footnoted.
2. **"Every suite run that did produce an answer was red."** -- **no longer true, with one
   qualification that is itself a finding.** A green whole-suite run is now recorded twice: by CI (the
   pipelines above **[ci-log]**), and locally at `d00bbb73` where `npm run test:unit` completes with a
   final tally -- **460 files, 6789 tests, 0 fail, 5 skipped**, exit 0, in about 400 s **[now]**. One
   failure mode was found since and is fixed in an open PR: `repoFingerprint` trusted `git add`'s stat
   cache, so an edit landing inside the same filesystem tick left `treeHash` stale and
   `test/unit/verify-test-result-cache.test.ts` failed determinism on Linux (pipeline 48 at
   `e008b3dc`; reproduced locally by touching a file with no content change, and the mechanism --
   `git add` trusting stat data within the same filesystem tick -- applies to any coarse-timestamp
   filesystem) -- PR **#658**.

   The qualification, measured at `e008b3dc` on this laptop **[now]**: `npm run test:integration` on
   the machine's default **Node v26.3.0** answers **1185 tests, 1182 pass, 3 fail**, exit 1 -- so the
   suite is *not* green on every runtime, only on the pinned one. The same files on **v22.22.3** (the
   family CI pins, `NODE_VER=22.23.4` in `.woodpecker/ci.yaml:61`) answer 16 tests, 0 fail, exit 0:

   * `test/integration/planner-worker-gateway-timeouts.test.ts:35` -- both its tests die in
     `new Dispatcher1Wrapper` with `InvalidArgumentError: Argument dispatcher must implement
     dispatch`, i.e. Node 26's bundled undici rejects the dispatcher the test installs;
   * `test/integration/planner-worker-executor.test.ts:110` -- `independent contracts must run
     concurrently (max in flight 1)`, an assertion about scheduling that passes on v22.

   The same two files on v22.22.3: **16 tests, 0 fail, exit 0** -- so in one run of each runtime,
   neither file hung; one run is what was measured, and a regression would be a hang again. What
   replaces the old finding is narrower and still worth someone's attention: the suite is green on
   the runtime CI pins and red on a newer one, and the only statement of which runtime is the
   contract is `package.json`'s `engines` field, `"node": ">=22.18"` -- a lower bound with **no
   upper bound**, so Node 26 satisfies it and a contributor on a newer runtime gets three red tests
   and nothing else.
3. **"No human approved anything."** -- **unchanged.** Nothing here adds a signature or an independent
   validator, and the trail's own independent review is still absent: the reviewing account reports a
   usage ceiling until 2026-11-11 07:03, so #653/#656 are self-verified and labelled so.

Citations in the review above that do not resolve, corrected today **[now]**:

* `AUDIT/lineage-allowlist.json` **does not exist** and never was committed (`git log --all
  --diff-filter=A` finds nothing on any ref). The tracked declaration file is
  **`AUDIT/lineage-superseded.json`**, 30 entries. The same dangling name is also carried by
  `PLAN-COMPLETION.json`'s `next_action` (marked in place) and by `X16/logs/12-closing-state.txt`,
  a log written today by the unit that is supposed to prevent exactly this. The log is a
  historical record and is **not rewritten**; the correction stands here and in
  `PLAN-COMPLETION.json`, where the trail keeps living state.
* The trail gates do not share one record denominator, and reading them as one overstates coverage:
  **160** tracked `*.handoff.json` files (what `record-reproducibility.mjs` recomputes, which PR #660
  widens from 119 (open; on `main` the figure is still 119)), versus **230** in `integrity-scan.mjs`, which counts any `*handoff*.json`
  (231 such files: 121 in generation directories, 41 in unit directories, 68 elsewhere). Neither
  number is wrong; `lineage-scan.mjs` walks **generation records only**, so **41 of the 160 records
  are outside its pointer check** -- that gap is open work, not coverage.

## Re-check commands

```sh
node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-scan.mjs HEAD        # expect: RESULT ok, exit 0
node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/record-reproducibility.mjs   # expect: RESULT ok, exit 0
npm run typecheck                                                                          # expect: exit 0
node --test --test-concurrency=1 --import ./test/support/isolatedState.ts \
  test/integration/mission-interrupt-pause.test.ts                                    # 2026-11-09: exits 0; the hang above is resolved [now]
node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/integrity-scan.mjs       # expect: RESULT ok, exit 0 -- run in a full clone; after #659 merges, a shallow one makes lineage-scan exit 2 saying so
```
