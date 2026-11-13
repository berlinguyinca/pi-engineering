# T05 — Surface required-context omissions

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/T05/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/T04/T04.handoff.json (sha256:a72b9d8d49b4978c9c1af0df652c0c176ca5f2800f83f8b04229db769c95d9e3, status PASS, resultSha 5b1ab0a465152673ac0bf29ab0956f8750c6fab1 = your base).
Base commit: 5b1ab0a465152673ac0bf29ab0956f8750c6fab1. Mode: isolated-change.

## Objective (plan delta, verbatim)
Return explicit unavailable/truncated required-context diagnostics; fail worker launch when indispensable evidence is missing unless policy explicitly allows blocked investigation.
Evidence: missing required file cannot be silently treated as complete context.

## Scope (hard limits)
- Exactly 2 files: `src/context/ContextBroker.ts` (production ≤ 2) and the NEW `test/unit/context-required-omission.test.ts` (tests ≤ 2). Total changed lines vs base ≤ 100.
- Denied: everything except those two files — notably `src/runtime/**` (the only production caller, `EngineeringRuntime.ts:4283`), `test/unit/context.test.ts` (pre-existing coverage you must keep green), `test/support/**`, `src/bootstrap/**`, `src/orchestration/**`, `src/plannerWorker/**`, `scripts/**`, `package.json`, `.gitignore`, `manifests/**`, `templates/**`. Read them; change none.
- Do NOT run the full unit suite (baselined red, ~25 min here). Run only the two verify commands plus `test/unit/context.test.ts` and report its exit code.

## Current behaviour (ContextBroker.ts:263-300)
`assembleContext(goal, targetTokens, required)` puts required files first: `const text = await this.readSlice(rel, 0, 300); if (text === null) continue;` — a **missing or unreadable required file is dropped in silence**, and the returned `ContextPackage` `{ id, goal, targetTokens, items, totalTokens, sources }` carries no trace of it. A required file whose slice exceeds the remaining budget is truncated into an item flagged `truncated: true`, but nothing at package level says the required context arrived only partially.

## Required behaviour
1. Add an optional `omissions` field to `ContextPackage` (export a `RequiredContextOmission` type): one entry per indispensable file the package could not deliver whole, each naming the path and the reason — at minimum `{ path: string; kind: "unavailable" | "truncated"; reason: string }`, and for `truncated` include the token counts (`requestedTokens`, `providedTokens`) so a reader can see the size of the hole. A missing/unreadable required path (the `readSlice` null case) records `unavailable` with a reason that says the file could not be read from the repository; the existing `continue` that hides it goes away. Truncated required files keep their `truncated: true` item **and** gain the package-level entry. A required file delivered whole records nothing, and a package with nothing missing reports no `omissions` (do not invent an empty array where the old shape had none — keep the field optional so `context.test.ts`'s shape assertions stay valid).
2. Export a pure, deterministic launch gate — e.g. `requiredContextGate(pkg: ContextPackage, policy: { allowBlockedInvestigation?: boolean }): { canLaunch: boolean; reason?: string }` — that a worker-launch path can call: with the default policy (`allowBlockedInvestigation` absent or false) any `unavailable` omission yields `canLaunch: false` and a reason naming the missing paths (indispensable evidence is missing); with the policy explicitly true the launch is allowed and the reason is still returned so the caller can surface it. A `truncated` omission alone never blocks by default — the required-context guarantee still holds partially, and blocking on truncation would change behaviour the plan does not ask for. Do **not** touch `EngineeringRuntime.ts` (deny-listed): the gate is the contract the launch path will consume, and your report must state where you expect it to be called (`src/runtime/EngineeringRuntime.ts` around line 4283) and that wiring it is a later unit's job.
3. Budgets and all other behaviour stay exactly as they are: `targetTokens` accounting, `readSlice(rel, 0, 300)` for required files, `goalKeywords` limits, `rankFiles`/`searchAny`/`repoMap` caps, non-required item handling, `sources`, `totalTokens`. No new file reads, no new searches, no larger slices. Pure and deterministic.
4. Update the comment block above the required-file loop (it currently promises the required-context guarantee holds "even for large files" while saying nothing about unreadable ones) so it describes the reporting and the gate.

## Tests (new test/unit/context-required-omission.test.ts)
Follow how `test/unit/context.test.ts` builds a broker over fixture files, and keep it small. Assert: a required path that does not exist produces exactly one `unavailable` omission naming that path and no item for it, and `requiredContextGate` refuses launch with a reason naming it; the same package launches when `allowBlockedInvestigation: true`, with the reason still present; a required file truncated by a tight `targetTokens` produces a `truncated` omission with token counts, keeps the `truncated: true` item, and does **not** block by default; all-required-delivered produces no `omissions` at all; an empty `required` list produces none. Keep `test/unit/context.test.ts` green.

## Verify (must be green at the commit you produce)
- `npm run typecheck`
- `node --test --import ./test/support/isolatedState.ts test/unit/context-required-omission.test.ts`

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat 5b1ab0a465152673ac0bf29ab0956f8750c6fab1 HEAD`, each command with exit code, the exact `RequiredContextOmission`/gate signatures you shipped, and any deviation or BLOCKED clause. Commit only the two files as `feat(context): report unavailable required context and gate launch on it (T05)`.
