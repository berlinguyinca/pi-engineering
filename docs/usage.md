# Usage

`pi-engineering-runtime` runs as a pi extension inside a normal pi install and
works in any git repository. It requires no GitHub, AutoSpec, InferWeave, or
distributed infrastructure. The interactive pi session is used as usual; the
engineering runtime is available **on demand**.

## Install

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

### Loading one runtime per session

Pi's tool namespace is global, and it checks name uniqueness **after** an
extension finishes loading. A second copy of this runtime — the installed
package plus a checkout passed with `--extension`, or two checkouts — therefore
cannot be caught from inside the extension: `pi.registerTool()` accepts the
registration, and the load fails afterwards with
`Tool "ledger_read" conflicts with <the other path>`.

Load exactly one runtime per session. When developing against a checkout:

```bash
pi --no-extensions --extension /absolute/path/to/checkout/extensions/index.ts
```

The error names the copy that lost the race, not a broken install. The copy that
registered first serves the tools; the other keeps its commands that do not
collide. Nothing in this package can change that outcome — the tolerance in
`src/tools/registration.ts` and `src/runtime/host/piBridge.ts` covers hosts that
reject a name synchronously (a generation handover mid-session), which is the
case the runtime can actually handle.

A generation handover is not a second copy. The previous generation's tools stay
in Pi's registry, the first registration wins, and the incoming generation
inherits the names rather than re-registering them. Health checks therefore read
Pi's registry, not the generation's own registrations: an inherited `ledger_read`
satisfies "tools registered" (the check says so in its detail), so a live update
is not rolled back for a name its predecessor legitimately holds. A required tool
nobody holds still fails the check and rolls the candidate back.

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

### worker_result guard, nudge and wrap-up

- **No-change guard.** A mutating worker (implementer, debugger, test-generator,
  clean-room-challenger) in a mission worktree cannot report `completed` over an
  untouched worktree: `worker_result` returns an error ("no changes vs base:
  commit your work or report blocked/partial with a reason") and the session
  keeps going. Only tracked changes and commits past the worktree's actual fork
  base (the mission base, or a repair/recovery candidate tip) count; untracked
  files alone do not. `blocked`, `partial` and `failed` reports are accepted as
  given. A `partial` report (`details.done` lists finished deliverables) is a
  resumable checkpoint: the broker keeps its commits, checkpoints the done
  deliverables, settles the execution like a wall-clock timeout and recovery
  re-plans only the remaining deliverables, with no retry attempt spent.
  Read-only roles are unaffected.
- **In-session nudge.** If a session ends without calling `worker_result`, the
  worker (or reviewer, with `review_result`) gets exactly one more turn in the
  same session ("Call worker_result now ..."). It counts as the same attempt; if it is ignored the run settles as the
  usual no-result failure.
- **Wrap-up.** When a task has an opt-in wall-clock budget
  (`limits.max_task_wall_clock_ms` or a task's `execution_budget_ms`), the worker
  gets one wrap-up turn at 75% of it so a timeout leaves a resumable partial
  result, and every 20th `bash` / `claim_deliverable` result carries a
  "Time budget: ... elapsed, ... remaining." line (override the interval with
  `PI_ENGINEERING_BUDGET_NOTICE_EVERY`). Standalone runs without an owner signal
  that set `timeoutMs` explicitly get a silence wrap-up turn after 75% of it.
  With no budget and no explicit `timeoutMs` (the default) nothing is injected.

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

Following the gateway's own advice is on by default: when a request is refused
with `IW-ACT-RETRY-ALTERNATE` ("try another eligible deployment", scope
`model`), the runtime switches the session to a stand-in that fits its context
and modality and continues the turn on it, with a notice naming both models.
The envelope names no model, so the choice is the runtime's (the same chooser
as the fallback above; it refuses any model the session would not fit in). If
no stand-in fits, the request waits as before and ends with the advice (a
stand-in that stopped fitting mid-turn is handled by taking the declared delay
and retrying the same model, at most three times). A model left this way is not
chosen again for ten minutes, so two models short of capacity cannot trade the
session back and forth. Set
`PI_GATEWAY_ADVISED_MODEL_SWITCH=false` to only print the advice. A switch made
this way is not an operator pin either; `/model` changes back.

### Provider failures before any tool call

An implementer execution that fails on the provider (connection error, timeout,
5xx, a gateway capacity hold or alternate-route retry) before any tool call ran
has no side effects, so it does not consume a task attempt. The mission parks in
`WAITING_FOR_LLM`; its `nextAction` reads for example "waiting for provider: 3/20
zero-tool-call retries (connection error); next probe at ...", and the task
re-runs when the recovery probe allows. Unless you pinned a model, the next run
may use another eligible model. A pinned model is waited on rather than
switched (see "Switching the model a mission uses" above).

`PI_GATEWAY_MAX_ZERO_TOOL_RETRIES` (`max_zero_tool_retries`, default 20) is how
many such relaunches a task gets at normal pacing. Past it the mission keeps
waiting in `WAITING_FOR_LLM` and relaunches only on an authoritative healthy
probe; it is never `BLOCKED` for this. Executions that ran tools count as
attempts as before.

### Gateway recovery capacity checks

For InferWeave, the recovery probe authenticates to the model catalogue and
reads `/iw/v1/admission` for the selected model. Catalogue `slots` is a capacity
ceiling. Automatic recovery requires measured immediate model headroom and an
empty model queue; spare queue room alone does not release a paused mission.
The probe supports both the Go model-keyed report and the Rust model-array
report. Go capacity must be known and less than 90 seconds old. Logical aliases
are matched using the catalogue or admission report's explicit model mapping.

This is a model-level readiness check. Caller, session, priority and downstream
limits can still refuse a request; another caller's aggregate queue or priority
statistics do not establish availability for this mission. When Go diagnostics
report an effective model or global active limit, the probe also checks it.

Missing, stale or unsupported admission telemetry is **unknown capacity**, not
proof of either free capacity or a model outage. An idle Go model may have no
tracked admission row. Such answers do not establish automatic recovery and can
leave a mission waiting until telemetry appears. Plain OpenAI-compatible
providers retain their model-availability check without requiring InferWeave.

For a legacy gateway without suitable admission telemetry, an operator can set
`PI_GATEWAY_HEALTH_URL` to an explicitly chosen gateway base URL to use the
existing HTTP readiness probe instead. This override proves only that the
selected health endpoint responds; it does **not** measure queue headroom.
Ordinary `/mission resume` is not a guaranteed bypass of the capacity probe.

### Reviewer tools and the candidate guard

The reviewer gets `read`, `bash`, `repo_search` and `symbol` next to the evidence
tools, and its prompt carries the diff, the validation result and the criteria IDs
as untrusted data. Because `bash` is not sandboxed, every review attempt is guarded:
the candidate worktree must still be at the recorded candidate commit with a clean
tree, no new ignored files, unchanged `git for-each-ref`, and unchanged shared
`hooks/` and `config`. On a violation the worktree is reset to the candidate
(`git reset --hard`, `git clean -fd`, new ignored paths removed), the attempt fails as
invalid output, and the review re-runs; changed refs or hooks are reported but not
restored. Residual risk, accepted for now: writes outside the worktree and network
access are not detected, since there is no read-only bash wrapper.

### Reviewer retries on a dead provider

Gate roles (reviewers and challengers) judge work and have no side effects, so
they do not wait out a dead route in-session. Next to the worker-wide
`PI_GUARD_TRANSIENT_*` variables, `PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS`
(default 2) caps the transient retries a gate role spends on one model; after
that the review moves to the next eligible model, and a provider whose connection
was refused is skipped for five minutes. An operator-pinned reviewer is exempt
from the cap and keeps waiting, unless its host refuses connections or does not
resolve; then it moves to another model with a notice.

### Updating and hot reload (`/pie`)

`/pie` is the short alias for everything pi-engineering registers: `/pie
update`, `/pie reload`, `/pie version`, `/pie rollback`, `/pie status`, `/pie
cancel`, and any pi-engineering command by name (`/pie mission status` is
`/mission status`; `/pie` alone lists them).

When Pi loads pi-engineering from a git checkout, a commit landing on that
checkout hot-reloads every running session by itself within about 15 seconds:
the Host hands over to a new generation at the next safe point and the same
conversation continues. Nothing has to be restarted. Uncommitted edits are
never loaded: while a tracked file has uncommitted changes, a new commit is
not reloaded either (the handover would copy the half-edit); you are told
once, and the reload happens as soon as the tree is clean, or at once with
`/pie reload`. Summary and compaction calls, which have no turn to continue,
wait out a gateway hold instead of switching models. `/pie update` does the same immediately (and, when the checkout
has not moved, checks the update remote as before). `PI_ENGINEERING_AUTO_RELOAD=0`
turns the automatic reload off.

A session on another host, loading pi-engineering from a clone that tracks
GitHub, follows it too: every 5 minutes the checkout is fetched and
fast-forwarded (only when clean and strictly behind its upstream; a diverged
or dirty checkout is never touched), and the new commit hot-reloads the
session the same way. `PI_ENGINEERING_FOLLOW_REMOTE=0` turns the fetch off.

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
and the footer. It reads `PAUSED by operator at <time> — automatic
repair is off; resume with /mission resume <id> (add --model auto to release a
model pin)`, next to the mission's operator pin if it has one. It survives a
restart and clears on `/mission resume` or `/mission cancel`.

A mission that cannot pause stays in the state it is in and is not cancelled;
the tool reports "interrupt noted". This covers a mission that is
`NEEDS_ATTENTION`, `BLOCKED` or `WAITING_FOR_USER`. An interrupt that arrives
before any work was planned still cancels, because there is nothing to keep.

#### Pausing a mission you name: `/mission pause <id>`

Esc pauses the turn you are watching. Dozens of missions can run at once, and the
one worth stopping is rarely the one on screen, so a mission can also be paused
by name: `/mission pause <id>`, or the `mission` tool's `pause` action. No live
turn is needed. The pause is written to the mission first, so automatic recovery
is off from that instant and the supervisor leaves the mission alone even after a
restart; then whatever is live is stopped — a dispatched pipeline parks itself
with its work, a queued or waiting mission is parked with its resume recorded.
`/mission resume <id>` continues it.

A mission that has not dispatched yet is paused rather than cancelled. The Esc
path cancels that state because an interrupt during planning preserves nothing;
reusing it for a named pause would destroy missions whose operators only asked to
stop them, and a cancel cannot be resumed.

### What you see while missions run

Two surfaces show mission activity, and they share one arbiter
(`src/status/surfaceBus.ts`) instead of guarding each other out:

- the native working line, which the foreground agent owns while it runs, and
  which the mission strip takes back the moment the turn ends;
- the `engineering-missions` strip, ranked by who needs you first, plus the
  terminal title and one notification per state change.

Each producer claims a surface with a priority, so a third claimant — a recovery
notice, a gateway wait — needs to know nothing about the others, and a claim that
expires cannot keep a surface after its reason has ended.

The strip shows the missions **this window runs**. Durable mission state is shared
by every pi window on the machine, so backfilling the strip from it is scoped to
the session that started each mission (`mission.parent_session_id`): a fresh window
opens with an empty strip instead of mirroring queues it is not driving, and
mission output stays in the window the mission runs at. Live activity still arrives,
because a runtime emits it only for missions it is running here. Set
`PI_MISSION_PRESENCE_SCOPE=all` for one machine-wide dashboard, or
`PI_MISSION_PRESENCE=0` to drop the strip entirely.

The strip and the working line lead with **evidence**, not with a mission's
narration about itself. Attention is derived from observability facts in a fixed
order — you being the next actor, exhausted recovery, failure, blocking review
findings, failing tests, a loop counter, your own pause, a parked state, a stall,
a wait past its deadline, progress age, and the one case where neither heartbeat
nor progress proves the work is alive — and the strongest fact is what you read.
"repeated tool call ×9" is something you can act on; "working on it" is not. The
derivation is pure and reads no model text, so two operators looking at the same
mission see the same reason.

The evidence reaches the row you scan, not just the notification. Markers mean:

| Marker | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| `!`    | you are the next actor — nothing else ranks above it                |
| `*`    | worth a look: looping, blocked on a finding, failing tests, stalled |
| `#`    | parked — its work is kept and it waits for `/mission resume`        |
| `~`    | waiting (cooldown, gateway, lease)                                  |
| `>`    | running                                                            |
| `v` `x`| complete / failed or cancelled                                      |

A row with evidence appends the reason at the end (`· repeated tool call ×12 —
read src/status/presence.ts`); the full sentence stays on the working line and the
notification. The header counts the markers the rows show, by the same function, so
it cannot claim "0 needs you" above two `!` rows, and `running` counts only rows
that are actually running.

When a mission worker's model runs out of capacity (`queue_deadline_exceeded`,
`queue_timeout`, `CAPACITY_EXHAUSTED`), the worker first waits out the gateway's
advertised holds. If the hold is for one model (not the whole account) and the
router can place the role on a comparable model, the mission switches to it
automatically after a finite number of holds and carries on; the saturated model
stays eligible for other work. An account-wide hold (a shared queue, a
concurrency ceiling) is still waited out, and an operator-pinned model is never
given up for an alternate. While waiting, the mission shows `model X is out of
capacity; … switch with /model to continue`, so you can move it without
cancelling; a switch ends a capacity hold within about a quarter of a second,
without waiting out the gateway's advertised retry time.

