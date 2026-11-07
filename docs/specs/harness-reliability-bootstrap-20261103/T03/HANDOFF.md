# T03 — Constrain malformed-plan fallback

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T03/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T02/T02.handoff.json (sha256:cbd2fae48b886e8d68d0400ab85a25e506962c1ab0ccbcbeb9cc9b4c54eb2ed2, status PASS, resultSha 95aba353f1876f8d617143556ec753709b718e34 = your base).
Base commit: 95aba353f1876f8d617143556ec753709b718e34. Mode: isolated-change.

## Objective (plan delta, verbatim)
On planner failure, carry original scope/budget/acceptance to single-task fallback or block when no safe envelope exists; emit visible fallback reason.
Evidence: malformed planner output cannot expand allowed write paths.

## Scope (hard limits)
- Exactly 2 files: `src/orchestration/missionPlanner.ts` (production ≤ 2; its comment header line 5 currently claims "a malformed plan never blocks a mission" — update that claim, it stops being true) and the NEW `test/unit/mission-planner-fallback-scope.test.ts` (tests ≤ 2). Total changed lines vs base ≤ 100.
- Denied: `src/plannerWorker/**` (T02 just landed there), everything under `src/bootstrap/**`, `scripts/**`, `src/runtime/**`, `package.json`, `.gitignore`, `test/support/**`, `test/integration/**`, `manifests/**`, `templates/**`. Read them; change none.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus `test/integration/mission-planner-contract.test.ts` and report its exit code.

## Current behaviour (missionPlanner.ts:215-266)
`fallback(reason)` returns `{ tasks: [input.single()], fallbackReason: reason }` for: transient planner failure after one retry, planner call failed, malformed plan, no contracts, and a contract with no writable domain. `input.single()` is caller-authored (`EngineeringRuntime.ts:1744` passes `{ ...single(), objective }` plus `plannerScope(workspaceManifest, repoRoot)`), and the fallback path **never clamps it against the envelope** (`writableDomains` / `readOnlyPrefixes`) and never blocks.

## Required behaviour
1. Route every one of those five fallback paths through one helper that (a) clamps `input.single()`'s `write_domains` to the envelope using the same rules `scopeTaskDomains` already applies — reject absolute paths, drive-letter paths, `..` segments, `.git` prefixes, anything under a `readOnlyPrefixes` root, and anything outside `writableDomains` when that envelope is non-empty; (b) carries the mission's original **acceptance** (`input.acceptanceIds`), **scope** (the clamped domains) and **budget** (whatever `single()` carries: `max_attempts`, `checkpoint_policy`, `failure_policy`) into the fallback task instead of dropping them, so the executor still sees the envelope it came from; (c) reports what it removed in the visible `fallbackReason` (e.g. `… ; clamped write_domains: /etc/**, ../escape`), never silently.
2. Block when no safe envelope exists: after clamping, if a mutating mission is left with zero writable domains (or the input declares `mutates: true` with no writable domain at all in `single()`), return no tasks with a visible reason that says the mission is blocked and why. Before choosing the representation, read the consumer at `src/runtime/EngineeringRuntime.ts` around the `planMission` call and any place that treats an empty `tasks` array, and state in your report why your choice cannot be read as completed work. `clarification` stays reserved for genuine planner ambiguity (its doc comment says a malformed plan never sets it) — do not reuse it for this.
3. Malformed planner output must not expand anything: the fallback task's write domains are the clamped **original** ones; the planner text (including a plan that claims `write: ["**"]` or absolute paths) is not consulted at all on the fallback path. Prove it in a test.
4. Unchanged: the non-mutating / no-planner-attempt path still returns `{ tasks: [input.single()] }` with no `fallbackReason`; the success path, `scopeTaskDomains`, `toTasks`, `plannerCandidates`, `clarification` handling and the transient-retry-once rule keep their behaviour; `MissionPlanResult` gains no required field (optional additions only, and prefer none).
5. Pure and deterministic; no fs, no network, no clock, no RNG beyond what the file already does.

## Tests (new test/unit/mission-planner-fallback-scope.test.ts)
Drive `planMission` with a fake `runPlanner` (throwing `PlannerTransientError` twice, throwing a hard error, returning malformed JSON, returning `{contracts: []}`, and returning a plan whose contracts grant `**`/absolute paths). Assert: transient path retries exactly once then falls back; every fallback carries acceptance ids, budget fields and only envelope-legal write domains, with the clamped-away globs named in `fallbackReason`; **the plan claiming `write: ["**", "/etc/**"]` cannot widen the fallback task beyond the manifest envelope**; a read-only prefix removes the matching domain and says so; a mutating mission whose only domain is read-only ends blocked with zero tasks and a visible reason that is not `clarification`; the non-mutating path is untouched. Keep `test/integration/mission-planner-contract.test.ts` green.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/mission-planner-fallback-scope.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 95aba353f1876f8d617143556ec753709b718e34 HEAD`, each command with exit code, the block representation you chose with the consumer evidence, and any deviation or BLOCKED clause. Commit only the two files as `feat(orchestration): envelope-clamped mission fallback (T03)`.
