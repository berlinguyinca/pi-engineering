# Pi Engineering Platform — Implementation Report

**Spec package:** `pi-engineering-implementation-spec-2026-09-15-v3`
**Target repo:** `pi-engineering-runtime` (local `pi-engineering` integration/policy harness)
**Date:** 2026-09-15/16

This report covers the implementation pass against the normative `MASTER_SPEC.md`
and `support/EXTERNAL_TOOLS_AND_OWNERSHIP.md`. Pi Forge is **OUT OF SCOPE** and
was never inspected or integrated. Pi Web is the selected external operator UI.

---

## 1. What was delivered

The specification package was copied verbatim to
`docs/specs/pi-engineering/` (master / sub-spec / support structure preserved),
and `docs/specs/pi-engineering/GAP_MATRIX.md` classifies every requirement as
EXISTING / PARTIAL / MISSING / SUPERSEDED / EXTERNAL / NOT-APPLICABLE, with the
external-tool detail required by the task.

Implementation followed `IMPLEMENTATION_ORDER.md`. The delivered pi-engineering-owned
control-plane foundation (new module `src/platform/`):

| Order step | Deliverable | Files |
|---|---|---|
| 1 — shared domain contracts | `Workspace -> Project -> Repository -> Work Item -> Run -> Task -> Worker` model; Run entity + distinct Worker entity (lifecycle, heartbeat, budgets, cancel/restart, generation) | `src/platform/types.ts` |
| 2 — durable EventStore + compat adapter | `EventStoreBackend` interface; JSONL backend (current-execution compat); adapter over the existing ledger `EventStore` | `src/platform/eventstore/*` |
| 5/9 — work graph | `WorkGraph`: run/worker lifecycle, heartbeats, idempotent restart, event-driven replay (`WorkGraph.rebuild`) | `src/platform/WorkGraph.ts` |
| 7 — Plannotator | adapter with 4 modes (`interactive`/`autonomous`/`policy`/`disabled`), persisted decision correlation, explicit autonomous-bypass audit (never fakes approval), policy-gated risk classes | `src/platform/Plannotator.ts` |
| 8 — Pi Web control plane | `ControlPlane` normalized adapter exposing projects/runs/workers/events/tests/reviews/routing/memory/interventions + `scripts/control-server.ts` HTTP server | `src/platform/ControlPlane.ts`, `scripts/control-server.ts` |
| 9 — MCP + security | project/role-scoped MCP registry (discovery ≠ permission, invocation audit, child ceiling); project auth, capability ceilings, high-risk approval gate, risk classification | `src/platform/McpRegistry.ts`, `src/platform/security.ts` |
| 12 — remote workers | one Worker contract, outbound authenticated channels, idempotent generation-keyed commands, disconnect → reconnect recovery | `src/platform/RemoteWorker.ts` |
| 4/7 — memory | durable OpenViking offline outbox with secret redaction (never silently memoryless) | `src/platform/memoryOutbox.ts` |
| 6 — review isolation | structural reviewer brief builder + isolation gate | `src/platform/review.ts` |
| 14/17 — testing | 50-worker load test, worker-crash / parent-restart (replay) recovery, reviewer isolation, outbox recovery, Plannotator decision recovery, full E2E loop test | `test/unit/platform-*.test.ts`, `test/integration/platform-*.test.ts` |
| 18 — deployment | reference Docker Compose (control API, PostgreSQL, MinIO, Prometheus/Grafana) + Dockerfile; documents where external Pi Web/Plannotator plug in | `deploy/compose/control-plane/*` |

New package scripts: `test:platform`, `platform:e2e`, `platform:serve`.

---

## 2. External integrations used

- **pi-subagents** — not installed in this environment; the in-process worker
  executors (`src/workers/`) are the fallback. Orchestration policy is
  documented as EXTERNAL/PARTIAL in the gap matrix; adopting the upstream
  package when available is listed as follow-up.
- **Pi Web** — external operator UI; the control-plane adapter (`ControlPlane`)
  and `control-server.ts` are the pi-engineering-side surface it consumes.
  No Pi Web source was scaffolded.
- **Plannotator** — external plan gate; integrated via `PlannotatorAdapter`
  (transport seam), including interactive, explicit autonomous bypass, policy
  and disabled modes. No replacement Plannotator UI/service.