### Same providers on every machine: `/model-sync`

`/model-refresh` is the only thing that edits a provider's model list, and it
reloads Pi after a real write (not on `--dry-run`). The old `/refresh-models`
name remains an alias. `/model-sync` keeps the
*provider definitions* identical across machines, then calls `/model-refresh`
and reloads once. Pi's own `/model` stays the way to pick a model.

Each machine pulls one canonical, key-free file, named in
`~/.pi/agent/model-sync.json`:

```json
{ "source": "ssh://bender/home/me/.pi/agent/canonical-providers.json" }
```

`source` is a file path, an `http(s)://` URL, or `ssh://host/absolute/path`
(plain `ssh`, batch mode, no shell). The canonical file is
`{"providers": {"<id>": {"baseUrl": "...", ...}}}` and is refused if any provider
carries `apiKey`, `headers`, a token or similar at any nesting level, including
model overrides, or credentials in a URL: credentials are per device, so
each machine keeps its own. A provider the machine has no credential for is
reported `needs-key` and not created. Only the keys the canonical file names are
replaced (unknown keys survive); its `models` only seed a provider that has none.

`/model-sync --dry-run` previews and writes nothing; `--no-refresh` aligns
settings without probing models; `--check` is a read-only drift report ("In
sync." or "Out of sync"). Add `"checkOnStart": true` to `model-sync.json` for a
quiet check at session start that speaks only on drift.

Every write of `models.json` appends a line to `models.json.writers.log` (time,
writer, pid, parent pid, provider ids and HTTP(S) origins; last 200 kept), so an
unexplained change can be traced to the process that made it. URL credentials,
paths, queries and fragments are omitted because they can contain keys. The log
is private (0600), and logging failures never fail a successful config write.

`/models` is the model picker with a tab per provider. Pi's built-in `/model`
offers only an all/scoped toggle that mixes every provider into one list, and an
extension cannot replace it, so `/models` is a sibling command. It opens on the
current model's provider; `Tab`/`Shift+Tab` (or `←`/`→`) move between the
provider tabs and an `all` tab, typing filters within the tab (several words must
all match), `↑`/`↓` move, `Enter` switches and `Esc` cancels. `/models qwen`
opens with the filter filled in. The `all` tab labels each model with its
provider; a provider tab does not need to.

`/model-refresh [provider] [--timeout seconds] [--dry-run] [--prune]` refreshes
all configured providers, or only the named provider. Probes run sequentially
within each provider to avoid creating their own capacity contention. Each
attempt now waits up to **120 seconds** by default; a timed-out probe is retried
once. For a slower endpoint, use `/model-refresh metabolomics --timeout 300`.
The timeout accepts 1–3600 seconds per attempt. Discovery has a separate
15-second deadline.

While refresh runs, the footer and a progress panel show the provider, a bar and
completed-model percentage, plus the current model, attempt, elapsed seconds
and deadline. For example: `metabolomics [##--------] 20% (1/5 probed)` and
`Probing flash-next · attempt 1/2 · 42s / 120s`. The elapsed time updates every
second; the percentage advances only when a model's probes finish, so it can
remain at 20% while a slow model answers. The panel clears on completion,
failure or cancellation.

Gateway aliases are kept and probed under their advertised route ID; a working
backing model does not prove that its aliases work. The progress panel and final
report show `alias → backing-model` when the gateway supplies that relationship.
New aliases inherit input, reasoning, output limit, cost and compatibility
settings from their configured backing model when available, bounded by the
alias's advertised context window. Other additions report inferred settings.
Existing model names and settings survive refresh, and identical IDs in two
providers remain separate entries. Aliases only listed as `x_aliases` on a
concrete model are descriptive metadata; refresh does not invent route entries
that the gateway has not separately advertised.

`/model-refresh` probes each model with one minimal request: 64 output tokens, no
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

### Mission planning for non-trivial goals

A mission whose goal implies more than one deliverable, names several paths, or runs past 30 words makes ONE planner call (role `planner`, strongest routed model, the planner/worker `PLANNER_PROMPT`) and gets a bounded task DAG: per-task `write_domains`, `relevant_files` and `verification` (handed to each worker as its context). Tasks run in parallel only when their write domains are disjoint; overlapping ones are serialized. Trivial goals keep the single task. A malformed or empty plan falls back to the single task and records a minor `mission_planner` finding. `PI_MISSION_PLANNER=on|off|auto` (default `auto`) forces or disables it. Task domains are pre-validated: absolute, `..`, `.git`, forbidden, read-only and out-of-manifest domains are dropped, and a task left with none falls back to the single task (the finding names the rejected domains). The call is bounded by `PI_MISSION_PLANNER_TIMEOUT_MS` (default 600000); a transient failure is retried once, then falls back with a finding saying transient.

## Concurrency caps, cooldown scope and stall detection

- Scheduler caps use catalogue `active_limit` (or `x_active_limit`, else `slots`) only when the backend supplies an authoritative provider/endpoint and model route. Requested model hints and pins are not proof of the eventual route. Unknown routes, including the default production path where routing happens after dispatch, use configured limits; provider-only observations become unknown if that name has described multiple endpoints. Zero capacity blocks automatically limited model tasks, but does not block local process/validation/integration tasks. Explicit `PI_ENGINEERING_MAX_PER_ROLE` and `PI_ENGINEERING_MAX_AGENTS` settings remain authoritative. The separate process-wide admission controller retains its configured concurrency and reserved slot policy, with `PI_GATEWAY_MAX_CONCURRENCY` taking precedence over catalogue-derived capacity.
- A 429 cools down only the model (or route) it named. It parks the whole process only when the gateway says `scope: "global"` or `"caller"`, or when the refusal names no model.
- A model turn that streams no first token for `PI_GATEWAY_FIRST_TOKEN_STALL_MS` (default 15 minutes), or then goes `PI_GATEWAY_STREAM_STALL_MS` (default 5 minutes; `0` disables) between tokens, ends as a transient stream failure, so resume and retry accounting apply. A slow turn that keeps streaming never stalls. The 60 minute worker-inactivity watchdog remains for long-running tool commands.
- The scheduler pass loop is event-driven: it wakes when a task settles and otherwise ticks once a second.

## Worker transcripts and runtime log caps

Every worker session (implementer, reviewer, repair, planner) is persisted as
JSONL under the runtime state directory, never in the repo or a candidate
worktree:

    <PI_ENGINEERING_STATE_DIR>/worktrees/<worktree-id>/transcripts/<missionId>/<executionId>.jsonl

Records: session header (role, model), messages (role, model, stop reason,
tokens, timestamps), tool calls, tool results (truncated, with the error
category on failure) and a per-turn line (stop reason, tool-error category,
tokens). Secrets (bearer tokens, `password=`, API keys) are redacted. Each turn
also emits a `Turn ended: stop=<reason> tool_error=<category>` worker activity,
persisted as a `mission.obs.worker` event, so stop-reason and tool-error rates
can be computed per worker.

- `PI_WORKER_TRANSCRIPTS` (`on`|`off`, default `on`).
- `PI_WORKER_TRANSCRIPT_MAX_BYTES` (default 5 MiB): per-file cap; the file rotates
  to `<file>.1` (one predecessor kept).
- `PI_WORKER_TRANSCRIPT_TOOL_CHARS` (default 4000): cap per tool argument/result.

Transcripts are keyed by the mission's state worktree (the orchestrator's identity), then
by mission id. Redaction is key-aware (password/secret/token/api key/authorization/cookie
values in JSON and `KEY=value` lines), covers Basic/Bearer headers, URL userinfo and
sensitive query params, known token prefixes, prose ("password is X") and PEM blocks.
The per-turn line does not count as worker activity for the inactivity watchdog.
runtime.jsonl rotation is per process: two processes sharing one file may overwrite `.1`.

