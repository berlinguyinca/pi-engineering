# Mission Presence — design

Date: 2026-10-27
Branch: `feat/mission-visibility` (base `origin/main` @ `85b1b06`)
Status: approved direction (Approach 1 — "feed the meters, then paint them"); document pending approval
Supersedes nothing. Implements the operator-facing parts of `docs/specs/mission-observability/02` and `04`
that were specified but never wired.

## 1. Problem

An operator sitting at the terminal cannot tell, without asking, whether a mission is alive, what it is
doing, whether it is making progress, or whether it needs them. With dozens of missions running across
panes, the only answers are: open a command (`/mission-status`), open a panel that takes keyboard focus,
or read a footer line that reports lifecycle counts rather than mission state.

The felt symptom is "black screen / Working". The cause is not a missing design — specs 00-09 already
specify this capability in detail. The cause is that the machinery those specs produced is not connected
to anything the operator can see.

## 2. Root causes (verified on `origin/main` @ 85b1b06)

**RC1 — The observability service's operator-facing emitter is connected to nothing.**
`EngineeringRuntime` accepts `onMissionObservabilityUpdate` and passes it as `MissionObservability`'s
`onUpdate` (`src/runtime/EngineeringRuntime.ts:523`, `:1250`). No caller anywhere constructs
`EngineeringRuntime` with that option. Every sentence `MissionObservability` already composes — phase
changes, worker started/failed, `Tests: 34 passed, 1 failing`, `Blocking review finding: …`,
`Recovery attempt 2/4: …`, `Completion gate not verified: …`, `100% · VERIFIED COMPLETE ✓` — is emitted
into `undefined`.

**RC2 — Half the meters have no producer.**
Counting call sites outside `MissionObservability.ts` across `src/`, `extensions/`, `scripts/`, these have
zero callers: `taskProgress`, `setTaskUnits`, `setTaskWeight`, `meaningfulProgress`, `testProgress`,
`testCompleted`, `reviewStarted`, `reviewFinding`, `reviewCompleted`, `repairStarted`, `repairCompleted`,
`recoveryStarted`, `recoveryCompleted`, `recoveryFailed`, `gateFailed`, `noteWorkerRead`,
`noteWorkerError`, `noteWorkerCycle`, `workerFileChanged`, `loopSignals`, `hasLoop`,
`maybeEmitQuietUpdate`, `listMissionIds`. The worker activity path itself is wired
(`OrchestrationOrchestrator.observeWorkerActivity` ← `broker` `onActivity`, 15 s heartbeat timer), so
activity and heartbeats do reach the service — but test counts, review findings, repair, recovery,
measurable task units, and loop/stall evidence never do. `src/orchestration/broker.ts` does not reference
the observability service at all.

**RC3 — No surface owns mission presence.**
`WorkingStatusController` (`src/status/working.ts`) is the model to follow: it owns
`ctx.ui.setWorkingMessage` plus a `setWidget` panel, ticks on a 1 s clock, and renders
`Working · <activity> · <age> · <silence> · <route>`. It is driven exclusively by the foreground agent's
own session events (`onAgentStart`, `onToolEvent`, `onMessageUpdate`, gateway waits). It has no mission
input, so a background mission leaves it silent, and an in-session mission competes with tool activity.
`MissionFooterController` renders lifecycle task labels, and `renderAmbient` (`src/status/ambient.ts`)
renders file/finding/token counts — neither renders mission progress. `MissionPanelOverlay` is correct but
takes keyboard focus, so it cannot be the always-on surface. `ctx.ui.setWidget` is documented as
"Render a component above the editor" and does **not** take focus; `src/status/ambient.ts` claims pi
"offers no non-focusing variant", which is factually wrong and is the reason presence was pushed into the
footer. That comment is corrected as part of this change.

## 3. Goals

- G1. At a glance, in every pane: is anything running, what is it doing, when did it last prove it was
  alive, does it need me.
- G2. Works with dozens of missions without turning the terminal into a firehose.
- G3. Never steals keyboard focus; never competes with the foreground agent's own working line.
- G4. Deterministic. Percentages stay approximate and unit-derived; counts come only from real events.
- G5. Degrades to today's behaviour when disabled.

## 4. Non-goals

- A cross-pane/cross-host fleet board (needs a shared registry; deferred, see §10).
- A mission panel inside the vendored `split-view` extension (it owns thinking/tools/files bands and has
  zero mission awareness; we do not modify vendored code).
