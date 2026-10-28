# Mission Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a running mission legible from the terminal without opening anything — a persistent, attention-ranked strip plus a working line that says what the mission is doing and when it last proved it was alive.

**Architecture:** `MissionObservability` already composes operator-facing sentences and already derives health, progress and per-worker liveness; its `onUpdate` emitter is passed by `EngineeringRuntime` and provided by nobody. Task 1-5 connect that stream to two non-focus-stealing pi surfaces through a new pure projection (`src/status/presence.ts`) and a controller (`src/status/MissionPresenceController.ts`) modelled on the existing `WorkingStatusController`. Tasks 6-8 add the missing producers (recovery, review, repair, gate failure, meaningful progress, loop signals) so the vocabulary the service already renders has data behind it.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-mission-presence-design.md` — read it with this plan; the spec carries the root-cause evidence and the deferrals.

## Global Constraints

- Never invent a number. Percentages stay `~`-prefixed and unit-derived; `progress.basis === "inferred"` and unmeasured tasks stay visibly unmeasured (spec 00 "Requirements", `src/orchestration/observability/progress.ts`).
- Counts come only from recognised runner output. No test count is guessed (§5.2a is out of this plan).
- Presence never takes keyboard focus: no `ctx.ui.custom()`, no `setFooter`, no `setStatus`. Only `setWorkingMessage`, `setWidget`, `setTitle`, `notify`.
- Widget key is exactly `"engineering-missions"`. Never write `"engineering-working"`, `"engineering"`, `"model-refresh"`, `"split-view"`.
- Health verdicts come from `src/orchestration/observability/health.ts`. Presence renders `event.health`; it never derives health itself.
- Marker and rank vocabulary is derived from `MissionStatus` (`src/orchestration/types.ts:24-55`) and `MissionHealth` (`src/orchestration/observability/types.ts:15`). No new states are invented.
- All user-visible text passes through `redactSecrets` (`src/platform/redact.ts:71`) before reaching a surface.
- Feature flags follow the existing env convention in `extensions/index.ts` (`/^(0|false|off|no)$/i`): `PI_MISSION_PRESENCE` (default on), `PI_MISSION_PRESENCE_ROWS` (default 4, cap 8), `PI_MISSION_TITLE` (default off).
- Every sink call is wrapped so a torn-down UI cannot fail a mission; timers are `unref`'d and cleared in `dispose()`.
- Test command form: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts <file>`.

## Review Focus

1. **A UI without `setWidget` / `setWorkingMessage`.** The existing harness `commandContext` in `test/integration/extension-mission-commands.test.ts:57-76` supplies only `notify`, `custom`, `setFooter`, `onTerminalInput`. Presence must no-op silently on a UI missing either method — never throw, never degrade the footer path. Pinned by Task 3 Step 1 (`survives a UI without setWidget or setWorkingMessage`).
2. **A mission whose progress is inferred, not measured.** `progress.basis === "inferred"` must render as `~<n>% (inferred)`, and a mission with no liveness timestamps must render `no proof of life yet` rather than `0s ago` or a fabricated age. Pinned by Task 2 Step 1.
3. **Dozens of missions, identical health, identical last-progress instant.** Row order must be a total order that heartbeats cannot change: an elapsed label updating must not move a row. Pinned by Task 2 Step 1 (`heartbeat-only change does not reorder rows`).
4. **A mission that oscillates needs-you → running → needs-you.** Exactly one notification per state change, none while the state is unchanged, and a mission cannot spam the terminal. Pinned by Task 3 Step 1.
5. **Presence disabled, or `ctx.hasUI === false`.** Behaviour is byte-identical to today: no widget, no working-line write, no new notification, and progress text keeps its current fate. Pinned by Task 4 Step 1.

---

### Task 1: Move the shared activity formatter into `src/status/`

Presence, the footer and the panel must show one vocabulary, not three. `formatMissionActivity` is the existing one; it lives inside the extension and is already tested there.

**Files:**
- Create: `src/status/missionActivity.ts`
- Modify: `extensions/index.ts:422-485` (the `formatMissionActivity` export and its private `missionActivityAge` helper)
- Test: `test/unit/mission-activity-format.test.ts`

