# pi-engineering-runtime

An autonomous **engineering runtime** for the **pi** coding agent: a durable
Engineering Ledger, fresh-context scouts/implementers/reviewers, isolated
candidate worktrees, deterministic verification, and a risk-adaptive
multi-agent workflow — all in-process with a normal pi install, no GitHub,
no AutoSpec, no InferWeave, no distributed infra, and no extra models.

> The authoritative design specification is
> [docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md](docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md).
> Operating policy for agents working in this repo is in
> [AGENTS.md](AGENTS.md).

## What it does

Given a goal, `/engineer` runs the full vertical slice:

```
inspect repo ──▶ scout (fresh context) ──▶ bounded task context
    ──▶ implement (isolated git worktree) ──▶ deterministic verification
    ──▶ independent review (fresh context) ──▶ controlled merge/promotion
    ──▶ evidence recorded in the durable ledger
```

Material review findings trigger fix rounds; each fix runs as a *child*
candidate in a fresh worktree. Nothing about a run depends on the interactive
transcript surviving — all state is on disk in `.pi-eng/` (ledger + artifacts +
roadmap evidence). When the repository's Roadmap 1.0 is complete,
`/engineer`, `/plan`, `/tournament`, and `/execute` refuse to invent new work
(autonomous stop) — the runtime does not keep manufacturing work past "done".

## Install as a pi extension

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

## Commands

| Command            | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `/engineer G`      | Run the full adaptive workflow for goal `G`                    |
| `/tournament G [n]` | N independent implementations; verify+review each; promote the deterministic winner (default 3, `--parallel` opt-in) |
| `/plan G`         | Decompose `G` into a dependency-aware task DAG (recorded in the ledger) |
| `/execute [plan]` | Execute a planned task DAG in dependency order via the engineer pipeline |
| `/review`         | Fresh-context independent review of the current candidate      |
| `/challenge`      | Clean-room challenge of the current approach (no prior reasoning) |
| `/verify [full]`  | Run risk-appropriate verification, record deterministic evidence (`full` = lint + test:full) |
| `/ledger [k]`     | Show work items, candidates, and ledger entities (optionally filtered) |
| `/context`        | Show context budget, sources, and worker usage                 |
| `/roadmap-status` | Show derived Roadmap 1.0 completion status for this repository |
| `/blackhole [--dashboard]` | Show optional Blackhole session-memory status (disabled by default) |
| `/remember <text>` | Explicitly save a private Viking note (up to 4,000 characters) |
| `/memory [query]` | Verify the memory connection, or search saved notes |
| `/memory setup` | Configure or change the Viking host and access key |

### Everyday memory

On the first interactive Pi start after installing or updating this extension,
the setup dialog asks you to confirm or change the Viking connection. Existing
environment/token-file settings can be kept. Changed credentials are entered
in a masked field and verified before they are saved. Settings and private key
files live under `~/.pi/agent/engineering-memory/` (or the active
`PI_CODING_AGENT_DIR`), outside the extension checkout. Updates preserve them.
Cancelled setup can be retried with `/memory setup`; headless sessions never
block for a dialog. The update command itself does not need an interactive
credential hook: the check runs when Pi next loads the updated extension.

```text
/remember Calibration reports should use metric units.
/memory calibration
```

Ordinary chat prompts automatically recall a small set of keyword-matching
notes. The footer shows `Memory: ready`, match counts, or a specific connection
failure. `/memory` distinguishes a healthy empty store from a rejected key.
Automatic recall is ephemeral model context, inserted before the current user
request; it is not copied into the saved transcript. Only `/remember` writes
notes—normal conversations are not automatically uploaded or promoted.

Saving requires a read/write device key. Read-only keys can recall but cannot
save. Treat saved notes as user-provided reference information, not proof that
claims were machine-verified. Independent review/challenge workers do not load
these interactive hooks. Existing engineering-worker hydration is preserved.

Confirmed profile settings override old shell host/key defaults. Set
`PI_OPENVIKING_ENABLED=0` to disable all memory access for a launcher. A token
file rotation is picked up by subsequent memory operations; changing host/key
also refreshes the cached engineering runtime on the next engineering command.
See [the feature design](docs/specs/2026-09-14-everyday-viking-memory.md) for limits
and verification boundaries.

### Blackhole session memory (optional, off by default)

