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

## Orchestration missions (automatic, no slash command required)

Normal-language intent automatically invokes the orchestration workflow through
the semantic `mission` tool. An optional `/mission <request>` command runs the
same pipeline explicitly (correctness never depends on it). See
[`docs/orchestration.md`](orchestration.md) for the full design.

```bash
/mission Add a health endpoint
/mission Find out why login fails
/mission-status
```

The pipeline routes intent, creates a durable **mission**, plans/executes
workers, runs validation, launches a fresh independent reviewer, and enforces
the deterministic completion gate — no `/engineer` or `/review` needed.

### When a worker reaches a configured wall-clock limit

A mutating worker runs in a fresh isolated worktree. A task has no wall-clock
limit by default (see [Mission time limits](mission-time-limits.md)). When an
operator configured one (`limits.max_task_wall_clock_ms`, or a task's explicit
`execution_budget_ms`, including the 30-minute budget persisted on tasks created
before limits became opt-in), the worker may reach it without committing. If
its activity shows build commands (cargo, npm, gradle, ...), the mission's
failure reason and a `major` `execution_budget` finding say how much of the run
went to building. Two examples:

- "probable cold build in an isolated worktree: the worker spent 20m 0s of the
  30m 0s run in 12 build command(s) (cargo x12), 1 still running at the
  deadline, and made no commit"
- "... builds took the smaller part of the budget, so most of it went to other
  work (model turns, other commands)"

The runtime records only which build tool a command used and how long it ran,
never the command itself. The "cold build" wording appears only when builds
took most of the run.

A fresh worktree has no `target/`. Do not point every worker at one shared
`CARGO_TARGET_DIR`, for example by exporting it in the shell that starts pi.
Cargo identifies a workspace crate by its path relative to the workspace root
and decides freshness by mtime. Two worktrees sharing a target directory
therefore share artifacts for the repository's own crates. A worktree whose
sources are older than another worktree's last build reuses that build, so one
worker's tests run against another worker's code. Node needs no setup: the
repository's `node_modules` is symlinked into each worktree.

### Workspace scope

A mission may write only to the repositories it was clearly asked to change.
State the scope with directive lines. They take priority over everything else
in the request:

```text
writable: /home/me/src/service, /home/me/src/client
read-only: /home/me/src/shared-lib
Port the retry logic from shared-lib into both apps.
```

Recognized keys (case-insensitive; also as list items, inside a fenced block,
or as `do not modify:` followed by a list): `writable:`, `write:`, `target:`,
`targets:` grant write; `read-only:`, `readonly:`, `read only:`,
`reference:`, `references:`, `do not modify:` grant read only. If any
`writable:`/`target:` line is present, no other path is writable. A path that
is named both writable and read-only is refused. So is a writable root that
contains a read-only path, because a writable root cannot have a read-only
hole inside it.

Without directives the request text is read conservatively:

- A path is writable only if a change verb (fix, add, implement, update,
  install, refactor, port, …) is aimed at it and no restriction applies to it.
  If exactly one path is named and nothing restricts it, it is the target
  even without a verb.
- **Strong** restriction words make every path in their sentence (and in a
  list whose intro or header uses them) read-only: do not, don't, never,
  must not, avoid, skip, ignore, exclude, except, leave … alone, untouched,
  unchanged, must stay/remain, keep … as is, hands off, off-limits,
  read-only, refrain, forbidden, not allowed, reference, for context.
  There are three narrow exceptions:
  - In `Fix /a, but don't touch /b`, /a stays writable. The restriction sits
    in its own clause (split on `,` `;` `but` `and` `except`) and that clause
    names its own path.
  - With exactly one path named, a restriction about something else leaves
    it writable. Examples: "do not change the public API", "don't touch the
    CI config". A pronoun or repository noun ("do not modify it", "the
    repository") does not get this exception.
  - Result clauses are outcomes, not exclusions: "so it no longer crashes",
    "so that it does not leak", "to not use".
- **Weak** words restrict a path only when they sit right before it (or a
  negation right after it): no, not, nothing, none, without, `n't`, and the
  reference words review, analyze, inspect, look at, compare, copy, mirror,
  follow, port. `from /path` marks a source, so in
  `Port the change from /r into /t`, /r is read-only and /t is writable.
