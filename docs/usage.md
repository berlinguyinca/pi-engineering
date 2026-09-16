# Usage

`pi-engineering-runtime` runs as a pi extension inside a normal pi install and
works in any git repository. It requires no GitHub, AutoSpec, InferWeave, or
distributed infrastructure. The interactive pi session is used as usual; the
engineering runtime is available **on demand**.

## Install

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

## Running the full workflow

```bash
/engineer implement an isEven(n) helper in src/utils.js
```

The pipeline runs **asynchronously** with progress notifications:

1. **Scout** (fresh context) inspects the repo and recommends the smallest
   coherent change and the files to touch.
2. **Implement** a fresh worker edits an **isolated git worktree** (the main
   branch is never touched by the worker).
3. **Verify** runs deterministic gates (`node --test` etc.) and records evidence.
4. **Review** a fresh, independent reviewer inspects the candidate diff.
5. **Promote** — if clean, the verified change is merged into your working tree
   and the ledger records it. Material findings spawn a fix round (a child
   candidate) instead.

## Individual commands

| Command        | Effect                                                        |
| -------------- | ------------------------------------------------------------- |
| `/engineer G`  | Full adaptive workflow (scout → implement → verify → review). |
| `/tournament G [n]` | Candidate tournament: n independent implementations, verify+review each, promote the deterministic winner (default 3, `--parallel` opt-in). |
| `/plan G`      | Decompose `G` into a dependency-aware task DAG (recorded in the ledger). |
| `/execute [plan]` | Execute a planned task DAG in dependency order via the engineer pipeline. |
| `/review`      | Fresh independent review of the latest candidate.             |
| `/challenge`   | Clean-room challenge of the current approach (fresh context, no prior reasoning). |
| `/verify [full]` | Detect a verification profile and run it, recording evidence (`full` = lint + test:full). |
| `/ledger [kind]` | Show work items + candidates + entities (optionally filter by `kind`, e.g. `/ledger finding`). |
| `/context`     | Show active context usage, ledger size, artifact count, budgets. |
| `/roadmap-status` | Show derived Roadmap 1.0 completion status for this repository. |

## Verifiable roadmap completion

`node scripts/pi-engineering.ts roadmap check` (or `npm run roadmap:check`)
returns a machine verdict: **exit 0** when the roadmap is complete. Completion
is **derived** from evidence bound to commit SHAs (unit/integration/typecheck/
lint/package_load/roadmap_test) + dependencies + freshness + a release gate
(deterministic suites + independent fresh-context review + dogfood). A relevant
change invalidates evidence (`NEEDS_REVERIFICATION`); completion is never
declared by a model. `roadmap status` prints the human summary. The structured
definition lives in `docs/roadmap/roadmap.yaml`; model-dependent evidence is
recorded by `node scripts/record-roadmap-evidence.ts --critical 0 --high 0`
into `docs/roadmap/evidence.yaml`.

## Optional Blackhole session memory

`pi-blackhole` is an **optional** per-session memory/context provider, pinned to
**0.5.4**. It is disabled by default and backward compatible. When enabled it
provides session-local memory with strict candidate isolation, recall into worker
context, evidence-gated promotion through the OpenViking durable-memory
abstraction (never auto-promoted), and lower-priority background memory workers.

```sh
node scripts/pi-engineering.ts blackhole status        # show manager state
node scripts/pi-engineering.ts blackhole validate      # validate pinned version / provider
node scripts/pi-engineering.ts blackhole benchmark     # A/B benchmark (report + 12 SVG plots + raw data)
node scripts/pi-engineering.ts benchmark               # same as `blackhole benchmark`
```

Artifacts are written under `docs/evidence/blackhole/`. The benchmark is a
deterministic, model-free simulator (see the report methodology note) — it
validates the measurement pipeline and shows the expected direction of effect,
not a measured model claim.

### Sharing memory across several workers

Only *evidence-promoted* knowledge is shared; session-local working memory stays
strictly isolated per candidate/reviewer/challenger. The `durable` config selects
the backing store for shared durable memory (default `memory` = single process):

```ts
// Several workers on one host / CI share promoted memory via an append-only JSONL file.
blackhole: { config: { enabled: true, durable: { kind: "shared-file", file: "/shared/durable.jsonl" } } }

// Cross-machine sharing via the external OpenViking service.
blackhole: { config: { enabled: true, durable: { kind: "openviking", baseUrl: "https://openviking.example", token } } }
```

Each `runWorker` hydrates its context from shared durable memory on run, so a
later/other worker consumes knowledge promoted by any earlier worker (spec:
*"accepted promoted memories can be consumed by later sessions"*). Provider
outage degrades hydration to an empty result and never fails the worker.
`pi-engineering blackhole status` reports the active `durable` kind.

### Running the OpenViking service (tier-1)

The `openviking` durable kind points workers at a shared HTTP service. A minimal
containerized implementation lives at `services/openviking/` — a thin,
stateless HTTP layer over a PostgreSQL backing store that serves exactly the
contract `OpenVikingProvider` speaks (POST `/memory`, GET `/memory`,
`GET /memory/search?q=`). Deploy on a single host (e.g. a lab box):

```sh
cd services/openviking
cp .env.example .env     # set OPENVIKING_TOKEN + POSTGRES_PASSWORD
# run the service standalone (in-memory, zero deps) for a quick check:
node src/index.mjs
# or run the durable Postgres-backed deployment:
docker compose up -d --build
```

