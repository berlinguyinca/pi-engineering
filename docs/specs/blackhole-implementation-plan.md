# Blackhole Integration — Implementation Plan

Authoritative spec: `docs/specs/PI_BLACKHOLE_INTEGRATION_SPEC.md`.

## Design decisions (autonomous, per AGENTS.md)

1. **Provider seam, built-in default.** `pi-blackhole` is not installed. To keep the
   package standalone and the feature testable end-to-end, `src/blackhole/` defines a
   `BlackholeAdapter` provider interface. `loadBlackholeAdapter()` attempts to
   `import("pi-blackhole")` when present and otherwise returns a **built-in
   session-local memory provider** that implements the same semantics (session store,
   observe/reflect/drop, compaction, recall, promotion candidates). The pinned version
   `0.5.4` is recorded and validated; package validation is a first-class event.
2. **Strict isolation.** Session identity = `{project}/{workItem}/{runId}/{role}/{workerId}/{sessionId}`.
   The memory store is keyed by full session identity; a worker may only read its own
   session. Tournament candidates, reviewers, and challengers each get distinct
   identities → isolated stores.
3. **EventStore/PostgreSQL stays authoritative.** Blackhole events are appended to the
   same ledger via a public `Ledger.emitEvent`; the memory store is ephemeral working
   memory, never the system of record.
4. **Memory workers routed + scheduled.** Observer/Reflector/Dropper run through the
   existing `ModelRouter` (cheap/fast capability, priority classes P3/P4) and the
   existing `Scheduler` (backpressure) so they never preempt P0–P2 engineering work.
5. **Promotion requires evidence + explicit approval.** No auto-promotion. Promotion
   candidates carry evidence refs (ledger event/evidence/commit) and transition
   `proposed → accepted → promoted` (or rejected/superseded). Promoted durable memory
   goes through the OpenViking provider abstraction (in-memory durable default).
6. **Backward compatibility.** All blackhole behavior is off by default; enabling it
   changes only session-memory behavior and emits events/telemetry.
7. **A/B benchmark.** Paired native-vs-blackhole runs + compaction experiment; raw data
   retained as JSONL; `Report.ts` writes `report.md`; `Plots.ts` emits 12 SVG plots
   (SVG chosen to stay dependency-free).

## Modules

- `src/blackhole/{types,config,versioning,SessionStore,MemoryStore,BlackholeAdapter,memoryWorkers,OpenViking,promotion,BlackholeManager,telemetry,dashboard}.ts`
- `src/benchmark/{Metrics,ExperimentRunner,Report,Plots}.ts`
- Extend `src/core/types.ts` EventType; add `Ledger.emitEvent`.
- Integrate session identity + lifecycle into `EngineeringRuntime`.
- CLI subcommands in `scripts/pi-engineering.ts` + extension `/blackhole`.
- Tests: unit (config/version/session/isolation/promotion/recall/compaction/memory-workers),
  integration (runtime lifecycle, tournament/reviewer isolation), concurrency (parallel
  candidates isolated), benchmark (plots+report generated/readable).

## Completion gates
- `tsc --noEmit`, `biome check`, full `node --test`, `test:e2e` all pass.
- `roadmap check` still exit 0 (blackhole is additive; roadmap unaffected unless folded).
- A/B benchmark runs with plots + report generated and inspected; docs updated; committed.
