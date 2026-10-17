# Investigation: using InferWeave for a better mission interface and execution

Date: 2026-06-18
Scope: `pi-engineering` (this repo) × `inferweave` (`/home/wohlgemuth/IdeaProjects/inferweave`,
deployed edge `https://llm.metabolomics.us`, Go gateway `inferweave-gateway`, Rust core
`crates/iw-gateway`), against the operator complaints:

1. mission progress bar pinned at 0%
2. missions are "flaky and dumb"
3. the system does not switch modes to provided models of the right capabilities
4. execution is a black box — no detailed updates

---

## 1. Findings (root causes, verified in code + live gateway)

### F1. The progress bar measures the wrong thing

- The live bar is `Orchestrator.progressBar()` (`src/orchestration/orchestrator.ts:1481`).
  It renders `summary.progress.approximatePercent`.
- `MissionObservability` computes that percentage from **verified acceptance coverage**
  (`src/orchestration/observability/progress.ts`, consumed at
  `src/orchestration/observability/MissionObservability.ts:1146`). Acceptance criteria only
  become verified after the completion gate, so the primary % is 0 for ~99% of a mission's
  life and then jumps to 100.
- The DAG-weighted workflow progress **is** computed (`workflowProgress.approximatePercent`)
  and shown by `/mission-status` — but the live progress line never uses it.
- The specs contradict each other and the implementation followed the wrong one:
  - `docs/specs/mission-observability/00-master-spec.md:44` — `progress.basis: "weighted_dag"`
    (primary progress = weighted DAG)
  - `docs/specs/mission-observability/08-testing-and-acceptance.md:214` — "primary percentage
    reflects verified acceptance coverage"
- Test fixtures even encode the divergence:
  `test/extension-mission-commands.test.ts:427-429` — `acceptance 0%` while `workflow 80%`,
  bar rendered `0%`.

**Conclusion:** acceptance coverage is an audit metric, not a progress metric. The live bar
must track the weighted-DAG workflow progress; acceptance coverage stays visible as a
separate number (it already is, in `/mission-status`).

### F2. "Doesn't switch modes to models of the right capabilities" — three independent causes

**A. The deployed gateway advertises no role capabilities.**
Verified live (2026-06-18) against `llm.metabolomics.us/v1/models`:

- 34 concrete models, none with `x_capabilities`; only family aliases
  (`carrot`, `deepseek_v4`, `qwen3.8`, `laya`, …).
- No logical routes: local Rust edge exposes `GET /iw/v1/routes` and it returns
  `{"generation":0,"models":{},"retiring":[],"routes":{}}` — the feature exists, it is
  unconfigured. The deployed Go edge does not expose the endpoint at all (404).
- `plannerWorker/mode.ts` (`chooseExecutionMode`, spec §26) explicitly degrades
  `auto → single` when `planner.via === "static" || implementer.via === "static"` or when
  "the gateway does not advertise role capabilities". So the entire multi-model
  planner-worker machinery is **dormant on this host by design of the heuristic**: the
  heuristic is waiting for the gateway to declare roles, and the gateway never did.

**B. The mission path (`/mission` → orchestrator → scheduler → broker) routes roles
statically.**
`src/runtime/EngineeringRuntime.ts:1072-1130` builds the mission `routeModel` hook from
`createRoleRouter({ …, allowModelNetwork: false })` — the capability registry is built from
the local Pi model runtime + agent models file, never the live gateway capability catalog.
Role placement = repo policy `.pi/engineering.yaml` pins > local-registry scoring >
session default. The live `x_capabilities`/alias catalog is only consumed by the separate
`plannerWorker` subsystem (`/engineer`), not by missions.

**C. The mission planner hardcodes one shape for every task.**
`src/orchestration/missionPlanner.ts:198` sets `execution_requirements: {}` on all tasks,
and tasks carry no per-task model/capability distinction. The broker does forward
`modelRequirements` (`scheduler.ts:849`, `broker.ts:2501`), so the plumbing exists — the
planner simply never fills it. There is nothing for routing to switch on.

