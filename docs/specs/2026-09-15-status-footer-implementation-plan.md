# Live status footer (track 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the status footer say what the runtime is doing and — when it appears frozen — why it is waiting, by adding a task segment, a producing-model segment, and a counting-down wait segment fed from the gateway admission controller and the engineering runtime.

**Architecture:** No new subsystem. `HarnessStatusState` gains `task` and `wait`; `renderStatus` gains two segments with the highest layout priorities; `FooterController` subscribes to the gateway admission controller and to a new optional runtime phase hook, and ticks once a second while a wait is live so the countdown moves. Everything the footer renders is precomputed state — the render path stays free of git, network, and token work.

**Tech Stack:** TypeScript (ESM, `.ts` imports), `node:test` + `node:assert/strict`, Biome, `@earendil-works/pi-tui` for width math.

**Spec:** `docs/specs/2026-09-15-engineering-panel-and-status-design.md`

## Global Constraints

- Render path performs no git, no network, no unbounded work; updates are coalesced (existing `FooterController.requestRender` throttle at `config.refreshMs`).
- `renderStatus` never throws: any unexpected input returns `""` (existing try/catch contract).
- The wait segment holds the highest layout priority and survives every width reduction that keeps any segment at all.
- Config follows the existing env convention: `PI_STATUS_BAR_*`, safe defaults, `bool()`/`int()` helpers already in `src/status/config.ts`.
- Conventional commits. `npm run lint`, `npm run typecheck`, `npm test` must pass before each commit.
- Track 2 (the overlay panel) is NOT in this plan. It gets its own plan once this state shape is proven in use.
- `WaitState.kind` admits `"verify"` and `"worker"`, and the renderer handles both (Task 1 tests one), but only the gateway feeder is wired here. That matches the spec's track 1 acceptance criteria; feeding the other two is a later, additive change with no type or renderer work left to do.

---

### Task 1: Wait segment — state, config, renderer

**Files:**
- Modify: `src/status/state.ts` (add `WaitState`, `TaskState`, extend `HarnessStatusState`)
- Modify: `src/status/config.ts` (add `showTask`, `showWait` + env keys)
- Modify: `src/status/layout.ts` (add segments, renumber priorities, add elision stages, accept `now`)
- Test: `test/unit/status-layout.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface WaitState { kind: "gateway" | "verify" | "worker"; detail: string; untilMs?: number }`
  - `interface TaskState { workItemId: string; phase: string; label?: string }`
  - `HarnessStatusState.task?: TaskState`, `HarnessStatusState.wait?: WaitState`
  - `StatusBarConfig.showTask: boolean`, `StatusBarConfig.showWait: boolean`
  - `renderStatus(state, width, config, nowMs?: number): string` — the 4th parameter defaults to `Date.now()` and exists so countdown rendering is deterministic in tests.

**Priority scheme (read this before editing `layout.ts`):** in the existing renderer a *lower* priority number is dropped *first*, and the elision stages filter `priority >= N`. Current numbers: directory 0, repository 1, worktree 2, branch 3, model 4, throughput 5. This task adds task 6 and wait 7, making the wait segment the irreducible core.

- [x] **Step 1: Write the failing tests**

Append to `test/unit/status-layout.test.ts`:

