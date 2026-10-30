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

When no Viking connection is configured, interactive Pi offers a setup dialog.
An existing connection is preserved across updates; use `/memory setup` to
change it. Existing environment/token-file settings can be kept. Changed credentials are entered
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

Automatic startup recall and per-prompt searches wait at most 250 ms, so a slow
memory service does not hold up the model turn for seconds. A timed-out lookup
adds no notes to that turn. Successful searches, including empty results, are
cached for 60 seconds with at most 32 query entries. Saving a note, a successful
explicit memory check/search, session replacement, or a changed host/key clears
the cache. Transient failures pause automatic requests for 60 seconds; rejected
or forbidden keys pause them for five minutes. `/memory` and `/memory setup`
remain available during that pause, and changing the host or key retries
immediately. Explicit commands retain their longer, bounded verification wait.
Starting another turn does not cancel a pending explicit memory command. A
completed save/check/search invalidates older automatic lookups; replacing the
session or connection still fences results from the retired context.

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

## External mission entry (AutoSpec adapter)

`pi-engineering mission submit|observe|cancel` is a JSON entry point for an
external system (AutoSpec) to hand Pi a mission and watch or stop it: `submit`
creates (or re-confirms) a mission and returns its fencing token, `observe`
reads a mission snapshot, `cancel` stops it. Pi stays the mission's owner.
The entry is off unless `PI_AUTOSPEC_ENABLED` is set (`1` or `true`) and never
runs inside a mission worker. See the [External mission entry](docs/usage.md#external-mission-entry-autospec-adapter)
section in `docs/usage.md` for the request/response contract and exit codes.

## Automatic engineering lifecycle & capability-aware model router

The runtime ships an **automatic engineering harness** that owns the lifecycle
for ordinary engineering turns — no `/review`, `/verify`, or reviewer command
is needed from the parent model.

- **Automatic activation** — when the agent settles after a turn, the harness
  runs one lifecycle pass: classify → implement → verify → independent +
  specialist review → gate. Non-engineering chat with no repository change
  stays passive.
- **Harness-owned completion** — the parent model cannot self-declare success.
  The completion gate decides, and the harness records the completion
  timestamp. When the gate fails, the harness injects a remediation follow-up.
- **Capability-aware routing** — models are auto-discovered from configured
  providers and routed to each role by capability, availability, observed
  performance, and cost, with overrides and fallback. Every routing decision
  is fully explainable (candidates, rejects, rationale).
- **Independent & specialist review** — reviewers are never the implementing
  model; specialist reviewers are triggered by change category.
- **Verification & spec verification** — declared commands (package scripts,
  CI, AGENTS.md, Makefile) are run as evidence; specs are verified when
  referenced.
- **Vision routing** — UI/visual work or attached images route to a
  vision-capable model or force a hand-off.
- **Destructive-operation gating** — SSH, remote administration, Ansible,
  deployment, package installs, and server starts are preserved but gated
  behind risk-aware approval; irreversible operations (recursive deletes,
  DROP/TRUNCATE, force-push, `terraform destroy`) are blocked or
  approval-gated — never blanket-disabled.

Implementation spec:
[docs/specs/pi-automatic-engineering-lifecycle-model-router-spec.md](docs/specs/pi-automatic-engineering-lifecycle-model-router-spec.md).

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
  **in full** — clamping a wait the gateway asked for only sends the retry back
  into the same saturated queue and earns the same 429;
* saturation is a wait, never a failure: transient conditions are waited out
  for hours (see *Long transient outages* below), never ended by an attempt
  count;
* the cooldown is held **process-wide** — every model caller waits behind one
  gate, so parallel tournament legs stop hammering a queue that just refused
  one of them, and the interactive session holds its next request too;
* a hold is visible in the status bar (spinner, countdown, and your position in
  the gateway's queue) rather than as repeated warnings, and **escape ends the
  hold** for your turn — an unbounded wait you cannot cancel is a wedged
  session, and one operator escaping does not tell the gateway it has capacity
  again, so the cooldown stands for everyone else;
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

Mission scheduling uses advertised capacity only for an unambiguous selected
provider/model route. Refreshing another provider cannot change that route's
limit. If routing has not selected a concrete model yet, or a provider name
identifies multiple endpoints, scheduling uses configured limits instead of an
unrelated catalogue maximum. Explicit scheduler limits remain authoritative;
model-capacity signals do not block local process or validation tasks.

### Long transient outages: wait for hours, fail only on permanent errors

A model reloading or moving to another GPU, `capacity_unavailable` /
`model_activating` / `no worker`, a node restarting for a deployment
(`node_updating`: HTTP 503, `Retry-After: 30`, shown as "updating node, please
retry in 30 s"), a gateway restart, a link cut, an expired
routing snapshot or a queue timeout can last **hours**. None of them ends an
interactive turn or a mission early. The **elapsed horizon** ends a wait;
attempt counts never do. Permanent errors — auth, other 4xx, quota/billing,
`model_not_found` after its one catalog-resync retry, `request_too_large` —
still fail fast. Context overflow is handled by compaction.

Each error class has **one** layer that owns its long wait, so waits never
multiply:

| Who | Short retries (seconds) | Long wait (owner) | After the horizon |
| --- | --- | --- | --- |
| Interactive turn | — | the gateway pump: capped-exponential waits (≤60s between attempts, an advertised `Retry-After` / `retry_after_ms` honoured exactly), up to `PI_GATEWAY_MAX_ELAPSED_MS` | the error is shown; **Esc** ends the wait at any time |
| Worker session | transient layer (`PI_GUARD_TRANSIENT_*`, 4 attempts); a **mission** worker honours gateway waits for as long as the gateway asks (a standalone run stops after `PI_GATEWAY_MAX_RETRIES`) | hands off with a `transient:*` marker to the mission scheduler | — |
| Mission | — | scheduler window `PI_GATEWAY_RETRY_WINDOW`: relaunches paced by the recovery probe (`PI_GATEWAY_HEALTH_URL`), or without one by a capped-exponential backoff up to `PI_GATEWAY_MAX_BACKOFF` | the mission **pauses** (never fails); with a real probe it keeps probing and resumes itself on the first healthy answer — with no horizon unless `PI_GATEWAY_AUTO_RESUME_HORIZON` sets one |

While a turn waits, the status bar shows what it is waiting for, the next
retry countdown and, once the outage passes a minute, how long it has lasted
(`gateway 60s · capacity_unavailable · for 2h 03m`). Automatic model fallback
is disabled by default. When explicitly enabled, it is armed only by a model's
own outage (three consecutive holds): an account-wide queue, a connection drop
and a link cut do not switch models.

`node_updating` is the exception to the hours-long wait. The console sends it
while the only node serving a model restarts for a deployment, with
`retry_alternate` advice, but Pi never switches models on that advice: the
pump holds the request on the same model, honouring `Retry-After` /
`retry_after_ms` (the larger wins; 30 s when the code arrives without either).
Switches that do not depend on the advice still apply by design: the opt-in
hold-count fallback above, and the planner worker's switch after its third
`MODEL_LOADING` strike. An interactive turn's hold is capped at 15 minutes
(`ALTERNATE_MODEL_MAX_ELAPSED_MS`, or `PI_GATEWAY_MAX_ELAPSED_MS` when that is
shorter). The console's updating mark lasts 10 minutes by default (up to
1 hour), so a node still refusing after that is most likely stuck. The turn
then ends with the refusal, and settle recovery does not continue it. A
mission worker has no such cap: it waits for as long as the console answers
`node_updating`, which is bounded only by the mark's TTL (an updater re-marking
the node extends it).

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PI_GATEWAY_ADMISSION_ENABLED` | `true` | Disable admission control entirely |
| `PI_GATEWAY_MODEL_FALLBACK_ENABLED` | `false` | Allow a model-scoped outage to switch the active session model automatically |
| `PI_GATEWAY_ADVISED_MODEL_SWITCH` | `true` | When the gateway itself advises an alternate deployment (`IW-ACT-RETRY-ALTERNATE`), switch to a stand-in that fits the session and continue the turn on it instead of waiting and printing "switch with /model" |
| `PI_GATEWAY_MAX_CONCURRENCY` | `4` | Total concurrent model requests this runtime aims at |
| `PI_GATEWAY_RESERVED_SLOTS` | `1` | Of that total, slots kept free for your interactive turn (so 3 worker sessions by default, held from the start) |
| `PI_GATEWAY_MAX_WAIT_MS` | `300000` | Retained for compatibility; a server-advertised wait is never shortened |
| `PI_GATEWAY_JITTER_MS` | `250` | Release stagger window |
| `PI_GATEWAY_MAX_RETRIES` | `8` | Gateway waits a standalone (non-mission) worker attempt honours; mission workers wait as long as the gateway asks |
| `PI_GATEWAY_MAX_ELAPSED_MS` | `12h` | How long an interactive turn waits out transient infrastructure (ms or a duration such as `12h`) |
| `PI_GATEWAY_RETRY_WINDOW` | `12h` | How long a mission keeps relaunching a task through a transient outage before pausing |
| `PI_GATEWAY_MAX_BACKOFF` | `3m` | Cap between relaunches when no recovery probe is configured |
| `PI_GATEWAY_HEALTH_URL` | *none* | Gateway base URL for the recovery probe (`/ready`, `/health`, `/v1/models`) |
| `PI_GATEWAY_PROBE_INTERVAL` | `10000` | Recovery probe cadence (ms) |
| `PI_GATEWAY_AUTO_RESUME` | `true` | Whether a paused mission resumes itself when the probe reports healthy |
| `PI_GATEWAY_AUTO_RESUME_HORIZON` | *unbounded* | How long a paused mission keeps probing for recovery (set to give up and stay paused) |
| `PI_GATEWAY_MAX_OUTAGE` | *none* | Opt-in: total outage after which a task FAILS (unset: an outage is waited out) |
| `PI_GATEWAY_TELEMETRY` | `true` | Emit `[gateway-admission]` events on stderr |

Pi's own retry (`.pi/settings.json` `retry`) is separate; the waits above do
not depend on it and work with it disabled.

### Mission time limits

Missions have **no fixed wall-clock window**: a mission, its tasks, workers,
reviews, validation and recovery run as long as they make progress — if it
takes 8 hours, it takes 8 hours. A worker is treated as hung only after
`limits.worker_inactivity_ms` (default 1 hour) with no activity at all (tool,
model output, checkpoint, or waiting on the gateway); it is then resumed from
its checkpoint, not failed. Verification commands are killed only after 15
minutes of silence, never for running long. `mission {action:"status"}` shows
elapsed time, last activity and the current stage; cancelling (Esc) is the
only thing that ends a healthy mission early.

Caps are opt-in, in `engineering.yaml`:

```yaml
limits:
  worker_inactivity_ms: 3600000        # hung-worker window (default 1h)
  # max_task_wall_clock_ms: 28800000   # opt-in per-task ceiling (unset = none)
  # max_mission_wall_clock_ms: 86400000 # opt-in mission ceiling (unset = none)
```

`PI_ENGINEERING_WORKER_INACTIVITY_MS` overrides the hung-worker window and
`PI_ENGINEERING_WORKER_TIMEOUT_MS` sets an opt-in per-execution ceiling. The
full inventory of time limits and their classification is in
[`docs/mission-time-limits.md`](docs/mission-time-limits.md).

## Live working activity

The native Pi working indicator updates every second during an active turn,
including split view and sessions with the custom status bar disabled. It shows
whether the model is waiting, thinking, responding, or preparing a tool call;
running tools show a safe command label or file path, elapsed time, and time
since output. Long periods without output stay visible rather than suggesting
that an animated spinner means useful progress.

Gateway waits remain visible in a persistent detail panel with provider/model,
reason, reported queue depth/capacity and admission limit, retry countdown, and
total waiting time. Queue depth is a gateway load snapshot, not your individual
position in the queue. Transport interruptions have a separate label from
capacity waits. After a countdown reaches zero the indicator says **Awaiting
gateway response** until real activity resumes. Completion, cancellation,
shutdown, and model switches clear stale wait state. Press Esc to cancel as
usual; display updates do not change retry policy or send HerdR notifications.

## Live status bar

The footer answers "what is it doing, and why is nothing happening":

```
⠙ gateway 28s · queue 30/100 │ WI-12 implement │ opus-5 │ main │ ⚡247 t/s
```

- **the wait** — why the runtime is idle: a spinner (a still glyph reads as a
  hang, and a gateway hold can now run for minutes), the countdown, and your
  position in the gateway's queue when it reports one — `queue 30/100` answers
  "is this draining?", which `queue_timeout` never did. Waits with no queue
  numbers fall back to the reason. Fed from the gateway admission controller,
  which is why a backoff is a status line rather than a wall of warnings.
- **the task** — the work item and pipeline phase currently in flight
  (`scout`, `implement`, `verify`, `review`), cleared when the run settles,
  including when it fails.
- **the model** — the one actually producing tokens: a worker's model during a
  run (the executor's choice, including a fallback), the session model otherwise.

Segments are elided from the left as the terminal narrows; the wait reason is
the last to go, because it is the only one that explains an apparently frozen
session. The render path never runs git or network work, and redraws are
coalesced rather than issued per token.

`/harness-status` prints the fully resolved state.

The footer also carries an ambient row summarising the run (changed files,
findings, token spend). The right-hand **Engineering panel** (`/panel`,
`ctrl+p` / `ctrl+b`, `PI_PANEL_*`) was removed: its keys collided with Pi's own
bindings (`ctrl+p` cycles models, `ctrl+b` moves the cursor) and no unused
`ctrl+letter` exists. For a full per-agent view of conversation, tools, files and
diffs, tokens and tests, use the Herdr agent inspector
([`docs/split-view-and-inspector.md`](docs/split-view-and-inspector.md)).

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PI_STATUS_BAR_ENABLED` | `true` | Disable the footer entirely |
| `PI_STATUS_BAR_SHOW_WAIT` | `true` | Show why the runtime is waiting |
| `PI_STATUS_BAR_SHOW_TASK` | `false` | Show the engineering task in flight |
| `PI_STATUS_BAR_SHOW_MISSION_STATUS` | `false` | Show the mission `token · why · next` text (a paused mission's resume hint always shows) |
| `PI_STATUS_BAR_SHOW_MODEL` | `true` | Show the producing model |
| `PI_STATUS_BAR_SHOW_THROUGHPUT` | `false` | Show rolling output tokens/sec |
| `PI_STATUS_BAR_SHOW_BRANCH` / `_DIRECTORY` | `true` | Git and path segments |
| `PI_STATUS_BAR_SHOW_REPOSITORY` / `_WORKTREE` | `false` | Repository and worktree segments |
| `PI_STATUS_BAR_REFRESH_MS` | `150` | Redraw coalescing window |
| `PI_STATUS_BAR_GIT_TTL_MS` | `30000` | How long cached git context is trusted |


## Rust build cache

Cargo keys its build cache on the checkout directory, so every isolated
candidate worktree would otherwise leave a multi-gigabyte `target/` behind.
For repositories with a `Cargo.toml` at the root (Node and Python repos are
untouched), the runtime points the Rust builds it spawns itself — verification
stages, CAV runs and lifecycle commands — at one machine-wide cache root
(created mode 0700) instead. The variables are set per spawned command, never
exported process-wide, so a worker's own `bash` tool calls get neither the
per-worktree target dir nor sccache and build inside the worktree:

    ~/.rust/cache/target/<repo>-<hash>/<worktree-hash>   CARGO_TARGET_DIR
    ~/.rust/cache/sccache                                 SCCACHE_DIR

Each worktree gets its own target directory. One target directory shared
between worktrees is unsafe: cargo identifies a workspace crate by its path
relative to the workspace root and decides freshness by mtime, so a worktree
whose sources are older than another worktree's last build reuses that build
and one worker's tests run against another worker's code. Compiled
dependencies are shared safely through `sccache` instead: install it
(`brew install sccache` or `cargo install sccache`) and the runtime sets
`RUSTC_WRAPPER`, so a second worktree's dependency build is a cache hit rather
than a recompile. Values the operator already set (`CARGO_TARGET_DIR`,
`RUSTC_WRAPPER`, `SCCACHE_DIR`) are never overridden. Everything under the
cache root is derived output you can delete yourself at any time. Housekeeping
never deletes it: idle, marked generations whose worktree is gone are moved to
`<cache root>/.trash` (see Housekeeping), and only `/gc --purge-trash` removes
them. There is no byte cap.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PI_RUST_CACHE_DIR` | `~/.rust/cache` | Cache root (`~` is expanded). Must be empty, an older cache, or carry `.pi-eng-rust-cache-root`; any other directory is refused |
| `PI_RUST_CACHE` | `1` | `0` disables the managed cache |
| `PI_RUST_CACHE_MAX_AGE_DAYS` | `30` | Marked target dirs no build touched for this long (and whose worktree is gone) are moved to the cache trash by housekeeping |

## Housekeeping

Autonomous runs leave things behind when a process dies: the broker removes
the candidate worktrees it tracks in memory once a mission reaches cleanup, but
a crashed session, a killed worker or a mission that never reached a terminal
state leaves `pi-eng-<hash>-<branch>` checkouts next to the repository, each a
full working tree plus whatever the worker built. Housekeeping runs at session
start, every six hours while a session stays open, and on demand with `/gc`
(`/gc` previews by default; `/gc --apply` acts; `--dry-run` is accepted as an alias):

- Only worktrees on `pi-eng-candidate-*` / `pi-eng-orch-*` branches in the
  runtime's own namespace (`pi-eng-<hash(repoRoot)>-*` siblings of the repo
  root) are ever reclaimed, and only when their mission is durably `COMPLETE`
  or `CANCELED` (`FAILED` missions can be reopened, so they are never reclaimed; read from the orchestration event log, so missions run
  by other pi processes count) **and** the worktree carries the runtime's
  ownership marker `pi-eng-owner.json` in its git dir
  (`.git/worktrees/<id>/`; JSON `{version:1, creator:"pi-engineering",
  repoRootHash, repoRootSha256, branch, createdAt}`, written by
  `GitRepo.createWorktree` via `src/git/ownerMarker.ts`, which is also the only
  reader: `repoRootSha256` is mandatory and hashed over `realpath(repoRoot)`, the
  branch must match the live branch exactly, a detached worktree matches only a
  marker that recorded no branch, and a symlinked marker is never trusted). A
  missing, unparseable or mismatching marker means "not provably ours": kept and
  reported ("no ownership marker" / "ownership marker rejected (<reason>)").
  Worktrees created before the marker existed therefore stay kept until you
  remove them yourself; `/gc --adopt-preview` lists them read-only with the plain
  `git worktree remove <path>` an operator could run for each eligible one (it
  adopts and writes nothing; adopting is a deliberate future step). Fork
  worktrees (`pi-fork-<hash>-<id>`) live outside the swept `pi-eng-<hash>-`
  namespace, are never touched by this janitor, and their markers are for a
  future janitor. A worktree on any other branch is yours: it is
  kept and reported, however idle. A mission this process cannot prove terminal
  is kept, as is any worktree a durable candidate, cleanup or quarantined record
  still names. Nothing younger than `PI_WORKTREE_MIN_AGE_HOURS` (default and
  minimum 1) is reclaimed.
- Housekeeping never loses data. A worktree is reclaimed only when its branch
  (or, if detached, its folder name) carries a parsable mission/task id whose
  mission is durably `COMPLETE` or `CANCELED`; no owner means it is kept, however
  idle (`MSN-ext-*`/`MSN-local-*` ids parse truncated and so are always kept).
  It is also kept and reported, before anything is committed, when git has it
  locked; a git operation is in progress in it (rebase incl. `--autostash`,
  merge, cherry-pick, revert, bisect; their state lives only in the git dir);
  an `index.lock` exists (never removed; one a crashed janitor run left is
  reported as stale and still kept); per-worktree refs (`refs/worktree/*`,
  `refs/bisect/*`, `refs/rewritten/*`) exist or its HEAD reflog (scanned up to
  1000 entries) holds a commit no branch or tag contains; it holds an initialized submodule or an untracked embedded git
  repository; it holds ignored files other than disposable derived folders;
  an untracked derived folder would block a plain remove; assume-unchanged or
  skip-worktree index entries could hide edits; its HEAD is detached and dirty or
  unreachable from every local branch and tag (remote-tracking refs and a stash
  do not count); changes would remain after staging; its Rust cache key is
  the shared `_shared` fallback; an unreadable directory exists under it; or a
  root derived folder holds any file or folder newer than the owning mission's
  terminal timestamp (`completed_at`, else `updated_at`, the earlier of the
  in-process store and the durable event log), or such a folder exists and no
  terminal timestamp is known: something used the checkout after the mission
  ended.
- Ignored-file rules are shared with the repository layer
  (`src/git/worktreeSafety.ts`: nested `.git`, bare repositories and secret-looking
  files such as `.env` or `id_rsa` under a derived folder other than `node_modules`
  keep the worktree), but the janitor stays stricter: only the five root-level
  names below count as disposable, never the any-depth cache names.
- **Disposable derived folders** are exactly these, and only at the worktree
  root: `node_modules/`, `target/`, `.next/`, `dist/`, `coverage/`, and only when
  the folder itself is git-ignored and nothing named `.git` lives beneath it.
  Same-named folders at any other depth, or ignored files inside a folder that is
  not itself ignored, keep the worktree. An ignored root `dist/` is treated as
  rebuildable output even if someone hand-wrote into it; keep such files
  elsewhere.
- Otherwise uncommitted changes are staged in a temporary copy of the index
  (the dry-run simulation also writes new objects to a throw-away object
  directory) and committed onto the worktree's own branch; the real index is
  replaced afterwards under `index.lock` with an atomic rename. A file that is
  both staged and further modified (`MM`, `AM`, ...) keeps the worktree, since
  restaging would lose the staged version. The repo's own `node_modules`
  symlink that `createWorktree` provisions is never staged; on reclaim only the
  link is unlinked.
- **A sweep never deletes.** Every keep check runs, the checkout is moved
  with `git worktree move` to a `reclaim-` quarantine name beside it, every
  check runs again there (plus a comparison of the tree's newest mtime), and
  only then is it renamed into the trash,
  `<state-dir>/trash/<ISO-ts>/<name>` (state dir: `PI_ENGINEERING_STATE_DIR`,
  else `$XDG_STATE_HOME/pi-engineering`, else `~/.local/state/pi-engineering`),
  next to a `.pi-eng-trash.json` marker. The rename needs the trash on the same
  filesystem as the repository; if it is not, the checkout is moved back, kept
  and reported ("state dir on different filesystem: set PI_TRASH_DIR next to the
  repos"; `PI_TRASH_DIR` relocates the trash, and the directory must be empty,
  missing, or already a trash root marked `.pi-eng-trash-root`; it must be an
  absolute path, must not be a symlink and must not lie inside any working tree
  of the repository, otherwise the worktree is kept). Its git registration is
  then MOVED, not deleted: ONLY its own `<common-git-dir>/worktrees/<id>` (found
  by the path in its `gitdir` file, exactly one match, not locked) goes to
  `<trash entry>/.pi-eng-admin`; `git worktree prune` is never run because it
  would also drop other worktrees whose `.git` file is missing (an unmounted disk
  whose mount point still exists). An ambiguous match leaves the registration
  and reports the exact admin dir with `git worktree repair` / `remove`
  guidance. To restore a trashed worktree: move `<trash entry>/<name>` back to
  its original path, move `<trash entry>/.pi-eng-admin` to
  `<common-git-dir>/worktrees/<id>` (any unused name), then run
  `git worktree repair <original path>`. If any check fails the checkout is moved back. A writer
  that only knows the original path can no longer reach the files. Accepted
  residual: a process with its
  working directory already inside the checkout, or one that follows the
  quarantine path, can still add an ignored file or a file in a root derived
  folder between the final re-check and git's own removal; git itself refuses
  for untracked files, but not for ignored ones. The branch is always kept. A
  namespace directory git no longer lists is reported as a stray and its files
  are never removed (`git worktree repair` may re-register it first, which only
  rewrites git metadata); delete it yourself if you do not want it.
- **Purging the trash is a separate, explicit act**:
  `/gc --purge-trash [--older-than <days>] --apply` (default 14 days, minimum 7;
  without `--apply` it only lists what it would purge, and it never sweeps).
  It deletes only entries directly under a trash root that are regular
  directories carrying a valid `.pi-eng-trash.json` written by housekeeping,
  at least `<days>` old, and it never follows symlinks; everything else is
  skipped and reported. A trash root that is a symlink is refused. Directories
  the repository layer parked in `<repo parent>/.pi-eng-trash/<ts>-<name>` carry
  no marker and cannot get one retroactively, so NO command ever deletes them:
  they are listed by `/gc --purge-trash` with the `rm -rf` an operator
  may run after looking inside. A preview never writes or chmods anything, and a Rust
  cache root without `.pi-eng-rust-cache-root` is not purged. It covers `<state-dir>/trash` and `<rust-cache>/.trash`.
- Rust cache: the runtime writes `.pi-eng-rust-cache.json` into every
  generation dir (`<cache>/target/<repo>/<worktree>`) it assigns. The sweep moves
  (never deletes) a generation to `<cache>/.trash/<ts>/` only when that marker is
  valid, no build touched it for `PI_RUST_CACHE_MAX_AGE_DAYS`, and its worktree
  is gone and not a live worktree's target dir. Unmarked generations (created
  before the marker, or by anything else) are kept and reported. The cache root
  must carry `.pi-eng-rust-cache-root`, written on first use of an empty cache or
  an older one holding only `target/` and `sccache/`; a `PI_RUST_CACHE_DIR`
  naming any other directory is refused (no shared cache is used, nothing is
  written or swept in it; a one-time process warning and the `/gc` report say
  so). A generation marker without a recorded worktree path is kept. A reclaimed worktree's cargo target dir is left to
  this sweep.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `PI_HOUSEKEEPING` | dry-run | Automatic housekeeping only reports by default; `1`/`true`/`on`/`yes` lets it act (moving to the trash, never deleting), `0`/`false`/`off`/`no` disables it. Mission strip rows default to 2 (`PI_MISSION_PRESENCE_ROWS`). `/gc` previews by default and lists what it kept and why; `/gc --apply` moves to the trash; `/gc --purge-trash --older-than <days> --apply` is the only deletion |
| `PI_HOUSEKEEPING_INTERVAL_MS` | `21600000` | Interval between sweeps while a session is open; `0` for session start only |
| `PI_WORKTREE_IDLE_HOURS` | `24` | Retained for compatibility; governs nothing now. A worktree with no parsable mission/task owner is kept, never reclaimed by age. `PI_WORKTREE_MIN_AGE_HOURS` still sets the minimum age for a terminal-owner reclaim |

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

### Mission recovery and status semantics

Mission state is durable under `.pi-eng/`. `/mission resume <missionId>` resumes
an actionable stopped mission under the same ID: it fences stale ownership,
reconciles side effects, preserves completed checkpoint work, and schedules
only the remaining deliverables. A late old-worker result is retained as audit
evidence and cannot change task, candidate, gate, or repository state.
Mission workers do not report checkpoints: the broker derives them from the
worker branch (it harvests uncommitted edits into a commit before the final
checkpoint), so the candidate SHA and committed paths always come from the
broker's own Git snapshot. A `checkpoint_progress` claim, when a caller still
offers that tool, must name the exact current candidate SHA and committed
evidence paths present in that snapshot. Any artifact URI is resolved through the runtime artifact store;
missing, unreadable, or invented references reject the claim, while accepted
references are copied to unique checkpoint-owned, content-addressed URIs with
one aligned SHA-256 content hash each. Equal-content claims remain distinct.
Recovery re-resolves every checkpoint-owned URI and recomputes its exact hash
before dispatch, so deleted or overwritten checkpoint evidence fails closed.
Plain activity text
and spoofed SHA/path/artifact claims carry no authority. Missing Git providers
and incomplete lifecycle inventory APIs fail closed with a typed
`PERSISTENCE_UNAVAILABLE` diagnostic; a repository root is never substituted
for actual candidate, branch, worktree, artifact, or committed-path evidence.

- `EXECUTING`: authoritative owned work is active.
- `WAITING_*`: a named condition has a next action and deadline.
- `BLOCKED`: recovery is scheduled or a typed stop explains the reason,
  preserved work, attempts, and exact resume condition.
- `REPAIRING`: durable replacement lineage is running; failed tasks remain
  immutable history.
- `COMPLETE`: the final candidate has current validation/review evidence and
  every material acceptance criterion passed.
- `FAILED` / `CANCELED`: terminal without an approval claim.

Run the deterministic foundation proof with:

```bash
npm run test:mission-reliability
```

For an opt-in installed-Pi live check:

```bash
npm run dogfood:mission-recovery
```

The default dogfood path verifies exactly one installed
`pi-engineering-runtime` package, requires its Git SHA to match this checkout
(or `--expected-sha`), requires its tracked tree, index, and untracked set to
be clean before any extension-loading Pi command, and then lets Pi discover
that installed extension normally;
it does not also pass `--extension`. It refuses non-`local/local` models,
enabled/advertised metabolomics, and a temporary parent that is or overlaps the
current checkout, extension/package installation, or any Git worktree. It then
creates a temporary Git repository only and drives the installed public mission
surface through a checkpoint, bounded interruption, stale late-result
rejection, and recovery/resume. Success requires durable `task.checkpointed`,
`execution.late_result_rejected`, recovery attempt `> 0`, preserved work, and a
fresh `local/local` review carrying `same_model_reduced`; a nonterminal mission
with zero active workers must expose a next action or complete stop/resume
condition. The script validates every required snapshot contract-v3 field and
numeric counter. `COMPLETE` additionally requires a
nonzero declared acceptance total, every declared criterion passed, exact
coverage, internally consistent passed/failed/skipped test accounting with a
passing nonfailure result, and a completed review whose blocking count matches
its findings. Review severities and statuses must be valid runtime enums,
`repaired` must agree exactly with `resolved`, and every blocking finding whose
status is not `resolved` remains unresolved (including `accepted`). Stopped
states require nonempty reason, resume condition,
recovery IDs, and actual preserved-work references.
Only `COMPLETE` with verified current acceptance evidence, or an explicitly
allowed stopped state with a complete actionable stop, exits zero;
`FAILED`/`CANCELED` retain and print the inspection path and exit nonzero.

For source-only diagnostics (not the Task 12 installed-package proof), run
`node scripts/dogfood-mission-recovery.ts --source-only`. That mode is labeled
in its JSON output and uses `--no-extensions` before one explicit source
`--extension`, preventing duplicate discovery. Every preliminary source-mode
Pi invocation also uses `--no-extensions`.

Slice 1 supports multiple explicitly authorized local roots, with one
repository-bound executable task and promotion at a time. Cross-repository
dependency coordination, repository-head vectors, and external
branch/PR/check/merge reconciliation remain Slice 2. Database-backed leases,
distributed controllers, and remote-worker reconciliation remain Slice 3; the
local JSONL runtime does not claim those guarantees.

## Development

```bash
npm install
npm run typecheck     # core + mission-recovery script tsconfigs
npm test              # node --test (unit + integration, deterministic)
```

- Tests run via `node --test` (Node >= 22.18 native type-stripping); imports use
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

### Automatic recovery when reopening a session

Install the optional user-local launcher with `node scripts/install-session-auto-resume.ts`.
It preserves the original Pi CLI and saves a backup at `~/.local/bin/pi.before-session-auto-resume`.

On a host whose Pi is a *managed install* (`~/.pi/agent/bin/pi` with `install/current-version`), run
`node scripts/install-session-auto-resume.ts --managed` instead. It leaves the managed wrapper in place
and adds one marked block before its final `exec`, so the managed install can still switch releases:
the Pi to run is resolved from `current-version` at every start, and the launcher's package links
follow it. The block starts the launcher only after `node <launcher> --check` loads it, and otherwise
falls through to the plain `exec`, so a missing or broken launcher never stops Pi starting.
`PI_SESSION_AUTO_RESUME_BYPASS=1` skips it. The original wrapper is saved once as
`~/.pi/agent/bin/pi.before-session-auto-resume`. Re-running the installer refreshes the files and
the block; if Pi's own updater regenerates the wrapper, run it again to restore the hook.
On interactive `pi --session <id-or-file>` or `pi -c` it supplies a continuation through Pi's
normal initial-prompt path when the session stopped in one of three ways. Pi finishes startup and
restores/selects its model before work starts. Existing tool results and mission IDs remain in context.

- **Refused with a replay contract:** the last turn failed without output and the gateway explicitly
  marked replay safe. The server's remaining retry delay is honored.
- **Failed turn:** any other retryable inference failure (dropped stream, timeout, lost capacity),
  with or without a partial answer. The in-session retry layers do not survive a restart.
- **Interrupted:** the session ends on a tool call or result, so Pi was closed or died mid-turn. The
  prompt says the last call may have run fully, partly or not at all, and to check state first.

Safeguards: the last event must be at least 10 minutes old (`PI_SESSION_AUTO_RESUME_MIN_AGE_MS`), and
no other Pi may be running in the session's directory (Linux, via `/proc`), because Pi takes no lock on
a session file and two processes must never share one. Set `PI_SESSION_AUTO_RESUME_IGNORE_LIVE=1` to
override. At most three recoveries follow one operator message. Completed, cancelled, final-refusal
(`do_not_retry`, bad request, unknown model, exhausted quota), and operator-aborted tails stay idle.
Explicit CLI prompts or attachments, piped input, print/RPC modes, forks, `--resume` and interactive
session selection are left to Pi. `pi -c` is resolved to the file Pi itself would open (newest by
mtime) and pinned. Local session IDs and file paths are supported; cross-project ID lookup is left
to Pi. Set `PI_SESSION_AUTO_RESUME=0` to disable recovery for a launch.

To uninstall, restore the saved launcher:
`mv ~/.local/bin/pi.before-session-auto-resume ~/.local/bin/pi`.
The installer accepts optional launcher and installation-directory arguments for isolated testing.