**Interfaces:**
- Consumes: `RuntimeMissionActivityEvent` from `src/runtime/EngineeringRuntime.ts`.
- Produces: `formatMissionActivity(event: RuntimeMissionActivityEvent): MissionActivityRendering` and `export interface MissionActivityRendering { phase: string; detail: string; missionStatus: { token: string; reason: string; next: string; live?: string } }` from `src/status/missionActivity.ts`. `extensions/index.ts` re-exports it so `test/integration/extension-mission-commands.test.ts:419,695,722` keeps resolving it off the extension module. Task 3 imports it from `src/status/missionActivity.ts`.

- [ ] **Step 1: Write the failing test**

In `test/unit/mission-activity-format.test.ts`, import `formatMissionActivity` from `../../src/status/missionActivity.ts` (not from the extension) and assert the token vocabulary that the footer already shows today:

```ts
test("renders the recovery/attempt token and the operator-pause token", () => {
  assert.equal(
    formatMissionActivity(event({ recovery: { attempt: 2, maxAttempts: 4 }, action: "recover" })).missionStatus.token,
    "R2/4 RECOVER→retry",
  );
  assert.match(
    formatMissionActivity(event({ operatorPausedAt: "2026-10-27T10:00:00.000Z" })).missionStatus.token,
    /PAUSED \(operator\).*\/mission resume MSN-1/,
  );
});
```

`event(overrides)` is a local helper building a complete `RuntimeMissionActivityEvent` with `missionId: "MSN-1"`, `recovery: { attempt: 0, maxAttempts: 0 }`, `preservedWork: []`, `acceptanceCoverage: { completed: 0, total: 0, approximatePercent: 0 }`, `workflowProgress` likewise, and empty strings for `summary`/`reason`/`nextAction`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/mission-activity-format.test.ts`
Expected: FAIL — cannot resolve `../../src/status/missionActivity.ts`.

- [ ] **Step 3: Move the code**

Move `formatMissionActivity` and `missionActivityAge` verbatim from `extensions/index.ts:422-485` into `src/status/missionActivity.ts`, exporting both the function and the `MissionActivityRendering` return type (replace the inline return-type literal with the named interface). In `extensions/index.ts`, import them and add `export { formatMissionActivity };` so the existing integration test's `extensionModule.formatMissionActivity` still resolves. No behaviour change.

- [ ] **Step 4: Run both tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/mission-activity-format.test.ts test/integration/extension-mission-commands.test.ts`
Expected: PASS in both files.

- [ ] **Step 5: Commit**

```bash
git add src/status/missionActivity.ts extensions/index.ts test/unit/mission-activity-format.test.ts
git commit -m "refactor(status): move formatMissionActivity into src/status so presence can share it"
```

---

### Task 2: The presence projection

**Files:**
- Create: `src/status/presence.ts`
- Test: `test/unit/status-presence.test.ts`

**Interfaces:**
- Consumes: `RuntimeMissionActivityEvent` (type-only import), `formatMissionActivity` from Task 1, `redactSecrets` from `src/platform/redact.ts`.
- Produces:
  - `export interface PresenceRow { missionId: string; title: string; marker: string; token: string; percent: string; unit: string; age: string; attention: boolean }`
  - `export interface PresenceView { header: string; rows: PresenceRow[]; overflow: string | null; workingLine: string | null }`
  - `export function presenceRank(event: RuntimeMissionActivityEvent): number`
  - `export function presenceMarker(event: RuntimeMissionActivityEvent): string`
  - `export function projectPresence(events: readonly RuntimeMissionActivityEvent[], budget: number, now: number, basis?: ReadonlyMap<string, "weighted_dag" | "inferred">): PresenceView`
  - `export function storeOnlyEvent(mission: { mission_id: string; title: string; status: MissionStatus }): RuntimeMissionActivityEvent`
  - `export function renderWidgetLines(view: PresenceView): string[]`
  Task 3 imports all of these; nothing else does.

