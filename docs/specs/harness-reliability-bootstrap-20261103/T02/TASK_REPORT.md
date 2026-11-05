# T02 — Fail closed on dropped deny patterns — conductor report

Task authority: sha256:060a5ae6e5d4ad859ce55297a0af86a84573b46655f980420f7fbcf669f07823
Plan delta: For authorization-origin deny constraints, reject contradictions rather than discard; preserve existing parser behavior for planner-origin notes only where safe and explicitly reviewed. Evidence: regression — broad grant + restricted subtree does not weaken deny. (production 2 / tests 2 / ≤100 lines / verify: typecheck; node --test test/unit/planner-worker-contract.test.ts)
Worker panes: **t02 (claude-opus-5) died at start** — `Error: No API key found for anthropic` on this host (same class as the earlier openai-codex revocation and the qwen3.7-max-next 404), no diff produced; pane closed and the unit re-run as **t02b (pane w8:pA, metabolomics/qwen3.8-flash_next)** on base 145549b5.
Result: 95aba353f1876f8d617143556ec753709b718e34 (amended once, see review) — parent 145549b5061f; 44 + 4 deleted in `src/plannerWorker/contract.ts` and 52 added in `test/unit/planner-worker-contract.test.ts` = **100 changed lines** (exactly the cap; production 1 ≤ 2, tests 1 ≤ 2).

## What the unit provides
Authorization-origin denies arrive on two host channels — `scope.forbidden_authorization` and `authorization.denied` — and are **never discarded**: if an allowed grant lies wholly inside one (`grantInsideDeny`), the contract is rejected with `scope.allowed "<grant>" is inside authorization deny "<deny>": nothing writable`; otherwise the deny narrows the grant, is kept in `scope.forbidden`, and is tagged in `scope.forbiddenAuthorization` so later enforcement can tell origins apart. A planner note cannot remove, narrow or outrank one (omitting it, restating it or granting inside it all end with the deny enforced or the contract rejected). `scope.forbidden` (planner-origin) keeps its base keep/discard semantics and `ignored_forbidden` reporting — the explicitly reviewed part: a planner note can only narrow its own contract, never the operator's policy, so discarding a self-contradicting note cannot weaken an authorization deny. The authorization channels now require an array of non-empty strings and refuse otherwise with the offending index.

## Conductor verification (logs/T02/, all against the unit commit)
- `01`, `07-typecheck-after.txt` — exit 0.
- `02`, `08-unit-planner-contract-after.txt` — the task's own verify command: 17/17 pass 0 fail (all 14 base cases still green plus the T02 regressions, including the plan's named one).
- `03`, `09-unit-neighbours-after.txt` — `planner-worker-routing-constraints.test.ts` + `bootstrap-path-policy.test.ts`: 31/31 pass 0 fail.
- `04`, `05`, `06` — conductor probes: broad grant `src/**` + auth deny `src/secret/**` accepted with the deny kept and tagged; explicit re-grant `src/secret/app.ts` inside it rejected naming both; directory deny swallowing a literal grant rejected; `authorization.denied` channel works and de-dupes; planner-origin discard behaviour unchanged; omitting/restating the auth deny keeps it enforced; malformed globs refused. Probe 06 exposed the fail-open path (below).
- `10-conductor-deny-after.txt` — after the fix: `denied:[42]`, `[true]`, `['src/secret/**',7]` → refused with `authorization.denied[N] must be a non-empty string`; bare string → `must be an array of strings`; `['src/secret/**']` accepted and tagged; named regression still holds; planner-origin coercion (`42` → `"42"` inside the planner's own `forbidden`) unchanged as required.

## Review finding and correction (conductor-initiated)
First commit `d38a3d79` (84 lines) routed the authorization channels through the existing lenient `stringList`, which coerces numbers and booleans: `authorization.denied: [42]` produced an *invented* deny pattern `"42"`, `[true]` produced `"true"`, and `['src/secret/**',7]` produced two denies — a host-side channel manufacturing constraints from junk, the same fail-open class this unit exists to close. The worker was told to require an array of non-empty strings per channel with an index-naming refusal, leave planner leniency alone, add the test and stay within budget; it amended to `95aba353` at exactly 100 lines and probe 10 confirms the behaviour.

## Integration
`git merge --ff-only feat/t02-deny-origin` → HEAD `95aba353`; `git show --stat HEAD` lists exactly the two files, 96 insertions / 4 deletions. Handoff `T02/T02.handoff.json` (sha256:cbd2fae48b886e8d68d0400ab85a25e506962c1ab0ccbcbeb9cc9b4c54eb2ed2) recomputes and validates against `templates/handoff.schema.json`; next task T03@95aba353.

## Residual risk / observations carried forward
- Nothing enforces `scope.forbiddenAuthorization` yet: `createPathPolicy` (B01) does not read it, so the guarantee is parser-level until a later unit wires the contract scope into the policy — the plan assigns scope enforcement to T04; **carry this as an explicit requirement there**.
- `forbiddenAuthorization` preserves arrival order rather than canonicalizing, so two contracts with the same deny set in different order serialize differently; harmless for matching, relevant if a hash ever covers the parsed scope.
- The parser cap is now exactly at the 100-line budget for this task family; a follow-up touching `contract.ts` will need its own budget.
