# Pi Engineering Platform — Gap Matrix

**Spec package:** `pi-engineering-implementation-spec-2026-09-15-v3`
**Revision date:** 2026-09-15
**Target repository:** `pi-engineering-runtime` (the local `pi-engineering` integration/policy harness)

## Classification legend

- **EXISTING** — implemented, tested, and owned by pi-engineering as allowed.
- **PARTIAL** — implemented but incomplete against the normative requirement.
- **MISSING** — not present; pi-engineering-owned work required.
- **SUPERSEDED** — an older design that this package explicitly removes.
- **EXTERNAL** — owned by an external tool/service; pi-engineering only adapts/configures.
- **NOT-APPLICABLE** — deliberately out of scope (e.g. Pi Forge).

The master spec and `support/EXTERNAL_TOOLS_AND_OWNERSHIP.md` are normative.
The `EXTERNAL` rows below are the ones where pi-engineering must write an adapter/config,
not re-implement the external system.

---

## Normative architecture (MASTER_SPEC / DECISIONS)

| # | Requirement | Classification | Evidence / Notes |
|---|-------------|----------------|------------------|
| A1 | Pi is the engineering runtime | EXTERNAL | Pi (`@earendil-works/pi-coding-agent`) is a peer dependency; the extension entry point `extensions/index.ts` runs inside a Pi session. pi-engineering owns the extension, not the runtime. |
| A2 | pi-subagents is the preferred child orchestration | EXTERNAL / PARTIAL | Reuse its run/fanout/lanes/steering/fresh-context/worktree primitives before inventing. The repo currently uses its own in-process worker executors (`src/workers/PiWorkerExecutor.ts`). No `pi-subagents` package integration discovered yet. pi-engineering must adopt/configure pi-subagents where it is installed, and only fall back to the in-process executor where the upstream package is absent. |
| A3 | Pi Web is the single operator UI (integrate, do not build) | EXTERNAL / MISSING-adapter | No Pi Web adapter/control-plane surface exists. pi-engineering must expose projects/runs/workers/events/tests/reviews/interventions via a normalized adapter that the existing Pi Web consumes. |
| A4 | Pi Forge is OUT OF SCOPE | NOT-APPLICABLE | Not inspected, not integrated, not vendored. |
| A5 | Plannotator is an external plan gate (integrate, do not build) | EXTERNAL / MISSING-adapter | No Plannotator adapter. pi-engineering must implement plan handoff, decision ingestion, persisted correlation and the 4 modes (interactive/autonomous/policy/disabled). |
| A6 | AutoSpec consumes Pi; never supervises Pi | EXTERNAL / PARTIAL | `src/adapters/Adapters.ts` defines an `AutoSpecAdapter` seam (designSpec/splitSpec), never invoked by core. No plan→Plannotator→implement→test→review→fix→CI→commit loop that invokes AutoSpec's public orchestration. |
| A7 | OpenViking is mandatory shared durable memory | EXTERNAL / PARTIAL | `OpenVikingProvider` (`src/blackhole/durable.ts`) + `services/openviking` (thin local HTTP endpoint over Postgres for dev/tests). No outbox-based emergency offline mode; no canonical project identity mapping for distinct per-parent/child sessions yet. |
| A8 | Blackhole is local per session | EXISTING | Pinned `0.5.4`, session-local, never synchronized; promotion bridge to durable memory is evidence-gated (`src/blackhole/promotion.ts`). |
| A9 | PostgreSQL/EventStore is authoritative runtime history | PARTIAL | `EventStore` (`src/ledger/EventStore.ts`) is append-only JSONL. No swappable backend interface / Postgres-compatible adapter seam yet. |
| A10 | InferWeave owns GPU/model placement and seat admission | EXTERNAL / PARTIAL | `InferWeaveAdapter` seam exists (`src/adapters/Adapters.ts`, retrieve/record). No seat/resource semantics, no 503+Retry-After/429 handling specific to InferWeave beyond the generic gateway admission controller. |
| A11 | Docker-first surrounding stack | PARTIAL | `deploy/` (Apptainer + AWS) and `services/openviking` compose. No reference Compose for the full control plane (control API, Pi Web, PostgreSQL, Plannotator, object storage, observability). |
| A12 | No shared-Blackhole server / filesystem design | SUPERSEDED | The package explicitly removes these; nothing in the repo implements a shared Blackhole server. `SharedFileDurableMemory` is a shared-file backing for evidence-promoted durable memory only, not Blackhole session memory. |

---

## Spec-by-spec