The worktree janitor must leave `transcripts/` alone except by age.

`sessions/<id>/runtime.jsonl` is capped: it rotates to `runtime.jsonl.1` at
`PI_RUNTIME_LOG_MAX_BYTES` (default 10 MiB). `lease.contended` is logged once per
(resource, holder); repeats are counted and a `lease.contended_summary` line
carries the counters every `PI_RUNTIME_CONTENTION_SUMMARY_MS` (default 5 min).

## Context budget for mission workers

A worker's context budget is the smaller of its role's budget (`ROLE_BUDGETS`,
`hardMaxTokens`) and 70% of the context window of the model it was routed to, so
a role is never planned for more context than its model holds: an implementer or
reviewer on a 32k-slot model gets 22,937 tokens, not 40k/64k. The window comes
from the model record (`contextWindow` in `models.json`, kept in step with the
gateway catalogue). If it is unknown, only the role budget applies and a warning
is shown. The budget is passed to the session as `maxContextTokens` and recorded
as `details.context_budget` (`tokens`, `roleTokens`, `contextWindow`,
`limitedBy`) on the worker result.

Mission worker sessions compact at 60% of that budget, keeping the recent window
the per-model compaction tuning computes (bounded to half the trigger on small
windows); the summary request is sent thinking-off like every worker request.
Operator (interactive) sessions are unchanged.

- `PI_WORKER_COMPACT_AT` (default `0.6`): fraction of the budget at which a worker
  session compacts. Accepts 0.1 to 0.95; anything else falls back to 0.6.

