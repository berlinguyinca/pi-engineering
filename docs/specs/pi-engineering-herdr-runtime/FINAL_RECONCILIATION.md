# Final Reconciliation — Herdr Runtime Migration

Branch `feat/herdr-runtime-recon`. Companion docs: `IMPLEMENTATION_RECONCILIATION.md`
(requirement matrix), `HERDR_COMPATIBILITY.md` (live 0.9.1 spike), `IMPLEMENTATION_LOG.md`
(commands + results). This is a **staged migration, not a rewrite**: existing
orchestration, workers, artifacts, GitRepo, capability discovery, and Pi-Web
were reused, not duplicated.

## Implemented (this PR)

| Deliverable | Where |
|---|---|
| Runtime-neutral `AgentRuntime` seam (opaque ids, normalized `AgentStatus`, artifact-first `AgentWorkerResult`, `ContextPolicy`) | `src/runtime/AgentRuntime.ts` |
| Legacy adapter (current runtime behind the seam, no behavior change) | `src/runtime/LegacyAgentRuntime.ts` |
| `createAgentRuntime` selector + capability/version negotiation | `src/runtime/index.ts` |
| Herdr CLI client (thin consumer; not a fork) + `HerdrError` | `src/runtime/herdr/HerdrCli.ts` |
| `HerdrAgentRuntime` (create/start/sendTask=get prompt, waitFor=agent.wait, boundedOutput=agent.read, interrupt=send_keys, terminate=pane close, resumeOrReconcile, attach, health) | `src/runtime/herdr/HerdrAgentRuntime.ts` |
| Shared contract tests run against BOTH runtimes | `test/unit/agentruntime-contract.ts` + `agentruntime.test.ts` + `herdr-runtime.test.ts` |
| **Architectural 413 prevention** (discover context window from metadata, budget tokens+serialized bytes, materialize → summarize → split/fan-out → preflight reject) | `src/request/RequestPlanner.ts` |
| 413 regression tests | `test/unit/request-planner.test.ts` |
| Runtime-neutral canary (Planner → EngA/B → Tester → Reviewer) | `test/integration/runtime-canary.test.ts` |

## Reused existing (no duplicate subsystem created)

- `WorkerExecutor` / `FakeWorkerExecutor` / `PiWorkerExecutor` — wrapped, not replaced.
- `GitRepo` worktrees, `ArtifactStore`, `ContextBroker` + `context/capability.ts`
  (context-window discovery; 128K conservative floor, **no fixed 260K**).
- InferWeave admission / gateway / `ModelRouter`, `EventStore`/`Ledger`,
  OpenViking (`blackhole/`), Pi-Web `ControlPlane`, `SecurityPolicy`, `RemoteWorker`.

## External dependency

- **Herdr 0.9.1** (installed, server running, protocol 22) — accessed only through
  `HerdrAgentRuntime` → `HerdrCli`. Never forked/reimplemented.
- **Pi-Web** — untouched (external operator UI).
- **Pi Forge** — excluded entirely; not installed/integrated/evaluated.

## Deprecated / removed

- Nothing deleted. The legacy runtime is retained as the default and the rollback
  target until parity/recovery/canary/rollback gates pass.

## Deferred / externally blocked (honest status)

- **Phase G live canary**: real InferWeave model selection + real Herdr
  provisioning (needs pane/workspace creation first — see `HERDR_COMPATIBILITY.md`
  finding FINDING-hN7K73) — **EXTERNALLY BLOCKED**; not faked.
- **Phase H migration state machine + rollback drill**: deferred until the live
  canary passes; legacy remains default.
- Herdr is selectable behind `runtime:"herdr"` + negotiation but is **not** the default.

## Tests / evidence

```
npx tsc --noEmit                       # EXIT 0
npx biome check src ... test/...       # clean
test/unit/agentruntime.test.ts         # 6/6  (legacy contract)
test/unit/herdr-runtime.test.ts        # 6/6  (herdr contract + negotiation)
test/unit/request-planner.test.ts      # 7/7  (413 regression)
test/integration/runtime-canary.test.ts # 2/2
full suite (excl pre-existing flaky CAV browser tests) # 1496 pass / 0 fail
live smoke: RealHerdrCli against running server       # status/agent.list/health OK
```

## 413 regression — proved architecturally

Reproduced the failure signature (16 design specs × 40 KB inlined ≈ 640 KB body).
`planRequest` transforms BEFORE submission: `mode: materialize`, `artifactRefs`=16,
planned body `<= byteBudget`. Also covered: 3 MB single reference → materialize;
1 MB objective → `reject` (`request_too_large`); 200 refs → `split` fan-out;
context window discovered from metadata (never 260K).

## Canary results

Runtime-neutral canary passes (2/2): Planner → Engineer A/B (isolated ids,
artifact refs) → Tester (synthesis) → Reviewer, with bounded output. Live canary
is externally blocked (above).

## Rollback results

**Not yet demonstrated.** Legacy runtime remains the default rollback target; a
rollback drill is deferred until the live canary passes.

## Remaining risks / next steps

1. Wire real Herdr provisioning: create a pane/worktree-backed workspace, then
   `agent start` in a real pane (Phase E integration) — resolves FINDING-hN7K73.
2. Run the live canary against a configured InferWeave endpoint.
3. Implement the migration state machine and demonstrate rollback (Phase H).
4. Surface normalized Herdr events/worker states to Pi-Web (spec 08/09) once the
   live path is green.