Rank is a total order, lowest first: `0` `state` in `NEEDS_ATTENTION` / `WAITING_FOR_USER`; `1` `state` in `BLOCKED` / `PAUSED_INFRASTRUCTURE`; `2` `health === "stalled"`; `3` `state` starts with `WAITING_` or `RECOVERING_`, or `health === "waiting"`; `4` `state` in `COMPLETE` / `CANCELED` / `FAILED`; `5` everything else. Ties break on health rank (`blocked` < `stalled` < `slow` < `waiting` < `active` < `complete`), then oldest `lastMeaningfulProgressAt` with `null` sorting oldest, then `missionId` ascending. Marker: `!` rank 0, `#` rank 1, `*` rank 2, `~` rank 3, `v` `COMPLETE`, `x` `FAILED` / `CANCELED`, `>` otherwise. `percent` is `~<approximatePercent>%`, suffixed ` (inferred)` when `basis?.get(missionId) === "inferred"` — the basis map is a parameter because `RuntimeMissionActivityEvent` does not carry it. `unit` is `acc <completed>/<total>` from `acceptanceCoverage`, or `workers <active>a/<waiting>w/<failed>f` when the coverage total is 0. `age` is the age of `lastMeaningfulProgressAt ?? lastHeartbeatAt` at `now`, or `no proof of life yet` when both are absent. `storeOnlyEvent` builds the minimal event for a mission the observability service has no state for: `state` from `mission.status`, `health` `"waiting"`, zero coverage and worker counts, `lastMeaningfulProgressAt: null`, empty `summary`/`reason`/`nextAction`, so such a mission still appears in the strip instead of silently disappearing (spec §7).

- [ ] **Step 1: Write the failing test**

In `test/unit/status-presence.test.ts`, cover with `mission(overrides)` as in Task 1:

```ts
test("ranks needs-you above blocked, blocked above stalled, and terminal last", () => { /* 5 events -> missionId order */ });
test("heartbeat-only change does not reorder rows", () => {
  const before = projectPresence([mission({ missionId: "MSN-b", health: "active", lastMeaningfulProgressAt: "2026-10-27T10:00:00.000Z" })], 4, T).rows.map((r) => r.missionId);
  const after = projectPresence([mission({ missionId: "MSN-b", health: "active", lastMeaningfulProgressAt: "2026-10-27T10:00:00.000Z", lastHeartbeatAt: "2026-10-27T10:09:00.000Z" })], 4, T);
  assert.deepEqual(after.rows.map((r) => r.missionId), before);
});
test("breaks ties deterministically on health, then oldest progress, then mission id", () => { /* two identical-health events */ });
test("marks inferred progress as inferred", () => {
  assert.equal(projectPresence([mission({ approximatePercent: 40, progressBasis: "inferred" })], 4, T).rows[0].percent, "~40% (inferred)");
});
test("shows no proof of life yet instead of a fabricated age", () => {
  assert.equal(projectPresence([mission({ lastMeaningfulProgressAt: null })], 4, T).rows[0].age, "no proof of life yet");
});
test("caps rows at the budget and names the worst unshown mission in the overflow line", () => {
  const view = projectPresence([needsYou, stalled, running1, running2, running3], 2, T);
  assert.equal(view.rows.length, 2);
  assert.match(view.overflow ?? "", /^1 more/);
});
test("redacts secrets in titles", () => {
  assert.doesNotMatch(projectPresence([mission({ title: "uses sk-abc123def456abc123" })], 4, T).rows[0].title, /sk-abc123/);
});
test("header counts running, needs-you and queued", () => { /* assert "1 running · 1 needs you" */ });
test("a mission with no observability state still renders, with no percentage", () => {
  const e = storeOnlyEvent({ mission_id: "MSN-9", title: "queued leg", status: "QUEUED" });
  const row = projectPresence([e], 4, T).rows[0];
  assert.equal(row.marker, "~");
  assert.equal(row.age, "no proof of life yet");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/status-presence.test.ts`
Expected: FAIL — cannot resolve `../../src/status/presence.ts`.

- [ ] **Step 3: Implement `src/status/presence.ts`**