- Changes to DAG progress weighting, acceptance coverage arithmetic, or the stall policy engine.
- New persistence. `MissionObservability` already persists its event log.

## 5. Design

### 5.1 New component: `MissionPresenceController` (`src/status/presence.ts`)

A sibling of `WorkingStatusController`, same shape: a pure projection function plus a controller that owns
two sinks.

```
pure:  projectPresence(state: PresenceState, now: number, budget: RowBudget): PresenceView
impure: MissionPresenceController — subscribes, ticks, publishes
```

"The visible mission" means, in order: a mission this pane started or resumed, else the highest-ranked row
from §5.4. There is no UI focus concept in pi and none is invented here.

Inputs it subscribes to:

| Source | Use |
|---|---|
| `onMissionObservabilityUpdate(missionId, message)` (RC1) | the live activity sentence; the payload is a bare sentence with no mission context, so presence prefixes the mission id and flattens newlines before the working line |
| `onMissionActivity(event)` (already wired) | projection snapshot: phase, health, %, workers, heartbeat, `lastMeaningfulProgressAt`, action, next action |
| `MissionObservability.maybeEmitQuietUpdate` via its own clock (RC2) | liveness summary during silence |
| `MissionStore.listMissions` on a slow poll | missions that exist but have emitted no observability state yet |

Outputs:

| Sink | Content | Rule |
|---|---|---|
| `ctx.ui.setWorkingMessage` | `Mission · <activity> · <age> · <silence> · <phase> ~<pct>%` | written **only while the foreground agent is idle** (§5.3) |
| `ctx.ui.setWidget("engineering-missions", lines)` | the fleet strip (§5.4) | default placement, matching `engineering-working`; never another key |
| `ctx.ui.setTitle` | `<n> running · <m> need you · <repo>` | opt-in, default off (§5.6) |
| `ctx.ui.notify` | attention only (§5.5) | never for routine transitions |

### 5.2 Producer wiring (RC2)

Wired in dependency order, each with its own test, each additive:

1. **Quiet heartbeat.** The presence clock calls `maybeEmitQuietUpdate(missionId)` for visible missions.
   The method already suppresses itself when a real transition happened inside the interval, so double
   calls are harmless, and it is in-memory only — `emitUpdate` performs no durable write, so shortening
   the interval costs no storage traffic. Default `quietUpdateIntervalMs` drops from 300 000 to 60 000:
   five minutes is tuned for a background run, and an operator watching wants a minute. The interval
   semantics are pinned by `test/unit/observability-service.test.ts:505-524`, which is updated alongside.
2. **Recovery.** `OrchestrationOrchestrator`'s scheduler `onStatus` handler already distinguishes
   resumed / waiting / paused and calls `setWaiting`/`clearWaiting`. Add the matching
   `recoveryStarted` / `recoveryCompleted` / `recoveryFailed` calls so the recovery vocabulary in spec 02
   ("Recovery vocabulary") has data.
3. **Test units — split out, see §5.2a.**
4. **Review.** `reviewStarted` / `reviewFinding` / `reviewCompleted` at the fresh-review boundary, with
   severity and file:line already available on the finding record.
5. **Repair.** `repairStarted` / `repairCompleted` where the repair loop runs.
6. **Gate failure.** `gateFailed` beside the existing `gatePassed` path.
7. **Loop evidence.** Feed the existing `LoopTracker` signals into `loopSignals` / `hasLoop` so
   `stall.ts`'s `loop_detected` trigger has input, and `progress.ts` can report
   `no_progress_reason: "looping"`.
8. **Meaningful progress.** `meaningfulProgress` on the events that already carry
   `meaningfulProgress: true`, so `lastMeaningfulProgressAt` stops depending on the activity fallback.

`setTaskWeight` stays unused: the DAG already derives weights, and a second weight source would create
two answers to "how far along".