**D. The static pins are themselves a documented workaround for gateway flakiness.**
`.pi/engineering.yaml` notes (rev 3, 2026-10-04; rev 4, 2026-10-06):

- local GPU pins were unreachable in fresh processes → roles degraded to
  `deepseek_v4-flash-…-mxfp4`, which **loops without progress on substantial turns**
  (the exact failure APS exists to detect);
- the `qwen3.8-27b` text q8 endpoint **flaps** — repeatedly unlisted from `/models`
  mid-execution ("model is not served") — burning the 30-min recovery deadline on long
  tasks; implementer was moved to `qwen3.8-flash_next` as the stable model.

So "flaky and dumb" is a compound: a model that loops + endpoints that flap + static pins
that chase both + a routing layer that can only see a frozen local view.

### F3. Black box: routing provenance is captured but never surfaced

- Every inference already captures full InferWeave provenance:
  `src/inference/inferweaveMetadata.ts` (all `x-inferweave-*` headers: resolved model,
  node, worker, route, route-generation, route-fallback, capacity state, failure reason),
  plus structured admission rejections (`src/inference/admissionTransport.ts`:
  `reason`, `retry_after_ms`, `active/active_limit/queued/queue_limit`, scope).
- `plannerWorker/gateway.ts:333-342` already reads `x-inferweave-model`, `x-inferweave-route`,
  `x-inferweave-route-generation`, `x-inferweave-route-fallback` per request.
- The mission broker records the serving `model` per execution (`broker.ts:2501`) — but
  nothing downstream (mission observability summary, `/mission-status`, PI-Web snapshot,
  progress lines) exposes **which model served which task, on which node, via which route,
  with what fallbacks, and why a task is waiting for capacity**. The operator sees
  "worker running" and a 0% bar.
