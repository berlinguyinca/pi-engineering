# WORKER_REPORT — T03: constrain malformed-plan fallback

- Repository: `pi-engineering-runtime`, worktree `/Users/wohlgemuth/IdeaProjects/worktrees/pi-t03-fallback-envelope-20261104`
- Branch: `feat/t03-fallback-envelope`, base `95aba353f1876f8d617143556ec753709b718e34`
- Files changed (2, as scoped): `src/orchestration/missionPlanner.ts`, `test/unit/mission-planner-fallback-scope.test.ts` (new)
- Authority: `docs/specs/harness-reliability-bootstrap-20261103/T03/HANDOFF.md`

## 1. Diff size (contract: ≤ 100 changed lines)

```
$ git diff --numstat 95aba353f1876f8d617143556ec753709b718e34
21	4	src/orchestration/missionPlanner.ts
74	0	test/unit/mission-planner-fallback-scope.test.ts
```

**99 changed lines (21+4+74), 2 files, 1 production file, 1 new test file.**

## 2. What changed and why

### The old behaviour (base, `missionPlanner.ts:215-266`)

`const fallback = (reason) => ({ tasks: [input.single()], fallbackReason: reason })` — one line,
five callers (transient-after-retry, planner call failed, malformed plan, no contracts, contract
with no writable domain). It handed `input.single()` to the broker **verbatim**: never clamped
against `writableDomains` / `readOnlyPrefixes`, and never blocking. In production `single()`
declares `write_domains: ["**"]` (`src/runtime/EngineeringRuntime.ts:1721-1740`), so a fallback
task claimed repo-wide write scope regardless of the manifest envelope.

### The new invariant

> Every fallback path returns `single()` **clamped to the manifest envelope by
> `scopeTaskDomains`'s own rules**, carrying the mission's acceptance and `single()`'s budget,
> naming every removed glob in the visible `fallbackReason`. If nothing survives the clamp the
> mission **blocks**: `{ tasks: [], fallbackReason: "…; mission blocked: no writable domain survives the envelope" }`.
> Planner text is never consulted on a fallback path, so a malformed plan can only ever narrow.

New helper, reached through the existing `fallback` closure (so all five paths route through it):

```ts
function clampedFallback(input: MissionPlanInput, reason: string): MissionPlanResult {
  const base = input.single();
  // One reuse of `scopeTaskDomains`, which reads only `scope`, so the clamp is the same.
  const { kept, rejected } = scopeTaskDomains({ scope: { allowed: [...base.write_domains], forbidden: [] } }, input);
  const why = rejected.length > 0 ? `${reason}; clamped write_domains: ${rejected.join(", ")}` : reason;
  const acceptance_ids = input.acceptanceIds.length > 0 ? [...input.acceptanceIds] : [...(base.acceptance_ids ?? [])];
  if (kept.length === 0)
    return { tasks: [], fallbackReason: `${why}; mission blocked: no writable domain survives the envelope` };
  return { tasks: [{ ...base, write_domains: kept, acceptance_ids }], fallbackReason: why };
}
```

### The shared clamp reused (not restated)

`scopeTaskDomains` (`src/orchestration/missionPlanner.ts:119`) is the existing authority for what a
*planner contract* may keep: it rejects absolute globs, drive-letter globs, `..` segments,
`.git`/`.git/**`, anything under a `readOnlyPrefixes` root or a directory-shaped
`scope.forbidden` deny, and intersects survivors with `writableDomains` through
`intersectWriteDomains`. The fallback calls **that function** rather than copying any rule.

To make the reuse honest instead of accidental, its parameter type was narrowed from
`TaskContract` to `Pick<TaskContract, "scope">` — the body reads nothing else (`c.scope.forbidden`,
`c.scope.allowed`, plus `opts`), so the fallback cannot smuggle in a fake contract and the two
paths cannot drift. **Behaviour is unchanged**: every existing caller still passes a full
`TaskContract`, and `mission-planner-contract.test.ts` — including its own
`scopeTaskDomains drops read-only roots and domains outside the manifest's writable domains` case —
is green (§4). `intersectWriteDomains` was *not* wrapped: it is the intersect half that
`scopeTaskDomains` already calls, and a second entry point would create two authorities.