### 01 Boundaries & precedence
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Create a gap matrix before refactoring | EXISTING (this file) | — |
| Enforce MASTER_SPEC ownership; one authoritative owner per capability | PARTIAL | Adapters are seams; worker lifecycle is in-process. No explicit single-owner registry for shared memory / runtime state / plan approval / inference / UI. |
| Mark shared-Blackhole memory designs superseded | EXISTING | Documented SUPERSEDED. |

### 02 Integrate external Pi Web
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Do not build Pi Web | EXISTING (policy) | Enforced by ownership doc. |
| Expose projects/runs/workers/events/tests/diffs/reviews/routing/memory/interventions through Pi Web | MISSING | No control-plane adapter. pi-engineering owns this adapter. |
| Use Pi Web native capabilities; document upstream gaps | PARTIAL | No Pi Web adapter yet, so no gap documentation. |

### 03 Integrate external Plannotator
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Do not build a replacement Plannotator | EXISTING (policy) | Enforced. |
| Plan handoff, decision ingestion, persisted correlation, 4 modes | MISSING | No Plannotator adapter. |
| Recovery of pending plan-decision correlation state | MISSING | To be implemented with the adapter. |

### 04 pi-subagents runtime
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Reuse upstream run/fanout/lanes/steering/background/fresh-context/output-schema/worktree primitives | EXTERNAL / PARTIAL | In-process executors used today; pi-subagents adoption required where available. |
| Parent stays responsive; heavy/mutating work → children | EXISTING | `EngineeringRuntime` delegates to worker executors; interactive session is separate. |
| Every worker has IDs, lifecycle, heartbeat, events, budgets, cancel/restart | PARTIAL | Candidates have lifecycle; no distinct `Worker` entity with heartbeat/restart persisted. |

### 05 Work graph & scheduler
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Persist Run/Task/Dependency/Worker graph | PARTIAL | WorkItem/Candidate/Task persisted via ledger; no `Run` entity and no distinct `Worker` entity with lifecycle/heartbeat. |
| Schedule only dependency-ready tasks; account for write conflicts, role/project limits, provider/host capacity, priority, fairness, budgets | PARTIAL | `Scheduler` does weighted fairness + backpressure + speculation; task DAG handles dependencies. Project-level limits and write-conflict scheduling not present. |
| Explicit blockers / waiting-for-human states | PARTIAL | WorkItem has `BLOCKED`/`NEEDS_HUMAN`; not surfaced as scheduler state. |
| Best-effort critical path from evidence; no invented percentages/ETAs | PARTIAL | Task DAG exists; no critical-path computation. |

### 06 Worktrees, tournaments & review
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Parallel mutators in isolated worktrees | EXISTING | `GitRepo` worktree isolation + `test/integration/git-worktree-concurrency.test.ts`. |
| Tournament candidates from equivalent snapshots + isolated sessions | EXISTING | `src/runtime/EngineeringRuntime.ts` tournament; `src/verify/farm`. |
| Fresh reviewers see only allowed requirements/code/diff/tests/accepted memory | EXISTING / PARTIAL | Reviewers are fresh-context; reviewer isolation test needed (see 17). |
| Preserve failed worktrees for diagnosis; promote only independently-validated loser knowledge | EXISTING | Evidence-gated promotion. |

### 07 OpenViking
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Mandatory shared durable memory; distinct session per parent/child, shared canonical project resource | PARTIAL | OpenVikingProvider exists; distinct session identity exists (`SessionStore`); canonical project identity mapping for multi-project not present. |
| Bootstrap ~4k–8k tokens, retrieve on demand, commit at phase/run boundaries | PARTIAL | Durable hydration exists; bootstrap-size policy is not enforced at the platform level. |
| Search/recall/remember/status | EXISTING | `/memory`, `/remember`, recall, status. |
| Explicit offline outbox | MISSING | No outbox. |
| Prefer OpenViking Git ingestion/watch over custom indexing | PARTIAL | Custom durable provider used; no Git-ingestion seam. |

### 08 Blackhole
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Strictly local per session; never shared server/filesystem | EXISTING | Enforced. |
| Pin validated versions | EXISTING | Pinned 0.5.4. |
| Promote only durable validated observations to OpenViking | EXISTING | `src/blackhole/promotion.ts` evidence-gated. |
| Native vs Blackhole benchmark | EXISTING | `src/benchmark/` + `scripts/blackhole-benchmark.ts`. |

