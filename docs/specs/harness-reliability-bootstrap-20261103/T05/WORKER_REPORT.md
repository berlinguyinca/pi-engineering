# T05 — WORKER_REPORT

Task: Surface required-context omissions (`docs/specs/harness-reliability-bootstrap-20261103/T05/HANDOFF.md`).
Parent: T04 handoff `sha256:a72b9d8d49b4978c9c1af0df652c0c176ca5f2800f83f8b04229db769c95d9e3` (PASS).
Base: `5b1ab0a465152673ac0bf29ab0956f8750c6fab1`. Result commit: `75a15f0b` on `feat/t05-context-omission`.
Status: COMPLETE. No BLOCKED clause.

## Changed files (only these two are committed)

`git diff --numstat 5b1ab0a465152673ac0bf29ab0956f8750c6fab1 HEAD`

```
45	5	src/context/ContextBroker.ts
49	0	test/unit/context-required-omission.test.ts
```

94 added + 5 deleted = **99 changed lines** (≤ 100). Production files changed: 1 (`src/context/ContextBroker.ts`).
Test files changed: 1 (new). Nothing else touched: `src/runtime/**`, `test/unit/context.test.ts`,
`test/support/**`, `src/bootstrap/**`, `src/orchestration/**`, `src/plannerWorker/**`, `scripts/**`,
`package.json`, `.gitignore`, `manifests/**`, `templates/**` are all unchanged (`git diff --name-only` above
lists only the two in-scope files).

## Verification (run at commit 75a15f0b)

| Command | Exit |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit` + `tsc --noEmit -p tsconfig.scripts.json`) | **0** |
| `node --test --import ./test/support/isolatedState.ts test/unit/context-required-omission.test.ts` | **0** (2/2 pass) |
| `node --test --import ./test/support/isolatedState.ts test/unit/context.test.ts` (pre-existing coverage) | **0** (10/10 pass) |
| `npx biome check src/context/ContextBroker.ts test/unit/context-required-omission.test.ts` (extra) | 0 |

Full unit suite deliberately NOT run (baselined red per the handoff).

Environment note (not a repo change): this worktree had no `node_modules`, so it is a symlink to the primary
checkout's `node_modules` per AGENTS.md ("Symlink `node_modules` into the new worktree"). `node_modules` is
gitignored and is not part of the commit.

## Shipped signatures

```ts
export interface RequiredContextOmission {
  path: string;
  kind: "unavailable" | "truncated";
  reason: string;
  /** For `truncated`: tokens the required slice needed, and tokens actually delivered. */
  requestedTokens?: number;
  providedTokens?: number;
}

export interface ContextPackage {
  /* ...unchanged fields... */
  omissions?: RequiredContextOmission[]; // absent when nothing is missing
}

export function requiredContextGate(
  pkg: ContextPackage,
  policy: { allowBlockedInvestigation?: boolean } = {},
): { canLaunch: boolean; reason?: string };
```

Behaviour: `readSlice(rel, 0, 300) === null` for a required path now records
`{ kind: "unavailable", reason: "required file could not be read from the repository: <path>" }` (the silent
`continue` that dropped it is gone, and no item is created for it); a required file truncated into the budget
keeps its `truncated: true` item **and** gains `{ kind: "truncated", requestedTokens, providedTokens }`.
A required file delivered whole records nothing; `omissions` is spread in only when non-empty, so the old
package shape (and `context.test.ts`'s assertions) is untouched. `requiredContextGate` blocks by default on
any `unavailable` omission with a reason naming the paths, returns `{ canLaunch: true, reason }` under
`allowBlockedInvestigation: true`, and never blocks on truncation alone. Budgets, `readSlice` caps,
`goalKeywords`, `rankFiles`/`searchAny`/`repoMap` limits, non-required items, `sources`, `totalTokens` and
`renderContext` are unchanged — no new reads, searches or larger slices; the gate is pure and deterministic.
The comment block above the required-file loop now describes the reporting and the gate.

## Gate wiring (explicit, per the deny list)

`requiredContextGate` is **NOT wired into any production caller**. `src/runtime/**` is deny-listed for this
unit, so `src/runtime/EngineeringRuntime.ts` (`safeContext`, ~line 4283 — the only production caller of
`assembleContext`) still renders the package and never consults the gate. The expected future call site is
`EngineeringRuntime.safeContext` (or its caller immediately before worker dispatch): assemble → gate →
refuse/annotate the launch, and surface the returned `reason` even when
`allowBlockedInvestigation: true` permits the launch. Wiring is a later unit's job.

## Deviations / observations (no scope change)

1. `assembleContext` with `targetTokens` already exhausted (`remaining <= 0`) still drops the remaining
   required file via the existing `push()` guard, and that case records **no** omission. The handoff enumerates
   exactly two omission kinds (readSlice-null → `unavailable`, truncation → `truncated` with counts) and freezes
   "budgets and all other behaviour stay exactly as they are"; recording that third case would add an omission
   the contract does not ask for. Flagged for the next unit if the plan wants zero-delivery reported too.
2. `renderContext` is unchanged, so the rendered worker text does not yet show omissions — surfacing them is
   part of the unwired launch-path work above.
3. The new test asserts all five contract cases across two tests (missing path → exactly one `unavailable`
   omission + no item + blocked launch with reason naming it; same package launchable under
   `allowBlockedInvestigation: true` with the reason preserved; tight-budget `big.txt` → `truncated` omission
   with `requestedTokens > providedTokens`, item still `truncated: true`, `canLaunch: true`; required file
   delivered whole → `omissions === undefined`; empty `required` → `omissions === undefined`).