```ts
test("wait segment renders the reason and a countdown", () => {
  const state: HarnessStatusState = {
    cwd: "/repo",
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  };
  const line = renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 0);
  assert.match(line, /⏳ gateway 30s · queue_timeout/);
});

test("wait countdown floors at 0s and never goes negative", () => {
  const state: HarnessStatusState = {
    cwd: "/repo",
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 1_000 },
  };
  const line = renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 9_000);
  assert.match(line, /⏳ gateway 0s · queue_timeout/);
});

test("a wait with no deadline renders without a countdown", () => {
  const state: HarnessStatusState = {
    cwd: "/repo",
    throughput: { phase: "waiting" },
    wait: { kind: "verify", detail: "npm test" },
  };
  const line = renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 0);
  assert.match(line, /⏳ verify · npm test/);
  assert.doesNotMatch(line, /\ds ·/);
});

test("the wait segment is the last thing standing as width shrinks", () => {
  const state: HarnessStatusState = {
    cwd: "/home/u/projects/pi-engineering-runtime",
    repository: "berlinguyinca/pi-engineering-runtime",
    branch: "main",
    model: "opus-5",
    provider: "anthropic",
    throughput: { phase: "streaming", currentTokensPerSecond: 247 },
    task: { workItemId: "WI-12", phase: "implement" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  };
  const narrow = renderStatus(state, 26, DEFAULT_STATUS_BAR_CONFIG, 0);
  assert.match(narrow, /gateway/);
  assert.ok(narrow.length <= 26, `line too wide: ${narrow.length}`);
});

test("no wait state renders no wait segment", () => {
  const state: HarnessStatusState = { cwd: "/repo", throughput: { phase: "idle" } };
  assert.doesNotMatch(renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 0), /⏳/);
});

test("showWait=false hides the segment even while waiting", () => {
  const config = { ...DEFAULT_STATUS_BAR_CONFIG, showWait: false };
  const state: HarnessStatusState = {
    cwd: "/repo",
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  };
  assert.doesNotMatch(renderStatus(state, 200, config, 0), /⏳/);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/status-layout.test.ts`
Expected: FAIL — `renderStatus` takes 3 arguments and knows nothing about `wait`; TypeScript also rejects `wait` on `HarnessStatusState`.

- [x] **Step 3: Add the state types**

In `src/status/state.ts`, above `HarnessStatusState`:

```ts
/** Why the runtime is not producing output right now. */
export interface WaitState {
  /** What we are waiting on. */
  kind: "gateway" | "verify" | "worker";
  /** Machine-readable detail, e.g. "queue_timeout" or the verify command. */
  detail: string;
  /** Epoch ms when the wait is expected to end. Omitted when unknown. */
  untilMs?: number;
}

/** The engineering task currently in flight. */
export interface TaskState {
  workItemId: string;
  /** Pipeline phase, e.g. "scout", "implement", "verify", "review". */
  phase: string;
  /** Short human label (the goal), optional. */
  label?: string;
}
```

Then add to `HarnessStatusState`, after `provider`:

```ts
  /** Engineering task in flight, when a run is active. */
  task?: TaskState;
  /** Why the runtime is waiting, when it is. */
  wait?: WaitState;
```

- [x] **Step 4: Add the config toggles**

In `src/status/config.ts`: add `showTask: boolean;` and `showWait: boolean;` to `StatusBarConfig` (after `showModel`), add `showTask: true, showWait: true,` to `DEFAULT_STATUS_BAR_CONFIG`, add to `ENV`:

```ts
  task: "PI_STATUS_BAR_SHOW_TASK",
  wait: "PI_STATUS_BAR_SHOW_WAIT",
```

and to the object returned by `resolveStatusBarConfig`:

```ts
    showTask: bool(env[ENV.task], base.showTask),
    showWait: bool(env[ENV.wait], base.showWait),
```

- [x] **Step 5: Render the segment**

In `src/status/layout.ts`, change both signatures to accept the clock:

```ts
export function renderStatus(
  state: HarnessStatusState,
  width: number,
  config: StatusBarConfig,
  nowMs: number = Date.now(),
): string {
  try {
    return renderUnsafe(state, width, config, nowMs);
  } catch {
    return "";
  }
}

function renderUnsafe(
  state: HarnessStatusState,
  width: number,
  config: StatusBarConfig,
  nowMs: number,
): string {
```

Add the segment after the throughput block, so it is built last and carries the highest priority:

```ts
  if (config.showWait && state.wait) {
    const wait = formatWait(state.wait, nowMs);
    full.push({ text: wait, priority: 7 });
    short.push({ text: wait, priority: 7 });
  }
```

Extend the elision stages (after the existing `priority >= 4` stage):

```ts
  stages.push(short.filter((s) => s.priority >= 5));
  stages.push(short.filter((s) => s.priority >= 6));
  stages.push(short.filter((s) => s.priority >= 7));
```