Because the service is stateless (all memory lives in the Postgres volume), you
can later move it to AWS/Fly.io and keep the data. See
`services/openviking/README.md`. The production deployment runs on the lab's
whiteale server as an Apptainer container behind an nginx virtual host — see
`docs/deployments/openviking-whiteale.md`.

### Installing the connection anywhere pi is installed (no code edits)

Any pi installation that loads this package's **extension** connects to a shared
OpenViking automatically when the environment is set — no per-repo code. Set
these once (e.g. in `~/.bashrc`, a systemd unit, or a `.env` the pi process
loads):

```sh
export PI_OPENVIKING_BASE_URL=https://viking.metabolomics.us
# Bearer token for the service — either inline, or from a file (secret hygiene):
export PI_OPENVIKING_TOKEN=<token>
# or: export PI_OPENVIKING_TOKEN_FILE=/path/to/token.txt
# Optional: bounded wait for the provider (default 10000ms):
export PI_OPENVIKING_PROVIDER_TIMEOUT_MS=10000
# Optional: explicitly force the connection off:
# export PI_OPENVIKING_ENABLED=0
```

When `PI_OPENVIKING_BASE_URL` is set, the extension passes
`blackhole: { config: { enabled: true, durable: { kind: "openviking", ... } } }`
into every `EngineeringRuntime` it opens, so all repos in that install share the
deployed durable memory. Absent the env vars, blackhole stays off (backward
compatible). Verify a connection with `/blackhole` in a pi session, or:

```sh
node scripts/pi-engineering.ts blackhole status
```

The resolver is `src/blackhole/envConfig.ts`; it is fail-closed (a malformed
timeout falls back to the default; a missing token degrades recall to empty
rather than crash).

## Durable state

State lives in `<repoRoot>/.pi-eng/` and is git-ignored:

```
.pi-eng/ledger.jsonl            append-only event stream (work items, candidates, entities)
.pi-eng/artifacts/              candidate diffs, verification logs, scout context
.pi-eng/roadmap/evidence.jsonl  regenerated roadmap evidence (bound to commit SHAs)
```

The ledger is event-sourced and replayed on open, so **no run depends on the
interactive transcript surviving** — you can close and reopen pi and `/ledger`
still shows prior work items, candidates, and evidence.

## Interacting with the ledger

- `/ledger` — all work items and their incumbent candidates.
- `/ledger finding` — open reviewer findings.
- `/ledger hypothesis` — claims not yet promoted to facts.
- `/verify` — run verification yourself and see the captured log artifact.

## Real-model smoke tests

After installing the package, from the repo directory:

```bash
node scripts/smoke-worker.ts    <repo>                 # real fresh worker
node scripts/smoke-engineer.ts  <repo> "your goal"     # full real /engineer
```

These require a configured model endpoint (pi's normal model config). The
deterministic unit/integration tests do **not** require a model.

## InferWeave context capabilities (optional)

When the workspace has an InferWeave gateway, the harness can take model context
sizes from the gateway instead of a static config, and show context pressure in
the status footer. Enable it by pointing at the gateway:

```bash
export INFERWEAVE_BASE_URL=http://gw.internal:8787/v1   # enables the integration
export INFERWEAVE_PROVIDER=inferweave                    # provider id shown in /model
export INFERWEAVE_TTL_SECONDS=300                        # capability cache TTL
export INFERWEAVE_STALE_SECONDS=3600                     # stale-if-error bound
export INFERWEAVE_TIMEOUT_MS=5000                        # refresh deadline
export INFERWEAVE_MAX_CAPABILITY_LOOKUPS=8               # per-refresh cap on per-model capability fetches
# Optional explicit windows; `unsafe` is required to exceed the gateway guarantee:
export INFERWEAVE_MODEL_CONTEXT="qwen3.8-27b=262144:32768,small-model=32768"
```

What that buys you:

- **Discovery through Pi's own `refreshModels` hook.** `contextWindow` becomes
  the gateway's *guaranteed routable* context and `maxTokens` its advertised
  output maximum, so a 1M deployment is not squeezed to 262 144 and a 262 144
  deployment is not promised 1M. Nothing is forked or patched in Pi core, and Pi's
  native compaction (including overflow recovery) stays in charge — the harness
  does not summarize anything itself.
- **One shared capability client per process**, with ETag revalidation, TTL,
  timeout, `AbortSignal` and stale-if-error, so a fan-out of subagents does not
  stampede `/v1/models`.
- **A context reading in the existing status footer**, next to the model:
  `… │ acme/qwen3.8-27b │ ctx 143k/262k 55% │ ⚡ 31.0 t/s`. It renders the window
  the capability layer resolved for the *selected* model, so switching models
  changes the number. `PI_STATUS_BAR_SHOW_CONTEXT=0` hides the segment; the other
  `PI_STATUS_BAR_*` knobs are unchanged.
- **A model-switch guard.** Switching to a narrower window compacts through Pi
  before the next request; a switch into a window that cannot hold the session is
  refused with a reason instead of failing later as an upstream error.
- **`/iw-context [model]`** prints the resolved window and which rule produced it
  (`guaranteed_routable_tokens`, `context_window`, `max_model_len`,
  `local_override`, `last_known_good`, `conservative_fallback`), the capability
  generation, age, source, staleness, heterogeneity, and any refused unsafe
  override.

Without `INFERWEAVE_BASE_URL` the integration is inert and the footer shows
context only when Pi reports a window. The floor when nothing trustworthy is
known is **128 000** tokens — never 260 000/262 144, which came from an admission
implementation rather than from any model.