- **OpenViking** — external shared durable memory; `OpenVikingProvider`
  (`src/blackhole/durable.ts`) is the existing HTTP client; the new
  `MemoryOutbox` covers offline recovery. `services/openviking` is a thin
  local dev/test HTTP endpoint (Postgres-backed), distinct from the external
  production service.
- **InferWeave** — external; `InferWeaveAdapter` seam exists. Seat/backpressure
  semantics are follow-up (see gaps).
- **AutoSpec** — external sibling; `AutoSpecAdapter` seam exists; the
  plan→Plannotator→implement→test→review→fix→complete loop is implemented
  against the platform primitives (E2E), with AutoSpec's public orchestration
  as a follow-up wiring.
- **MCP servers** — external; generic `McpRegistry` (no hard-coded domain
  servers) with project/role allowlists.

---

## 3. Requirements intentionally left external

Per `support/EXTERNAL_TOOLS_AND_OWNERSHIP.md`, pi-engineering does NOT build:

- Pi (runtime), pi-subagents (orchestration package)
- **Pi Web** frontend/backend
- **Pi Forge** (explicitly OUT OF SCOPE — not inspected)
- Plannotator UI/service
- OpenViking server / vector DB / custom shared-memory server
- InferWeave GPU scheduler / gateway / node runtime
- AutoSpec repo/engine
- MCP servers
- PostgreSQL server, Prometheus/OpenTelemetry, container runtime

No shared-Blackhole server / shared-filesystem memory design was implemented
(SUPERSEDED by this package).

---

## 4. Architecture deviations and reasons

- **In-process worker executors remain the fallback.** The spec prefers
  pi-subagents primitives. pi-subagents is not present in this environment, so
  the existing executors stay, and the platform Worker contract is built so a
  pi-subagents-backed executor can be plugged in later without changing the
  domain model.
- **JSONL EventStore as authoritative-compat seam.** The spec says PostgreSQL is
  authoritative; per order step 18 the JSONL store is preserved as the
  current-execution compatibility seam behind the new `EventStoreBackend`
  interface. A Postgres backend is follow-up.
- **Control-plane HTTP server is a minimal reference.** It serves the normalized
  snapshot for the external Pi Web; production must sit behind the
  `ProjectAuth`/capability-ceiling layer (spec 11). Documented as glue, not a
  replacement UI.
- **OpenViking offline outbox is local-first.** The outbox is pi-engineering-owned
  durable state for its own memory commits; OpenViking itself stays external.

---

## 5. Tests and results

Full suite (`npm test`): **1054 passed, 0 failed, 1 skipped** (the skip is a
pre-existing network-dependent test).
`npm run typecheck` (tsc --noEmit): clean.
`npm run lint` (biome) and `npm run format`: clean.
Package-load smoke (`smoke-installed`, `smoke-commands`): loads and registers
commands/tools.

New coverage:
- **Unit:** EventStore backends + ledger compat; ProjectRegistry (remote
  normalization, worktree-joining, multi-project); WorkGraph (run/worker
  lifecycle, heartbeat, restart generation, stale detection); Plannotator
  (all 4 modes, transport-required error, persisted correlation); ControlPlane
  snapshot shape + health; McpRegistry (discovery≠permission, allowlist,
  ceiling, audit); RemoteWorkerClient (attach/dispatch/reconnect/disconnect);
  security (project auth, ceilings, high-risk gate); outbox (redaction,
  flush, retry, durability).
- **Integration/recovery:** worker crash → recovering → restart (generation
  bump); parent/control-plane restart rebuilds run/worker graph from events;
  pending Plannotator decision survives restart; OpenViking outage uses the
  durable outbox and recovers when online; reviewer-isolation invariant.
- **E2E:** plan → Plannotator approval (interactive) / explicit autonomous
  bypass → implementation + test workers → fresh isolated review → completion
  → durable OpenViking commit via outbox.

---

## 6. 50-worker load-test results

`test/integration/platform-load-50.test.ts`:

```
# Subtest: load: 50 concurrent workers        duration_ms: 21.3
# Subtest: reconstruct all 50 from events     duration_ms: 4.5
# tests 2  # pass 2  # fail 0
```

50 workers are created and run concurrently with events + heartbeats + recall;
the persisted graph and control-plane snapshot hold all 50; all 50 are
reconstructed from events after a simulated restart. (Workers are in-memory
here; the load contract — 50 concurrent workers with events/heartbeats/recall —
is what the test proves deterministically.)