**5.2a — Test units need their own investigation before they are wired.**
`setTaskUnits` / `taskProgress` / `testProgress` / `testCompleted` are the only items here whose data
source is not already at hand. Tests for a mission task run inside a worker session, not the parent
session, so counts must be lifted out of worker activity events or out of the validation / gate result
record — and the repo's existing runner-summary parser lives in `src/runtime/herdr/InspectorFeed.ts`,
which is a remote feed, not an observability producer. Deciding between "parse worker bash output", "read
the gate's recorded test result", and "generalise the inspector parser into a shared module" changes how
much work this item is, and picking wrong means either invented counts or a second parser. Items 1, 2 and
4-8 are mechanical and do not wait on it; §5.4 renders the `tests` column only when counts exist, so the
strip ships and degrades honestly without them.

### 5.3 Surface ownership (the no-fighting rule)

- The foreground agent owns the working line while it is running. `WorkingStatusController.active` is
  private and stays private: presence tracks agent liveness itself from the same session hooks the
  extension already forwards (`onAgentStart` / `onAgentEnd`), writes the mission line only while the agent
  is idle, and clears it on agent start. This is the single rule that keeps two controllers from writing
  the same string, and it needs no change to `working.ts`.
- Widget keys are namespaced and never shared: `engineering-working` (gateway wait), `engineering`
  (footer ambient), `engineering-missions` (new), `model-refresh`, `split-view`. Presence never writes a
  key it does not own.
- Presence never calls `setFooter`/`setStatus`; `MissionFooterController` keeps the footer.
- Presence never calls `ctx.ui.custom()`; the panel keeps keyboard focus and stays a detail surface.

### 5.4 The fleet strip

Rows are a scarce resource. The strip is **attention-ranked**, not list-order:

```
MISSIONS  3 running · 1 needs you · 12 queued                    [esc] pauses this pane
! MSN-2ruR5  health endpoint             STALLED    ~31%  no progress 18m   <- needs you
> MSN-8QnZ   refactor ledger store        EXECUTING  ~64%  tests 34/81        3s ago
> MSN-Ed2F   gateway retry probe          VALIDATING ~92%  gate 2/3           7s ago
~ MSN-3T1fw  InferWeave admission         WAITING    ~48%  queue #4           41s ago
+ 11 more · /mission-status for detail
```

Ranking, deterministic with a total order: `needs_action` first, then `blocked`, then `stalled`, then
`waiting`, then running. Within a class: worst health, then oldest `lastMeaningfulProgressAt`, then
mission id. Rows never drop or reorder on a heartbeat alone — an elapsed label changing must not move a
row.

Budget: 4 rows plus the header and the overflow line by default, hard cap 8, `PI_MISSION_PRESENCE_ROWS`.
Overflow shows the count and the single worst unshown mission, so a mission that starts needing you cannot
hide behind 11 others.

Row vocabulary is ASCII-first, matching pi's own footer, which already spells paused as `|` — glyph
coverage across terminals and fonts is not guaranteed, and a strip whose markers render as boxes is worse
than no strip: `>` running, `~` waiting, `!` stalled, `x` failed, `v` verified complete, `|` paused.
Each row carries mission id, title (redacted, truncated), phase, approximate percent, the
best available unit (tests `34/81`, gate `2/3`, review findings, worker count), and the age of the last
proof of life. `lastHeartbeatAt` and `lastMeaningfulProgressAt` are distinct columns in meaning and must
never be collapsed into one "last seen".

### 5.5 Notification demotion

`onProgress` currently calls `ctx.ui.notify` for every progress line, and `onMissionActivity` already
notifies only for `needs_action` / `blocked` / `paused`. Progress lines move to the working line and the
strip. `notify` keeps exactly: needs-you, blocked, paused, failed, verified-complete, and the interactive
Esc path. With presence disabled, `onProgress` returns to its current behaviour so turning the feature off
never leaves the operator with less than they have today.

### 5.6 Terminal title

`ctx.ui.setTitle` is the only channel visible across panes without a second window, which is what "dozens"
wants. It is off by default: terminal titles are also owned by terminal multiplexers and by Herdr panes,
and this repo already defers to external pane title management. `PI_MISSION_TITLE=1` enables
`<n> running · <m> need you · <repo>`. pi exposes no getter for the current title, so "restore" is not
available; `setTitle(undefined)` is documented as resetting it to the default, and that is what disable
and dispose call. Never writes secrets or raw content.

### 5.7 Refresh discipline

One render per tick, and no publish when nothing changed: the controller compares the serialized view
against the last one published, the way `WorkingStatusController` compares `lastMessage` / `lastPanel`.
Event subscriptions mark the view dirty; a 1 s unref'd clock redraws elapsed labels and runs the
quiet-heartbeat check; a slow poll (30 s) picks up missions that have produced no observability state yet.
Both timers are unref'd, both are cleared in `dispose()`, and every publish is wrapped so a torn-down UI
can never fail a mission.