A provider error that says the prompt does not fit the context (HTTP 400
"context length exceeded", "maximum context length", llama.cpp "exceeds the
available context size", `context_length_exceeded`) is **not retryable**. The
worker compacts its prompt once and retries the turn once in a fresh session; if
that overflows too, the run fails with the structured error `context_overflow`.
Recovery classifies it as `TASK_BUDGET_EXHAUSTED` and plans
`CHECKPOINT_SPLIT_AND_REPLACE` (split the task into smaller ones) instead of
replaying it.

## Thinking off for mission roles

Mission implementers, reviewers and repair workers send thinking off on every
request, whatever the output allowance: `chat_template_kwargs.enable_thinking: false` (plus `reasoning_effort: "none"`
only for models with `compat.supportsReasoningEffort`; the InferWeave node
rejects unknown top-level fields). Hidden reasoning costs 8-13k
tokens per turn on the gateway models, and a worker makes dozens of turns. The
one-shot planner keeps thinking on. Interactive sessions keep thinking on for
ordinary turns; their compaction/summarisation turns and low-output-budget turns
use the same thinking-off payload as mission roles (`chat_template_kwargs` always,
`reasoning_effort` only with `compat.supportsReasoningEffort`). Each mission-role
request logs `thinking: off (mission role)`.

The policy applies to `openai-completions` models on providers `metabolomics`,
`beast`, `bender` (`PI_THINKING_OFF_PROVIDERS`) or hosts `llm.example.com`,
`llm.metabolomics.us`, `127.0.0.1`, `localhost` (`PI_THINKING_OFF_HOSTS`,
comma-separated; entries match `host:port` or the bare hostname;
`PI_THINKING_OFF_GATEWAYS` is the older name).

### Model override: qwen3.8-27b never runs with thinking off

Operator directive (2026-10-17): models whose id contains a `thinkingOnModels`
fragment keep their thinking under **every** rule above — mission roles,
compaction/summarisation, low-output-budget turns alike. The default fragment
list is `qwen3.8-27b`; override with `PI_THINKING_ON_MODELS` (comma-separated
fragments, lowercased; an empty value disables the default). Rationale: the
27B mission implementer, run thinking-off, stalled in repeated file-read loops
(APS `repeated_call` / `stale_tool_results`) and timed out on real missions;
the model needs its hidden reasoning. Each mission-role request on a protected
model logs `thinking: on (model override)` instead of the off notice.

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

### Git locks and recovery of planner-worker output

Worktree and promotion locks now live in the shared Git common directory's
`pi-engineering-locks/` metadata directory, outside Git's top-level safety scan.
Before upgrading mutating runtimes, drain their work and restart **all** older
processes that can mutate that repository. Mixed old/new mutation is unsupported:
new runtimes conservatively refuse an already-present legacy lock, but that
absence check cannot serialize an older process that acquires its old lock later.
The Git hard-link and symlink safety checks remain enabled.

A failed or unverified harvest retains its worker output and reports the worktree
path and branch. Failed mission workspaces are kept in full, including ignored
files. Replanning retains superseded workspaces even if a later plan succeeds,
and durably records their path, branch, and base before replacing contracts.
Reissuing a task ID refuses to overwrite an existing branch and instead names
its recovery location. Generic idle housekeeping leaves planner-worker workspaces
to their executor or explicit recovery; retained output consumes disk until then.
Resume refuses dirty, unharvested, or unmerged prior work instead of resetting or
deleting it. Inspect the named worktree and preserve its changes on a recovery
branch or integrate them deliberately. Save ignored artifacts separately or
explicitly commit them to the recovery branch. Then remove both the original
worktree directory and its branch and retry resume. Do not delete the state file or force-remove a
worktree merely to clear the recovery fence. Successful completion additionally
reruns the contract verification commands in the integrated tree before applying
the result to the checkout. Verification and review must leave that tree at the
same clean commit; source edits, new untracked files, or a changed HEAD fail
completion and retain the workspace. Application uses the verified commit ID
rather than a branch name that could move after verification.

## Individual commands

| Command        | Effect                                                        |
| -------------- | ------------------------------------------------------------- |
| `/mission inspect <id> [workerId]` | Inspect current worker/model routing, recent activity (last 20 summaries), changed files, tests, retries, recovery and blockers. Supply a worker ID to filter its activity. |
| `/mission why <id>` | Explains why a mission is not finishing: blocking task, failure category and reason, who holds the repository lease or custody (session and pid), cooldown scope and `nextActionAt`, retry counters, inherited failures, stranded branches, per-task typed usage (tokens, wall-time split, attempts, stream resumes, thinking), per-model error rollups (429, 404, connect-refused, stream stall, takeover, grammar 400) and the exact remedy command. Offline equivalent: `pi-engineering missions why --store <dir> <id> [--json]`. |
| `/mission pause <id>` | Pause one named mission (no live turn needed). Esc pauses the turn on screen; this pauses the mission you name. Its work is kept and only `/mission resume <id>` continues it. |
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

## External mission entry (AutoSpec adapter)

The `pi-engineering mission` subcommand is a JSON entry point for an external
system (AutoSpec) to hand Pi a mission and watch or stop it. It reads exactly
**one JSON object on stdin** and replies with exactly **one JSON object on
stdout**; errors are also JSON objects (see exit codes below). Pi stays the
mission's owner: submit creates the mission in `CREATED` (status `NEW`) and
acquires its lease for `ownerId`, returning the lease's fencing token.

```
pi-engineering mission submit  --store <dir>   < input.json   # create or re-confirm a mission
pi-engineering mission observe --store <dir>   < input.json   # read a mission snapshot
pi-engineering mission cancel  --store <dir>   < input.json   # cancel a mission
```

### Master switch and guard

The entry is **off unless `PI_AUTOSPEC_ENABLED` is set** (`1` or `true`). Without
it the command exits **2** and prints to stderr:

```
pi-engineering mission is off: set PI_AUTOSPEC_ENABLED=1 to use the external entry point
```

It never runs inside a mission worker: `assertRootMissionAllowed` refuses when
`PI_MISSION_DEPTH` is non-zero, so nested missions are not allowed.

### Submit

Reads a plain-JSON request object:

- **Required:** `ownerId`, `idempotencyKey`, `title`, `goal`, `repository`,
  `baseRef`.
- **Optional:** `userRequest` (defaults to `goal`), `workflowClass` (default
  `"engineering"`), `riskProfile` (one of `low`/`medium`/`high`/`critical`,
  default `"medium"`), `leaseMs` (clamped, see below), `constraints` (an
  optional array of strings).

`submit` is idempotent: the same `idempotencyKey` always names the same mission
(`MSN-ext-<sha256>`), across processes and restarts. Re-submitting an existing
mission under the same owner confirms its lease and returns `result:"existing"`;
a `leaseMs` it carries is clamped to at most the submission-receipt cap. A
`submit` whose idempotency key already belongs to another owner is rejected
with `{result:"conflict", missionId, reason:"the idempotencyKey belongs to
another owner"}` and exits **1**, writing nothing.

**Submission-receipt lease cap.** `SUBMISSION_RECEIPT_LEASE_MS` is **5 minutes**
(300 000 ms). Any `submit` `leaseMs` is clamped to at most this value so no
submit can grant a long-lived ownership receipt; `observe` and `cancel` do
**not** renew the lease. A runtime-held controller lease (24 h default) is a
separate concern, not granted by this entry point.

**Response** (exactly these fields):

```json
{ "result": "created" | "existing", "missionId": "MSN-ext-…", "ownerId": "…", "fencingToken": <int>, "status": "NEW", "canonicalState": "…" }
```

### Fencing tokens

Every later call must present the same `ownerId` and the fencing token returned
by submit. The token must match the store's **latest lease epoch exactly**: a
lower token is a superseded owner, a higher token was never issued, and either
is rejected as **`stale` with exit 1 and nothing written** (no read, no write).

### Observe

Request: `{ "missionId": "…", "ownerId": "…", "fencingToken": <int> }`.

Response: `{ "result": "ok", "mission": <snapshot> }` where `<snapshot>` is
the mission snapshot (tasks, findings, executions, classifications, lifecycle).
If the mission does not exist the reply is `{ "result": "not_found",
"missionId": "…" }` (exit **1**); if the owner or token is stale the reply is
`{ "result": "stale", "missionId": "…" }` (exit **1**).

```bash
# observe: read the mission snapshot
pi-engineering mission observe --store <dir> < observe.json # {result:"ok", mission:<snapshot>}
```

### Cancel

Request: `{ "missionId": "…", "ownerId": "…", "fencingToken": <int>, "reason": "…"? }`
(the `reason` is optional). Response: `{ "result": "cancelled", "missionId":
"…", "status": "CANCELED", "reason": "…" | null }`. Same `not_found`/`stale`
handling as observe (exit **1**).

### Exit codes

- **0** — ok.
- **1** — stale / conflict / not found (a valid request that could not be served).
- **2** — disabled (no `PI_AUTOSPEC_ENABLED`) or invalid request (bad JSON, missing
  field, bad subcommand, missing `--store`, invalid `riskProfile`, malformed
  `fencingToken`).
- **3** — the store could not be opened (missing/unreadable `orchestration.jsonl`,
  or the store refuses to run beside a live writer).

### Complete examples

```bash
# submit: create a mission and receive its fencing token
pi-engineering mission submit --store <dir> < submit.json # {result:"created", missionId, ownerId, fencingToken, status, canonicalState}
```

```bash
# observe: fetch the mission snapshot with the token from submit
pi-engineering mission observe --store <dir> < observe.json # {result:"ok", mission:<snapshot>}
```

## Optional AutoSpec DAG, design-gate evidence and quality law

Everything here is OFF unless an `autospec:` block exists in `~/.pi/agent/engineering.yaml`
(global) or `<repo>/.pi/engineering.yaml` (repo). There are no environment variables, and
with no block nothing from `src/integrations/autospec/` is imported, read or executed. The
`mission submit|observe|cancel` contract is unchanged.

```yaml
autospec:
  dag: {enabled: true}                  # global only
  design_gate:
    report: .autospec/reports/design-gates.json   # global only, repo-relative
    rules_file: /path/to/autospec-design/rules.yaml  # global only: Pi's own view of vlm/review rules
    ui_paths: ["src/ui/**"]             # global sets; a repo layer may only add
    require_for_ui: true                # a repo layer may only turn it ON
  quality_law:                          # global only, informational
    profile_file: /path/to/profile.json
    profile_id: web
    gate_files: [/path/to/quality-gate.json]
```

- **DAG ingestion**: `pi-engineering plan --store <dir> --from-autospec <file|dir>` (a file
  `{mission, tasks}` or a directory with `mission.json` and `tasks.json`). Refused unless
  `autospec.dag.enabled: true` is set in the global config; a repo layer cannot enable it. It maps
  `autospec.protocol.mission/task.v1` records to plan tasks (`depends_on` = prerequisites), keeps
  repo-qualified issue refs (`owner/repo#N`, from the `autospec.issue_refs` extension) in
  `execution_requirements.autospec` so they are covered by the plan digest, and fails closed on cycles
  (iterative, at most 2000 tasks), missing dependencies, unknown *required* extensions,
  `autospec-managed` executors, started work, odd task ids, and surfaces that are wildcards, `~`,
  control characters or under `.git/`, `.pi/`, `.autospec/`. The plan then goes through the same T03
  plan-review gate and policy as any other plan. Like the standalone plan it stops before any worker
  starts; Pi stays the execution authority.
- **Design gate evidence**: Pi never runs the design gates. It reads the report AutoSpec's
  `autospec-design-gates.sh` wrote, **from the commit under evaluation** (`git show <sha>:<report>`);
  an untracked or edited worktree copy is ignored. It recomputes the verdict from `gates[]`
  (a failed `severity: blocker` gate blocks whatever its `blocking` flag says) and requires every
  `auto` rule in Pi's vendored table (or the operator's `rules_file`) to be present. The report must
  name the commit it was produced for (`commit_sha`, or a `design-gates.commit` sidecar); that commit
  must be the evaluated commit or an ancestor with no UI-path change since (the report cannot name its
  own commit, so it is normally committed one commit later). SKIPPED, missing, stale, unbound,
  malformed or incomplete reports are "not run" / unavailable, never a pass. `vlm` and `review`
  rules are an advisory checklist.
  With `require_for_ui: true` the interactive completion gate blocks a UI change without valid
  evidence, **and so does the orchestrated-mission completion gate**: it evaluates the candidate commit
  (`CandidateEvidenceIdentity.candidateSha`) against the changed UI paths, synchronously, from a
  committed report. A mission with several repository candidates is blocked rather than skipped.
  Without `require_for_ui` the item is shown but never blocks. A malformed `engineering.yaml` (either layer)
  counts as configured and blocks; it never silently switches the gate off. `ui_paths` are case-insensitive
  anchored globs (`*` within a segment, `**` across; `dir/**` also matches `dir` itself; `? [ ] { }` are
  rejected; use a leading `**` segment to match a file name at any depth). `report` must end in `.json`.
