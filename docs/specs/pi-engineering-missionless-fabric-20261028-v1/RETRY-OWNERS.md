# Retry owners: audit and the single-owner rule

Spec: `missionless-fabric/03-runtime-quality.md` (a 429 / model loss pauses or migrates only the affected run, one owner), `04-optimizations.md` O2 (no retries multiplying at gateway + Pi + broker, per-layer ownership trace), `06-migration-tests.md` T4.

Scenario for the numbers: one request is refused with a gateway `inference_admission` 429 (`queue_timeout`, advertised wait 20 ms) and the model keeps refusing. Defaults: ladder 4 attempts, worker hold budget 8 (`gateway.maxRetries`), takeover 16 models, scheduler relaunch 100.

## Audit (before this change)

| # | Layer (code) | Retries what | Max attempts | Backoff | Who is told | Acts on a 429? |
|---|---|---|---|---|---|---|
| 0 | pi-ai / Pi transport retry | transport errors | worker session sets `retry.enabled=false`; admission transport sets `maxRetries=0` | n/a | nobody | no (disabled) |
| 1 | Admission transport (`inference/admissionTransport.ts`, installed by `lifecycle/harness.ts`) | `type:"inference_admission"` bodies | 50 attempts / 15 min | server floor, 2 s..120 s | telemetry `inference.retry.*` | yes, but already defers when `invocation.resilient` is set (admissionTransport.ts ~1015), so it does not stack under layer 2 |
| 2 | In-call resilient ladder (`inference/resilientStream.ts` + `recovery.ts`, `StreamRetryPolicy`) | replays the same request in the same stream | 4 per model (`streamRetryMaxAttempts`), then `wait_capacity` park | 30/60/120 s ladder, server `Retry-After` is a floor | status line, telemetry, mission park | yes when it can classify the refusal as `honor_retry_after` (status/headers or body metadata). On the bare-text path of the openai-completions provider it classifies `unknown -> fail` and settles at once (measured, below) |
| 3 | Worker gateway hold (`workers/PiWorkerExecutor.ts`: `decideGatewayRetry`, `withinGatewayBudget`, `holdForGateway`) | re-runs the whole attempt after the gateway's advertised wait | 8 holds (`gatewayConfig.maxRetries`); unbounded for a mission worker with an operator pin or an account-wide wait; implicit/model-scoped capacity gives up after 8 | gateway's `retry_after_ms`, escalated for flattened refusals, shared `AdmissionController` cooldown | `WAITING_FOR_INFERENCE` activity, `capacity` telemetry, `/model` hint | yes (the intended owner) |
| 4 | Worker transient retry (`withTransientRetry`) | 5xx, network, timeout, compaction | 4 | 1 s..30 s exponential | transient telemetry | no: a 429 admission refusal is handed over (`decideTransientHandover`), not retried here |
| 5 | Model takeover (`orchestration/realBackends.ts` `runWithModelTakeover`) | moves the run to the next eligible model on `transient:server_unavailable` (capacity), gone model, provider fault, operator switch | 16 models (`MAX_MODEL_TAKEOVER_ATTEMPTS`); explicit operator pin is waited, not abandoned (`pinnedWait`) | none (immediate) | activity notice `switched ... to ...` | on capacity exhaustion (a different decision: migrate) |
| 5b | Router hold pin (`runtime/modelRouting.ts` `holdPin`, `execution.hold_mission_model`) | refuses to offer a replacement, so the task fails with the pinned model's own error | 0 (suppresses layer 5) | n/a | task failure text | no, it only removes layer 5 |
| 6 | Scheduler resilience window (`orchestration/scheduler.ts` `resilienceGate`, `resilience/config.ts`) | relaunches the task on `transient:rate_limit` / `server_unavailable` | 100 relaunches, 20 zero-tool, 12 h window; task `max_attempts` (3) applies to non-transient failures only | probe interval, capped exponential to 3 min | mission `WAITING_*` state | yes (mission-level wait) |
| 7 | Interactive turn (`gateway/streamRetry.ts` pump + `gateway/fallbackLifecycle.ts`) | replays the interactive stream; after 3 holds arms a stand-in model | pump: classifier decides; fallback after `FALLBACK_AFTER_HOLDS=3` | gateway wait | status line | separate path from workers; not stacked with 3/5/6 |

### Multiplication for one sustained 429 (defaults, one worker execution)

Layers 1 and 4 do not stack (1 defers under 2; 4 hands a 429 over). The stacking pair was 2 x 3:

- Before, when layer 2 could classify the refusal: each of the 1 + 8 worker attempts re-entered the ladder for up to 4 requests, so `4 x (1 + 8) = 36` requests on one model, with the ladder sleeping 30 + 60 + 120 s per hold although the gateway advertised 20 ms.
- Takeover then repeats that per model: `16 x 36 = 576`; the scheduler window repeats the whole walk per relaunch: `100 x 576 = 57,600` (theoretical ceiling).
- After this change: `1 + 8 = 9` per model, `16 x 9 = 144` per walk, `100 x 144 = 14,400` ceiling. The ladder factor of 4 is gone; the takeover and window factors are migrations/mission waits, each a decision about a different unit (another model; another relaunch after probes), and are unchanged.