Add the formatter beside `formatThroughput`:

```ts
/**
 * "⏳ gateway 30s · queue_timeout" — the one segment that explains an
 * apparently frozen session, so it is the last to be elided.
 */
function formatWait(wait: WaitState, nowMs: number): string {
  const parts = [wait.kind];
  if (wait.untilMs != null) {
    const remainingMs = Math.max(0, wait.untilMs - nowMs);
    parts.push(`${Math.ceil(remainingMs / 1000)}s`);
  }
  const head = parts.join(" ");
  return wait.detail ? `⏳ ${head} · ${wait.detail}` : `⏳ ${head}`;
}
```

Import the type: change the existing type import to `import type { HarnessStatusState, WaitState } from "./state.ts";`

Update the stale comment above the irreducible-core fallback to name the wait segment rather than model + tps.

- [x] **Step 6: Run the tests to verify they pass**

Run: `node --test test/unit/status-layout.test.ts`
Expected: PASS, including the pre-existing tests (the 4th parameter is optional, so no existing call site changes).

- [x] **Step 7: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/status/state.ts src/status/config.ts src/status/layout.ts test/unit/status-layout.test.ts
git commit -m "feat(status): render why the runtime is waiting"
```

---

### Task 2: Task segment — the work item in flight

**Files:**
- Modify: `src/status/layout.ts`
- Test: `test/unit/status-layout.test.ts`

**Interfaces:**
- Consumes: `TaskState`, `StatusBarConfig.showTask`, `renderStatus(state, width, config, nowMs)` from Task 1.
- Produces: no new exports; the task segment renders at priority 6 (below wait, above throughput).

- [x] **Step 1: Write the failing tests**

```ts
test("task segment names the work item and phase", () => {
  const state: HarnessStatusState = {
    cwd: "/repo",
    throughput: { phase: "streaming", currentTokensPerSecond: 12 },
    task: { workItemId: "WI-12", phase: "implement" },
  };
  assert.match(renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 0), /WI-12 implement/);
});

test("task segment appends a truncated goal label when there is room", () => {
  const state: HarnessStatusState = {
    cwd: "/repo",
    throughput: { phase: "idle" },
    task: { workItemId: "WI-12", phase: "implement", label: "add retry to the gateway client" },
  };
  const line = renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 0);
  assert.match(line, /WI-12 implement · add retry to the gateway/);
});