Pure module: no timers, no I/O, no runtime imports beyond `formatMissionActivity` and `redactSecrets`. `projectPresence` takes an optional third element on each entry for `progressBasis` via a second parameter form `projectPresence(events, budget, now, basis?: ReadonlyMap<string, "weighted_dag" | "inferred">)` — the map is keyed by mission id because `RuntimeMissionActivityEvent` does not carry the basis. `workingLine` is `null` when the highest-ranked row is terminal, otherwise `Mission · <missionId> · <activity> · <age> · <phase> <percent>` built from `formatMissionActivity(event).detail` with newlines collapsed to single spaces and the whole line capped at 240 characters. `renderWidgetLines` returns `[header, ...rows formatted, overflow]` with overflow omitted when null, each row formatted as `` `${marker} ${missionId}  ${title}  ${token}  ${percent}  ${unit}  ${age}` `` padded to a fixed column layout.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/status-presence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status/presence.ts test/unit/status-presence.test.ts
git commit -m "feat(status): add attention-ranked mission presence projection"
```

---

### Task 3: The presence controller

**Files:**
- Create: `src/status/MissionPresenceController.ts`
- Modify: `src/status/ambient.ts:1-13` (the header comment's false claim)
- Test: `test/unit/status-presence-controller.test.ts`

**Interfaces:**
- Consumes: `projectPresence`, `renderWidgetLines` (Task 2); `RuntimeMissionActivityEvent`.
- Produces:
  - `export interface PresenceSink { setWorkingMessage?(text?: string): void; setWidget?(key: string, lines: string[] | undefined): void; setTitle?(title: string | undefined): void; notify?(text: string, level: "info" | "warning"): void }`
  - `export interface PresenceOptions { rows?: number; title?: boolean; quiet?: (missionId: string) => void; now?: () => number; intervalMs?: number }`
  - `export class MissionPresenceController` with `constructor(sink: PresenceSink, options?: PresenceOptions)`, `update(event: RuntimeMissionActivityEvent, progressBasis?: "weighted_dag" | "inferred"): void`, `noteSentence(missionId: string, sentence: string): void`, `onAgentStart(): void`, `onAgentEnd(): void`, `tick(): void`, `dispose(): void`, `visible(): number`.
  Task 4 constructs it; nothing else does.

The controller owns the working line only while the foreground agent is idle: `onAgentStart` clears its working message and suppresses writes until `onAgentEnd`. It publishes at most once per `tick`, and only when the serialized view differs from the last published one. `intervalMs` defaults to 1000 and the timer is `unref`'d; each tick calls `options.quiet?.(missionId)` for every currently visible mission before projecting. Attention notification fires on a change of `attentionKey(event) = \`${state}|${health}\`` for a mission, and only when rank is 0 or 1 or `state` is `FAILED` / `COMPLETE`.

- [ ] **Step 1: Write the failing test**

In `test/unit/status-presence-controller.test.ts`, drive a fake sink recording calls and a controllable clock:

```ts
test("survives a UI without setWidget or setWorkingMessage", () => {
  const c = new MissionPresenceController({ notify: () => {} }, { now: clock });
  c.update(needsYou); c.tick(); c.dispose(); // must not throw
});
test("writes the working line while idle and clears it on agent start", () => { /* assert setWorkingMessage calls */ });
test("does not write the working line while the agent is running", () => { c.onAgentStart(); c.update(running); c.tick(); assert.equal(sink.working.length, 0); });
test("publishes the widget at most once per tick and not when nothing changed", () => { c.update(running); c.tick(); c.tick(); assert.equal(sink.widget.length, 1); });
test("uses only the engineering-missions widget key", () => { assert.deepEqual([...new Set(sink.widgetKeys)], ["engineering-missions"]); });
test("notifies once per attention change and not again while unchanged", () => {
  c.update(needsYou); c.tick(); c.update(needsYou); c.tick(); assert.equal(sink.notices.length, 1);
  c.update(running); c.tick(); c.update(needsYou); c.tick(); assert.equal(sink.notices.length, 2);
});
test("calls the quiet hook for every visible mission on tick", () => { assert.deepEqual(quietCalls.at(-1), ["MSN-1"]); });
test("noteSentence replaces the working-line text for that mission", () => { c.update(running); c.noteSentence("MSN-1", "Tests: 34 passed, 1 failing"); c.tick(); assert.match(sink.working.at(-1) ?? "", /Tests: 34 passed, 1 failing/); });
test("dispose clears the widget, the working line and the title", () => { /* assert undefined published for all three */ });
test("title stays off unless enabled", () => { /* default options -> no setTitle call */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/status-presence-controller.test.ts`
Expected: FAIL — cannot resolve `../../src/status/MissionPresenceController.ts`.

- [ ] **Step 3: Implement `src/status/MissionPresenceController.ts`**