Measured: a real local HTTP gateway (`test/integration/single-retry-owner.test.ts`) with `maxRetries=2` receives exactly `1 + 2 = 3` requests. On that bare-text path the ladder already settles (it classifies `unknown -> fail`), so the 36 above is computed from the code constants plus the unit test that the ladder does replay a classified admission 429 when no worker owns it; it was not reproduced over HTTP because the openai-completions provider does not expose response status to the ladder.

## Transient faults and relaunches (follow-up)

Defaults: ladder 4 attempts, worker transient retry 4 attempts, takeover 16 models, relaunch 100.

### (A) Ladder x worker transient retry (5xx, network, timeout)

- Before: a fault the worker retries (e.g. 503, connection reset) could be replayed by the ladder (4 requests) inside each of the worker's 4 attempts: `4 x 4 = 16` requests for one fault on one model.
- After: `InferenceInvocation.transientRetryOwner = "worker-transient-retry"` (set by the worker around every attempt, whether or not gateway holds are enabled). For a same-model step (`retry`, `wait_capacity`) on a fault the worker's own `classifyError` would retry (`server_error`, `server_unavailable`, `network`, `timeout`), the ladder returns "settle", traces `defer`, and the worker's loop is the only retrier: `4` requests (its budget). Without an owner (non-worker callers) the ladder retries as before. A fault the worker would not retry (e.g. a bare 500, classified permanent) is not deferred, so exactly one layer still retries it.
- Measured: `test/integration/single-retry-owner-transient.test.ts`. Over a real local HTTP server a connection reset costs exactly the worker budget (3 requests with `maxAttempts` 2) and a 5xx costs the gateway-hold budget (the worker reads a 5xx body as a gateway refusal), with and without this change: the provider path does not expose the status/headers the ladder needs, so the 16x is not reproducible over HTTP (same limitation as the 429 case). The ladder's behaviour is pinned by unit assertions: replay without an owner, `defer` with one, for 503 / ECONNRESET.

### (B) Relaunch re-walking the takeover list

- Before: the `tried` set was per `runWithModelTakeover` call, so each scheduler relaunch started on the router's first choice and walked the same dead models again: up to `100 x 16 = 1,600` dead-model attempts per task.
- After: `realBackends` keeps, per `mission|task|role`, the models a walk found dead (capacity, gone, provider fault) with a TTL (`takeoverMemoryTtlMs`, default 15 min). A relaunch swaps a remembered initial model for `plan.next(remembered)` and excludes them from later `next` calls. Result: each dead model is retried at most once per TTL window per task, so `1 x 16` per window rather than `100 x 16`. If every candidate is remembered dead the memory is dropped and the list is walked afresh (no starvation, same as before).
- Why here: `UnavailableModels` is global and for gateway-confirmed gone models; putting a capacity-exhausted model there would remove it from routing for every task. The task record is owned by the scheduler store, which this layer cannot write. In-memory loses the memory on process restart, costing one extra walk.
- Reset / exemptions: an operator pin change (or an operator supersede) clears it; an explicitly pinned model (`operatorPin` route / `operatorPinned` request) is never recorded, never excluded, and never replaced; `takeoverMemoryTtlMs: 0` disables it.

## The rule now

One owner per failure; every other layer records `defer` and stops.

| Failure | Owner | Everyone else |
|---|---|---|
| Gateway admission 429 (same model) | worker gateway hold (layer 3), budget 8 / unbounded for explicit pins | layer 2 settles (`gatewayWaitOwner` on the invocation) and traces `defer`; 1 defers; 4 hands over |
| Capacity exhaustion after the hold budget | model takeover (5), bounded by 16 | layer 3 gave up and traced `give-up`; operator pin is waited out; `hold_mission_model` suppresses 5 |
| Provider outage / long wait | scheduler window (6) | worker returned `transient:*` |

Preserved: explicit operator pin is waited out (`unboundedInferenceWait` + `operatorPinned`), implicit pin gives up after the finite hold count, `hold_mission_model` still fails with the pinned model's own error.

## RetryTrace

`src/inference/retryTrace.ts`: `{ layer, attempt, reason, next, owner }`, `next` in `retry | hold | failover | give-up | defer`. Entries go to `result.details.retry_trace` (worker holds and give-up; takeover failovers; earlier runs' entries are carried across a takeover) and to the telemetry bus event `inference.retry.trace`. `actingLayers(trace)` returns the layers that acted; more than one for one failure is a multiplication bug.

Hand-off flag: `InferenceInvocation.gatewayWaitOwner = "worker-gateway-hold"`, set by the worker around each attempt while `gatewayConfig.enabled`. The ladder settles only for a failure the worker will actually hold on (`isGatewayAdmissionRefusal(text)`) and only for same-model steps (`retry`, `wait_capacity`); model fallback, catalog refresh and permanent failures are untouched.