- A path that is read-only anywhere in the request is read-only everywhere,
  and so is everything inside it. `Only change /a` makes every other named
  path read-only.
- The launch repository stays the default target when every named path is an
  input or scratch location outside any repository (`~/Downloads`, `/tmp/…`,
  a log file), or lies inside the launch repository. Naming another
  repository, excluding the launch directory, an unexpandable path
  (`$HOME/x`, `C:\x`, `~user/x`, an existing `../x` outside the launch
  directory), or a restriction on "anything here" or "this repo" rules the
  default out.
- When a verb is aimed straight at a missing path, the request is refused.
  This covers a typo, an uncloned repository, a near-miss of an existing
  directory, or `~/x`. A protected path such as `/etc`, `~/.ssh` or `~/.pi`
  is refused the same way.

When the request does not grant write clearly, the mission is refused with a
message that names the directive syntax. Adding one `writable:` line is the
fix.

### Switching the model a mission uses

An explicit switch with `/model` (or model cycling) becomes the **operator
pin**. Every mission started from (or resumed in) this Pi process adopts it at
its next inference boundary:

- the next worker dispatch, including scout workers;
- for planner/worker (`PW-`) missions, the next contract dispatch, replan or
  review;
- a worker that is waiting for gateway capacity.

A stream already in progress is never interrupted. The pin wins over
`engineering.yaml` role pins and the capability router for every worker role,
with these exceptions:

- If the router or the gateway catalogue knows the pinned model cannot serve a
  role, that role is routed as usual and the mission says why. Reasons include a
  missing capability such as vision, a context window that is too small, no tool
  calling, or an unhealthy model.
- An independent reviewer never runs on the model that produced the work.
- In planner/worker missions the planner and the implementer stay on different
  models when another capable model exists. If the pinned model is the only one,
  both use it and the `MODEL_TRANSITION` says why.
- A reviewer may run on the pinned model when that model did not produce the
  work. The pinned model is usually also your interactive model.

**Scope.** The pin belongs to the Pi process, not to one conversation. The
runtime session id is a single id per process, so every mission that process
starts or resumes counts as "this session's". `/new` clears the pin for all of
them. Missions started by other Pi processes are not affected.

**Persistence.** Each mission that adopts the pin stores it, so the pin survives
a restart. A stored pin keeps overriding role pins after the restart. It also
keeps the mission waiting on that model when the model is out of capacity: a
pinned model is never given up for an alternate. Each adoption is logged as a
`MODEL_TRANSITION`. `/engineering-status` and mission status show
`model: X (operator pin)`.

**Releasing it.**

- `/engineering-model auto` clears the process pin and releases the pins stored
  on this process's live missions.
- Switching back to the model the session started on clears the process pin.
- `/mission resume <id> --model auto` releases one mission, for example a
  mission from before a restart. The mission tool's `clear_pin` action does the
  same.

A released mission uses role pins and the router until you switch models again.

Automatic fallback of the interactive model (`PI_GATEWAY_MODEL_FALLBACK_ENABLED`)
is still off by default, and a switch it makes is not an operator pin.

### Interrupting and cancelling a mission

Pressing Esc while the `mission` tool or `/mission` runs **pauses** the mission
instead of cancelling it. In-flight work stops, interrupted tasks stay
resumable, and progress is kept. The mission waits until you continue it with
`/mission resume <id>` or the tool's `resume` action. A resumed mission keeps its
operator pin. Only an explicit cancel ends a healthy mission: `/mission cancel
<id>`, or the tool's `cancel` action.

The pause is recorded on the mission the moment Esc lands. Until you resume it,
nothing automatic resumes it: not the supervisor, not infrastructure
auto-resume, not repair. The pause shows wherever a mission's state shows:
mission status, `/mission-status`, the tool's status action, `/engineering-status`
and the Engineering panel. It reads `PAUSED by operator at <time> — automatic
repair is off; resume with /mission resume <id> (add --model auto to release a
model pin)`, next to the mission's operator pin if it has one. It survives a
restart and clears on `/mission resume` or `/mission cancel`.

A mission that cannot pause stays in the state it is in and is not cancelled;
the tool reports "interrupt noted". This covers a mission that is
`NEEDS_ATTENTION`, `BLOCKED` or `WAITING_FOR_USER`. An interrupt that arrives
before any work was planned still cancels, because there is nothing to keep.