test("task segment outlives model and throughput but not the wait", () => {
  const state: HarnessStatusState = {
    cwd: "/home/u/repo",
    branch: "main",
    model: "opus-5",
    throughput: { phase: "streaming", currentTokensPerSecond: 247 },
    task: { workItemId: "WI-12", phase: "implement" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  };
  const line = renderStatus(state, 46, DEFAULT_STATUS_BAR_CONFIG, 0);
  assert.match(line, /WI-12 implement/);
  assert.match(line, /gateway/);
  assert.doesNotMatch(line, /opus-5/);
});

test("no task renders no task segment", () => {
  const state: HarnessStatusState = { cwd: "/repo", throughput: { phase: "idle" } };
  assert.doesNotMatch(renderStatus(state, 200, DEFAULT_STATUS_BAR_CONFIG, 0), /WI-/);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/status-layout.test.ts`
Expected: FAIL — no task segment is rendered.

- [x] **Step 3: Render the segment**

In `renderUnsafe`, after the throughput block and before the wait block:

```ts
  if (config.showTask && state.task) {
    full.push({ text: formatTask(state.task, 32), priority: 6 });
    short.push({ text: formatTask(state.task, 0), priority: 6 });
  }
```

```ts
/**
 * "WI-12 implement · add retry to the gateway" — the abbreviated form drops
 * the goal label, which is the first thing worth losing under pressure.
 */
function formatTask(task: TaskState, labelBudget: number): string {
  const head = `${task.workItemId} ${task.phase}`;
  if (labelBudget <= 0 || !task.label) return head;
  const label = task.label.length > labelBudget ? task.label.slice(0, labelBudget).trimEnd() : task.label;
  return `${head} · ${label}`;
}
```

Extend the type import: `import type { HarnessStatusState, TaskState, WaitState } from "./state.ts";`

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test test/unit/status-layout.test.ts`
Expected: PASS.

- [x] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/status/layout.ts test/unit/status-layout.test.ts
git commit -m "feat(status): render the engineering task in flight"
```

---

### Task 3: Feed gateway waits into the footer

**Files:**
- Modify: `src/gateway/AdmissionController.ts` (add `subscribe`)
- Modify: `src/status/footer.ts` (subscribe, countdown tick, pass clock to `renderStatus`)
- Modify: `extensions/index.ts` (wire the controller to the active footer)
- Test: `test/unit/gateway-admission.test.ts`, `test/unit/status-lifecycle.test.ts`

**Interfaces:**
- Consumes: `WaitState` (Task 1); `AdmissionController`, `AdmissionEvent`, `describeGatewayWait` (existing, `src/gateway/`).
- Produces:
  - `AdmissionController.subscribe(listener: (event: AdmissionEvent) => void): () => void`
  - `FooterController.onGatewayEvent(event: AdmissionEvent): void`
  - `FooterController.setWait(wait: WaitState | undefined): void`

**Why a `subscribe` is needed:** `AdmissionController` currently supports exactly one `onEvent` callback, and `sharedAdmissionController()` already spends it on telemetry. The footer is a second consumer, so the controller needs real multi-subscriber support; `onEvent` stays as the constructor-level hook.

- [x] **Step 1: Write the failing tests**

Append to `test/unit/gateway-admission.test.ts`:

```ts
test("subscribers receive admission events alongside the telemetry hook", () => {
  const seen: string[] = [];
  const hook: string[] = [];
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => 1_000,
    sleep: async () => {},
    onEvent: (e) => hook.push(e.type),
  });
  const unsubscribe = controller.subscribe((e) => seen.push(e.type));

  controller.noteWait({ retryAfterMs: 30_000, retryable: true, source: "body", activeLimit: 1 });
  assert.deepEqual(hook, ["clamp", "wait"]);
  assert.deepEqual(seen, ["clamp", "wait"]);

  unsubscribe();
  controller.noteWait({ retryAfterMs: 1_000, retryable: true, source: "body" });
  assert.deepEqual(seen, ["clamp", "wait"], "unsubscribed listener must stop receiving");
});

test("a throwing subscriber cannot break admission control", () => {
  const controller = new AdmissionController({
    maxConcurrency: 4,
    jitterMs: 0,
    now: () => 1_000,
    sleep: async () => {},
  });
  controller.subscribe(() => {
    throw new Error("listener blew up");
  });
  assert.doesNotThrow(() => controller.noteWait({ retryAfterMs: 5_000, retryable: true, source: "body" }));
  assert.equal(controller.cooldownRemainingMs(), 5_000);
});
```

Append to `test/unit/status-lifecycle.test.ts`. That file already provides
`makeHarness()` (a fake `ctx` with `ui.setFooter`) and `cfg`
(`DEFAULT_STATUS_BAR_CONFIG` with `refreshMs: 0`) — use them, and note the
`ctx as never` cast the existing tests use:

```ts
test("a gateway wait event becomes footer wait state and clears when it expires", () => {
  const h = makeHarness();
  let now = 1_000;
  const footer = new FooterController({ ctx: h.ctx as never, config: cfg, now: () => now });

  footer.onGatewayEvent({
    type: "wait",
    waitMs: 30_000,
    concurrency: 3,
    signal: { retryAfterMs: 30_000, retryable: true, source: "body", reason: "queue_timeout", status: 429 },
  });

  assert.equal(footer.state.wait?.kind, "gateway");
  assert.equal(footer.state.wait?.detail, "queue_timeout");
  assert.equal(footer.state.wait?.untilMs, 31_000);

  now = 31_001;
  footer.tickWait();
  assert.equal(footer.state.wait, undefined, "an expired wait must clear itself");
  footer.dispose();
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/gateway-admission.test.ts test/unit/status-lifecycle.test.ts`
Expected: FAIL — `subscribe`, `onGatewayEvent`, and `tickWait` do not exist.

- [x] **Step 3: Add `subscribe` to the controller**

In `src/gateway/AdmissionController.ts`, add a field and method, and route every emission through one place:

```ts
  private readonly listeners = new Set<(event: AdmissionEvent) => void>();

  /** Observe admission events. Returns an unsubscribe. */
  subscribe(listener: (event: AdmissionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit to the constructor hook and every subscriber; a listener must never break admission. */
  private emit(event: AdmissionEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A misbehaving telemetry hook must never break admission control.
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Same contract as StatusState: listeners are observers, not participants.
      }
    }
  }
```

Replace all three existing `this.onEvent?.({ ... })` calls (`clamp`, `wait`, `relax`) with `this.emit({ ... })`. Clear `this.listeners` in no new place — the controller is process-wide and outlives its observers, so unsubscribing is the observer's job.

- [x] **Step 4: Add wait handling to the footer**

In `src/status/footer.ts`, add a `waitTimer` field beside `renderTimer`, and:

```ts
  /** Translate a gateway admission event into footer wait state. */
  onGatewayEvent(event: AdmissionEvent): void {
    if (this.disposed) return;
    if (event.type !== "wait") return;
    const signal = event.signal;
    this.setWait({
      kind: "gateway",
      detail: signal.reason ?? signal.type ?? String(signal.status ?? 429),
      untilMs: this.now() + event.waitMs,
    });
  }

  /** Publish (or clear) the wait, starting or stopping the countdown tick. */
  setWait(wait: WaitState | undefined): void {
    if (this.disposed) return;
    this.status.set({ wait });
    if (wait?.untilMs != null) this.startWaitTick();
    else this.stopWaitTick();
    this.requestRender();
  }

  /** Re-render the countdown; clears the wait once it has elapsed. */
  tickWait(): void {
    if (this.disposed) return;
    const wait = this.status.snapshot.wait;
    if (!wait) {
      this.stopWaitTick();
      return;
    }
    if (wait.untilMs != null && this.now() >= wait.untilMs) {
      this.status.set({ wait: undefined });
      this.stopWaitTick();
    }
    this.requestRender();
  }

  private startWaitTick(): void {
    if (this.waitTimer) return;
    // One tick per second: the countdown is the only thing moving, and the
    // render throttle still coalesces the repaint.
    this.waitTimer = setInterval(() => this.tickWait(), 1000);
    this.waitTimer.unref?.();
  }

  private stopWaitTick(): void {
    if (!this.waitTimer) return;
    clearInterval(this.waitTimer);
    this.waitTimer = null;
  }
```

Declare the field as `private waitTimer: ReturnType<typeof setInterval> | null = null;`, add `this.stopWaitTick();` to `dispose()`, import `AdmissionEvent` and `WaitState`, and pass the clock through in `renderLine`:

```ts
      line = renderStatus(this.status.snapshot, width, this.config, this.now());
```

- [x] **Step 5: Wire it in the extension**

In `extensions/index.ts`, inside the `session_start` handler where `activeFooter` is created, subscribe the new footer to the shared controller and keep the unsubscribe so it dies with the session:

```ts
    pi.on("session_start", (_event, ctx) => {
      activeFooter?.dispose();
      const footer = new FooterController({ ctx, config: statusBarConfig });
      activeFooter = footer;
      if (gatewayConfig.enabled) {
        const unsubscribe = sharedAdmissionController().subscribe((event) => footer.onGatewayEvent(event));
        footerUnsubscribes.push(unsubscribe);
      }
    });
```

Declare `const footerUnsubscribes: Array<() => void> = [];` beside `activeFooter`, and drain it in the `session_shutdown` handler before disposing the footer:

```ts
    pi.on("session_shutdown", () => {
      for (const un of footerUnsubscribes.splice(0)) un();
      activeFooter?.dispose();
      activeFooter = null;
    });
```

Note the ordering constraint: the gateway block currently sits *below* the status-bar block in the file, so hoist `const gatewayConfig = sharedGatewayConfig();` above the status-bar block, leaving one declaration used by both.

- [x] **Step 6: Run the tests to verify they pass**

Run: `node --test test/unit/gateway-admission.test.ts test/unit/status-lifecycle.test.ts`
Expected: PASS.

- [x] **Step 7: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
git add src/gateway/AdmissionController.ts src/status/footer.ts extensions/index.ts test/unit/gateway-admission.test.ts test/unit/status-lifecycle.test.ts
git commit -m "feat(status): show gateway backoff in the footer with a live countdown"
```

---

### Task 4: Feed the engineering task and producing model

**Files:**
- Modify: `src/runtime/EngineeringRuntime.ts` (add the `onPhase` option, emit it)
- Modify: `src/status/footer.ts` (add `setTask`)
- Modify: `extensions/index.ts` (pass `onPhase` when opening the runtime)
- Modify: `README.md` (document the new env vars and the footer segments)
- Test: `test/unit/status-lifecycle.test.ts`, `test/integration/vertical-slice.test.ts`

**Interfaces:**
- Consumes: `TaskState` (Task 1), `FooterController` (Task 3).
- Produces:
  - `interface RuntimePhaseEvent { workItemId: string; phase: "scout" | "implement" | "verify" | "review" | "settled"; goal?: string; model?: string }`
  - `EngineeringRuntimeOptions.onPhase?: (event: RuntimePhaseEvent) => void`
  - `FooterController.setTask(task: TaskState | undefined): void`
  - `FooterController.setProducingModel(model: string | undefined): void`

- [x] **Step 1: Write the failing tests**

Append to `test/unit/status-lifecycle.test.ts`:

```ts
test("setTask publishes the task and clears it on settle", () => {
  const h = makeHarness();
  const footer = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  footer.setTask({ workItemId: "WI-12", phase: "implement", label: "add retry" });
  assert.equal(footer.state.task?.workItemId, "WI-12");
  assert.equal(footer.state.task?.phase, "implement");
  footer.setTask(undefined);
  assert.equal(footer.state.task, undefined);
  footer.dispose();
});

test("the producing model overrides the session model while a worker runs", () => {
  const h = makeHarness();
  const footer = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  const sessionModel = footer.state.model; // "m1" from makeHarness
  footer.setTask({ workItemId: "WI-12", phase: "review" });
  footer.setProducingModel("haiku-4-5");
  assert.equal(footer.state.model, "haiku-4-5");
  footer.setProducingModel(undefined);
  assert.equal(footer.state.model, sessionModel, "clearing restores the session model");
  footer.dispose();
});
```

Append to `test/integration/vertical-slice.test.ts`. Copy the fixture + worker
setup from the first test in that file (`makeFixtureRepo()` from
`../fixtures/make-fixture.ts`, a `FakeWorkerExecutor` with `implementer` and
`reviewer` handlers, `CommandVerifier`), and add `onPhase` to the open call:

```ts
test("engineer() reports each phase through onPhase and settles", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      implementer: async () => ({
        status: "completed",
        summary: "Implemented add.",
        claims: [],
        details: {},
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
      reviewer: () => ({
        status: "completed",
        summary: "No material findings.",
        claims: [],
        details: { findings: [] },
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
      }),
    });
    const phases: string[] = [];
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker,
      verifier: new CommandVerifier(),
      onPhase: (e) => phases.push(e.phase),
    });

    await rt.engineer("Implement add(a, b) to return the sum of a and b");

    assert.ok(phases.includes("implement"), `phases seen: ${phases.join(",")}`);
    assert.equal(phases.at(-1), "settled", "the last phase must clear the footer");
  } finally {
    await fixture.cleanup();
  }
});
```

Note: the implementer handler in the existing test also writes the fixture file;
copy that body verbatim rather than the abbreviated version above if the run
needs a real diff. This test only asserts on phases, so a no-op implementer is
sufficient.

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/status-lifecycle.test.ts test/integration/vertical-slice.test.ts`
Expected: FAIL — `setTask`, `setProducingModel`, and `onPhase` do not exist.

- [x] **Step 3: Add the runtime hook**

In `src/runtime/EngineeringRuntime.ts`, export the event type above `EngineeringRuntimeOptions`:

```ts
/** Pipeline progress, for status surfaces. Emitted best-effort; never awaited. */
export interface RuntimePhaseEvent {
  workItemId: string;
  phase: "scout" | "implement" | "verify" | "review" | "settled";
  /** The work item's goal, for a human-readable label. */
  goal?: string;
  /** Model that produced this phase, when a worker ran one. */
  model?: string;
}
```

Add to `EngineeringRuntimeOptions`:

```ts
  /**
   * Optional progress hook for status surfaces (footer, panel). Best-effort and
   * synchronous: a throwing or slow listener must never affect the pipeline.
   */
  onPhase?: (event: RuntimePhaseEvent) => void;
```

Store it on the instance, and add one private emitter used at each pipeline stage:

```ts
  private emitPhase(event: RuntimePhaseEvent): void {
    try {
      this.onPhase?.(event);
    } catch {
      // A status listener must never break an engineering run.
    }
  }
```

Call `this.emitPhase({ workItemId, phase: "scout", goal })` (and `"implement"`, `"verify"`, `"review"`) at the start of each stage inside `engineer()`, and `this.emitPhase({ workItemId, phase: "settled", goal })` in a `finally` so the footer clears even when the run throws.

- [x] **Step 4: Add the footer methods**

In `src/status/footer.ts`:

```ts
  /** Publish (or clear) the engineering task in flight. */
  setTask(task: TaskState | undefined): void {
    if (this.disposed) return;
    this.status.set({ task });
    this.requestRender();
  }

  /**
   * Override the displayed model with the one actually producing tokens (a
   * worker's model during a run). Pass undefined to restore the session model.
   */
  setProducingModel(model: string | undefined): void {
    if (this.disposed) return;
    this.status.set({ model: model ?? modelInfo(this.ctx.model).id });
    this.requestRender();
  }
```

Import `TaskState`.

- [x] **Step 5: Wire it in the extension**

In `extensions/index.ts`, inside `getRuntimeByCwd`'s `EngineeringRuntime.open({ ... })` call, add:

```ts
    onPhase: (event) => {
      const footer = activeFooter;
      if (!footer) return;
      if (event.phase === "settled") {
        footer.setTask(undefined);
        footer.setProducingModel(undefined);
        return;
      }
      footer.setTask({ workItemId: event.workItemId, phase: event.phase, ...(event.goal ? { label: event.goal } : {}) });
      footer.setProducingModel(event.model);
    },
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `node --test test/unit/status-lifecycle.test.ts test/integration/vertical-slice.test.ts`
Expected: PASS.

- [x] **Step 7: Document the new surface**

In `README.md`, in the status-bar section, show the new line and add the two env vars to the table:

```
⏳ gateway 30s · queue_timeout │ WI-12 implement │ opus-5 │ main │ ⚡247 t/s
```

| `PI_STATUS_BAR_SHOW_TASK` | `true` | Show the engineering task in flight |
| `PI_STATUS_BAR_SHOW_WAIT` | `true` | Show why the runtime is waiting |

- [x] **Step 8: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
git add src/runtime/EngineeringRuntime.ts src/status/footer.ts extensions/index.ts README.md test/unit/status-lifecycle.test.ts test/integration/vertical-slice.test.ts
git commit -m "feat(status): show the task in flight and the producing model"
```

---

## Done when

The footer renders `⏳ gateway 30s · queue_timeout │ WI-12 implement │ opus-5 │ main │ ⚡247 t/s` during a backoff inside a run; the wait segment is the last to be elided as the terminal narrows; the countdown decrements once a second and clears itself; no git or network call happens on the render path; `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:e2e` all pass.

Track 2 (the overlay panel) is planned separately once this state shape has been used in anger.