### 09 Dynamic context & InferWeave
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Discover model context/output/reasoning/vision/tool metadata dynamically, cache TTL/version, safe fallback | EXISTING / PARTIAL | `src/models/refresh.ts` + `gatewayCatalog.ts` discover context from gateway; TTL/version caching is partial. |
| Remove fixed 260k reservations | EXISTING | Context comes from configured/discovered models, not a fixed 260k constant. |
| Stable session IDs / affinity | PARTIAL | Worker session identity exists; InferWeave affinity not wired. |
| One branch = one seat; admission via context/KV/VRAM/RAM/residency/compute/queue/fairness | EXTERNAL / MISSING | InferWeave owns this; pi-engineering needs a seat/backpressure adapter. |
| Respect 503+Retry-After and 429 | PARTIAL | Generic gateway admission controller handles 429/503; not InferWeave-specific seat semantics. |

### 10 Model routing
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Route by role/capability/service class, not GPU | EXISTING | `src/routing/ModelRouter.ts` with `ROLE_CAPABILITIES`. |
| Support discovered families (Qwen, GLM, DeepSeek, Claude, Codex, future) | PARTIAL | Router is capability-generic; family list is extensible. |
| Roles: planner/implementer/debugger/tester/reviewer/security/docs/UI-vision/scout/memory | PARTIAL | Roles exist; `docs`/`UI-vision`/`memory` worker roles are not first-class. |
| Overrides + fallback preserves capabilities and separation of duties | EXISTING / PARTIAL | Fallback exists; reviewer-independence fallback not explicitly tested. |

### 11 Security, permissions & Docker
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Docker-first stack and worker isolation | PARTIAL | Deploy scripts; no full control-plane Compose. |
| Identity/project auth, role tools, Pi permissions, capability ceilings, filesystem/worktree scope, minimal secrets, network policy, audit | PARTIAL | `src/security/SecurityPolicy.ts` covers redaction/tool policy/injection; no project auth or capability-ceiling enforcement. |
| Control API cannot bypass worker policy | MISSING | No control API yet. |
| High-risk actions require approval even in autonomous mode | MISSING | To be implemented with Plannotator/approval gate. |
| Test cross-project and escape attempts | MISSING | No such test. |

### 12 Remote workers
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Local/remote one Worker contract | MISSING | No Worker entity/contract. |
| Remote hosts connect outbound; authenticated channels; no public inbound | MISSING | No remote worker support. |
| Preserve IDs/permissions/OpenViking/events/cancellation/worktree semantics | MISSING | No remote worker support. |
| Idempotent commands; recover from disconnects | MISSING | No remote worker support. |
| Location/latency are placement attributes, not a second orchestration API | MISSING | No remote worker support. |

### 13 Events, prompts & observability
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Versioned events for run/task/worker lifecycle, heartbeats, activity, files, commands, tests, decisions, blockers, review, interventions | PARTIAL | Rich event set for work item/candidate/task/evidence; no worker heartbeat/run events. |
| PostgreSQL authoritative | PARTIAL | JSONL authoritative; no backend interface. |
| Prompt telemetry: correlation IDs, role/model/provider, template version, hashes, payload refs, tokens, latency, context, compactions, tools, routing, outcome | PARTIAL | `src/telemetry/` + `TelemetryExport`; per-event prompt telemetry is partial. |
| Never expose chain-of-thought | EXISTING | Enforced. |

### 14 MCP/tools
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Generic project/role-scoped MCP registry | MISSING | No MCP registry. |
| Discovery ≠ permission; project/role allowlists | MISSING | No MCP registry. |
| Record server/version, invocation correlation, duration/status, permission decision | MISSING | No MCP registry. |
| Child capabilities never exceed parent/run ceiling | MISSING | No ceiling enforcement. |

### 15 AutoSpec & CI
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| AutoSpec owns spec/work-item policy; calls Pi public orchestration | EXTERNAL / PARTIAL | `AutoSpecAdapter` seam exists; no live loop. |
| Substantial loop: plan→optional Plannotator→implement→test→review→fix→rerun→docs→commit/PR by policy→OpenViking commit | PARTIAL | Engineer pipeline implements→verify→review→fix→promote; Plannotator gate and policy commit are missing. |
| CI/log/review/changelog via common event model | PARTIAL | Ledger event model + GitHub Actions; not a multi-project event model. |

### 17 Testing, recovery & load
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Unit: schemas/transitions/permissions/routing/context/memory redaction/outbox | PARTIAL | Most covered; outbox missing. |
| Integration: parent-child, worktrees, steering/cancel/restart, OpenViking sharing, reviewer isolation, Plannotator, InferWeave backpressure, AutoSpec, MCP | PARTIAL | parent-child/worktrees/OpenViking covered; reviewer isolation, Plannotator, InferWeave seat, MCP not yet. |
| Recovery: worker/parent/DB/provider/OpenViking/remote failures | MISSING | Not present. |
| Load: 50 concurrent workers with events/heartbeats/recall | MISSING | No 50-worker load test. |
| E2E: real plan→implement→test→review→fix→complete | EXISTING / PARTIAL | `test/integration/vertical-slice.test.ts` + smoke scripts; no Plannotator-gated E2E. |