When a mission worker's model runs out of capacity (`queue_deadline_exceeded`,
`queue_timeout`, `CAPACITY_EXHAUSTED`), the mission keeps waiting with no
deadline. It shows `model X is out of capacity; … switch with /model to
continue`, so you can move it without cancelling. A switch ends a capacity hold
within about a quarter of a second, without waiting out the gateway's advertised
retry time. The next request then goes to the new model.

`/refresh-models` probes each model with one minimal request: 64 output tokens, no
streaming, no tools, no images. A model whose probe gets HTTP 400 is retried
once without the optional parameters (`temperature`, `reasoning_effort`). Each
model gets its own verdict:

- **working**: any answer with a completion, applied. A reasoning model that
  spends the whole budget thinking (empty text, `finish_reason: length`) is
  served. Models configured with `reasoning: true` get a 256-token budget.
- **excluded**: 404 or `model_not_found`, and the model is also gone from a
  fresh `/models` listing. Pruned. A 404 for a model that is still listed, or
  one the listing cannot confirm, is inconclusive.
- **rejected**: still 400, 413 or 422 after the retry.
- **inconclusive**: 429, 5xx or a timeout.

Rejected and inconclusive models keep their configured entry, are never added,
and are listed with the gateway's own error text. Only an authentication or
account-wide refusal stops a provider's refresh. In that case its configuration
is left as it was.

## Planner/worker execution mode

`/mission` can split a mission across models by cognitive role. A planner turns
the mission into a validated DAG of bounded task contracts. Implementers then
carry out each contract in its own git worktree, in parallel where the
contracts are independent, and a reviewer judges every result. Roles resolve
through gateway aliases and capabilities, never model names. Escalation,
convergence detection and replanning are automatic. Design:
[`docs/specs/planner-worker-hot-model-routing.md`](specs/planner-worker-hot-model-routing.md).
Gateway contract:
[`docs/specs/planner-worker-inferweave-contract.md`](specs/planner-worker-inferweave-contract.md).

```bash
/engineering-mode            # show: auto (default) | planner-worker | single
/engineering-mode planner-worker
/engineering-status          # planner, workers, reviewer, attempts, escalations
/engineering-plan            # the contract DAG by layer
/engineering-workers         # contracts + per role/model telemetry + MODEL_TRANSITIONs
npm run bench:planner-worker -- --base-url http://localhost:8081/v1   # modes A-D
```

In `auto` mode, planner-worker runs only when all of these hold:

- the mission is a nontrivial engineering change;
- the gateway advertises role capabilities or aliases;
- the gateway can serve the planner and the implementer on distinct models.

Otherwise `/mission` runs the existing single-model orchestrator unchanged.

Configuration lives in `engineering.yaml` under `planner_worker:`. It covers
`mode`, `provider`, `concurrency`, `roles.<role>` (`capability`, `alias`,
`preferred_family`, `min_context`), `escalation` and `convergence`. State is
written to `.pi-eng/planner-worker/<mission>/state.json` and
`transitions.jsonl`. An interrupted mission resumes with
`/mission resume PW-<id>`. Contracts already merged into the mission branch
are kept and are not run again. Missions are bounded by attempts and
convergence (stall detection), not by wall-clock budgets. Route swaps on
InferWeave (`/iw/v1/routes/events`) are followed between requests, without a
restart.

## Individual commands

| Command        | Effect                                                        |
| -------------- | ------------------------------------------------------------- |
| `/mission G`   | Orchestration mission pipeline (intent → plan → execute → validate → review → complete). Esc pauses it; `/mission resume <id>` continues it and `/mission cancel <id>` ends it. |
| `/mission-status` | Show orchestration mission/task/execution status.          |
| `/engineering-mode [m]` | Show or set the execution mode (`auto`, `planner-worker`, `single`). |
| `/engineering-status` / `-plan` / `-workers` | Planner/worker mission status, contract DAG, role/model telemetry. `-status` also shows the session's mission model (`model: X (operator pin)`). |
| `/engineering-model [auto]` | Show the model this session's missions use; `auto` clears the operator pin set by `/model`. |
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
| `/engineering admission` | Show a live InferWeave admission-retry summary (retries, waited time, reasons, saturation). |

## Tool-call guard

The extension guards the session's own tool calls (`src/guard/toolCallGuard.ts`,
on by default):