`pi-blackhole` can act as an **optional per-session memory/context provider** (pinned to
version **0.5.4**). It is fully backward compatible: when omitted or disabled the runtime
behaves exactly as before (no sessions, no events). When enabled, each worker session gets
an isolated session-local memory store; prior memory is recalled into worker context for
context-efficiency; background Observer/Reflector/Dropper workers run at lower priority
(P3/P4) via the model router + scheduler; and promoted durable memory flows through the
OpenViking abstraction with an **evidence-gated promotion workflow** (never auto-promoted)
that emits audit events to the authoritative EventStore.

CLI: `pi-engineering blackhole status|validate|benchmark`. A native-vs-Blackhole A/B
benchmark generates a report + **12 SVG plots** and preserves raw JSONL/CSV under
`docs/evidence/blackhole/`. See `docs/specs/PI_BLACKHOLE_INTEGRATION_SPEC.md`.

**Sharing memory across workers:** the `durable` config selects the backing store for
*evidence-promoted* knowledge (`memory` default, `shared-file` for several workers on
one host / CI, `openviking` for the external cross-machine service). Each worker
hydrates its context from shared durable memory on run, so promoted knowledge is
consumed by later/other workers while session-local working memory stays isolated:

`pi-engineering roadmap check` (also `npm run roadmap:check`) returns a
**verifiable completion verdict**: exit **0** when every required milestone is
VERIFIED with fresh evidence, the release gate passes (deterministic suites +
independent fresh-context review + dogfood), and no unresolved critical/high
findings remain. Completion is **derived from machine evidence bound to commit
SHAs** — never declared by a model. `pi-engineering roadmap status` prints the
human summary. See `docs/roadmap/roadmap.yaml` and
`docs/specs/pi-engineering-verifiable-roadmap-completion-spec.md`. The roadmap
engine is also exported as a public API from `src/index.ts`.

## Generation guard

Streaming output is watched for degeneration — a model looping on the same
sentence, or generating without ever acting. The guard is fed the *incremental*
stream delta, so a token is charged to its budgets exactly once; it measures
each budget over the segment **since the last progress event**, so a turn that
keeps calling tools is never charged for text it already paid for, and a loop
that starts mid-turn is still caught.

Two profiles, because the deliverable differs:

| Profile | Deliverable | Detectors |
| ------- | ----------- | --------- |
| worker (`/engineer` scouts, implementers, reviewers) | a `worker_result` tool call | repetition, no-progress, pre-action narration budget |
| interactive (your own Pi session) | the assistant's prose answer | repetition, plus a wide no-progress backstop |

The pre-action narration budget is **off** interactively: there, prose *is* the
answer, and nothing in the stream distinguishes a long answer from narration
until the turn is over — enforcing it aborts healthy replies.

Tuning (all optional):

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PI_GUARD_ENABLED` | `true` | Disable the guard entirely |
| `PI_GUARD_SENTENCE_THRESHOLD` | `4` | Identical sentences within the window that count as a loop |
| `PI_GUARD_WINDOW` | `8` | Rolling sentence window |
| `PI_GUARD_MAX_REASONING_TOKENS` | `1500` | Worker no-progress budget, per segment |
| `PI_GUARD_MAX_NARRATION_TOKENS` | `600` | Worker pre-action narration budget |
| `PI_GUARD_NARRATION_BUDGET` | `true` | Enforce the narration budget (worker profile) |
| `PI_GUARD_INTERACTIVE_MAX_NO_PROGRESS_TOKENS` | `12000` | Interactive no-progress backstop |
| `PI_GUARD_MAX_RECOVERY` | `3` | Recovery-ladder attempts after a degeneration abort |
| `PI_GUARD_TELEMETRY` | `true` | Emit `[generation-guard]` events on stderr |

## Model-gateway backpressure

A gateway in front of the model reports exactly how long to stay away and how
many concurrent requests it will admit:

```
429: {"active":4,"active_limit":4,"reason":"queue_timeout","retry_after_ms":30000,
      "scope":"agent","type":"inference_admission", …}
