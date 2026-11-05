# T01 — Persist canonical original task identity

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T01/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/D08/D08.handoff.json (sha256:a42ead207e17c03fe228d46c9ab97251fcc1d547d1e6a251d0b58caf55f2e602, status PASS, resultSha 7be362d657c5ed1de8d0a70ce56def5dcc60953f = your base).
Base commit: 7be362d657c5ed1de8d0a70ce56def5dcc60953f. Mode: isolated-change.

## Objective (plan delta, verbatim)
Canonicalize and SHA-256 hash original user goal, scope, explicit non-goals and tests separately from generated planner contracts. Source cannot be overwritten by a model.

## Scope (hard limits)
- Exactly 2 files: `src/bootstrap/taskAuthority.ts` (production ≤ 2) and `test/unit/task-authority.test.ts` (tests ≤ 2). It is a **new** file inside `src/bootstrap/`; every other file under `src/bootstrap/` (`resultGate.ts`, `diffGuard.ts`, `pathPolicy.ts`, `handoffWriter.ts`, `taskManifest.ts`), `scripts/**`, `package.json`, `.gitignore`, `test/support/**`, `manifests/**`, `templates/**` is denied — read them, do not edit them.
- Do NOT wire this into the gate: no change to `resultGate.ts`, `bootstrap-one.ts`, `taskManifest.ts` or `handoffWriter.ts`. Later units (T04, T05) consume it.
- Total changed lines vs base (added + deleted) ≤ 100.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus the neighbours named below.

## Required behaviour
1. Pure and deterministic: no fs, no network, no clock, no RNG, no mutation of inputs; identical input serializes identically.
2. Reuse the existing canonicalizer/hash: import `canonicalHash` from `./resultGate.ts` (and whatever `taskManifest.ts` exports if you need its shapes) — do not write a second canonicalization or hashing implementation. The two hashes this unit produces must be comparable in form with the hashes the gate already prints.
3. Export `deriveTaskAuthority(source)` over the **operator-authored** request only: `goal` (string), `scope`, `nonGoals`, `tests` (string arrays). Canonicalize before hashing: trim surrounding whitespace, drop empty strings, refuse non-string members, collapse duplicates keeping the first occurrence, preserve authored order (order is meaning-bearing — a scope list is a contract, not a set). Refuse (`ok: false` with stable reasons) when goal is empty after trimming, when any of the three arrays is empty after cleaning, or when a member is not a string. Never invent a placeholder.
4. Export `derivePlannerContractHash(contract)` for the **generated** planner artifact (plan text, generated task list, any model-authored restatement). It must be a separate hash over a separate canonical form — authority and planner contract for the same words must produce different digests, and the planner artifact must be recorded, not ignored.
5. Export `verifyAuthority(authority, candidate)` that recomputes authority **only** from the frozen source fields and proves a planner change cannot move it: fields arriving inside planner output (`goal`, `scope`, `nonGoals`, `tests` restated by a model) are read but never substituted into the recomputation; report which planner fields differ (`diverged`) so drift is visible, and never treat divergence as a re-authorization.
6. Refuse a source object that carries planner-authored content in place of the operator's (e.g. `origin: "planner"`), with a reason; a model must not be able to overwrite the source by supplying its own copy.

## Tests (test/unit/task-authority.test.ts)
Assert the plan's named regression first: **modifying planner output (including a planner restatement of goal/scope/nonGoals/tests that changes their content) does not change the authority hash**, while `diverged` names exactly what changed. Also: each of goal/scope/nonGoals/tests changing by one item changes the authority hash; authority ≠ planner-contract hash for identical words; duplicate/whitespace variants canonicalize to the same hash; reordering scope changes it (order is meaning-bearing); malformed inputs are refused with reasons (non-string member, empty goal, empty array after cleaning, planner-origin source); and inputs are not mutated. Run neighbours `test/unit/result-gate.test.ts` and `test/unit/task-manifest.test.ts` and report their exit codes.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/task-authority.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 7be362d657c5ed1de8d0a70ce56def5dcc60953f HEAD`, each command with exit code, and any deviation or BLOCKED clause (if a clause cannot fit 100 lines, name the clause and its cost). Commit only the two files as `feat(bootstrap): canonical original task authority (T01)`.