- An identical tool call (same tool, same arguments) repeated more than
  `PI_REPEATED_TOOL_CALL_LIMIT` times in a row (default 8) is blocked. A single
  read-only status query (`gh pr checks`, `gh run view`, `git status`,
  `squeue`, …, optionally after `sleep N &&`) is polling and gets ten times
  that limit.
- A bash test/build command (`npm test`, `cargo build`, `make`, … at command
  position) with no explicit `timeout` gets `PI_BASH_TEST_TIMEOUT_SEC`
  (default 3600). This is a wall-clock limit: the hook cannot observe output
  activity. Pass an explicit `timeout` for longer builds.
- A command that just timed out is refused when re-run unchanged, unless the
  re-run raises its `timeout`; the refusal expires after three other tool
  calls. A user abort (Esc) never blocks a re-run.

`PI_TOOL_CALL_GUARD=0` turns the guard off.

## Verification commands

`/verify` and the mission validators run the repository's own checks. npm
`typecheck`/`check`, `test` and `build` scripts win when declared (npm's
`no test specified` placeholder does not count); otherwise the root's
`Cargo.toml`, `go.mod`, pytest configuration or `Makefile` decide, also in a
mixed repository whose `package.json` only carries lint/format scripts. Each
command runs in its own process group, killed after 15 minutes without output.
When Pi exits — normally or on an uncaught exception — every running
verification group is killed; a `SIGKILL` of Pi itself cannot run that cleanup,
so a group can outlive it in that one case.

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
your-host server as an Apptainer container behind an nginx virtual host — see
`docs/deployments/openviking-deployment.md`.

### Installing the connection anywhere pi is installed (no code edits)

Any pi installation that loads this package's **extension** connects to a shared
OpenViking automatically when the environment is set — no per-repo code. Set
these once (e.g. in `~/.bashrc`, a systemd unit, or a `.env` the pi process
loads):

```sh
export PI_OPENVIKING_BASE_URL=https://viking.example.com
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

### Concurrent sessions, parent-directory launches, and recovery

Concurrency is a supported operating mode — there is nothing to configure.
Open as many Pi sessions as you like, from inside a repository or from a parent
directory (`cd ~/IdeaProjects && pi`), on the same or different repositories and
worktrees:

- **Machine-local runtime state.** Coordination state lives under
  `$XDG_STATE_HOME/pi-engineering` (default `~/.local/state/pi-engineering`):
  a SQLite (WAL) session registry with generation-fenced leases, and one
  orchestration namespace per git worktree (`worktrees/<worktree-id>/`,
  identified by git common dir + worktree root, never by directory name).
- **Per-session writers.** Each session appends only to its own stream
  (`events/<session-id>.jsonl`); readers see one merged history. There is no
  shared writer lock to contend on, so a second session never disables
  engineering features.
- **Parent launches follow the work.** A session started in a parent directory
  binds to the worktree you actually work in (the first nested repository whose
  files it touches) and rebinds transactionally when you move to another one.
- **Self-healing.** Crashed sessions (SIGKILL, OOM, reboot) are detected from
  PID + process start time + boot id at the next start; their ownership is
  reclaimed, a torn final record is quarantined and truncated (valid history is
  kept), and their missions are adopted by a live session. Stale or garbage lock
  metadata is quarantined, never fatal.
- **Legacy stores** (`.pi-eng/orchestration.jsonl`) are imported automatically
  and left untouched.
- **Introspection.** `/pi-engineering status` shows the bound worktree,
  session, health, writer, concurrent sessions and heartbeat;
  `/pi-engineering events` lists recent runtime decisions (also logged to
  `sessions/<id>/runtime.jsonl`; set `PI_ENGINEERING_DEBUG_RUNTIME=1` to see them
  live). `pi-engineering doctor [--repair]` (or `/pi-engineering doctor`)
  inspects everything and performs only safe repairs.

Expert overrides: `PI_ENGINEERING_STATE_DIR` relocates all runtime state;
`PI_ENGINEERING_ORCHESTRATION_DIR` pins every worktree's orchestration namespace
to one directory — still with per-session writers, never a single shared writer.
If the state directory is on a network filesystem (NFS, SMB, Lustre, BeeGFS…),
the SQLite registry is kept on a machine-local runtime directory automatically.

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
