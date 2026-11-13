# T07 — Detect deterministic goal deviation signals

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T07/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T06/T06.handoff.json (sha256:6c054bfd3b5d45d4428316890ebba438e435f37d5aa54c1c6522bb100670b905, status PASS, resultSha 1fdccb18f986a1e4a7b09ce72f53a3f5c3acf58f = your base).
Base commit: 1fdccb18f986a1e4a7b09ce72f53a3f5c3acf58f. Mode: isolated-change.

## Objective (plan delta, verbatim)
Flag out-of-scope writes, unrelated new dependencies, unexpected task expansion, and acceptance criterion stagnation. Report evidence not invented numeric certainty.
Evidence: Fixture flags irrelevant refactor; allows legitimate read-only investigation.

## Scope (hard limits)
- Exactly 2 files: the NEW `src/aps/taskAlignment.ts` (production ≤ 2) and the NEW `test/unit/aps-task-alignment.test.ts` (tests ≤ 2). Total changed lines vs base ≤ 100.
- Denied: every existing file — notably `src/aps/types.ts` (T06 just landed; import from it), `src/aps/{observability,workerActivity,progress,supervisor,fingerprint,index}.ts`, `src/plannerWorker/contract.ts` (import `matchesGlob`, do not edit), `src/bootstrap/**`, `src/orchestration/**`, `src/runtime/**`, `scripts/**`, `package.json`, `.gitignore`, `test/support/**`, `manifests/**`, `templates/**`. Read them; change none.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands and report their exit codes.

## What to build (pure module, no fs, no network, no clock, no RNG)
`evaluateTaskAlignment(input: TaskAlignmentInput): AlignmentSignal[]` plus its exported types. Deterministic: identical input → identical output, ordered by `kind`, then `subject`, then first-observation iteration; duplicates collapsed.

`TaskAlignmentInput` (all read from data the harness already has; nothing inferred from prose):
- `allowedScope: readonly string[]` — the contract's allowed write globs (or the manifest's writable domains).
- `declaredTasks: readonly string[]` — task ids the plan declared for this run.
- `allowedDependencies: readonly string[]` — dependency names the task may add (empty means none are authorized).
- `actions: readonly TaskAction[]` where `TaskAction = { iteration: number; tool: string; target?: string; taskId?: string; mutating: boolean; newDependency?: string }` — accept it structurally so APS `AgentAction`s can be mapped in by the caller (do not import the APS event constructors to *build* them; `isMutatingTool` from `./types.ts` may be used to decide `mutating` when the caller leaves it undefined).
- `acceptance?: { criteria: readonly string[]; progressedAtIteration: Record<string, number> }` — last iteration each criterion was seen passing/advancing.
- `stagnationIterations?: number` — how many iterations without any acceptance progress count as stagnation (default 10; must be a positive finite integer, otherwise fall back to the default rather than throwing).

Signals — `kind` one of `"out_of_scope_write" | "unrelated_dependency" | "task_expansion" | "acceptance_stagnation"`, each `{ kind, subject, iteration, evidence: string, taskId?: string }`:
1. `out_of_scope_write`: a **mutating** action whose `target` does not match any `allowedScope` glob (use `matchesGlob(target, glob)` from `src/plannerWorker/contract.ts:298`; a target equal to a literal allowed path, or under an allowed `dir/**`, is in scope). Evidence names the target and lists the allowed globs it was checked against. **A non-mutating action outside scope is never flagged** — read-only investigation of unrelated files is legitimate and must stay silent (that is the plan's second half of the evidence).
2. `unrelated_dependency`: a `newDependency` not present in `allowedDependencies` (case-insensitive compare, trimmed). Evidence names the dependency and the iteration.
3. `task_expansion`: a `taskId` on an action that is not in `declaredTasks`. Evidence names the unexpected task id.
4. `acceptance_stagnation`: when `acceptance` is provided, there is at least one criterion, and the highest `progressedAtIteration` across all criteria is at least `stagnationIterations` behind the maximum action iteration observed, flag once (subject = the criteria that never advanced, joined and sorted) with evidence giving the last-progress iteration, the observed iteration and the threshold — counts and iterations only.
5. **No invented certainty**: no scores, no percentages, no confidences anywhere in the output or in code comments. Evidence strings state observable facts only.
6. Missing/empty inputs are inert: no actions → no signals; empty `allowedScope` means nothing is authorized, so *any* mutating target is out of scope (say so in evidence); an action without a `target` cannot be judged for scope and is skipped silently.

## Tests (new test/unit/aps-task-alignment.test.ts)
Table-driven, no fs beyond `test/support/isolatedState.ts`. Must include the plan's named fixture pair: (a) an "irrelevant refactor" run — declared scope `src/reader/**`, actions that `write`/`edit` `src/ui/theme.ts` and `docs/roadmap.md`, add dependency `left-pad`, and carry `taskId: "T99"` while only `T07` was declared — asserting all four signal kinds appear with evidence naming the offending subject, and the output is sorted/deduplicated; (b) a legitimate read-only investigation — the same unrelated files touched with `read`/`grep`/`repo_search` (`mutating: false`) and no dependency or task-id change — asserting **zero** signals. Also: in-scope mutating writes produce none; a non-mutating `write`-named tool is judged by its `mutating` flag (caller override wins); `allowedDependencies: ["zod"]` accepts `Zod ` and flags `left-pad`; empty `allowedScope` flags any mutating target; a stale `progressedAtIteration` beyond the threshold flags stagnation exactly once and a fresh one does not; a non-positive/NaN `stagnationIterations` falls back to 10; identical input twice returns identical output.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/aps-task-alignment.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 1fdccb18f986a1e4a7b09ce72f53a3f5c3acf58f HEAD`, each command with exit code, and any deviation or BLOCKED clause. Commit only the two files as `feat(aps): deterministic task-alignment deviation signals (T07)`.
