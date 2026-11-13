# T02 — Fail closed on dropped deny patterns

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T02/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T01/T01.handoff.json (sha256:a8018b3dc9120df8ce1eaab8ad4efe806cd57e1c37b0aeea6dc06ca1719657c0, status PASS, resultSha 145549b5061f6b56b8c99645837e8361cd5b9be4 = your base).
Base commit: 145549b5061f6b56b8c99645837e8361cd5b9be4. Mode: isolated-change.

## Objective (plan delta, verbatim)
For authorization-origin deny constraints, reject contradictions rather than discard; preserve existing parser behavior for planner-origin notes only where safe and explicitly reviewed.

## Scope (hard limits)
- Exactly 2 files: `src/plannerWorker/contract.ts` (production ≤ 2) and `test/unit/planner-worker-contract.test.ts` (tests ≤ 2). Total changed lines vs base (added + deleted) ≤ 100 — the test file is already 211 lines and green (14/14), so add cases surgically; the parser is 343 lines, so change only the deny block and the smallest surface needed.
- Denied: every file under `src/bootstrap/**`, `scripts/**`, `package.json`, `.gitignore`, `test/support/**`, `docs/specs/harness-reliability-bootstrap-20261103/manifests/**`, `templates/**`, and any other planner file. Touch nothing else.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus `test/unit/planner-worker-routing-constraints.test.ts` and `test/unit/path-policy*.test.ts` (discover the exact path-policy file names with `ls test/unit | grep -i path`) and report their exit codes.

## Current behaviour you are changing (contract.ts:107-115)
`const keepsDeny = (deny) => DIRECTORY_DENY.test(deny) || !allowed.some((grant) => matchesGlob(grant, deny));` — a wildcard deny that matches the contract's own allowed scope is **discarded** into `ignored_forbidden`; directory denies are kept. That discard is the hole: for a deny the **authorization** (operator/task policy) issued, discarding weakens the deny to whatever the model happened to grant.

## Required behaviour
1. Distinguish origin. Planner-origin denies stay where they are: `raw.scope.forbidden`, existing keep/discard semantics unchanged, still reported in `ignored_forbidden` (that is the "explicitly reviewed" part — record in your report why it is safe for planner notes: a planner note can only narrow its own contract, never the operator's policy).
2. Add an authorization-origin channel: accept `raw.scope.forbidden_authorization` and/or `raw.authorization.denied` (either shape is fine, document which). These come from the host/operator, not from model text.
3. Authorization-origin denies are **never discarded**. For each such deny, after the existing glob validation (reuse `scopeGlobError(glob, { deny: true })`):
   - If some allowed grant is wholly inside the deny — the grant is a literal path the deny matches, or the grant's `staticPrefix` lies inside the deny's static prefix — the contract **rejects**: push a stable error naming the deny, the grant and why nothing writable remains. Reject, do not drop.
   - Otherwise the deny narrows the grant: keep it, and it must survive into the parsed contract so later enforcement can see it (union with planner-origin denies, de-duplicated, plus a way to tell the origins apart later, e.g. `scope.forbiddenAuthorization`).
4. A planner note cannot remove, narrow or outrank an authorization deny: omitting it, restating it, or granting inside it all end with the deny still enforced (grant-inside-deny is the rejection case).
5. Preserve every other parser behaviour: ids, reserved ids, objective limits, depends_on rules, acceptance/verification/constraints, execution block, `parsePlannerOutput` wiring, exported types. Add the new field to the exported `TaskContract` type only if needed for (3).
6. Pure and deterministic; no fs, no network, no clock.

## Tests (extend test/unit/planner-worker-contract.test.ts; keep all 14 existing cases passing)
The plan's named regression first: **broad grant + restricted subtree does not weaken deny** — allowed `src/**` with authorization deny `src/secret/**` keeps the deny enforced, and an explicit allowed `src/secret/**` alongside that deny is rejected rather than silently dropping the deny. Also: a directory deny that swallows a literal grant is rejected with a reason naming both; a narrowing wildcard deny is kept and reported with its authorization origin; planner-origin wildcard-vs-grant discard behaves exactly as at base (assert `ignored_forbidden` unchanged); a planner omitting an authorization deny does not remove it; malformed authorization globs are refused.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-contract.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 145549b5061f6b56b8c99645837e8361cd5b9be4 HEAD`, each command with exit code, the exact origin channel you chose, the paragraph justifying unchanged planner-origin behaviour, and any deviation or BLOCKED clause. Commit only the two files as `feat(planner): reject contradicted authorization denies instead of discarding (T02)`.