---

## 7. E2E result

`npm run platform:e2e` completes the full loop and prints a control-plane
snapshot:

```
✓ project alpha registered (github.com/acme/alpha)
✓ plan approved via external Plannotator (PLAN-APPROVED-RUN-…)
✓ implementation + test workers completed
✓ fresh independent review passed isolation gate
✓ OpenViking committed promotion (MEM-…)
✓ run completed and durable memory committed
```

`npm run platform:serve` boots the control-plane server and serves `GET /health`
and `GET /control` (verified: workspace `eng`, projects 1, events 2 on boot).

---

## 8. Artifacts

- `docs/specs/pi-engineering/` — the v3 spec package (preserved).
- `docs/specs/pi-engineering/GAP_MATRIX.md` — full requirement classification.
- `src/platform/**` — control-plane domain + adapters.
- `deploy/compose/control-plane/**` — reference Compose + Dockerfile + Prometheus.
- `scripts/control-server.ts`, `scripts/platform-e2e.ts`.
- `test/unit/platform-*.test.ts`, `test/integration/platform-*.test.ts`.

---

## 9. Unresolved external gaps

- **pi-subagents adoption** — package not installed here; orchestration policy
  and a pi-subagents-backed executor adapter remain to wire when available.
- **Postgres-backed EventStore backend** — the backend interface + JSONL compat
  exist; the Postgres implementation and migrations are follow-up.
- **InferWeave seat/backpressure** — generic gateway admission (429/503) exists;
  InferWeave-specific seat/resource semantics and 503+Retry-After handling are
  follow-up (spec 09).
- **OpenViking canonical project-session mapping + Git ingestion** — distinct
  per-parent/child OpenViking sessions tied to canonical project identity, and
  Git-ingestion/watch preference, are partial (follow-up, spec 07).
- **AutoSpec live loop + policy commit/PR** — the loop is implemented against
  platform primitives; AutoSpec public-orchestration wiring and policy-gated
  commit/PR are follow-up (spec 15).
- **Pi Web live wiring** — the adapter surface exists; pointing an actual Pi Web
  deployment at `control-server.ts` and documenting any missing upstream UI
  features is follow-up.
- **Cross-project / escape security tests** — `ProjectAuth` + capability
  ceilings are implemented and unit-tested; explicit cross-project escape
  integration tests are follow-up (spec 11/17).
- **Control-server auth** — production control API must sit behind the auth /
  capability-ceiling layer; the reference server documents this.

---

## 10. Exact follow-up work

1. Adopt pi-subagents when installed: add a `PiSubagentsWorkerExecutor` behind
   the platform Worker contract and orchestration policy (order 4).
2. Implement a Postgres `EventStoreBackend` + migrations behind the
   `EventStoreBackend` seam; keep JSONL as the compat adapter (order 2/18).
3. Add InferWeave seat/backpressure adapter honoring 503+Retry-After and 429 on
   top of the gateway admission controller; remove any residual fixed-context
   assumptions (order 5/9/10).
4. Map canonical project identity → distinct OpenViking sessions per
   parent/child; add Git-ingestion preference; wire the outbox to the
   `OpenVikingProvider` (order 4/7).
5. Wire AutoSpec's public orchestration into the plan→implement→review→commit
   loop with policy-gated commit/PR (order 10/15).
6. Point a real Pi Web deployment at `control-server.ts`; record any upstream
   Pi Web UI gaps rather than building replacements (order 8).
7. Add cross-project/escape, model/provider-outage, and remote-worker-disconnect
   integration tests; run an independent fresh-context security review and fix
   findings (order 11/14).
8. Stand up the reference Compose and validate control API + PostgreSQL +
   observability wiring (order 18).

---

## 11. Acceptance criteria status

The foundational pi-engineering-owned control plane is implemented, tested, and
runnable: multi-project registry, Run/Task/Worker graph with lifecycle/heartbeat,
event-driven recovery, Plannotator gate with explicit autonomous bypass,
Pi Web control-plane adapter, scoped MCP registry, security/capability policy,
remote-worker contract, durable OpenViking outbox, reviewer isolation,
50-worker load test, full E2E loop, and reference Compose. The remaining gaps
above are the larger external-tool wirings (pi-subagents, Postgres backend,
InferWeave seats, AutoSpec live, Pi Web live) that require the upstream systems
to be present and are explicitly scoped as follow-up per the ownership policy.