- **Attestation (recommended)**: set `design_gate.attestation_key_file` (global only) to an ABSOLUTE
  path of an owner-only (mode 0600) regular file, not a symlink, outside the repository, its top level
  and every linked worktree; anything else is rejected. The report must then be accompanied, in the same commit, by
  `design-gates.sig` = hex HMAC-SHA256 over `<commit_sha>\n<sha256 hex of the report bytes>`,
  produced by the operator's trusted runner. Without a key, provenance is only "committed": a worker
  that can commit can still commit a forged report. That is a residual trust assumption, not a fix.
- **Quality law**: the profile's Constitution `quality_gates` are listed in the finalization
  output as "not verified".

## Mission worker tools

Mission implementer and repair workers get `read`, `edit`, `write`, `bash`,
`repo_search` and `tests_for`. `read` prefixes every line with its line number.
`edit` first tries Pi's exact match; if that misses, it retries with
whitespace-normalised matching (trailing whitespace, indentation width, CRLF)
and applies the edit when exactly one place matches, re-indenting the
replacement to the file. When nothing or several places match, the error quotes
the closest candidate lines with line numbers. Implementers have no ledger,
artifact or `checkpoint_progress` tools: they commit when a step is done, and
the broker harvests uncommitted work and derives the checkpoint from the branch.
Scouts and reviewers keep their read-only semantic tools.

## Repair rounds and the degeneration guard

- One repair contract per round: all open blocking findings go to a single repair implementer task whose objective lists every finding (id, severity, file:line, summary, suggestion). Each finding is still resolved or left open individually after the round. The round limit is unchanged (`maxRepairRounds`, default 2).
- `blocker`, `critical`, `blocking` and `high` findings block completion, except that a `high` `missing_tests` or `spec_gaps` finding is recorded on the mission as non-blocking (`major`, still visible). A `request_changes` verdict with only non-blocking findings still starts a repair round. Each finding is resolved by the next review: one it still reports stays open and is re-sent, without a duplicate row.
- A failed integration is re-merged onto the current base up to twice before the mission stops; no LLM repair task is created for a merge conflict or infrastructure failure. Gates that ran and failed on the candidate (validation, review, or integration checks classified VALIDATION_FAILED) become a code-repair task.
- Worker degeneration guard defaults are 2000 narration tokens before the first action and 4000 tokens without progress (`PI_GUARD_MAX_NARRATION_TOKENS`, `PI_GUARD_MAX_REASONING_TOKENS`). The first trip steers inside the same session with a short corrective turn; only a second trip restarts a fresh session. Reviewer sessions no longer receive the Tool Transition Rule.

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

## Primary worktree guard

The extension enforces the one-agent-one-worktree rule (AGENTS.md: each agent
works in its own git worktree and never runs `git checkout` / `git switch` /
`git reset` in a directory it does not own). Until this guard existed the rule
was prose: a long-running session worked directly in a repository's PRIMARY
checkout (the main / production worktree) while another session carried
uncommitted work there; a force-switch destroyed the work, and a mission in
the same checkout planned against a base that kept moving.

`src/guard/primaryWorktreeGuard.ts` (on the `tool_call` hook, on by default)
blocks the session's own **mutating** calls against any git repository's
primary checkout:

- `write` / `edit` to a path in the primary checkout;
- bash `git` commands that change its state (`commit`, `checkout`, `switch`,
  `reset`, `merge`, `rebase`, `cherry-pick`, `am`, `apply`, `stash` (except
  `list`/`show`), `add`, `rm`, `mv`, `restore`, `revert`, `update-ref`,
  `gc`/`prune`/`clean`/`filter-branch`, `replace`, `notes` (except `list`),
  `tag <name>`, `branch <name>`/`-d`/`-D`/`-f`, `config` settings);
- bash writes into it (`> f`, `>> f`, `tee f`, `sed -i … f`, `mv`/`cp` into
  it).

Each mutating invocation is judged **where its own segment runs**, not where
the command started: `cd <own-worktree> && git push && git -C <primary> log`
leaves the `push` allowed and blocks only a mutating tail aimed at the primary.
The block reason names the culprit segment, so a compound command says which
step to move rather than refusing the whole line.

Read-only inspection (`git status`, `log`, `diff`, `show`, `fetch`, `ls-remote`,
`cat-file`, `for-each-ref`, `rev-list`, `merge-base`, `reflog`, `grep`, a bare
`git tag`, `git remote -v`, …) and worktree management (`git worktree
add|remove|list|prune`) stay allowed — that is how a session observes the repo
and **leaves** for its own worktree. The block reason tells the model the
escape hatch: `git worktree add <sibling-dir> -b <branch> origin/<base>`; when
the session's own worktree is gone (it removed it, or it was cleaned up) the
reason says so and gives the command that gets one back.

A `git` command is recognised by the word itself (`git`, `/usr/bin/git`,
`./git`) and by a verb git actually knows: a path segment
(`gh api repos/<owner>/<repo>/git/refs/…`), a filename (`rm /tmp/x.git`), a
branch name (`-b fix/…-git-…`) and prose (`echo "--- git: what is X ---"`) are
not commands — matching them as ones blocked the very `git worktree add` the
message above recommends, and blocked ordinary `echo` separators. Quoting is
stripped rather than skipped, so `sh -c 'git commit'` is still caught, a verb
inside a quoted argument (`grep "git push" README.md`) is still treated
conservatively, and an unknown verb at a real command position (`git what`)
stays blocked in case git grows a mutating verb this list predates.

Knobs (set before starting the session):

- `PI_ENG_PRIMARY=1` — this session is authorized to work in primary
  checkouts (production ops: deploys, docker, branch inspection that must
  happen in the production tree).
- `PI_ENG_WORKTREE_GUARD=0` — disable the guard entirely.
- `PI_ENG_BRANCH_TEARDOWN=0` — also refuse the one state change the guard
  allows on proof: deleting a **local branch** that is merged into the base
  (by ancestry or patch-equivalent, so a squash-merge counts) and checked out
  in no worktree. That is the convention's end-of-life step — merge, then clean
  up the branch you created — which had no in-session route at all beyond
  restarting with `PI_ENG_PRIMARY=1`. Any name in the delete that fails the
  proof blocks the whole command.

The bash checks are best-effort (no full shell parsing); an unrecognized
mutating form is a gap to close when it bites, not a contract hole. `git -C`,
`--git-dir` and `--work-tree` are all read as naming the checkout, so the
`--git-dir=<primary>/.git` form that once routed around the guard does not.
The runtime's own in-process git operations (mission workers run in candidate
worktrees; integration, janitor) do not go through the tool-call hook and are
unaffected.

## Recovering an interactive turn after the gateway wait is spent

Pi retries a failed turn three times, and the gateway wrapper waits a short transient out for about five minutes (fifteen with alternate-model advice). Before this, a turn that failed before any output after that ended and sat until the operator typed "retry".

`SettleRecovery` (`src/gateway/settleRecovery.ts`) is the last settle-boundary handler. When a turn failed with a retryable error and nothing was written, and no earlier handler continued it, it continues the turn after a paced wait: 30 s doubling to a 5 min cap with jitter, or the gateway's own advertised wait (up to 10 min) when that is longer. The wait is taken by the gateway wrapper, so Esc stops it.

It never retries a final refusal (`do_not_retry`, `fix_request`, unknown model, context overflow, oversize body, exhausted quota or spend limits) or an abort, and it does nothing for a model whose requests bypass the wrapper. A successful assistant message, a model switch, or the end of the run starts a fresh budget. It gives up after 150 attempts or the shared retry window (12 h), whichever comes first, and says so in the telemetry line. A turn cut after output has begun stays with `AfterOutputRetry`.

| Variable | Effect |
|---|---|
| `PI_SETTLE_RECOVERY=0` | Turn the handler off. |
| `PI_SETTLE_RECOVERY_HORIZON_MS` | Give up this long after the first failure. Defaults to `PI_GATEWAY_MAX_ELAPSED_MS`. |
| `PI_SETTLE_RECOVERY_BASE_MS`, `_CAP_MS` | First wait and the longest wait. |
| `PI_SETTLE_RECOVERY_MAX_ATTEMPTS` | Continues per episode. |

## Resuming a worker after a cut stream

When a worker's model stream is cut ("Stream ended without finish_reason", a
dropped connection, a link cut) AFTER tool calls ran, the session is kept. The
failed partial assistant message is dropped from the agent's history
(`session.agent.state.messages`), every executed tool call and its result stays,
and the turn is re-issued with `session.agent.continue()` on the same model
after the usual transient backoff. Nothing is replayed, so side effects run once.
The same history edit backs the interactive `afterOutputRetry` extension
(`src/inference/streamResume.ts`).

- At most `PI_STREAM_RESUME_MAX` resumes per execution (default 3; 0 disables).
  The next cut settles as `truncated_after_progress` as before.
- Each resume is a status notice and an activity event, and the execution's
  usage carries `streamResumes`.
- A cut before any tool call is unchanged: the attempt is retried in a fresh
  session without consuming an attempt.

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

A `Cargo.toml` repository gets `cargo check --all-targets`, then `cargo nextest
run` when `cargo nextest --version` succeeds (otherwise `cargo test --lib --bins
--tests`), then a separate `cargo test --doc` stage, because nextest does not run
doctests. The test stages run under the progress watchdog; nextest's
`PASS`/`FAIL`/`SKIP` lines count as test progress.

### Failures that were already red on the base

Integration and validation judge a candidate by the failures it introduces. When
a candidate's checks fail, the same profile is run once on the commit the
candidate was built on (a temporary worktree, never the shared checkout) and
the result is cached per (base SHA, profile hash) under the repository's
`pi-engineering-baselines` git directory, so it runs once per base, not once per
round. A failure is identified per test name (`test:<stage> » <name>`) when the
stage output yields node:test TAP/spec names, otherwise per stage
(`stage:<name>`, the command exited non-zero). A candidate whose failing ids
all also fail on the base passes with a warning and structured
`inheritedFailures`; any other failing id is new and fails the run. Flaky base
failures are never forgiven: the base is run `PI_ENGINEERING_BASELINE_RUNS`
times (default 2) through every stage, and a failure must occur in all of them.
A failing stage must also end as it did on the base (same exit code, not hung),
and a run that failed with no identifiable failure blocks. A bare test name is
not qualified by its file, so the same name failing in two files collides. The
base run is bounded by `PI_ENGINEERING_BASELINE_TIMEOUT_MS` (default 20
minutes); a timed-out or environment-failed run is not cached. A candidate that
stopped at an inherited failing stage is re-run through its later stages before
it is judged. If the baseline cannot be computed (base commit
unavailable, different profile, uncommitted changes) the run is judged without
one and says so in its warnings. An integration run whose checks ran and failed
is classified `VALIDATION_FAILED` (a code repair); `MERGE_CONFLICT` is reserved
for an actual merge conflict.

### Promotion through the merge queue