```

Pi's own auto-retry ignores both and backs off exponentially (1s, 2s, 4s against
a 30s ask), so the runtime reads the refusal itself:

* the reported `retry_after_ms` (body) or `Retry-After` (header) is honoured
  as-is, capped by `PI_GATEWAY_MAX_WAIT_MS`;
* the cooldown is held **process-wide** — every model caller waits behind one
  gate, so parallel tournament legs stop hammering a queue that just refused
  one of them, and the interactive session holds its next request too (every
  hold is announced, so a wait is never a silent stall);
* concurrency is capped at `PI_GATEWAY_MAX_CONCURRENCY` minus a slot reserved
  for your own interactive turn — held from the start, since the window before
  the first refusal is exactly when the gateway gets overloaded — and clamped
  further when a gateway reports a smaller `active_limit`, relaxing back after
  clean runs (never past the reserve);
* waiters are released with a small random stagger, so an expiring cooldown
  does not put every leg back on the wire in the same millisecond;
* quota/billing refusals are classified as non-retryable and fail fast.

Waiting out backpressure is deliberately **separate** from the degeneration
recovery ladder: a queue timeout is not a degeneration, and must not burn
attempts lowering reasoning effort or swapping models.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PI_GATEWAY_ADMISSION_ENABLED` | `true` | Disable admission control entirely |
| `PI_GATEWAY_MAX_CONCURRENCY` | `4` | Total concurrent model requests this runtime aims at |
| `PI_GATEWAY_RESERVED_SLOTS` | `1` | Of that total, slots kept free for your interactive turn (so 3 worker sessions by default, held from the start) |
| `PI_GATEWAY_MAX_WAIT_MS` | `120000` | Cap on a single honoured wait |
| `PI_GATEWAY_JITTER_MS` | `250` | Release stagger window |
| `PI_GATEWAY_MAX_RETRIES` | `4` | Gateway-wait retries per worker attempt |
| `PI_GATEWAY_TELEMETRY` | `true` | Emit `[gateway-admission]` events on stderr |

## Semantic tools

`ledger_read`, `ledger_claim`, `artifact_read`, `repo_search`, `symbol`,
`tests_for` — bound to the runtime for the current working directory, so
workers and the interactive session can retrieve task context cheaply.

## How to use it

1. `pi install /absolute/path/to/pi-engineering-runtime`
2. In any git repo: `/engineer implement an isEven(n) helper in src/utils.js`
3. Watch the scout → implement → verify → review → promote pipeline; the
   verified change is merged into your working tree, and the ledger records
   every claim, hypothesis, finding, and piece of evidence.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test (unit + integration, deterministic)
```

- Tests run via `node --test` (Node >= 22.6 native type-stripping); imports use
  explicit `.ts` extensions.
- `test/fixtures/make-fixture.ts` builds temporary git fixture repos.
- `test/integration/vertical-slice.test.ts` is the end-to-end slice using a
  deterministic fake worker; real-model execution is exercised by
  `scripts/smoke-*.ts`.

## Structure

```
extensions/          pi extension entry point (commands + tools)
src/core/            domain types + ids
src/ledger/          append-only event store + event-sourced ledger
src/artifacts/       filesystem artifact store (artifact:// URIs)
src/git/             worktree isolation + diff capture + controlled merge
src/context/         bounded task-context broker (repo map + git grep)
src/verify/          deterministic CommandVerifier + provider abstraction
src/verify/farm/     verification-farm depth (test-impact, adversarial, mutation, differential, perf)
src/plan/            dependency-aware task DAG planning (+ parallel execution)
src/roadmap/         verifiable roadmap completion engine (check/status/evidence)
src/routing/         capability+quota model routing + separation-of-duties diversity
src/sched/           weighted-fairness concurrency scheduler + backpressure
src/gateway/         model-gateway backpressure (honours reported retry_after_ms / active_limit)
src/guard/           generation guard (degeneration detection + bounded recovery ladder)
src/budget/          token-budget escalation + marginal-value stopping
src/security/        secret redaction, tool policy, prompt-injection guardrails
src/merge/           integration & merge queue (candidate→integration→main)
src/intel/           dependency-free repo symbol index (+ optional LSP seam)
src/bench/           engineering benchmark with baseline gate
src/adapters/        optional AutoSpec/InferWeave seams (empty by default)
src/telemetry/       deterministic telemetry export for external control planes
src/blackhole/       optional per-session memory provider (pinned 0.5.4, builtin default)
src/blackhole/durable.ts  shared durable-memory providers (shared-file, OpenViking HTTP)
src/benchmark/       native-vs-Blackhole A/B benchmark (report + 12 SVG plots + raw data)
src/workers/         role prompts + bounded worker_result tool + executors
src/runtime/         EngineeringRuntime facade (plan/engineer/tournament/review/challenge)
src/tools/           semantic tools bound per-cwd
scripts/             real-model smoke tests + roadmap CLI + evidence recording
.github/workflows/   CI (typecheck, lint, tests, package-load, roadmap:check)
```

## License

MIT