- The `chooseExecutionMode` decision and its *reason* ("auto: the gateway does not
  advertise role capabilities") is computed but not reported anywhere the operator sees.

### F4. What already works (do not rebuild)

- Admission retry state machine (spec
  `docs/specs/pi-engineering-harness-inferweave-admission-retry-spec`): reason-aware,
  elapsed-time-aware 429/503 handling, `x-should-retry` ownership, WAITING park with
  durable mission state — installed via `installAdmissionRetry`
  (`src/lifecycle/harness.ts:336`).
- Context capability client (`/iw/v1/capabilities`, ETag, 128k floor, status footer) —
  milestone `docs/evidence/milestone-inferweave-context-capabilities.md`.
- Session affinity plumbing: `x-inferweave-session` header set by the admission transport
  (`admissionTransport.ts:220,257`), sent by `plannerWorker/gateway.ts:281`; admission
  scope carries a session key (`harness.ts:347`).
- Failure classification from the InferWeave protocol table
  (`src/inference/failureClassifier.ts:458`).
- Live probe against the deployed edge confirms the full header surface works
  (2026-06-18, model `deepseek_v4`):

  ```
  x-inferweave-alias: deepseek_v4
  x-inferweave-model: deepseek_v4-flash-modality-text-quant-mxfp4
  x-inferweave-resolved-model: deepseek_v4-flash-modality-text-quant-mxfp4
  x-inferweave-node: node_hive-rust
  x-inferweave-worker: node_hive-rust:deepseek_v4-flash-modality-text-quant-mxfp4
  x-inferweave-request-id: probe-req-1
  ```

---

## 2. What InferWeave provides for this (verified in `inferweave` sources)

| Capability | Where | Status on deployed edge |
| --- | --- | --- |
| **Logical routes** — stable route names (`coding-planning`, `cap:…` queries) with fallback lists, route generation, hot-swap when a model goes away (`crates/iw-gateway/src/server_routes.rs`, `docs/specs/logical-routes.md`) | Rust core, `IW_LOGICAL_ROUTES` + admin API | **Unconfigured** (routes empty; Go edge lacks the admin endpoint — 404) |
| **Model capability profiles** — `x_capabilities` on concrete models, matched by `x-inferweave-capabilities`/`x-inferweave-min-context`/`x-inferweave-prefer-family` hints | Rust core | **Unconfigured** (no capabilities advertised) |
| **Per-request routing provenance headers** — `x-inferweave-alias/-model/-resolved-model/-node/-worker/-route/-route-generation/-route-fallback`, `x-request-id` idempotency | Rust core + Go edge passthrough (Go edge forwards the full header set, `cmd/gateway/alias_inference_client.go:353`) | **Works** (probed) |
| **Session affinity** — `x-inferweave-session` (1-256 printable ASCII, no spaces) for KV-cache pinning + sticky routing; comment in core: "Pi session id (not the caller id: a single caller runs many sub-agents)" — designed for exactly this use | Rust core | Works; pi-engineering sends it on the plannerWorker path |
| **Structured admission rejections** — 429/503 body (`reason`, `retry_after_ms`, `active/active_limit/queued/queue_limit`, `scope`) + `x-inferweave-queue: false` fail-fast | Rust core | Works (pi-engineering retry spec targets it) |
| **Route event stream** — `GET /iw/v1/routes/events` (SSE: MODEL_ROUTE_RESOLVED/CHANGED, MODEL_FALLBACK, MODEL_UNAVAILABLE) — the authoritative feed for "why did the model change mid-mission" | Rust core | Exposed on local Rust edge; not on Go edge |
| **Prompt ledger** — durable per-request records, `x-request-id` idempotency key | Rust core | Works |
| **Tenant isolation** — `x-inferweave-tenant` | both | available, unused by pi-engineering |

The strategic point: **InferWeave's logical routes move "which model serves a role" from
a client-side static pin (which must chase flaps and re-degrade) to a server-owned,
self-healing mapping with explicit provenance.** That directly attacks F2-D (flapping
endpoints + looping models) and F3 (black box) at the source.

---

## 3. Gap analysis and recommendations

### Gateway side (inferweave)

- **G1. Configure role logical routes on the deployed edge** — highest-leverage change.
  e.g. `coding-planning` → `qwen3.8-flash_next` text (fallback: flash family);
  `coding-implementation` → `qwen3.8-27b` text (fallback: flash_next, the model already
  proven stable for this role); `coding-review` → `qwen3.8-27b` vision (distinct family
  preferred); `coding-analysis`/`coding.debugging` → flash class. Once routes exist, the
  route name is the stable unit: a flapping endpoint triggers a gateway-side fallback with
  a route-generation bump and a MODEL_FALLBACK event, instead of the client discovering
  "model not served" 30 minutes into a task.
- **G2. Add model capability profiles** (`x_capabilities`: `coding.planning`,
  `coding.implementation`, `coding.review`, `vision`, `tools`, … + context windows) so
  capability queries work and pi-engineering's `gatewayCatalog` sees them.
- **G3. Expose route admin + events on the Go edge** (`/iw/v1/routes`,
  `/iw/v1/routes/events`) — or document the admin path — so pi-engineering can discover
  routes and ingest route events.
- **G4. (Stretch)** per-mission `x-inferweave-tenant: <missionId>` for capacity
  accounting/isolation of mission traffic.

### pi-engineering side

- **P1. Fix the progress bar metric** (fixes complaint 1; small, high visibility).
  - `progressBar()` renders the weighted-DAG `workflowProgress` percentage; keep
    `acceptanceCoverage` as its own labeled number.
  - Resolve the spec contradiction in favor of `00-master-spec` (`basis: "weighted_dag"`
    for the bar); amend `08-testing-and-acceptance.md:214` to say the *summary's*
    acceptance metric is separate from the *bar*, and update the fixture at
    `test/extension-mission-commands.test.ts:427-429`.
- **P2. Make mission routing use gateway-owned route names** (fixes complaint 3, config-only
  first cut). In `.pi/engineering.yaml`, pin roles to logical route IDs
  (`metabolomics/coding-planning`, `metabolomics/coding-implementation`,
  `metabolomics/coding-review`) instead of concrete model IDs. The broker already honors
  per-execution `modelRequirements.model`, and route names never flap — the gateway's
  fallback machinery absorbs endpoint churn. No code change required for the first cut.
- **P3. Planner assigns per-task roles + execution requirements** (fixes complaint 3,
  deeper). `missionPlanner.ts` should differentiate tasks: investigation/scouting
  (analysis capability, fast model), implementation (implementation capability, large
  context), review (distinct family). Fill `execution_requirements` (`model`, capability
  hints) so the broker's existing `modelRequirements` plumbing routes per task.
- **P4. Surface routing provenance in mission observability** (fixes complaint 4).
  - Record per-task: served model, route, route-generation, fallback count, node,
    capacity-wait duration (all already available in `inferweaveMetadata` captures +
    broker execution records).
  - Add to `MissionObservabilitySummary` (per-worker model), the `/mission-status` lines,
    the live progress lines, and the PI-Web snapshot.
  - Ingest `/iw/v1/routes/events` (once G3 lands) to explain mid-mission model changes as
    mission activity, not silent swaps.
- **P5. Send session affinity from mission workers.** Pass the task/worker session id as
  `x-inferweave-session` (the transport supports it; plannerWorker already does). KV-cache
  pinning across a worker's multi-turn execution cuts cost/latency and stabilizes routing.
- **P6. Report mode decisions.** When `chooseExecutionMode` degrades `auto → single`,
  publish the *reason* as a mission/operator line ("multi-model routing inactive: gateway
  advertises no role capabilities — configure logical routes on the edge"). Today the
  decision is computed and silently thrown away.

### Suggested order

1. **G1 + G2** (gateway config) — unblocks everything; immediately makes `/engineer`
   auto-mode engage and gives missions stable route names.
2. **P1** (progress bar) — small, kills the "stuck at 0%" complaint.
3. **P2** (route names in `engineering.yaml`) — config-only, ends flap-driven failures.
4. **P4** (provenance in observability) — the "detailed updates" half of the ask.
5. **P3, P5, G3, P6, G4** — deeper integration, each independently shippable.

---

## 4. Evidence index

- `src/orchestration/orchestrator.ts:1481` — live bar uses `approximatePercent`
- `src/orchestration/observability/progress.ts` — percent = verified acceptance coverage
- `src/orchestration/missionPlanner.ts:198` — `execution_requirements: {}` hardcoded
- `src/runtime/EngineeringRuntime.ts:1072-1130` — mission routing is static
  (`allowModelNetwork: false`)
- `src/plannerWorker/mode.ts` — auto→single degradation rules
- `.pi/engineering.yaml` rev 3/rev 4 notes — looping model + flapping endpoint history
- `docs/specs/mission-observability/00-master-spec.md:44` vs `08-testing-and-acceptance.md:214`
  — spec contradiction
- `test/extension-mission-commands.test.ts:427-429` — 0% bar with 80% workflow fixture
- Live probe 2026-06-18: `llm.metabolomics.us` routing headers (F3), `/v1/models`
  (no `x_capabilities`), `127.0.0.1:18081/iw/v1/routes` (empty), Go edge
  `/iw/v1/routes` (404)
- `inferweave/crates/iw-gateway/src/server_routes.rs`, `docs/specs/logical-routes.md`,
  `INFERWEAVE_DYNAMIC_ALIASES_MASTER_SPEC.md` (inferweave-specs) — route/alias capability
- `inferweave-gateway/cmd/gateway/alias_inference_client.go:353` — Go edge header surface