Nothing outside the two allowed files was touched: `ExecutionBroker`/`broker.ts`,
`PathConstraintEnforcer`, `MissionTaskPolicy`, `src/security/**`, `src/gate/**`,
`src/plannerWorker/**`, `src/bootstrap/**`, `src/runtime/**`, `scripts/**`, `test/support/**`,
`test/integration/**` are all unmodified (committed diff: exactly the two files; `WORKER_REPORT.md` is this untracked report).

### Carried vs. clamped

`{ ...base }` keeps every budget/identity field the caller declared — `kind`, `role`, `objective`,
`mutates_repo`, `isolation`, `depends_on`, `priority`, `execution_requirements`, `deliverables`,
`checkpoint_policy`, `max_attempts`, `failure_policy` — only `write_domains` is narrowed to `kept`.
`acceptance_ids` prefers `input.acceptanceIds` (the mission's own) and falls back to `single()`'s,
so acceptance is never dropped. `MissionPlanResult` gained **no** field (requirement 4).

### Behaviour matrix (fallback paths only)

| Path (`fallbackReason` prefix, produced in `planMission`) | Base | New |
| --- | --- | --- |
| `transient planner failure after one retry: …` | unclamped `single()` | clamped + `; clamped write_domains: …`; still exactly 2 planner calls |
| `planner call failed: …` | unclamped | clamped, **not** retried (1 call) |
| `malformed plan: …` | unclamped | clamped |
| `planner returned no contracts` | unclamped | clamped |
| `task <id> has no writable domain; rejected: …` | unclamped | clamped (both reject lists visible) |
| `planner gave no clarification question` | unclamped | clamped |
| **clamp leaves zero domains** | unclamped task to broker | **`tasks: []` + `; mission blocked: no writable domain survives the envelope`** |
| `!attempt \|\| !input.mutates` (`mode: "off"`, trivial goal, non-mutating) | `{ tasks: [single()] }`, no reason | **unchanged** (asserted deep-equal, planner never called) |
| explicit clarification | `{ tasks: [], clarification }` | **unchanged** |
| success path | `toTasks(...)` | **unchanged** |

The block gate is `kept.length === 0`, not `base.mutates_repo && …`: `planMission` returns early
unless `input.mutates` (`missionPlanner.ts:234`), so every reachable fallback *is* a mutating
mission — which is both the handoff's rule ("the input declares `mutates: true`") and strictly more
fail-closed than trusting the task's own flag.

## 3. Why zero tasks cannot be read as completed work (consumer evidence, all read-only)

Chosen representation: `{ tasks: [], fallbackReason: "…mission blocked…" }` — not `clarification`
(handoff: it "stays reserved for genuine planner ambiguity"; its doc comment at
`missionPlanner.ts:39-43` still says a malformed plan never sets it, and my tests assert
`clarification === undefined` on every fallback).

Why the empty `tasks` array is an honest block rather than a silent success:

1. **It is never persisted as a plan until the planner attempt ends.** `src/orchestration/orchestrator.ts:2723-2729`
   sets `this.planning.add(...)` before `await this.planner(...)` precisely so "the supervisor must
   not read the taskless mission as 'planning produced nothing' until the plan is materialised (or
   the planning attempt ends any other way)".
2. **The supervisor names the state, and it is not a healthy/complete state.**
   `src/orchestration/supervisor.ts:535-546`: with nothing running and nothing runnable and
   `tasks.length === 0`, it returns `health: "PLANNING_EMPTY"`, `category: "REQUIREMENT_AMBIGUITY"`,
   reason *"Planning produced no tasks for mission …: the operator must confirm or restate what this
   mission should do"* (and `null` while planning is still in flight). Its own header
   (`supervisor.ts:24-26`) defines `PLANNING_EMPTY` as *"the planner produced no executable work, so
   only the operator can say why"*. That is a stop requiring a human, not progress.
3. **The completion gate cannot be satisfied without work.** A mission with no tasks runs no worker,
   records no candidate and no verification, so `CompletionGate`
   (`src/orchestration/completionGate.ts:303-319`) reports, per acceptance criterion,
   `acceptance <id> lacks current candidate evidence` / `lacks an explicit current passing result` /
   `is not bound to current evidence`, plus the empty/missing-candidate guard
   (`completionGate.ts:140-156`) whose comment records the exact hole it closes: a mutating mission
   that recorded no candidate "cleared the gate and reported COMPLETE having produced no diff, no
   integration and nothing to review". Spec: INV-005 "Evidence before promotion" and INV-006 "Claims
   are not evidence" (`docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md:225-235`).
   Zero tasks therefore produces **no claims to mistake for done**.
4. **Fail-closed is the established posture for "nothing safe remains". ** The planner contract
   parser already rejects an authorization deny that wholly covers a grant rather than quietly
   narrowing it — `src/plannerWorker/contract.ts:137-144`, `… is inside authorization deny "…":
   nothing writable` — and the read-only/escape clamps in `scopeTaskDomains` and
   `PathConstraintEnforcer` refuse rather than permit. Before T03 the mission fallback was the one
   place in this pipeline that failed *open* (`write_domains: ["**"]` regardless of the manifest);
   it now fails closed like every neighbour.
5. **Production shape it fixes.** With a manifest whose repository binding has
   `writableDomains: []`, the base fallback produced a task claiming `["**"]`; the new fallback
   blocks with a reason naming the envelope. With a normal manifest the task is intersected down to
   the real domains (`single()`'s `["**"]` ∩ `writableDomains`).

## 4. Verification (all run in this worktree; `node_modules` symlinked per AGENTS.md)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | **0** | no diagnostics |
| `node --test --import ./test/support/isolatedState.ts test/unit/mission-planner-fallback-scope.test.ts` | **0** | 3 tests, 3 pass, 0 fail |
| `node --test --import ./test/support/isolatedState.ts test/integration/mission-planner-contract.test.ts` | **0** | 21 tests, 21 pass, 0 fail |
| `node --test --import ./test/support/isolatedState.ts test/integration/plan-review-runtime.test.ts` | **0** | 10 tests, 10 pass, 0 fail |
| `./node_modules/.bin/biome check <the two files>` | **0** | no diagnostics |

Green contract cases that constrain this change include: `malformed plan falls back to one task and
records a finding`, `a plan whose domains escape the workspace falls back naming the rejected
domains`, `a plan that only writes its own forbidden path falls back`, `a transient planner failure
is retried once, then falls back saying transient`, `a transient failure then a good plan recovers`,
`a hung planner is aborted by the timeout and falls back`, `an explicit clarification question yields
no tasks and a clarification finding`, `a blocked planner without a question (a tool failure) still
falls back to the single task`, `PI_MISSION_PLANNER=off never calls the planner`, `trivial goal keeps
the single task without a planner call`, `scopeTaskDomains drops read-only roots and domains outside
the manifest's writable domains`.

**Regression-guard check.** With the base `missionPlanner.ts` restored and only the new test file
kept: `✖ every planner failure …`, `✖ a mutating mission with no safe domain blocks …`,
`✔ the non-mutating and planner-off paths are untouched` (3 tests, 1 pass, 2 fail). The two new
behaviours genuinely fail at base; the third test guards behaviour that must not change.

### New tests (`test/unit/mission-planner-fallback-scope.test.ts`, 74 lines)

Envelope `writableDomains: ["src/**","vendor/**"]`, `readOnlyPrefixes: ["vendor"]`; `single()`
declares `["src/**","/etc/**","../escape/**","vendor/**",".git/**"]`, `checkpoint_policy`,
`max_attempts: 3`, `failure_policy: "retry"`, and **no** `acceptance_ids` (so any acceptance in the
result provably came from the mission). Six planner behaviours are driven through one loop —
`PlannerTransientError` (twice), a hard `Error`, a non-JSON string, `{contracts: []}`,
`'{"contracts":[{"task_id":"a","objective":"x","write":["**","/etc/passwd"]}]}'` (malformed:
`scope.allowed` missing), and a well-formed plan whose only domain is `vendor/**` — asserting per
case: exactly one task, `write_domains` exactly `["src/**"]`, `acceptance_ids` `["AC-1"]`,
`[max_attempts, failure_policy]` = `[3, "retry"]`, `checkpoint_policy` deep-equal, `fallbackReason`
containing `clamped write_domains: /etc/**, ../escape/**, vendor/**, .git/**`, and
`doesNotMatch(JSON.stringify(planned.tasks), /passwd/)`. Then the retry counts (transient = 2 calls,
hard = 1), and the two path tests: block (`tasks` deep-equal `[]`, reason matches `mission blocked`,
`clarification === undefined`) for both "only read-only domain" and "no domains at all", and the
untouched non-mutating / `mode: "off"` paths (planner is a rejecting stub, so a call fails the test;
result deep-equals `{ tasks: [single()] }`).

## 5. Deviations and BLOCKED clauses

1. **Five of the integration files named in the request do not exist** in this repository at base or
   at HEAD: `ls test/integration | grep -iE "mission|planner"` lists only
   `mission-planner-contract.test.ts` among them, and `node --test` reports
   `Could not find 'test/integration/mission-planner-budget.test.ts'` (likewise
   `mission-planner-partial-envelope`, `mission-planner-final-review`,
   `lifecycle-mission-planner-uses-planner-worker`, `lifecycle-planner-fallback`), exit 1 each. They
   could not be run. `grep -rln "planMission|missionPlanner|mission_planner|PlannerTransientError|missionPlannerMode" test/`
   returns exactly `test/integration/mission-planner-contract.test.ts`,
   `test/integration/plan-review-runtime.test.ts` and the new unit test — those three are the whole
   existing surface for this code, and all three are green.
2. **`src/runtime/**` is in the handoff's denied list, so two operator-visible strings there are now
   stale and I could not fix them** (`git status` proves I did not touch them). This is the one
   substantive gap created by this change:
   - `src/runtime/EngineeringRuntime.ts:1785-1796`, the finding recorded for any `fallbackReason`,
     reads `summary: "Mission planner output unusable; ran the goal as a single task."` and
     `recommended_action: "None required; the mission continues with one task."` For a **blocked**
     fallback both are false — the mission continues with **no** task, and the action is not "none".
     The block itself is still discoverable (the finding's `evidence` is the full `fallbackReason`,
     which says `mission blocked: no writable domain survives the envelope`, and the supervisor
     reports `PLANNING_EMPTY`), but the ledger copy claims a continuation.
   - `src/runtime/EngineeringRuntime.ts:1742-1743`, the comment above the `planMission` call, reads
     `a malformed plan falls back to the single task and never blocks` — the claim T03 was told to
     retire in `missionPlanner.ts:5`, now false in the runtime's prose too.
   Required follow-up (2 lines + 1 comment, in the runtime's own contract):
   `summary: "Mission planner output unusable; the envelope-clamped fallback was used."` /
   `recommended_action: "Read the evidence: it names what the envelope clamped; if it says mission blocked, no safe write domain remained."`
   and a comment that says the fallback is clamped and blocks when nothing survives.
3. **Full unit suite not run, per the handoff** ("Do NOT run the full unit suite (baselined red,
   ~25 min here)"). I started it before re-reading that clause and stopped it; the failures it had
   already printed were in git/broker/recovery files, and no test outside the three listed in §5.1
   references `planMission`, so none of them can be caused by this change. No claim is made about
   the suite's overall state.
4. **Type narrowing in a shared function.** `scopeTaskDomains`'s parameter type changed to
   `Pick<TaskContract, "scope">` (behaviour identical, tests green). This is the minimum change that
   lets the fallback reuse the same authority without inventing a fake `TaskContract`.
5. **Block gate is `kept.length === 0`** rather than also requiring `base.mutates_repo` — see §2.
   Consequence: a caller that declares `mutates: true` while `single()` says
   `mutates_repo: false` with no domains now blocks instead of returning an unclamped-empty task.
6. `node_modules` is a symlink to the primary checkout's (`AGENTS.md` "One agent, one worktree"); no
   `npm install` was run. `git worktree list` is unchanged apart from the temporary base worktree I
   created and removed for the regression check in §4.

## 6. Remaining risks

- The block has no typed marker: `tasks: []` + `fallbackReason` only. `SupervisorHealth` already has
  `PLANNING_EMPTY`, and its reason tells the operator to "confirm or restate" the goal, which is the
  wrong verb for an envelope block (the fix is the manifest). A typed `blocked` (or a distinct
  supervisor reason) is a follow-up outside this scope; note the clarification finding is *not*
  recorded for a block, so `PLANNING_EMPTY` arrives without a planner question.
- Reusing `scopeTaskDomains` couples the two paths on purpose: a future relaxation there widens both
  the contract path and the fallback path.
- Fallback acceptance prefers `input.acceptanceIds` over `single()`'s `acceptance_ids`; a caller
  setting both differently gets the mission's ids.
- A malformed plan still cannot widen anything — proven by `write_domains` deep-equal
  `["src/**"]` plus the `/passwd` assertion on every fallback case — but nothing yet proves the
  *success* path cannot exceed the envelope beyond `scopeTaskDomains` itself.

## 8. Exact production diff

```diff
diff --git a/src/orchestration/missionPlanner.ts b/src/orchestration/missionPlanner.ts
index 17d048fc..47c2e9ba 100644
--- a/src/orchestration/missionPlanner.ts
+++ b/src/orchestration/missionPlanner.ts
@@ -2,7 +2,7 @@
  * Mission planner (spec 06 + planner-worker contract): turns a non-trivial goal
  * into a bounded task DAG with real write domains by reusing the planner-worker
  * PLANNER_PROMPT and tolerant parser. Trivial or unparsable plans fall back to
- * the single-task path; a malformed plan never blocks a mission.
+ * the single-task path clamped to the manifest envelope; with no safe domain it blocks.
  */
 
 import { DIRECTORY_DENY, extractStructured, parsePlannerOutput, scopeConflict } from "../plannerWorker/contract.ts";
@@ -34,7 +34,7 @@ export function isNonTrivialGoal(goal: string): boolean {
 
 export interface MissionPlanResult {
   tasks: PlanTaskInput[];
-  /** Why the single-task fallback was used for a planner that was attempted. */
+  /** Why the single-task fallback was used, or (with no tasks) why the mission is blocked. Always visible. */
   fallbackReason?: string;
   /**
    * The planner explicitly reported the goal as ambiguous (blocked, with a
@@ -117,7 +117,7 @@ const under = (path: string, root: string): boolean => root === "" || path === r
  * writable domains. Returns the kept domains and what was rejected.
  */
 export function scopeTaskDomains(
-  c: TaskContract,
+  c: Pick<TaskContract, "scope">,
   opts: { writableDomains?: string[]; readOnlyPrefixes?: string[] },
 ): { kept: string[]; rejected: string[] } {
   const rejected: string[] = [];
@@ -212,10 +212,27 @@ function toTasks(contracts: TaskContract[], acceptanceIds: string[], domains: Ma
   }));
 }
 
+/**
+ * The fallback for EVERY planner failure: `single()` with write domains clamped by
+ * `scopeTaskDomains`'s own rules (planner text is never consulted), carrying the mission's
+ * acceptance and `single()`'s budget, each removal named in the visible reason. Reachable only
+ * for a mutating mission, so a task with no surviving writable domain is BLOCKED: no tasks.
+ */
+function clampedFallback(input: MissionPlanInput, reason: string): MissionPlanResult {
+  const base = input.single();
+  // One reuse of `scopeTaskDomains`, which reads only `scope`, so the clamp is the same.
+  const { kept, rejected } = scopeTaskDomains({ scope: { allowed: [...base.write_domains], forbidden: [] } }, input);
+  const why = rejected.length > 0 ? `${reason}; clamped write_domains: ${rejected.join(", ")}` : reason;
+  const acceptance_ids = input.acceptanceIds.length > 0 ? [...input.acceptanceIds] : [...(base.acceptance_ids ?? [])];
+  if (kept.length === 0)
+    return { tasks: [], fallbackReason: `${why}; mission blocked: no writable domain survives the envelope` };
+  return { tasks: [{ ...base, write_domains: kept, acceptance_ids }], fallbackReason: why };
+}
+
 export async function planMission(input: MissionPlanInput): Promise<MissionPlanResult> {
   const attempt = input.mode === "on" || (input.mode === "auto" && isNonTrivialGoal(input.goal));
   if (!attempt || !input.mutates) return { tasks: [input.single()] };
-  const fallback = (reason: string): MissionPlanResult => ({ tasks: [input.single()], fallbackReason: reason });
+  const fallback = (reason: string): MissionPlanResult => clampedFallback(input, reason);
   let output: PlannerRunOutput = "";
   for (let attemptNo = 0; ; attemptNo++) {
     try {
```