Mirror `src/status/working.ts`: a `lastMessage` / `lastPanel` / `lastTitle` compare-before-publish core, a `Map<string, { event; basis; sentence? }>` of live missions, and every sink call inside `try { } catch { }` with the comment that a status surface is observational and a torn-down UI must never fail a mission. The working line is the highest-ranked non-terminal row's `workingLine` from `projectPresence`, except that when that mission has a recorded `sentence`, the sentence replaces the activity text — the sentence is what `MissionObservability` composed for a human, and the projection is what it derived for a row. `dispose()` calls `onAgentEnd()`, clears the widget/working line/title with `undefined`, and clears the interval.

- [ ] **Step 4: Correct the false premise in `src/status/ambient.ts`**

Replace the header comment's claim that "pi offers no non-focusing variant" with the accurate statement: `ctx.ui.setWidget` renders above the editor and takes no focus, which is why persistent mission presence lives there (`src/status/MissionPresenceController.ts`); `setFooter` remains the footer's owner and `renderAmbient` keeps its counts-and-worst-finding job.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/status-presence-controller.test.ts test/unit/working-status.test.ts`
Expected: PASS in both — `working-status.test.ts` proves the working-line neighbour is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/status/MissionPresenceController.ts src/status/ambient.ts test/unit/status-presence-controller.test.ts
git commit -m "feat(status): persistent mission presence controller with working-line handoff"
```

---

### Task 4: Wire presence into the extension

**Files:**
- Modify: `extensions/index.ts:352-372` (`EngineeringRuntime.open` options)
- Modify: `extensions/index.ts:1989-2020` (the `session_start` / `agent_start` / `agent_settled` block that constructs `WorkingStatusController`)
- Modify: `extensions/index.ts` shutdown path (`session_shutdown` handler in that same block)
- Test: `test/integration/extension-mission-presence.test.ts`

**Interfaces:**
- Consumes: `MissionPresenceController` (Task 3), `EngineeringRuntime.open`'s `onMissionObservabilityUpdate?: (missionId: string, message: string) => void` (`src/runtime/EngineeringRuntime.ts:523`), `runtime.missionObservability`.
- Produces: nothing consumed by later tasks; this is the surface boundary.

- [ ] **Step 1: Write the failing test**

In `test/integration/extension-mission-presence.test.ts`, copy `loadHarness()` and `commandContext()` from `test/integration/extension-mission-commands.test.ts:29-76`, and extend the fake `ctx.ui` with `setWorkingMessage`, `setWidget` and `setTitle` recorders. Then:

```ts
test("presence publishes the widget on session start and clears it on shutdown", async () => { /* run session_start then session_shutdown handlers; assert a setWidget("engineering-missions", [...]) call and a later undefined */ });
test("PI_MISSION_PRESENCE=0 leaves no widget and no working-message write", async () => { /* set env, run handlers, assert both recorders empty */ });
test("a UI without setWidget still starts and shuts down cleanly", async () => { /* use the unmodified commandContext ui */ });
test("runtime receives onMissionObservabilityUpdate", async () => { /* stub EngineeringRuntime.open, assert the option is a function */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/integration/extension-mission-presence.test.ts`
Expected: FAIL — no `engineering-missions` widget call.

- [ ] **Step 3: Add the flags and the controller to `extensions/index.ts`**

Near the other env-derived flags (see `PI_AUTO_COMPACTION` at `extensions/index.ts:1564` for the idiom) add `presenceEnabled`, `presenceRows` (`Number(process.env.PI_MISSION_PRESENCE_ROWS ?? 4)`, clamped 1-8) and `presenceTitle` (`process.env.PI_MISSION_TITLE === "1"`). Add `let presence: MissionPresenceController | undefined;` beside `let working` at `extensions/index.ts:675`. In the block at `:1993`, construct it after `working`: `ctx.hasUI && presenceEnabled ? new MissionPresenceController(ctx.ui, { rows: presenceRows, title: presenceTitle, quiet: (id) => activeRuntime?.missionObservability?.maybeEmitQuietUpdate(id) }) : undefined`. Mirror `working` in the `agent_start`, `agent_settled` and `session_shutdown` handlers (`onAgentStart` / `onAgentEnd` / `dispose` + `presence = undefined`).

- [ ] **Step 4: Provide the dead emitter**

In the `EngineeringRuntime.open({...})` call at `extensions/index.ts:352`, add
`onMissionObservabilityUpdate: (missionId, message) => presence?.noteSentence(missionId, message)`. This is the
option declared at `src/runtime/EngineeringRuntime.ts:523` and passed to `MissionObservability` at `:1250` that
no caller has ever provided.