### 18 Deployment & migration
| Requirement | Classification | Notes |
|-------------|----------------|-------|
| Reference Compose: control API, Pi Web, PostgreSQL, Plannotator, optional S3, observability | MISSING | No full reference Compose. |
| Workers dynamic; InferWeave/OpenViking external | PARTIAL | Workers in-process; no dynamic worker model. |
| Roll out behind compatibility seams; preserve single-agent until parity | PARTIAL | JSONL EventStore is a compat seam; migration steps not documented. |

---

## External-tool integration detail (required by task step 5)

| Requirement (external) | External tool/service | Current integration mechanism | Config/API/extension point used | pi-engineering must implement locally | Must remain external |
|---|---|---|---|---|---|
| Child orchestration | pi-subagents | None (in-process executor fallback) | pi-subagents run/fanout/lanes/steering/background/worktree/output-schema primitives | Orchestration policy + adapter that prefers pi-subagents when installed, falls back to in-process executor | The pi-subagents package itself |
| Operator UI | Pi Web | None | Pi Web supported APIs/extensions/deep-links | Control-plane adapter exposing projects/runs/workers/events/tests/reviews/routing/memory/interventions | Pi Web source/frontend/backend |
| Plan gate | Plannotator | None | Plannotator CLI/API/server/container interfaces | Adapter (4 modes), decision ingestion, persisted correlation, policy; recovery of own pending state | Plannotator UI/service |
| Shared durable memory | OpenViking (`viking.metabolomics.us`) | `OpenVikingProvider` HTTP client + local dev endpoint | OpenViking HTTP memory API (POST/GET `/memory`, `/search`, `/health`) | Canonical project-session mapping, bootstrap/retrieve policy, offline outbox | OpenViking server/vector DB |
| Local per-session memory | Blackhole / pi-blackhole | `BlackholeManager` pinned 0.5.4 | pi-blackhole package API | Promotion bridge (evidence-gated) | pi-blackhole package |
| Inference placement/seats | InferWeave | `InferWeaveAdapter` seam (retrieve/record) | InferWeave gateway/node APIs; seat/resource semantics; 503/429 handling | Seat/backpressure adapter + capability discovery | InferWeave GPU scheduler/gateway/node runtime |
| Spec/work-item policy | AutoSpec | `AutoSpecAdapter` seam | AutoSpec public orchestration API | Plan→Plannotator→implement→test→review→fix→commit loop calling AutoSpec orchestration | AutoSpec repo/engine |
| Domain MCP servers (LCB, MassWiki, ChemLake, CTSLite) | Individual MCP services | None | MCP protocol; server config | Generic project/role-scoped MCP registry + permission policy | The MCP servers themselves |
| Runtime history | PostgreSQL | JSONL EventStore | SQL schema/migrations/client | EventStore backend interface + Postgres-compatible adapter + migrations | PostgreSQL server |
| Remote workers | Remote Pi hosts | None | Outbound authenticated channel; Worker contract | Remote worker contract, idempotent commands, reconnect/recovery | The remote worker hosts |
| Model gateway capacity | Provider gateways / InferWeave | Gateway admission controller (429/503) | Retry-After / retry_after_ms / active_limit | InferWeave-specific seat semantics on top of the generic gate | The gateways |

---

## Implementation priority (drives `IMPLEMENTATION_ORDER.md`)

The following MISSING items are pi-engineering-owned and will be implemented in this pass:

1. **Shared domain contracts** — `Workspace`/`Project`/`Repository`/`Run`/`Worker` entities and worker/run event types (order step 1).
2. **EventStore backend interface** + JSONL compatibility adapter (order step 2).
3. **Plannotator adapter** — 4 modes, persisted approval state, decision correlation, autonomous-bypass audit (order step 7).
4. **Control-plane adapter** for Pi Web — normalized projects/runs/workers/events/tests/reviews/interventions (order step 8).
5. **MCP registry** — project/role-scoped, discovery≠permission, invocation audit (order step 9).
6. **Remote worker contract** — outbound, authenticated, idempotent commands, reconnect (order step 12).
7. **Security hardening** — capability ceilings, project auth, high-risk approval gate (order step 9).
8. **Testing** — 50-worker load, worker crash/recovery, parent restart, reviewer isolation, outbox, MCP, Plannotator decision recovery (order step 14).
9. **Reference Compose** for the control plane (order step 18).

Pi Forge is NOT-APPLICABLE throughout and is never inspected or integrated.
