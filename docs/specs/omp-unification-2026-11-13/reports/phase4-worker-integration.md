# Phase 4: worker, session and tool integration on the OMP worker

Branch `feat/omp-worker-integration`, stacked on `feat/omp-engineer-slice` (PR #695). Legacy remains the default: nothing here runs unless `PI_ENGINEERING_OMP_WORKER=1` and `PI_ENGINEERING_OMP_ADAPTER=1` are both set.

## What moved

| Area | Change |
| --- | --- |
| Executor | `OmpWorkerExecutor` serves every worker role (scout, planner, implementer, reviewer, mission roles), not only `/engineer`. `FallbackWorkerExecutor` and `EngineeringRuntime` bind the runtime's semantic tools to it (`acceptsCustomTools`) exactly as they did for `PiWorkerExecutor`. |
| Host tools | `src/omp/hostTools.ts`: PE tools are registered with omp through `set_host_tools`, execute host-side (in PE), and are filtered by the same `req.tools` allowlist as legacy. Schemas are PE's own JSON, untouched. |
| Prompt | Same system prompt as legacy: `workerContext(req)` plus `TOOL_TRANSITION_RULE` for non-prose roles. |
| Recursion guard | Every omp worker runs at `PI_MISSION_DEPTH + 1` (omp's children inherit it). |
| Activity | `claim_deliverable` / `checkpoint_progress` results emit the same `checkpoint` activity (`meaningfulProgress`, `claims`) the broker consumes. |
| Process model | One fresh `omp --mode rpc --no-session` per worker run, in its own process group, killed on finish, abort or timeout. Negotiation (2 processes) happens once per `EngineeringRuntime.open`. |

## Tool mapping

| PE tool | Host name | Executes | Notes |
| --- | --- | --- | --- |
| `ledger_read`, `ledger_claim`, `ledger_evidence`, `artifact_read`, `repo_search`, `symbol`, `tests_for`, `mission` | same | PE | `coreTools`, same schemas |
| `claim_deliverable`, `checkpoint_progress` | same | PE | when `req.deliverables` is set (same predicates as legacy); emit checkpoint activity |
| worktree-confined `write` / `edit` (isolated worktree) | `pe_write`, `pe_edit` | PE | omp reserves built-in names; the omp built-in is dropped from `--tools` so only the confined one is offered |
| numbered `read`, tolerant `edit` (mission workers) | `pe_read`, `pe_edit` | PE | same reason |
| `read`, `grep`, `find`, `ls`, `write`, `edit` (non-isolated) | omp built-ins | omp | as in Phase 3 |
| `bash` | omp built-in | omp | legacy wraps bash with a budget notice and stall quarantine; here the process-group kill and the depth env replace them (known gap) |
| `worker_result`, `review_result` | same | PE | terminating tool, schema from the request's `resultTool`; never in the host-tool set |

## Parity per scenario (omp path vs legacy goldens, byte for byte, no golden edited)

`PARITY_PATH=omp` with real omp and an offline scripted model: 27/27 pass.

| Scenario | Status |
| --- | --- |
| engineer: happy, fix-round, persistent-findings-failed, review-not-completed | VERIFIED by real run |
| review: approve, findings | VERIFIED by real run |
| plan/execute: happy, blocked-downstream, idempotent-rerun, invalid-deps | VERIFIED by real run |
| plan/execute: unknown-plan | VERIFIED (pass-through: fails before any worker) |
| tournament: serial-n3-winner, failing-leg | VERIFIED by real run |
| recovery: torn-tail-reopen-append | VERIFIED by real run |
| verify: green, red | VERIFIED (pass-through under the flags) |
| cmd-*: 4 scenarios | VERIFIED (pass-through; the extension opens its own runtime, so the production selection reads the flags and negotiates real omp) |
| mission: 5 scenarios | VERIFIED byte-for-byte, but pass-through (see below) |

Printed per-path exemptions (the omp run prints them): every entry is a pass-through, never a loosened comparison; the comparison still runs. There are no byte differences to exempt.

### Missions

The mission goldens drive the Orchestrator with stub `BrokerBackends` that never reach a `WorkerExecutor`, so they cannot exercise an OMP worker. A production OMP path does exist: `EngineeringRuntime` hands `rt.worker` to `realBackends`, whose `agent` and `review` runners call `opts.worker.run(req)`, and `rt.worker` is the OMP executor under the same flag. `test/integration/omp-mission-backends.test.ts` proves it with a real omp: an implementer task writes a file and a mission review returns a structured `review_result` finding. Full mission DAGs on real omp are UNVERIFIED (no golden can compare them).

## Ledger, custody, lease, fencing

No ledger, custody, lease or fencing code changed (`git diff` touches only `src/omp`, the two executor wiring lines and three `export` keywords). `test/integration/omp-ledger-parity.test.ts` asserts, for each worker scenario, that the omp path's ledger event-type and actor sequence equals the legacy golden's. The goldens also compare every event's facts.

## Lifecycle (real omp, `test/integration/omp-worker-lifecycle.test.ts`)

- Negotiation spawns exactly 2 processes at open; later commands spawn only worker processes (counted by a launcher that logs its pid then execs omp).
- Tournament n=3: 3 implementers, each on its own process; processes started equals worker runs; no pid reused.
- DAG: each task's implementer on its own process.
- After runs, after abort, and after an inactivity timeout, no omp process is alive (checked by pid and by a before/after `pgrep` snapshot of descendants).
- Owner abort and inactivity timeout propagate: the run fails with `aborted by owner` / `no omp frame for Nms`, never falls back to legacy.

## Metrics vs legacy

| | legacy | omp |
| --- | --- | --- |
| Golden gate wall time (25 scenarios + 2 meta) | 23.5 s | 82 s |
| Child processes per run | 0 (in-process) | 2 at open, then 1 per worker run |

The cost is process start per worker run (about 1 to 2 s each with bun and the real omp source tree), not model time.

## Known gaps

- `promptSnippet` / `promptGuidelines` of PE tools are not forwarded (host tools carry name, description, schema).
- `bash`: no budget notice or stall quarantine; the process-group kill bounds it.
- Host tools that replace built-ins are named `pe_*`; prompt wording that says `write` / `edit` is unchanged.
- Scripted-model parity proves the integration, not model behavior; behavior differences between models are out of scope.
- Full mission DAGs on real omp are unverified.

## Rollback

Unset `PI_ENGINEERING_OMP_WORKER` (or the adapter flag). Nothing else changes: with the flag off `selectOmpWorker` returns `undefined`, `EngineeringRuntime.open` is untouched, and the legacy gate passes 27/27 with no golden edits.

## Coverage

`npm run test:coverage` exit 0: 6972 tests, 6967 pass, 0 fail, 5 skipped. Lines 85.62, branches 83.28, functions 83.38 (floors 85 / 83 / 83).