- [ ] **Step 5: Feed the strip from the activity event**

`onMissionActivity` already calls `publishMissionActivity(key, event)` at `extensions/index.ts:368`. Add beside it
`presence?.update(event, runtime.missionObservability?.summary(event.missionId)?.progress.basis)`.

- [ ] **Step 6: Pick up missions that have no observability state**

Add a 30 s `unref`'d poll in the controller's construction site that maps
`runtime.missionStore?.listMissions() ?? []` through `storeOnlyEvent` for any mission id the presence controller
has not received an activity event for, and clears it in the same `session_shutdown` handler that disposes the
controller.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/integration/extension-mission-presence.test.ts test/integration/extension-mission-commands.test.ts`
Expected: PASS in both.

- [ ] **Step 8: Commit**

```bash
git add extensions/index.ts test/integration/extension-mission-presence.test.ts
git commit -m "feat(extension): wire mission presence to observability's operator emitter"
```

---

### Task 5: Make the quiet heartbeat useful

`maybeEmitQuietUpdate` exists, is correct, and is called by nobody. Presence's 1 s tick calls it; the interval it guards is tuned for a background run.

**Files:**
- Modify: `src/orchestration/observability/types.ts:325` (`DEFAULT_OBSERVABILITY_CONFIG.quietUpdateIntervalMs`)
- Test: `test/unit/observability-service.test.ts:505-524` (update the interval the existing quiet-update test assumes)

**Interfaces:**
- Consumes: `MissionObservability.maybeEmitQuietUpdate(missionId: string): void` (`MissionObservability.ts:1552`), `onUpdate`.
- Produces: `DEFAULT_OBSERVABILITY_CONFIG.quietUpdateIntervalMs === 60_000`.

- [ ] **Step 1: Update the existing test to the new interval**

In `test/unit/observability-service.test.ts`, the block at `:505-524` advances the clock by the current 300 000 ms default. Change it to assert against the new default: a 59 000 ms advance emits nothing, a 61 000 ms advance emits the `Still running` summary, and a transition inside the window still suppresses the summary.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/observability-service.test.ts`
Expected: FAIL on the 61 000 ms assertion (default is still 300 000).

- [ ] **Step 3: Change the default**

