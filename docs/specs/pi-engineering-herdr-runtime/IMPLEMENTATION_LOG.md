# Pi-Engineering Herdr Runtime — Implementation Log

This log records each phase's commands and results, per `IMPLEMENTATION_PROMPT.md`.

## Phase A — Reconciliation

Inspection commands (run in worktree `feat/herdr-runtime-recon`):

```
git worktree add ../pi-engineering-runtime-herdr -b feat/herdr-runtime-recon origin/main
ln -s <main>/node_modules node_modules
unzip -o ~/Downloads/pi-engineering-herdr-runtime-spec-pack-2026-09-20.zip
```

Key files inspected:
- `src/workers/WorkerExecutor.ts` — `WorkerRequest` / `WorkerRun`
- `src/core/types.ts` — `WorkerResult`, `WorkerRole`, `ROLE_BUDGETS`
- `src/artifacts/ArtifactStore.ts` — artifact-first storage, summary-only reads
- `src/git/GitRepo.ts` — worktree create/merge
- `src/orchestration/` — `types.ts`, `broker.ts`, `integrator.ts`, `orchestrator.ts`, `missionStore.ts`, `scheduler.ts`, `completionGate.ts`, `realBackends.ts`
- `src/platform/` — `types.ts`, `WorkGraph.ts`, `ControlPlane.ts`, `RemoteWorker.ts`, `RemoteHttpTransport.ts`, `ProjectRegistry.ts`, `eventstore/backend.ts`, `memoryOutbox.ts`, `redact.ts`
- `src/security/SecurityPolicy.ts`, `src/budget/BudgetManager.ts`, `src/context/` (`capability.ts`, `usage.ts`, `ContextBroker.ts`), `src/capability/`, `src/routing/ModelRouter.ts`, `src/inference/admission*.ts`, `src/lifecycle/`, `src/telemetry/`, `src/blackhole/`

Deliverable: `IMPLEMENTATION_RECONCILIATION.md` (65 requirement rows; 16 EXISTING,
22 PARTIAL, 18 MISSING, 3 CONFLICTING, 6 EXTERNAL).

## Phase B — Dependency-aware implementation DAG

The current architecture changes the naive "implement specs in numeric order"
dependency order. Reconciliation shows a large EXISTING foundation; the DAG is
built around the real dependencies:

```
 1. AgentRuntime interface + contracts          (spec 02)   ── Phase C  [foundation]
 2. LegacyAgentRuntime adapter (current runtime) (spec 02)  ── Phase C  [depends 1]
 3. Herdr/pi-herdr compatibility spike           (spec 03)  ── Phase D  [depends 1]
 4. HerdrAgentRuntime + flag/negotiation         (spec 03,14)── Phase D  [depends 3]
 5. Normalized worker state/events vocabulary    (spec 05)  ── Phase E  [depends 2,4]
 6. Rich structured WorkerResult                 (spec 06)  ── Phase E  [depends 5]
 7. Byte budget + fan-out/synthesis + 413        (spec 06)  ── Phase E  [depends 6]
 8. Worktree isolation hardening + integration   (spec 07)  ── Phase E  [depends 2]
 9. Review/repair bounds                         (spec 08)  ── Phase E  [depends 6,7]
10. InferWeave capability routing + admission    (spec 09)  ── Phase E  [depends 4,7]
11. Remote host registry + least-privilege       (spec 10)  ── Phase E  [depends 4]
12. Pi-Web normalized APIs/events/actions        (spec 11)  ── Phase E  [depends 5,7,8]
13. Observability metrics                        (spec 12)  ── Phase E  [depends 5,10]
14. Restart reconciliation + idempotency         (spec 13)  ── Phase E  [depends 5,8]
15. Spec-15 test suite + 413 regression          (spec 15)  ── Phase F  [depends 6,7,10,13,14]
16. Canary (planner→2 engineers→tester→reviewer→repair→re-review) ── Phase G [depends 15]
17. Migration/rollback state machine             (spec 14)  ── Phase H  [depends 16]
18. Final reconciliation + DoD                     (spec 16) ── Phase H  [depends all]
```

Critical dependency notes (why we do not follow numeric order blindly):
- `03-herdr-adapter` depends on `02-agent-runtime` (the interface must exist first).
- `05 state/events`, `06 WorkerResult`, `07 git`, `13 recovery` all depend on the
  AgentRuntime abstraction (2) so legacy and Herdr share one contract.
- The 413 subsystem (7) depends on the rich WorkerResult (6) and on InferWeave
  capability discovery (10) for dynamic byte/token limits — not a fixed 260k.
- Migration/rollback (14/17) is LAST because it requires parity + canary evidence.

### Phase C scope (this checkpoint)
AgentRuntime interface + LegacyAgentRuntime adapter + contract tests. Nothing
Herdr yet. Checkpointed independently before Phase D.

## Phase C — Abstraction (current runtime behind AgentRuntime)

### Delivered
- `src/runtime/AgentRuntime.ts` — runtime-neutral interface: opaque `RuntimeId`;
  operations create/start/sendTask/get/list/boundedOutput/waitFor/interrupt/
  terminate/resumeOrReconcile/attach/health/capabilities; declarative
  `AgentWorkerRequest` (role, capabilities, isolation, duration, review,
  contextPolicy, permissions); normalized `AgentStatus`; structured
  artifact-first `AgentWorkerResult`; `ContextPolicy` with discovered (not
  fixed-260k) limits.
- `src/runtime/LegacyAgentRuntime.ts` — adapter wrapping the CURRENT
  `WorkerExecutor`. Documented legacy limitation: interrupt/terminate update
  persisted status; they cannot abort an in-flight `WorkerExecutor.run` (no
  AbortSignal).
- `src/runtime/index.ts` — re-exports + `createAgentRuntime` selector behind a
  feature flag (`runtime: "herdr"` reserved for Phase D, fails safe to legacy).
- `src/index.ts` — re-exports the runtime seam.
- `test/unit/agentruntime.test.ts` — 6 contract tests that MUST pass for both
  legacy and (future) Herdr runtimes.

### Commands + results
```
npx tsc --noEmit          # EXIT 0 (clean)
npx biome check src/runtime test/unit/agentruntime.test.ts   # clean
node --test test/unit/agentruntime.test.ts   # 6 pass / 0 fail
npm test (full)           # 1490 pass / 1 fail / 1 skip
```
The 1 full-suite failure is a pre-existing FLAKY Playwright CAV screenshot test
(`test/unit/cav-visual.test.ts`, `cav-pilot.test.ts`) that fails on
"Unable to capture screenshot" under parallel load; it passes in isolation
(4/0). It does not import any runtime file and is unrelated to this change.
Excluding the two flaky CAV screenshot files: 1483 pass / 0 fail / 1 skip.

Phase C is CHECKPOINTED here, independently, before introducing Herdr (Phase D).

## Phase D — Herdr (NOT STARTED)