A mission's candidate reaches the shared checkout only through the SHA-fenced
merge queue (`src/merge/MergeQueue.ts`), which the broker builds once per
repository and target branch. Promotion needs passing validation (a clean
failure-baseline verdict) and an approving review for the exact candidate SHA.
The entry is bound to that reviewed SHA and to the base it was validated on: a
candidate branch or target that moved is never merged, required checks that
fail or are pending block (none are configured unless a host supplies them, so
GitHub is never required), and the queue reports `MERGE_QUEUED`, `MERGING`,
`MERGED`. A same-model review (`same_model_reduced`) blocks promotion when a
reviewer of another model family was available or
`PI_ENGINEERING_REQUIRE_INDEPENDENT_REVIEW=1` is set; otherwise the mission
promotes and records one `review_independence` warning. A queue rejection (stale
base, conflict, failing checks) moves the mission to `REPAIRING` and retries; the
third rejection in one resumption leaves it `BLOCKED` with a durable stop. A
repair round re-enters the queue; it does not rebase the candidate onto a moved
target, so a stale base ends `BLOCKED` for the operator to rebase and resume. A
restart while `MERGING` finishes the committed promotion instead of merging again.

### Verification result reuse

The full suite runs once per candidate commit. Integration stores its passing
result under `<git-common-dir>/pi-engineering-verify/`, keyed by the candidate
SHA, the verification profile hash and (when a failure baseline applies) the
base SHA; validation of the unchanged candidate reuses it instead of running the
suite again. The validation evidence then carries `testSummary.reused: true` and
`originalRunId`, a `verify.cache` activity notice is emitted, and the evidence
stays bound to the exact candidate. An entry is never reused when the candidate
SHA, base SHA, diff hash (an unset base is the explicit `no-base`), stage list
or profile differ, when the environment fingerprint differs (node/npm/cargo/python
versions resolved on PATH, `CI`, `NODE_ENV`, lockfile hashes, and the mtime of
`node_modules`/`target`), or when the checkout has any tracked modification or
untracked non-ignored file; failed results are never cached. Residual limit:
ignored files outside those dependency directories are not seen. Entries older
than 7 days or beyond 200 are pruned on write, with stale `.tmp`/`.lock` files.
Concurrent processes asking for the same key compute it once (cross-process
lock). When validation is a reuse, the review runs alongside it instead of
waiting, starting only once validation has confirmed the reuse; if the entry
vanished and validation really runs, the review waits for it.

A finer, per-stage layer exists as a library (`src/verify/testResultCache.ts`,
#149) and is not consulted by the verifier yet: a stage's passing result is
reusable only when the source tree (content, including uncommitted changes), the
lockfiles, the toolchain versions, the stage command, an explicit environment
allowlist and the base SHA all match. A failed result is never stored.

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

### Nightly real-mission dogfood

Unit tests and the deterministic `scripts/dogfood-*.ts` runs never drive a real
`/mission` through the gateway, so they cannot show that missions complete.
`scripts/dogfood-real-mission.ts` does: it runs two real missions through
`EngineeringRuntime` (a docs-only README change, then `multiply(a, b)` with a
test), each on a fresh green fixture repo with isolated
`PI_ENGINEERING_STATE_DIR`/`PI_ENGINEERING_HOME`, and writes
`{kind: "dogfood_mission", sha, missions: [{goal, missionId, status,
candidateSha, wallMs, calls, inputTokens, outputTokens, model}], ranAt}`. Token
and call figures come from the same mission-store extraction as
`pi-engineering missions why --json`. It exits 0 only when both missions reach
`COMPLETE` within `--timeout-ms` (default 30 minutes each); otherwise it exits 1
and prints the `missions why` text of the failed mission. It exits 2 without the
gateway environment:

```bash
PI_DOGFOOD_GATEWAY_BASE_URL=https://gateway.example/v1 \
PI_DOGFOOD_GATEWAY_API_KEY=... \
PI_DOGFOOD_MODEL=metabolomics/qwen3.8-27b-modality-text-quant-mxfp4 \
  node scripts/dogfood-real-mission.ts --out dogfood/$(git rev-parse HEAD).json
```

`.github/workflows/nightly-dogfood.yml` runs it at 03:00 UTC (and on manual
dispatch) on a self-hosted runner, uploads the record as an artifact, and on
success opens a PR (never pushes to main) adding it as
`docs/roadmap/dogfood/<sha>.json`. Operator steps; nothing is queued until the
last one:

1. Register a runner that can reach the gateway with labels `self-hosted` and
   `inferweave`.
2. Add repository secrets `DOGFOOD_GATEWAY_BASE_URL` and
   `DOGFOOD_GATEWAY_API_KEY`.
3. Add repository variable `DOGFOOD_MODEL`.
4. Optional: add secret `DOGFOOD_PR_TOKEN` (a PAT or GitHub App token) used to
   push and open the evidence PR. PRs opened with the default `github.token`
   do not trigger `pull_request` CI, so without it close and reopen the PR to
   run CI. Either way, enable "Allow GitHub Actions to create and approve pull
   requests" (Settings > Actions > General).
5. Add repository variable `DOGFOOD_RUNNER_READY=true`.

Roadmap effect: `release_gate.require.real_mission_dogfood: true` (set in
`docs/roadmap/roadmap.yaml`) makes `roadmap check` demote a `VERIFIED`
milestone to `IMPLEMENTED` unless a passing `dogfood_mission` record is pinned
to a SHA at or after the latest commit touching that milestone's own
`scope.paths` (per-milestone, not global `src/`). A record passes only when
every mission in it is `COMPLETE`. A record is fresh for a
milestone when no commit reachable from `HEAD` but not from the record's SHA
touches that milestone's scope (reachability, not commit dates, so merged side
branches count). Records must be named `<sha>.json` for the `sha` they claim and
that SHA must exist in the repository; others are ignored and named in the
demotion blockers. This is an honor system: the record is a committed JSON file
reviewed in the evidence PR, and nothing cryptographically proves the missions
ran. `roadmap check --structural` (PR CI) is unaffected. Until the runner exists the release gate therefore reports those
milestones as `IMPLEMENTED`; run `/mission` on a fixture repo by hand and read
`missions why` as the interim measure.

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

The runtime makes it git-ignored itself: on open it writes `.pi-eng/.gitignore`
(`*`) when none exists, so the directory stays out of `git status`, `git add -A`,
`git stash -u` and `git clean -fd` even in a repository whose own `.gitignore`
does not list it. That matters: a `git stash -u` round-trip deletes and
recreates an unignored `.pi-eng/` with default permissions and new inodes, and
the artifact store then refuses to open (`ARTIFACT INTEGRITY: artifact root is
writable by another user` / `artifact lock root identity changed`). If that has
already happened, move `.pi-eng/artifacts` aside while no session has the store
open; the runtime recreates it on the next open.

When the runtime cannot open for a directory, the `mission` tool and `/mission`
(including `/mission cancel`) report why:
`Orchestrator not initialized for this directory: <reason>`. The tool also
returns a `details.diagnostics` entry with code `orchestrator_init_failed`.

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
- **Repository lease scope.** Implementer and repair workers run in their own
  worktrees under lane (write-domain) coordination only, so several missions can
  work on one repository at once. The exclusive per-repository lease is taken
  only to integrate into the candidate and to promote into the shared checkout,
  and is released right after. A lease held by another mission makes the task
  wait (the mission snapshot's next action names the holder mission) instead of
  blocking it; cross-session custody waits back off from 250 ms up to the 5 s
  poll interval within the same 10 minute ceiling.
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

## Risk-aware legacy verification and review

For legacy `/engineer` and tournament candidates, a low risk label enables cheap
verification only after the runtime reads the candidate's actual Git diff. A
change consisting entirely of `.md`, `.rst`, or `.adoc` files gets a required
patch-whitespace check plus any trusted `verify:docs` and `test:docs` scripts.
Agent instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `SKILL.md`)
retain the normal gates. Configuration files such as `requirements.txt` also
retain normal verification.