Missions executed on a remote worker host are not in presence's view; it reads only this process's
observability state, and §7 covers what it shows for a mission with no state.

## 6. Invariants

1. No invented numbers. Percentages stay `~`-prefixed and unit-derived; unmeasurable tasks stay `unmeasured`
   and are excluded from the denominator (spec 00, "Requirements", and `progress.ts`).
2. Counts come only from recognised runner output. No count is guessed.
3. Presence is observational. It never participates in execution, never awaits the network, never throws
   into the runtime.
4. Presence never takes keyboard focus and never writes a surface another controller owns.
5. Redaction is applied at the surface boundary (`redactSecrets`), as `emitMissionActivity` already does.
6. A quiet mission is reported as quiet, never as stalled; only the stall policy engine escalates
   (`stall.ts`), and presence renders its verdict rather than making one.
7. Disabling presence restores today's behaviour exactly.

## 7. Failure and degradation

- No UI (`ctx.hasUI === false`): the controller is not constructed; nothing else changes.
- Observability unavailable (storage degraded): the strip falls back to store-only rows (id, title, phase,
  no percentages) and says so; it does not fabricate progress.
- A mission with no observability state yet renders as `WAITING · no observability state yet` rather than
  disappearing.
- Sink throws (mid-teardown): swallowed, logged once, controller keeps running.
- More missions than the row budget: overflow line, never silent truncation.

## 8. Testing

- `test/unit/status-presence.test.ts` — pure projection: ranking total order, budget and overflow, row
  vocabulary, liveness vocabulary (alive / quiet / stalled / unverified), heartbeat vs meaningful-progress
  kept distinct, no invented percentages, redaction.
- `test/unit/status-presence-controller.test.ts` — working-line ownership while the agent is active vs
  idle, widget key isolation, one-render-per-tick, quiet-heartbeat call, dispose clears both sinks, sink
  throws swallowed.
- Producer tests, one per §5.2 item, red→green, following the existing pattern in
  `test/unit/orchestration-broker-model-provenance.test.ts` and `test/unit/observability-service.test.ts`.
- `test/integration/extension-mission-commands.test.ts` extended: `notify` fires for attention events and
  not for routine transitions; presence disabled reproduces current notify behaviour.
- `test/unit/split-view-vendor.test.ts` must stay green (no new widget-key or command collision).
- Manual proof before merge: run one mission in-session and one background, confirm the working line
  switches hands correctly, confirm typing is never blocked, confirm `Esc` still pauses missions in the pane.

## 9. Rollout and rollback

Additive and env-gated, following the existing toggle convention in `extensions/index.ts`
(`/^(0|false|off|no)$/i`):

| Variable | Default | Effect |
|---|---|---|
| `PI_MISSION_PRESENCE` | on | `0` / `false` / `off` / `no` removes the strip and the working-line handoff |
| `PI_MISSION_PRESENCE_ROWS` | 4 | visible rows, hard cap 8 |
| `PI_MISSION_TITLE` | off | `1` writes the fleet count to the terminal title |

Producer wiring is not gated — it only feeds a service that already exists and already persists.
Rollback: `PI_MISSION_PRESENCE=0` (strip and working-line handoff disappear, `onProgress` reverts), or
revert the branch. No schema change, no migration, no persisted-data change.

## 10. Deferred, with the reason

**Cross-pane fleet board.** One pane showing every mission on the box needs a shared registry with
liveness rules for dead and stale sessions. `src/events/` and `scripts/control-server.ts` are the natural
seats, and the presence view built here is exactly the payload that registry would carry — so §5.1 is not
throwaway work. It is deferred because the per-pane fix is what makes a single mission legible, and the
operator's stated pain starts there.

**Split-view mission band.** A mission panel in the vendored band would be the best long-term detail
surface, but the file is vendored unmodified by policy. Upstreaming or forking is a separate decision.

**Inspector feed.** Already streams per-agent activity to an external control plane when
`HERDR_CP_URL` + `PI_INSPECTOR_FEED=1` are set. That is the remote-visibility path; it does not help an
operator sitting at the terminal, which is what this design is for.
