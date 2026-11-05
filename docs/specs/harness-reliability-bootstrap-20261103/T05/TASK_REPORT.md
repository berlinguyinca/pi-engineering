# T05 — Surface required context omissions — conductor report

Task authority: sha256:0fe80af1840d6bd6b3a455f6d880bb5fb53372ec65f13fb4dd48d5fe3872f352
Plan delta: Return explicit unavailable/truncated required-context diagnostics; fail worker launch when indispensable evidence is missing unless policy explicitly allows blocked investigation. Evidence: missing required file cannot be silently treated as complete context. (production 1 / tests 1 / ≤100 lines / verify: typecheck; node --test test/unit/context-required-omission.test.ts)
Worker pane: t05 (pane w8:pD, metabolomics/qwen3.8-flash_next), base 5b1ab0a4 (~18 min).
Result: 75a15f0bce7b3f21ccae8a04d1525283eaf7fec7 — parent 5b1ab0a46515; 45 + 5 deleted in `src/context/ContextBroker.ts` and 49 added in the new `test/unit/context-required-omission.test.ts` = **99 changed lines** (within budget; production 1 ≤ 2, tests 1 ≤ 2).

## What the unit provides
`ContextPackage` gained an optional `omissions: RequiredContextOmission[]` and `assembleContext` now fills it: an unreadable required path (the old `if (text === null) continue;` that hid the hole) records `{ path, kind: "unavailable", reason }`, and a budget-truncated required file records `{ path, kind: "truncated", reason, requestedTokens, providedTokens }` beside the unchanged per-item `truncated: true`. A package that delivered everything reports no `omissions` field at all, keeping the old shape for existing consumers. The exported pure gate `requiredContextGate(pkg, policy)` is the launch contract: by default any `unavailable` evidence yields `canLaunch: false` with `indispensable evidence is missing (paths: …)`; `allowBlockedInvestigation: true` launches and still returns the reason for the caller to surface; truncation alone never blocks. Budgets are untouched (`targetTokens` accounting, `readSlice(rel, 0, 300)` for required files, keyword/rank/search/repoMap caps, non-required handling, `sources`, `totalTokens`).

## Conductor verification (logs/T05/, all against the unit commit)
- `01-typecheck.txt` — exit 0.
- `02-unit-required-omission.txt` — the task's own verify command: 2/2 pass 0 fail (unavailable reported + launch blocked by default; truncation reports counts without blocking; whole delivery reports nothing).
- `03-unit-context-neighbour.txt` — pre-existing `test/unit/context.test.ts` (the other `assembleContext` caller, including its truncation and budget tests): 10/10 pass 0 fail.
- `04-conductor-gate-probe.txt` — independent probe of the gate: default policy denies naming `src/reader.ts`; `allowBlockedInvestigation: true` launches with the same reason; `allowBlockedInvestigation: false` denies; truncated-only and omission-free packages launch with no reason; a mixed package denies naming only `b.ts, c.ts`.

## Integration
`git merge --ff-only feat/t05-context-omission` → HEAD `75a15f0b`; `git show --stat HEAD` lists exactly the two files, 94 insertions / 5 deletions. Handoff `T05/T05.handoff.json` (sha256:3af76be362edfe86b710d934ec9a484bf00e25fa914bda8449ef46ec93f58709) recomputes and validates; next task T06@75a15f0b.

## Residual risk / observations carried forward
- **The gate is not yet wired** (required by the deny-list, not by the worker's choice): the only production caller, `src/runtime/EngineeringRuntime.ts:4283`, assembles the package and launches the worker without consulting `requiredContextGate`, so today the omission is *visible but not blocking*. The delta's "fail worker launch" clause becomes real only when a later unit with authority over `src/runtime/**` calls the gate; carry this forward explicitly (T09's scope-integrity gate is the natural host, or a dedicated runtime unit).
- Truncation never blocks by design here; a caller wanting strict completeness must add a policy knob (deliberately not invented in this unit).
- `omissions` is optional rather than an always-present empty array, so consumers must use `pkg.omissions ?? []` (the gate does); a consumer that assumes presence would crash on the common path.