For other low-risk changes, the owner may declare `verify:quick` or `test:quick`
in the trusted checkout's package scripts (`verify:quick` takes precedence).
Without an owner-declared quick script, the normal profile remains in force.
Requests that explicitly mention verification, tests, checks, build, or lint keep
the normal gates; explicit full-suite requests select the full profile. Commands
are chosen from the trusted owner checkout and run in the candidate worktree.
Manual `/verify full` continues to request the broader suite.

Legacy independent reviews must return `details.findings` explicitly, including
an empty array for a clean review. Each finding must have a valid severity, a
nonempty claim, and an evidence string. A missing or malformed payload is an
incomplete review, so it cannot authorize promotion. Artifact-backed claims are
accepted as machine evidence only after content validation, including after
reopening a store.

## Artifact startup and paged reads

Reopening an artifact store validates metadata, file types, transaction recovery,
and content sizes without reading every historical blob. Content digests are
verified on first content access; same-size digest corruption is reported at that
point rather than at startup. Missing files, size mismatches, invalid paths, and
unsafe links still fail closed.

The first paged read streams the artifact once to verify its digest and build a
bounded sparse character index. Subsequent pages read the requested range near a
checkpoint. The cache retains indexes for at most 16 files, with at most 1,025
checkpoints each; it does not retain whole decoded blobs. File replacement,
modification, or metadata digest changes invalidate reuse. Pagination offsets
remain JavaScript string offsets (UTF-16 code units).

## Worker permissions and recovery isolation

A worker receives the builtin and semantic tools explicitly named in its request
allowlist, plus its executor-owned terminal result tool. Supplying tools to the
executor makes them available for selection; it does not grant them to every
role. Custom callers must explicitly name safe retrieval tools they need, such as
`ledger_read`, `artifact_read`, `repo_search`, `symbol`, and `tests_for`. Nested
`mission` execution and `ledger_claim` are not implicitly granted to reviewers
or scouts.

An explicit model-routing refusal stops planner-worker dispatch for every role;
it cannot silently select the worker's default model. Standalone hosts with no
routing information can still use their configured worker default.

A named mission wait protects its own condition. It cannot hide a separately
running worker that has exceeded its meaningful-progress stall threshold.
Worker-specific queue/model waits must be recorded on that worker, rather than
represented only as a mission-level wait. The supervisor still debounces stall
recovery and preserves existing opt-in deadline policy: this change adds no
mission wall-clock limit. The observability spec's universal wait-deadline wording
remains a policy discrepancy; default recovery waits currently end when their
condition changes or the operator cancels.

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


### Live mission activity

A visible mission footer refreshes every second while the mission is active. It shows health,
current activity, elapsed activity/wait time, last output, worker heartbeat and last meaningful
progress. These timestamps stay separate: a heartbeat proves the worker is alive, not that its
work advanced. Acceptance and workflow counts remain evidence-based; model calls show elapsed
time instead of a made-up completion percentage. A slow or stalled mission keeps its health
and current activity visible even on narrow terminals.

The serving model is shown as `route → provider/model` when both are recorded; this identifies
the backing model without renaming aliases. Missing telemetry reads `not recorded`.
`/mission-status` lists missions and `/mission inspect <id> [workerId]` opens a bounded readout
of recorded activity, files, test failures/retries and blockers. Each worker also shows its latest
captured tool output preview when available: actual tool result/update text with secrets and
terminal control sequences removed, capped at 1,000 characters. Until a tool emits captured output,
the inspector says `not recorded`. Model messages and private reasoning are never used as output
previews. These previews appear in inspection, not compact bars or HerdR attention notifications.

The mission refresh timer stops for completed, failed, canceled or operator-paused missions and
on runtime shutdown. Local footer refreshes do not create repeated notices. With the `herdr:` block of the global `engineering.yaml` configured (see "Herdr connection" below), HerdR receives one attention event when a mission
finishes, fails/crashes, or becomes stalled. Routine progress and heartbeats do not notify HerdR;
a recovered mission can alert again if it stalls again. Reconnecting seeds current state without
re-alerting about historical terminal or stalled missions.

Stall detection is evaluated on the next live tick once the configured criteria are met. Defaults
are slow after two minutes and stalled after five minutes without meaningful progress, together
with the recorded silence/loop evidence; a normal quiet model request is not automatically a crash.
Planner-worker missions use their configured silence watchdog and display its limit.

Planner-worker missions also update their persistent widget/status once per second. Use
`/engineering-workers [task]` to inspect a task's bounded recent activity, changed files and
recorded result/blocker, or `/engineering-status` for the current activity summary. Verified
contract counts determine percentage; live timers do not advance it.

### Herdr connection (global `engineering.yaml` only, no environment variables)

One block configures every Pi-to-Herdr path (attention events, lineage, steering, forks). It is read from the
GLOBAL `engineering.yaml` in Pi's agent directory only; a repository file cannot set it, and the old
`HERDR_INGEST_URL`, `HERDR_INGEST_API_KEY` and `HERDR_HOST_ID` variables are no longer read. If one of them is set,
Pi prints an error to stderr (once per process) saying so; there is no silent fallback.

```yaml
herdr:
  url: https://herdr.example.org       # https, or http only for localhost / 127.0.0.1 / ::1
  api_key_file: /home/me/.config/herdr/key   # absolute path, mode 0600, owned by you, one line
  instance_id: pi-laptop-1             # optional: names this Pi when several share one key
  lineage: true                        # optional (default false): emit typed lineage events
  visibility: room                     # optional: private | mission | room | org (default private)
  room_id: room-abc                    # optional: stamped on every lineage event (Herdr lineage_key_scopes)
  workspace_id: ws-1                   # optional
  mission_id: m-1                      # optional default mission for events that carry none
```

Absent block means Pi does not talk to Herdr at all. The key is read from the file, never logged, and is not placed
in the environment of anything Pi starts. Commands whose text a worker can author (the verifier's check commands,
CAV test runs) run with a scrubbed environment: every `HERDR_*` variable, GitHub tokens, `SSH_AUTH_SOCK` and
anything named `*_API_KEY`, `*_SECRET` or `*_PASSWORD` are removed.

Sequence recovery: Herdr orders each source by `source_sequence`. If Pi's sequence file is lost or restored from an
older copy, Pi lifts the counter above its own outbox, and on a `409` naming a taken sequence it learns the server's
high-water mark (`reason: "sequence_conflict"` and `last_sequence` in the 409 body when Herdr sends them, otherwise the message text and `GET /api/v1/ingest/sources`),
resumes above it and re-numbers the pending events; nothing is dropped. When that cannot be done, the event is
dead-lettered with an error notice and `conflictDeadLettered` in the ingest diagnostics.

Steering requests are judged on Herdr's clock (the `Date` header of the poll response plus monotonic time since),
not on Pi's wall clock. A request that names a digest (`expected_digest`) is applied (redirect, resume, fork, promote)
only while the target's current plan digest equals it, and is answered `stale` when Pi cannot compute one. Today Herdr
sends `expected_digest` only on `approve`/`reject`, which Pi answers `unsupported` (gate decisions are not taken from
steering), so in practice the digest check guards nothing that is applied yet; it is there so a Herdr that starts
sending it on the other actions cannot be trusted by accident. Herdr's `fence` is an opaque hash Pi cannot recompute:
it is compared only where a runtime supplies a fence for the target (none does today) and is always recorded in the
at-most-once ledger.

External web consumers receive additive `waitingSince`, `lastOutputAt`,
`currentActivityStartedAt` and worker timing fields in the mission snapshot. They should derive
elapsed times from these timestamps locally. This package does not control the separate web
plugin's redraw loop; the runtime does not rewrite snapshots every second just to animate a timer.