Set `quietUpdateIntervalMs: 60_000` with the comment `// 1m — an operator watching wants a minute; emitUpdate performs no durable write`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/observability-service.test.ts test/unit/status-presence-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/observability/types.ts test/unit/observability-service.test.ts
git commit -m "feat(observability): quiet update every minute for watched missions"
```

---

### Task 6: Recovery producers

The scheduler's `onStatus` handler already distinguishes resumed / waiting / paused and already calls `clearWaiting` / `setWaiting`. The matching recovery vocabulary has no producer.

**Files:**
- Modify: `src/orchestration/orchestrator.ts:478-500` (the scheduler `onStatus` callback)
- Test: `test/unit/orchestration-recovery-observability.test.ts`

**Interfaces:**
- Consumes: `MissionObservability.recoveryStarted(missionId, workerId, action, attempt, detail)` (`:1065`), `recoveryCompleted(missionId)` (`:1077`), `recoveryFailed(missionId)` (`:1087`); the existing `notice` shape with `action`, `status`, `reason`, `attempt`, `nextActionAt`, `missionId`.
- Produces: observability events `RECOVERY_STARTED` / `RECOVERY_COMPLETED` / `RECOVERY_FAILED` for a mission, visible in `summary(missionId).recovery.attempt`.

- [ ] **Step 1: Write the failing test**

In `test/unit/orchestration-recovery-observability.test.ts`, construct the orchestrator with a `MissionObservability` over an in-memory backend and a `FakeWorkerExecutor` (follow the setup style of `test/unit/orchestration-scheduler-resilience.test.ts`), invoke the `onStatus` callback with each notice shape, and assert:

```ts
test("a waiting notice records a recovery attempt", () => {
  assert.equal(obs.summary(id)?.recovery.attempt, 1);
});
test("a resumed notice closes the recovery window", () => {
  assert.equal(obs.summary(id)?.recovery.attempt, 0);
  assert.equal(obs.summary(id)?.waitingReason, undefined);
});
test("a paused notice marks recovery failed", () => {
  assert.match(obs.projection(id)?.summary.reason ?? "", /no active worker/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/orchestration-recovery-observability.test.ts`
Expected: FAIL — `recovery.attempt` is 0 after a waiting notice.

- [ ] **Step 3: Add the three calls**

In the `onStatus` callback, alongside the existing `clearWaiting` / `setWaiting` calls: `recoveryCompleted` on the
`resumed` branch, `recoveryStarted(missionId, notice.taskId, notice.action, notice.attempt, detail)` on the waiting
branch (`MissionSchedulerStatusNotice` at `src/orchestration/scheduler.ts:223-232` carries `taskId`, not a worker
id; the service accepts any stable worker key), and `recoveryFailed` on the `paused` branch. Keep the existing
`report(...)` lines unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/orchestration-recovery-observability.test.ts test/unit/orchestration-scheduler-resilience.test.ts`
Expected: PASS in both.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/orchestrator.ts test/unit/orchestration-recovery-observability.test.ts
git commit -m "feat(orchestration): feed recovery state into mission observability"
```

---

### Task 7: Review, repair and gate-failure producers

**Files:**
- Modify: `src/orchestration/orchestrator.ts` (the fresh-review settlement and the repair-round paths; start from `observeGatePassed` at `:1750` and its two call sites at `:2247` and `:3491`)
- Test: `test/unit/orchestration-review-repair-observability.test.ts`

**Interfaces:**
- Consumes: `reviewStarted(missionId, reviewerId?, model?)` (`:1002`), `reviewFinding(missionId, severity, summary, file?)` (`:1014`), `reviewCompleted(missionId)` (`:1030`), `repairStarted(missionId, taskId)` (`:1041`), `repairCompleted(missionId, taskId, findingId)` (`:1053`), `gateFailed(missionId, reasons)` (`:1123`); the existing finding record with `severity`, `summary`, `file`, `line`.
- Produces: `summary(id)` with non-zero `review.blocking` / `review.total` after findings are recorded, and a `completionStatus` that is not verified-complete when the gate did not pass.

- [ ] **Step 1: Write the failing test**

```ts
test("a blocking review finding reaches the projection and emits its sentence", () => {
  const review = obs.projection(id)?.review;
  assert.equal(review?.findings.filter((f) => f.severity === "blocking").length, 1);
  assert.equal(review?.status, "completed");
  assert.match(capturedUpdates.join("\n"), /Blocking review finding/);
});
test("a repair round is recorded and closed per finding", () => { /* repairStarted then repairCompleted -> projection.tasks shows the repair task */ });
test("a gate that does not pass records its reasons and is not verified complete", () => {
  assert.notEqual(obs.summary(id)?.progress.verifiedComplete, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/orchestration-review-repair-observability.test.ts`
Expected: FAIL — review counts are 0.

- [ ] **Step 3: Add the calls**

At the fresh-review boundary call `reviewStarted` before the reviewer runs and `reviewCompleted` after its findings are ingested, with `reviewFinding(missionId, finding.severity, finding.summary, finding.file)` per finding. Where a repair round is created from open blocking findings (`repairContractObjective`, `orchestrator.ts:331`), call `repairStarted` with the repair task id and `repairCompleted` per finding it settles. Beside `observeGatePassed`, add the negative path: where the verdict does not complete the mission, call `gateStarted` then `gateFailed(missionId, reasons)` with the gate's own reason strings — do not invent reasons.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/orchestration-review-repair-observability.test.ts test/integration/mission-observability-e2e.test.ts`
Expected: PASS in both.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/orchestrator.ts test/unit/orchestration-review-repair-observability.test.ts
git commit -m "feat(orchestration): feed review, repair and gate failure into observability"
```

---

### Task 8: Meaningful progress and the remaining loop signals

`lastMeaningfulProgressAt` currently depends on the activity fallback, and the loop tracker sees only tool signatures.

**Files:**
- Modify: `src/orchestration/orchestrator.ts` (`observeWorkerActivity`, `:1342-1416` on main)
- Test: `test/unit/orchestration-activity-observability.test.ts`

**Interfaces:**
- Consumes: `meaningfulProgress(missionId, summary, workerId?)` (`:877`), `noteWorkerRead(missionId, workerId, path)` (`:1167`), `noteWorkerError(missionId, workerId, signature)` (`:1175`), `noteWorkerCycle(missionId, workerId, signature)` (`:1179`), `workerFileChanged(missionId, workerId)` (`:1183`); the `WorkerActivity` union already delivered to `observeWorkerActivity`.
- Produces: `summary(id).lastMeaningfulProgressAt` non-null after a meaningful activity, and `hasLoop(id, workerId)` true after enough repeated reads.

- [ ] **Step 1: Write the failing test**

```ts
test("an activity flagged meaningful advances lastMeaningfulProgressAt", () => { /* feed one activity with meaningfulProgress: true -> assert non-null and later than the previous value */ });
test("repeated reads of the same path trip the loop tracker", () => {
  for (let i = 0; i < 9; i++) observe(toolRead("a.ts"));
  assert.equal(obs.hasLoop(id, workerId), true);
  assert.ok((obs.projection(id)?.workers.find((w) => w.workerId === workerId)?.repeatedFileReads ?? 0) >= 9);
});
test("a file change resets the tracker so legitimate repetition is not a loop", () => { /* interleaved workerFileChanged -> hasLoop false */ });
test("an error activity is recorded as an error signal", () => {
  assert.ok((obs.projection(id)?.workers.find((w) => w.workerId === workerId)?.repeatedErrors ?? 0) >= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/orchestration-activity-observability.test.ts`
Expected: FAIL — `hasLoop` stays false for repeated reads.

- [ ] **Step 3: Add the calls**

In `observeWorkerActivity`, when `event.meaningfulProgress` is true call `meaningfulProgress(missionId, event.summary, executionId)`. On `kind === "tool"` events, route by tool: a read-shaped tool calls `noteWorkerRead` with its path, an edit/write-shaped tool calls `workerFileChanged`, and a failed tool calls `noteWorkerError` with `${toolName}:${phase}`. Keep the existing `noteWorkerTool` call. Derive the signatures from the event's own fields; do not synthesise paths the event does not carry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 --import ./test/support/isolatedState.ts test/unit/orchestration-activity-observability.test.ts test/integration/orchestrator-e2e.test.ts`
Expected: PASS in both — the e2e file pins `workersDetail` routing provenance, which must not regress.

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/orchestrator.ts test/unit/orchestration-activity-observability.test.ts
git commit -m "feat(orchestration): record meaningful progress and full loop signals"
```

---

### Task 9: Manual proof at the terminal

The plan's automated tests cannot show that the strip is readable or that typing still works. This task is the verification the spec's §8 demands before merge.

**Files:**
- Create: `docs/evidence/mission-presence-2026-10-27.md`

**Interfaces:**
- Consumes: everything above.
- Produces: an evidence note with the exact commands run and the observed strip, referenced by the merge decision.

- [ ] **Step 1: Run a mission in-session and capture the strip**

Start `pi` in a scratch repo, run `/mission <small request>`, and paste the strip plus the working line into the evidence note. Expected: the working line shows `Mission · MSN-… · <activity> · <age>` while the agent is idle, and reverts to `Working · <tool> …` the moment the agent starts.

- [ ] **Step 2: Prove typing is never blocked**

While the mission runs, type into the editor and submit a message. Expected: no focus change, no keystroke loss, and `Esc` pauses the mission in that pane.

- [ ] **Step 3: Prove the disabled path**

Restart with `PI_MISSION_PRESENCE=0`, run a mission. Expected: no widget, no working-line mission text, no new notifications — identical to `origin/main` behaviour.

- [ ] **Step 4: Record the results and commit**

Write what was observed, including anything that failed, then:

```bash
git add docs/evidence/mission-presence-2026-10-27.md
git commit -m "docs(evidence): mission presence verified at the terminal"
```

---

## Out of this plan

**Test units (§5.2a of the spec).** `setTaskUnits` / `taskProgress` / `testProgress` / `testCompleted` have no producer at hand: tests for a mission task run inside a worker session, and the repo's only runner-summary parser lives in `src/runtime/herdr/InspectorFeed.ts`, a remote feed. Choosing between parsing worker bash output, reading the gate's recorded result, or generalising that parser into a shared module changes the size of the work and risks invented counts. The strip renders `acc <n>/<m>` from acceptance coverage instead, which is real data that already exists.

**Cross-pane fleet board.** Deferred per spec §10; the presence view is the payload it would carry.
