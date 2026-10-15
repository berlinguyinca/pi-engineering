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
no stand-in fits, the request waits as before and ends with the advice. Set
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

### Reviewer retries on a dead provider

Gate roles (reviewers and challengers) judge work and have no side effects, so
they do not wait out a dead route in-session. Next to the worker-wide
`PI_GUARD_TRANSIENT_*` variables, `PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS`
(default 2) caps the transient retries a gate role spends on one model; after
that the review moves to the next eligible model, and a provider whose connection
was refused is skipped for five minutes. An operator-pinned reviewer is exempt
from the cap and keeps waiting, unless its host refuses connections or does not
resolve; then it moves to another model with a notice.

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
one-shot planner and interactive sessions keep their current behaviour. Each
such request logs `thinking: off (mission role)`.

The policy applies to `openai-completions` models on providers `metabolomics`,
`beast`, `bender` (`PI_THINKING_OFF_PROVIDERS`) or hosts `llm.example.com`,
`llm.metabolomics.us`, `127.0.0.1`, `localhost` (`PI_THINKING_OFF_HOSTS`,
comma-separated; entries match `host:port` or the bare hostname;
`PI_THINKING_OFF_GATEWAYS` is the older name).

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
| `/mission why <id>` | Explains why a mission is not finishing: blocking task, failure category and reason, who holds the repository lease or custody (session and pid), cooldown scope and `nextActionAt`, retry counters, inherited failures, stranded branches, per-task typed usage (tokens, wall-time split, attempts, stream resumes, thinking), per-model error rollups (429, 404, connect-refused, stream stall, takeover, grammar 400) and the exact remedy command. Offline equivalent: `pi-engineering missions why --store <dir> <id> [--json]`. |
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
vanished and validation really runs, the review waits for it. A finer per-test result cache is tracked separately (#149).

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
