# Milestone M23 — Blackhole Session Memory Integration

Evidence for the Blackhole session-memory + benchmark milestone. This is an
OPTIONAL, additive integration: it is disabled by default and leaves the runtime
behaving exactly as before when omitted or disabled (backward compatible).

## What was built

- **`src/blackhole/`** — optional per-session memory provider.
  - `types.ts` — pinned Blackhole version **0.5.4** (never `latest`), allowlist,
    session identity, memory hierarchy, promotion state machine.
  - `config.ts` — backward-compatible config (disabled default); rejects any
    non-allowlisted version (fail-closed); forces `autoPromotion: false`.
  - `versioning.ts` — package validation; builtin fallback when `pi-blackhole`
    is absent (core stays standalone); drift fails closed.
  - `SessionStore.ts` — session identity generation + strict isolation key.
  - `MemoryStore.ts` — per-session store (observe/reflect/drop, priority recall,
    compaction with audit trail, promotion candidates).
  - `BlackholeAdapter.ts` — provider seam (builtin default; optional pi-blackhole).
  - `OpenViking.ts` — durable cross-session memory abstraction + in-memory default.
  - `promotion.ts` — evidence-gated promotion; **no auto-promotion**.
  - `memoryWorkers.ts` — Observer/Reflector/Dropper at P3/P4 via ModelRouter +
    Scheduler backpressure.
  - `BlackholeManager.ts` — lifecycle orchestration; EventStore-authoritative
    events; fail-closed version drift; session TTL GC.
  - `telemetry.ts`, `dashboard.ts` — telemetry + dashboard panels.
- **`src/benchmark/`** — native-vs-Blackhole A/B benchmark.
  - `Metrics.ts`, `ExperimentRunner.ts`, `Plots.ts`, `Report.ts`.
  - Generates a report + **12 SVG plots**; preserves raw JSONL + CSV.
  - Report is explicitly labeled as a deterministic, model-free simulator
    (not a measured model claim).
- **Runtime integration** (`EngineeringRuntime.runWorker`): stable per-candidate
  session memory; recall is appended to worker context; background observer runs
  after completed work. Isolation is keyed on candidate id so tournament
  candidates sharing a work item never share memory.
- **CLI** (`pi-engineering blackhole status|validate|benchmark`) + `/blackhole`
  extension command + dashboard.

## Evidence

- Deterministic unit + integration tests: `test/unit/blackhole*.test.ts`,
  `test/integration/blackhole.test.ts`.
- A/B benchmark artifacts: `docs/evidence/blackhole/` (report.md, 12 plots,
  raw.jsonl, raw.csv).
- Fresh-context review (`scripts/fresh-review-blackhole.ts`) found 6 material
  findings; a focused re-review (`scripts/fresh-review-blackhole-fixes.ts`)
  confirmed all RESOLVED with 0 critical / 0 high.

## Isolation & authority guarantees

- EventStore/PostgreSQL remains the authoritative system of record; Blackhole
  memory is ephemeral working memory and every lifecycle transition emits a
  ledger event.
- Strict isolation: session identity = project/work item/role/candidate scope;
  candidates, reviewers, and challengers never share working memory.
- Promotion is evidence-gated and requires explicit decision (never automatic).
