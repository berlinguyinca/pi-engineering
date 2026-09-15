# Engineering panel (track 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A toggleable, keyboard-navigable overlay panel showing what the runtime changed, what was reviewed and by whom, which models ran, and what was spent — during an engineering run, and from the working tree when idle.

**Architecture:** State, feeders, shaping, and painting are separate units, mirroring `src/status/`. `PanelState` is an observable store; two feeders fill it (ledger for a run, workspace for idle); `tree.ts` turns state into a flat row list as a pure function; `PanelComponent` only paints rows and moves a cursor; `PanelController` owns the overlay handle. All the behavior worth testing lives in pure code that needs no terminal.

**Tech Stack:** TypeScript (ESM, `.ts` imports), `node:test` + `node:assert/strict`, Biome, `@earendil-works/pi-tui` (`Component`, `truncateToWidth`, `visibleWidth`), `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `OverlayOptions`, `OverlayHandle`).

**Spec:** `docs/specs/2026-09-15-engineering-panel-and-status-design.md`

## Global Constraints

- The panel is a **read surface**: it never writes to the ledger, never mutates a worktree, never starts model work.
- Render path performs no git, no network, no unbounded work. Git is TTL-cached in the feeder, exactly as `src/status/git-context.ts` does it.
- A feeder failure degrades to a marked, empty section keeping the last known good data. Nothing throws into Pi's render loop.
- Every `render(width)` line must satisfy `visibleWidth(line) <= width` — the TUI contract.
- Artifact URIs travel; artifact bodies are never inlined into model context as a side effect of display.
- Keyboard is the contract. `MouseRegion` is progressive enhancement: pointer input is captured only in Pi's fullscreen TUI mode (`docs/tui.md`: *"Regular mode does not capture mouse input because the terminal owns its scrollback."*).
- Conventional commits. `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` pass before each commit.
- Track 3 (tabs, session narrative, memory readout, persisted layout, search, copy) is NOT in this plan.

---

### Task 1: PanelState — the observable store

**Files:**
- Create: `src/panel/PanelState.ts`
- Test: `test/unit/panel-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface PanelFileEntry { path: string; change: "added" | "modified" | "deleted" | "renamed" | "untracked"; }
export interface PanelFinding { id: string; severity: "info" | "low" | "medium" | "high" | "critical"; claim: string; role?: string; model?: string; candidateId?: string; status: string; }
export interface PanelSpend { model: string; input: number; output: number; cost: number; }
export interface PanelRunView { workItemId: string; goal: string; phase: string; risk: string; candidateId?: string; files: PanelFileEntry[]; findings: PanelFinding[]; spend: PanelSpend[]; }
export interface PanelWorkspaceView { branch?: string; files: PanelFileEntry[]; contextTokens?: number; contextPercent?: number; }
export interface PanelSectionError { section: "run" | "workspace"; message: string; }
export interface PanelStateShape { run?: PanelRunView; workspace?: PanelWorkspaceView; errors: PanelSectionError[]; updatedAt: number; }
export type PanelListener = (state: Readonly<PanelStateShape>) => void;
export class PanelState {
  constructor(init?: Partial<PanelStateShape>);
  get snapshot(): Readonly<PanelStateShape>;
  set(patch: Partial<PanelStateShape>): void;   // no-op when nothing changed
  noteError(section: "run" | "workspace", message: string): void;  // replaces that section's error
  clearError(section: "run" | "workspace"): void;
  subscribe(listener: PanelListener): () => void;
  dispose(): void;
}
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/panel-state.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";

test("panel state: set notifies subscribers once per real change", () => {
  const state = new PanelState();
  let calls = 0;
  const un = state.subscribe(() => calls++);

  state.set({ workspace: { files: [{ path: "a.ts", change: "modified" }] } });
  assert.equal(calls, 1);

  // Deep-equal patch: no notification.
  state.set({ workspace: { files: [{ path: "a.ts", change: "modified" }] } });
  assert.equal(calls, 1, "an unchanged patch must not notify");

  un();
  state.set({ workspace: { files: [] } });
  assert.equal(calls, 1, "unsubscribed listener must stop receiving");
  state.dispose();
});

test("panel state: a throwing subscriber cannot break publication", () => {
  const state = new PanelState();
  const seen: number[] = [];
  state.subscribe(() => {
    throw new Error("listener blew up");
  });
  state.subscribe((s) => seen.push(s.updatedAt));
  assert.doesNotThrow(() => state.set({ updatedAt: 42 }));
  assert.deepEqual(seen, [42]);
  state.dispose();
});

test("panel state: errors are per-section and replaceable", () => {
  const state = new PanelState();
  state.noteError("workspace", "git failed");
  state.noteError("workspace", "git failed again");
  assert.equal(state.snapshot.errors.length, 1, "one error per section");
  assert.equal(state.snapshot.errors[0]?.message, "git failed again");

  state.noteError("run", "ledger unreadable");
  assert.equal(state.snapshot.errors.length, 2);

  state.clearError("workspace");
  assert.deepEqual(
    state.snapshot.errors.map((e) => e.section),
    ["run"],
  );
  state.dispose();
});

test("panel state: dispose stops publication", () => {
  const state = new PanelState();
  let calls = 0;
  state.subscribe(() => calls++);
  state.dispose();
  state.set({ updatedAt: 1 });
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/panel-state.test.ts`
Expected: FAIL — `Cannot find module '../../src/panel/PanelState.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/panel/PanelState.ts` following `src/status/state.ts` exactly: a private `state`, a `Set` of listeners, `set()` that merges, compares with a `JSON.stringify` deep-equal and returns early when unchanged, notifies inside `try/catch` per listener, and a `disposed` flag checked in `set`. `noteError` filters that section out of `errors` and appends the new one; `clearError` filters it out. Initial state: `{ errors: [], updatedAt: 0 }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/panel-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/panel/PanelState.ts test/unit/panel-state.test.ts
git commit -m "feat(panel): observable panel state"
```

---

### Task 2: tree.ts — state to rows, as a pure function

**Files:**
- Create: `src/panel/tree.ts`
- Test: `test/unit/panel-tree.test.ts`

**Interfaces:**
- Consumes: `PanelStateShape`, `PanelFileEntry`, `PanelFinding`, `PanelSpend` (Task 1).
- Produces:

```ts
export type RowPayload =
  | { kind: "section"; id: string }
  | { kind: "file"; path: string; source: "run" | "workspace" }
  | { kind: "finding"; id: string }
  | { kind: "spend"; model: string }
  | { kind: "error" }
  | { kind: "empty" };
export interface PanelRow { depth: number; glyph: string; label: string; payload: RowPayload; selectable: boolean; }
export interface TreeView { rows: PanelRow[]; selectedIndex: number; }
/** Section ids that can be collapsed. */
export const SECTION_IDS: readonly string[];
export function buildRows(state: Readonly<PanelStateShape>, expanded: ReadonlySet<string>): PanelRow[];
/** Clamp a selection to the nearest selectable row; -1 when nothing is selectable. */
export function clampSelection(rows: readonly PanelRow[], desired: number): number;
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/panel-tree.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PanelStateShape } from "../../src/panel/PanelState.ts";
import { buildRows, clampSelection } from "../../src/panel/tree.ts";

const runState: PanelStateShape = {
  updatedAt: 1,
  errors: [],
  run: {
    workItemId: "WI-12",
    goal: "add retry to the gateway client",
    phase: "review",
    risk: "high",
    candidateId: "CAND-3",
    files: [
      { path: "src/gateway/signals.ts", change: "added" },
      { path: "extensions/index.ts", change: "modified" },
    ],
    findings: [
      {
        id: "E-1",
        severity: "high",
        claim: "retry loop can spin",
        role: "reviewer",
        model: "opus-5",
        candidateId: "CAND-3",
        status: "open",
      },
    ],
    spend: [{ model: "opus-5", input: 1000, output: 200, cost: 0.5 }],
  },
};

const allExpanded = new Set(["run", "files", "findings", "spend", "workspace"]);

test("tree: a run renders work item, files, findings and spend", () => {
  const rows = buildRows(runState, allExpanded);
  const labels = rows.map((r) => r.label);
  assert.ok(labels.some((l) => l.includes("WI-12")), labels.join("|"));
  assert.ok(labels.some((l) => l.includes("src/gateway/signals.ts")));
  assert.ok(labels.some((l) => l.includes("retry loop can spin")));
  assert.ok(labels.some((l) => l.includes("opus-5")));
});

test("tree: a finding carries its severity, reviewing role and model", () => {
  const rows = buildRows(runState, allExpanded);
  const finding = rows.find((r) => r.payload.kind === "finding");
  assert.ok(finding, "no finding row");
  assert.match(finding.label, /high/i);
  assert.match(finding.label, /reviewer/);
  assert.match(finding.label, /opus-5/);
});

test("tree: collapsing a section hides its children but keeps the header", () => {
  const collapsed = new Set(["run", "findings", "spend"]); // files collapsed
  const rows = buildRows(runState, collapsed);
  assert.ok(rows.some((r) => r.payload.kind === "section" && r.payload.id === "files"));
  assert.equal(rows.some((r) => r.payload.kind === "file"), false);
});

test("tree: the idle view renders the working tree when there is no run", () => {
  const rows = buildRows(
    {
      updatedAt: 1,
      errors: [],
      workspace: {
        branch: "main",
        files: [{ path: "README.md", change: "modified" }],
        contextTokens: 1200,
        contextPercent: 12,
      },
    },
    allExpanded,
  );
  const labels = rows.map((r) => r.label).join("|");
  assert.match(labels, /README\.md/);
  assert.match(labels, /main/);
});

test("tree: an empty state says so instead of rendering nothing", () => {
  const rows = buildRows({ updatedAt: 0, errors: [] }, allExpanded);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.payload.kind === "empty"));
});

test("tree: a section error renders as a marked row and does not hide other sections", () => {
  const rows = buildRows(
    { ...runState, errors: [{ section: "workspace", message: "git failed" }] },
    allExpanded,
  );
  assert.ok(rows.some((r) => r.payload.kind === "error" && /git failed/.test(r.label)));
  assert.ok(rows.some((r) => r.payload.kind === "file"), "run files must still render");
});

test("tree: clampSelection keeps the cursor on a selectable row", () => {
  const rows = buildRows(runState, allExpanded);
  assert.equal(rows[clampSelection(rows, -5)]?.selectable, true);
  assert.equal(rows[clampSelection(rows, 9999)]?.selectable, true);
  assert.equal(clampSelection([], 0), -1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/panel-tree.test.ts`
Expected: FAIL — `Cannot find module '../../src/panel/tree.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/panel/tree.ts`. `buildRows` appends, in order: the run header (`WI-12 · review · high`), then the `files`, `findings` and `spend` sections when `state.run` exists; then the workspace section when `state.workspace` exists; then one row per entry in `state.errors`; and an `{ kind: "empty" }` row when no run, no workspace and no errors produced anything. A section header is `selectable: true` with glyph `▾` when its id is in `expanded` and `▸` when not; children are emitted only when expanded. File rows use a one-letter change glyph (`A`/`M`/`D`/`R`/`?`). Finding rows render `severity · role · model · claim`. Spend rows render `model · in/out · $cost`. `clampSelection` returns -1 when no row is selectable, otherwise clamps into range and walks forward (then backward) to the nearest selectable row.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/panel-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/panel/tree.ts test/unit/panel-tree.test.ts
git commit -m "feat(panel): pure tree shaping from panel state"
```

---

### Task 3: Per-model spend from the runtime, and the ledger feeder

**Files:**
- Modify: `src/runtime/EngineeringRuntime.ts` (add `usage` to `RuntimePhaseEvent`)
- Create: `src/panel/feeders/LedgerFeeder.ts`
- Test: `test/unit/panel-ledger-feeder.test.ts`, `test/integration/vertical-slice.test.ts`

**Interfaces:**
- Consumes: `PanelState` (Task 1); `Ledger` (`getWorkItem(id)`, `listCandidates(workItemId?)`, `listEntities(kind?, workItemId?)`, `events(workItemId?)`), `RuntimePhaseEvent`.
- Produces:
  - `RuntimePhaseEvent.usage?: { input: number; output: number; cost: number }`
  - `class LedgerFeeder { constructor(opts: { ledger: Ledger; state: PanelState }); onPhase(event: RuntimePhaseEvent): void; refresh(workItemId?: string): void; }`

**Why the runtime change:** per-model spend is not persisted anywhere — `WorkerUsage` is folded into the runtime's aggregate `telemetry` and lost per model. The worker-run helper already reports `model` on the phase event; carrying `input`/`output`/`cost` alongside it is the smallest honest source for the spend section, and it needs no ledger schema change.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/panel-ledger-feeder.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../../src/ledger/EventStore.ts";
import { Ledger } from "../../src/ledger/Ledger.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { LedgerFeeder } from "../../src/panel/feeders/LedgerFeeder.ts";

async function openLedger() {
  const dir = await mkdtemp(join(tmpdir(), "panel-feeder-"));
  const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
  return { ledger, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("ledger feeder: a phase event publishes the work item, phase and goal", async () => {
  const { ledger, cleanup } = await openLedger();
  try {
    const actor = { type: "worker" as const, role: "planner" as const };
    const wi = await ledger.createWorkItem("add retry", "high", ["/repo"], actor);
    const state = new PanelState();
    const feeder = new LedgerFeeder({ ledger, state });

    feeder.onPhase({ workItemId: wi.id, phase: "implement", goal: "add retry" });

    assert.equal(state.snapshot.run?.workItemId, wi.id);
    assert.equal(state.snapshot.run?.phase, "implement");
    assert.equal(state.snapshot.run?.goal, "add retry");
    assert.equal(state.snapshot.run?.risk, "high");
  } finally {
    await cleanup();
  }
});

test("ledger feeder: candidate changed files and review findings reach the state", async () => {
  const { ledger, cleanup } = await openLedger();
  try {
    const actor = { type: "worker" as const, role: "implementer" as const };
    const wi = await ledger.createWorkItem("add retry", "medium", ["/repo"], actor);
    const cand = await ledger.createCandidate(wi.id, null, "abc123", "cand/1", actor);
    await ledger.changeCandidate(cand.id, { changed_files: ["src/a.ts", "src/b.ts"] }, wi.id, actor);
    // Severity/candidate live in the options object, and the REVIEWING actor is
    // what attributes the finding — entities do not store it themselves.
    await ledger.recordEntity(
      "finding",
      "retry loop can spin",
      "open",
      { type: "agent", role: "reviewer", model: "opus-5" },
      wi.id,
      { severity: "high", candidateId: cand.id },
    );

    const state = new PanelState();
    const feeder = new LedgerFeeder({ ledger, state });
    feeder.onPhase({ workItemId: wi.id, phase: "review", goal: "add retry" });

    assert.deepEqual(
      state.snapshot.run?.files.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    const finding = state.snapshot.run?.findings[0];
    assert.equal(finding?.severity, "high");
    assert.equal(finding?.role, "reviewer");
    assert.equal(finding?.model, "opus-5");
  } finally {
    await cleanup();
  }
});

test("ledger feeder: spend accumulates per model across phases", async () => {
  const { ledger, cleanup } = await openLedger();
  try {
    const actor = { type: "worker" as const, role: "planner" as const };
    const wi = await ledger.createWorkItem("add retry", "low", ["/repo"], actor);
    const state = new PanelState();
    const feeder = new LedgerFeeder({ ledger, state });

    feeder.onPhase({ workItemId: wi.id, phase: "implement", model: "opus-5", usage: { input: 100, output: 20, cost: 0.1 } });
    feeder.onPhase({ workItemId: wi.id, phase: "review", model: "opus-5", usage: { input: 50, output: 10, cost: 0.05 } });
    feeder.onPhase({ workItemId: wi.id, phase: "review", model: "haiku-4-5", usage: { input: 10, output: 5, cost: 0.001 } });

    const spend = state.snapshot.run?.spend ?? [];
    const opus = spend.find((s) => s.model === "opus-5");
    assert.equal(opus?.input, 150);
    assert.equal(opus?.output, 30);
    assert.ok(Math.abs((opus?.cost ?? 0) - 0.15) < 1e-9);
    assert.equal(spend.find((s) => s.model === "haiku-4-5")?.input, 10);
  } finally {
    await cleanup();
  }
});

test("ledger feeder: a settled run clears the run view", async () => {
  const { ledger, cleanup } = await openLedger();
  try {
    const actor = { type: "worker" as const, role: "planner" as const };
    const wi = await ledger.createWorkItem("add retry", "low", ["/repo"], actor);
    const state = new PanelState();
    const feeder = new LedgerFeeder({ ledger, state });
    feeder.onPhase({ workItemId: wi.id, phase: "implement" });
    feeder.onPhase({ workItemId: wi.id, phase: "settled" });
    assert.equal(state.snapshot.run, undefined);
  } finally {
    await cleanup();
  }
});

test("ledger feeder: a settle for a DIFFERENT run does not clear the live one", async () => {
  const { ledger, cleanup } = await openLedger();
  try {
    const actor = { type: "worker" as const, role: "planner" as const };
    const a = await ledger.createWorkItem("first", "low", ["/repo"], actor);
    const b = await ledger.createWorkItem("second", "low", ["/repo"], actor);
    const state = new PanelState();
    const feeder = new LedgerFeeder({ ledger, state });

    feeder.onPhase({ workItemId: a.id, phase: "implement" });
    feeder.onPhase({ workItemId: b.id, phase: "implement" });
    feeder.onPhase({ workItemId: a.id, phase: "settled" });

    assert.equal(state.snapshot.run?.workItemId, b.id, "a stale settle must not clear the live run");
  } finally {
    await cleanup();
  }
});

test("ledger feeder: an unreadable ledger marks the section instead of throwing", () => {
  const broken = {
    getWorkItem: () => {
      throw new Error("ledger unreadable");
    },
  } as never;
  const state = new PanelState();
  const feeder = new LedgerFeeder({ ledger: broken, state });
  assert.doesNotThrow(() => feeder.onPhase({ workItemId: "WI-1", phase: "implement" }));
  assert.match(state.snapshot.errors[0]?.message ?? "", /ledger unreadable/);
});
```

Append to `test/integration/vertical-slice.test.ts`:

```ts
test("vertical slice: onPhase reports per-model usage for the spend view", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        await writeFile(join(req.cwd, "src", "add.js"), `export function add(a, b) {\n  return a + b;\n}\n`);
        return {
          status: "completed",
          summary: "Implemented add.",
          claims: [],
          details: {},
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
        };
      },
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
    const withUsage: RuntimePhaseEvent[] = [];
    const rt = await EngineeringRuntime.open({
      cwd: fixture.root,
      worker,
      verifier: new CommandVerifier(),
      onPhase: (e) => {
        if (e.usage) withUsage.push(e);
      },
    });

    await rt.engineer("Implement add(a, b) to return the sum of a and b");

    // FakeWorkerExecutor reports usage; every usage-bearing event names a model.
    for (const e of withUsage) assert.ok(e.model, "usage without a model is unattributable");
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/unit/panel-ledger-feeder.test.ts`
Expected: FAIL — `Cannot find module '../../src/panel/feeders/LedgerFeeder.ts'`.

The ledger signatures this task relies on, confirmed against `src/ledger/Ledger.ts`:

```ts
createWorkItem(goal, risk, repositories, actor): Promise<WorkItem>
createCandidate(workItemId, parentId, baseCommit, branch, actor): Promise<Candidate>
changeCandidate(id, changes, workItemId, actor): Promise<void>   // NOT updateCandidate
recordEntity(kind, claim, status, actor, workItemId, opts?): Promise<LedgerEntity>
  // opts: { evidence?, confidence?, severity?, candidateId? }
events(workItemId?): LedgerEvent[]   // { event_id, work_item_id, timestamp, actor, type, payload }
```

- [ ] **Step 3: Extend the phase event**

In `src/runtime/EngineeringRuntime.ts`, add to `RuntimePhaseEvent`:

```ts
  /** Token/cost usage for this phase, when a worker reported it. */
  usage?: { input: number; output: number; cost: number };
```

and in the worker-run helper where `run.usage?.model` is already read, include it:

```ts
        this.emitPhase({
          workItemId: this.currentWorkItemId,
          phase,
          goal: this.currentPhaseGoal || undefined,
          model: run.usage.model,
          usage: { input: run.usage.input, output: run.usage.output, cost: run.usage.cost },
        });
```

- [ ] **Step 4: Write the feeder**

Create `src/panel/feeders/LedgerFeeder.ts`. It keeps `spendByModel: Map<string, PanelSpend>` and the active `workItemId`. `onPhase`:

1. wrap the whole body in `try/catch`; on catch call `state.noteError("run", String(err))` and return — a broken read must never reach the render loop;
2. on `settled`, clear the run view and the spend map **only when `event.workItemId` matches the active one** (parallel legs each settle — the same guard the footer needed);
3. otherwise set the active work item, accumulate `usage` into `spendByModel` keyed by `model`, and rebuild the run view from the ledger: `getWorkItem` for goal/risk, the last `listCandidates(workItemId)` entry for `changed_files` and `candidateId`, and `listEntities("finding", workItemId)` for findings;
4. call `state.clearError("run")` on a successful rebuild.

**Attribution ("who reviewed, which model") needs the events, not the entities.**
`LedgerEntity` carries no actor — the reviewing actor is on the ledger *event*
that recorded it. Build a one-pass map before assembling findings:

```ts
/** entity id -> the actor that recorded it (role, model). */
function attributionByEntity(ledger: Ledger, workItemId: string): Map<string, Actor> {
  const map = new Map<string, Actor>();
  for (const event of ledger.events(workItemId)) {
    const entity = (event.payload as { entity?: { id?: string } }).entity;
    if (entity?.id) map.set(entity.id, event.actor);
  }
  return map;
}
```

Findings are emitted as `finding.created` / `finding.resolved` with
`payload.entity`, so this covers them; a later `entity.updated` overwrites with
the most recent actor, which is what the panel should show. Where an entity has
no recorded event, leave `role`/`model` undefined rather than inventing a value
— `tree.ts` already renders only what is present.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/unit/panel-ledger-feeder.test.ts test/integration/vertical-slice.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/runtime/EngineeringRuntime.ts src/panel/feeders/LedgerFeeder.ts test/unit/panel-ledger-feeder.test.ts test/integration/vertical-slice.test.ts
git commit -m "feat(panel): ledger feeder with per-model spend"
```

---

### Task 4: WorkspaceFeeder — the idle view

**Files:**
- Create: `src/panel/feeders/WorkspaceFeeder.ts`
- Test: `test/unit/panel-workspace-feeder.test.ts`

**Interfaces:**
- Consumes: `PanelState` (Task 1); `GitRepo` (`status(): Promise<string>` returning `git status --short`, `currentBranch(): Promise<string | null>`).
- Produces:
  - `export function parseGitStatusShort(output: string): PanelFileEntry[]`
  - `class WorkspaceFeeder { constructor(opts: { state: PanelState; repo: GitRepo | null; now?: () => number; ttlMs?: number; contextUsage?: () => { tokens: number | null; percent: number | null } | undefined }); refresh(): Promise<void>; invalidate(): void; }`

- [ ] **Step 1: Write the failing test**

Create `test/unit/panel-workspace-feeder.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { WorkspaceFeeder, parseGitStatusShort } from "../../src/panel/feeders/WorkspaceFeeder.ts";

test("workspace feeder: parses git status --short into typed entries", () => {
  const entries = parseGitStatusShort(
    [" M src/a.ts", "A  src/b.ts", "?? notes.md", " D old.ts", 'R  "old name.ts" -> "new name.ts"', ""].join("\n"),
  );
  assert.deepEqual(entries, [
    { path: "src/a.ts", change: "modified" },
    { path: "src/b.ts", change: "added" },
    { path: "notes.md", change: "untracked" },
    { path: "old.ts", change: "deleted" },
    { path: "new name.ts", change: "renamed" },
  ]);
});

test("workspace feeder: publishes branch, files and context usage", async () => {
  const state = new PanelState();
  const repo = {
    status: async () => " M README.md\n",
    currentBranch: async () => "main",
  } as never;
  const feeder = new WorkspaceFeeder({
    state,
    repo,
    now: () => 0,
    contextUsage: () => ({ tokens: 1200, percent: 12 }),
  });

  await feeder.refresh();

  assert.equal(state.snapshot.workspace?.branch, "main");
  assert.deepEqual(state.snapshot.workspace?.files, [{ path: "README.md", change: "modified" }]);
  assert.equal(state.snapshot.workspace?.contextTokens, 1200);
});

test("workspace feeder: git is not re-run inside the TTL", async () => {
  let calls = 0;
  const state = new PanelState();
  const repo = {
    status: async () => {
      calls++;
      return " M README.md\n";
    },
    currentBranch: async () => "main",
  } as never;
  let now = 0;
  const feeder = new WorkspaceFeeder({ state, repo, now: () => now, ttlMs: 30_000 });

  await feeder.refresh();
  await feeder.refresh();
  assert.equal(calls, 1, "the second refresh must be served from cache");

  now = 31_000;
  await feeder.refresh();
  assert.equal(calls, 2, "an expired cache must re-read");

  feeder.invalidate();
  await feeder.refresh();
  assert.equal(calls, 3, "invalidate must force a re-read");
});

test("workspace feeder: a failing git marks the section and keeps the last good data", async () => {
  const state = new PanelState();
  let fail = false;
  const repo = {
    status: async () => {
      if (fail) throw new Error("git exploded");
      return " M README.md\n";
    },
    currentBranch: async () => "main",
  } as never;
  const feeder = new WorkspaceFeeder({ state, repo, now: () => 0, ttlMs: 0 });

  await feeder.refresh();
  fail = true;
  await feeder.refresh();

  assert.match(state.snapshot.errors[0]?.message ?? "", /git exploded/);
  assert.deepEqual(state.snapshot.workspace?.files, [{ path: "README.md", change: "modified" }], "last good data survives");
});

test("workspace feeder: outside a git repo there is no error, just no files", async () => {
  const state = new PanelState();
  const feeder = new WorkspaceFeeder({ state, repo: null, now: () => 0 });
  await feeder.refresh();
  assert.deepEqual(state.snapshot.workspace?.files, []);
  assert.deepEqual(state.snapshot.errors, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/panel-workspace-feeder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/panel/feeders/WorkspaceFeeder.ts`. `parseGitStatusShort` splits lines, reads the two-character status field, maps `??` → untracked, `A` → added, `D` → deleted, `R` → renamed (taking the path after `->` and stripping surrounding quotes), anything else with a non-space code → modified, and skips blank lines. `refresh()` returns early when `now() - lastReadAt < ttlMs` and a previous read succeeded; otherwise reads branch + status inside `try/catch`, publishes `{ branch, files, contextTokens, contextPercent }`, and on failure calls `noteError("workspace", ...)` while leaving the previous `workspace` value in place. A null repo publishes an empty file list and no error. Default `ttlMs` is 30_000, matching `DEFAULT_STATUS_BAR_CONFIG.gitCacheTtlMs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/panel-workspace-feeder.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/panel/feeders/WorkspaceFeeder.ts test/unit/panel-workspace-feeder.test.ts
git commit -m "feat(panel): workspace feeder for the idle view"
```

---

### Task 5: Bounded content view

**Files:**
- Create: `src/panel/content.ts`
- Test: `test/unit/panel-content.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore` (`readContentByUri(uri): Promise<string | undefined>`).
- Produces:

```ts
export interface ContentView { title: string; lines: string[]; truncated: boolean; error?: string; }
export const MAX_CONTENT_BYTES: number;   // 256 * 1024
export const MAX_CONTENT_LINES: number;   // 2000
export function toContentView(title: string, body: string): ContentView;
export async function readFileContent(absPath: string, title?: string): Promise<ContentView>;
export async function readDiffContent(artifacts: { readContentByUri(uri: string): Promise<string | undefined> }, uri: string): Promise<ContentView>;
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/panel-content.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CONTENT_LINES, readDiffContent, readFileContent, toContentView } from "../../src/panel/content.ts";

test("content: a short body is returned whole and untruncated", () => {
  const view = toContentView("a.ts", "one\ntwo\n");
  assert.deepEqual(view.lines, ["one", "two"]);
  assert.equal(view.truncated, false);
  assert.equal(view.title, "a.ts");
});

test("content: a long body is capped and marked truncated", () => {
  const body = Array.from({ length: MAX_CONTENT_LINES + 500 }, (_, i) => `line ${i}`).join("\n");
  const view = toContentView("big.ts", body);
  assert.equal(view.lines.length, MAX_CONTENT_LINES);
  assert.equal(view.truncated, true);
});

test("content: reads a working-tree file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-content-"));
  try {
    const p = join(dir, "a.ts");
    await writeFile(p, "export const a = 1;\n");
    const view = await readFileContent(p, "a.ts");
    assert.deepEqual(view.lines, ["export const a = 1;"]);
    assert.equal(view.error, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content: a missing file reports an error instead of throwing", async () => {
  const view = await readFileContent("/nonexistent/nope.ts");
  assert.ok(view.error, "expected an error");
  assert.deepEqual(view.lines, []);
});

test("content: reads a candidate diff through the artifact store by URI", async () => {
  const artifacts = { readContentByUri: async () => "diff --git a/x b/x\n+added\n" };
  const view = await readDiffContent(artifacts, "artifact://diffs/CAND-3");
  assert.match(view.lines.join("\n"), /\+added/);
});

test("content: an unreadable artifact reports an error", async () => {
  const artifacts = {
    readContentByUri: async () => {
      throw new Error("artifact gone");
    },
  };
  const view = await readDiffContent(artifacts, "artifact://diffs/CAND-3");
  assert.match(view.error ?? "", /artifact gone/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/panel-content.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/panel/content.ts`. `toContentView` splits on `\n`, drops a single trailing empty line, and caps at `MAX_CONTENT_LINES`, setting `truncated`. `readFileContent` stats the file first and refuses anything over `MAX_CONTENT_BYTES` with a `truncated` view containing the first chunk, catching every error into `{ lines: [], error }`. `readDiffContent` awaits `readContentByUri` inside `try/catch`, treating `undefined` as `{ error: "artifact not found" }`. Nothing here ever throws.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/panel-content.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/panel/content.ts test/unit/panel-content.test.ts
git commit -m "feat(panel): bounded content view for files and diffs"
```

---

### Task 6: PanelComponent — paint rows, move the cursor

**Files:**
- Create: `src/panel/PanelComponent.ts`
- Test: `test/unit/panel-component.test.ts`

**Interfaces:**
- Consumes: `PanelRow`, `buildRows`, `clampSelection` (Task 2); `ContentView` (Task 5); `PanelState` (Task 1).
- Produces:

```ts
export interface PanelComponentOptions {
  state: PanelState;
  /** Requested when the component needs a repaint. */
  requestRender: () => void;
  /** Open a file/diff row; the controller supplies the reader. */
  openRow?: (payload: RowPayload) => void;
  /** Close the panel (escape at the top level). */
  onClose?: () => void;
}
export class PanelComponent {
  constructor(opts: PanelComponentOptions);
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
  /** Show a content view in place of the tree; escape returns to the tree. */
  showContent(view: ContentView): void;
  /** Test seam: the rows currently rendered. */
  get rows(): readonly PanelRow[];
  get selectedIndex(): number;
}
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/panel-component.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PanelState } from "../../src/panel/PanelState.ts";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";

function seeded(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    run: {
      workItemId: "WI-12",
      goal: "add retry to the gateway client",
      phase: "review",
      risk: "high",
      files: [
        { path: "src/gateway/signals.ts", change: "added" },
        { path: "extensions/index.ts", change: "modified" },
      ],
      findings: [],
      spend: [],
    },
  });
  return state;
}

test("component: every rendered line respects the width contract", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  for (const width of [20, 36, 40, 80, 200]) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
    }
  }
  component.dispose();
});

test("component: a very long path is truncated, not wrapped", () => {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: { files: [{ path: `src/${"very-long-directory/".repeat(20)}file.ts`, change: "modified" }] },
  });
  const component = new PanelComponent({ state, requestRender: () => {} });
  const lines = component.render(40);
  assert.equal(lines.length, component.rows.length, "one line per row: no wrapping");
  for (const line of lines) assert.ok(visibleWidth(line) <= 40);
  component.dispose();
});

test("component: down and up move the selection between selectable rows", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.render(80);
  const first = component.selectedIndex;
  component.handleInput("\x1b[B"); // down
  assert.notEqual(component.selectedIndex, first);
  component.handleInput("\x1b[A"); // up
  assert.equal(component.selectedIndex, first);
  component.dispose();
});

test("component: selection never leaves the row range", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.render(80);
  for (let i = 0; i < 50; i++) component.handleInput("\x1b[B");
  assert.ok(component.selectedIndex < component.rows.length);
  for (let i = 0; i < 50; i++) component.handleInput("\x1b[A");
  assert.ok(component.selectedIndex >= 0);
  component.dispose();
});

test("component: enter on a file row asks the controller to open it", () => {
  const opened: string[] = [];
  const component = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    openRow: (payload) => {
      if (payload.kind === "file") opened.push(payload.path);
    },
  });
  component.render(80);
  while (component.rows[component.selectedIndex]?.payload.kind !== "file") component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.equal(opened.length, 1);
  component.dispose();
});

test("component: a state change requests exactly one repaint", () => {
  const state = seeded();
  let renders = 0;
  const component = new PanelComponent({ state, requestRender: () => renders++ });
  state.set({ updatedAt: 2 });
  assert.equal(renders, 1);
  component.dispose();
  state.set({ updatedAt: 3 });
  assert.equal(renders, 1, "a disposed component must unsubscribe");
});

test("component: content view replaces the tree and escape returns to it", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.render(80);
  component.showContent({ title: "a.ts", lines: ["export const a = 1;"], truncated: false });
  assert.match(component.render(80).join("\n"), /export const a = 1;/);
  component.handleInput("\x1b"); // escape
  assert.match(component.render(80).join("\n"), /WI-12/);
  component.dispose();
});

test("component: escape at the top level closes the panel", () => {
  let closed = 0;
  const component = new PanelComponent({ state: seeded(), requestRender: () => {}, onClose: () => closed++ });
  component.render(80);
  component.handleInput("\x1b");
  assert.equal(closed, 1);
  component.dispose();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/panel-component.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/panel/PanelComponent.ts`. It subscribes to `PanelState` in the constructor (storing the unsubscribe, called in `dispose`) and calls `requestRender` on change. It keeps `expanded: Set<string>` (all section ids expanded initially), `selectedIndex`, and an optional `content: ContentView | null`.

`render(width)` rebuilds rows via `buildRows(state.snapshot, expanded)`, re-clamps the selection, and returns exactly one line per row — each built as `indent + glyph + label`, prefixed with a selection marker, then passed through `truncateToWidth(line, width, "…")` so the width contract holds and nothing ever wraps. When `content` is set, it renders the content view's lines (header + capped body) instead.

`handleInput(data)` maps `\x1b[A`/`\x1b[B` to up/down, `\r`/`\n` and `\x1b[C` to expand-or-open (toggling `expanded` for a section row, calling `openRow` for file rows), `\x1b[D` to collapse, and `\x1b` to dismiss content (when showing) or call `onClose` (when not). Unknown input is ignored.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/panel-component.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test
git add src/panel/PanelComponent.ts test/unit/panel-component.test.ts
git commit -m "feat(panel): panel component with keyboard navigation"
```

---

### Task 7: PanelController, `/panel`, and the hotkey

**Files:**
- Create: `src/panel/PanelController.ts`
- Modify: `extensions/index.ts`
- Modify: `src/index.ts` (export the panel module)
- Modify: `README.md`
- Modify: `scripts/smoke-commands.ts` (assert the command registers)
- Test: `test/unit/panel-controller.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `export function matchesChord(data: string, chord: string): boolean` — used by the raw input handler.
  - `class PanelController { constructor(opts: { state: PanelState; ui: { custom: ... }; chord?: string }); toggle(): void; isOpen(): boolean; handleTerminalInput(data: string): { consume?: boolean } | undefined; dispose(): void; }`

**Why a raw input handler:** `ExtensionAPI` exposes `registerCommand` but no keybinding registration, so the hotkey is implemented with `ctx.ui.onTerminalInput`, which consumes only its configured chord and passes everything else through untouched.

- [ ] **Step 1: Write the failing test**

Create `test/unit/panel-controller.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { PanelController, matchesChord } from "../../src/panel/PanelController.ts";

test("controller: the chord matcher claims only its own key", () => {
  assert.equal(matchesChord("\x10", "ctrl+p"), true);
  assert.equal(matchesChord("\x01", "ctrl+p"), false);
  assert.equal(matchesChord("p", "ctrl+p"), false);
  assert.equal(matchesChord("\x10", "none"), false, "a disabled chord claims nothing");
});

test("controller: terminal input passes everything except the chord through", () => {
  const controller = new PanelController({ state: new PanelState(), ui: fakeUi(), chord: "ctrl+p" });
  assert.deepEqual(controller.handleTerminalInput("\x10"), { consume: true });
  assert.equal(controller.handleTerminalInput("hello"), undefined);
  assert.equal(controller.handleTerminalInput("\x1b[A"), undefined);
  controller.dispose();
});

test("controller: toggle opens and closes the overlay exactly once each way", () => {
  const ui = fakeUi();
  const controller = new PanelController({ state: new PanelState(), ui, chord: "ctrl+p" });
  assert.equal(controller.isOpen(), false);
  controller.toggle();
  assert.equal(controller.isOpen(), true);
  assert.equal(ui.customCalls, 1);
  controller.toggle();
  assert.equal(controller.isOpen(), false);
  assert.equal(ui.hideCalls, 1);
  controller.dispose();
});

test("controller: dispose hides an open overlay", () => {
  const ui = fakeUi();
  const controller = new PanelController({ state: new PanelState(), ui, chord: "ctrl+p" });
  controller.toggle();
  controller.dispose();
  assert.equal(ui.hideCalls, 1);
  assert.equal(controller.isOpen(), false);
});

function fakeUi() {
  const ui = {
    customCalls: 0,
    hideCalls: 0,
    custom: (_factory: unknown, options: { onHandle?: (h: unknown) => void }) => {
      ui.customCalls++;
      options.onHandle?.({
        hide: () => ui.hideCalls++,
        setHidden: () => {},
        isHidden: () => false,
        focus: () => {},
        unfocus: () => {},
        isFocused: () => true,
        getBounds: () => undefined,
      });
      return new Promise<void>(() => {});
    },
  };
  return ui;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/unit/panel-controller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the controller**

Create `src/panel/PanelController.ts`. `matchesChord` maps `ctrl+<letter>` to its control code (`ctrl+p` → `\x10`, i.e. `String.fromCharCode(letter.charCodeAt(0) - 96)`) and returns false for the literal chord `"none"`. The controller holds the `OverlayHandle` captured through `onHandle`, opens with:

```ts
    this.ui.custom(
      (tui, _theme, _keybindings, done) => {
        this.done = done;
        this.component = new PanelComponent({
          state: this.state,
          requestRender: () => tui.requestRender(),
          onClose: () => this.close(),
        });
        return this.component;
      },
      {
        overlay: true,
        overlayOptions: () => ({
          anchor: "top-right",
          width: "35%",
          minWidth: 36,
          margin: 1,
          // Below this the overlay would crowd the chat rather than help.
          visible: (cols: number) => cols >= 100,
        }),
        onHandle: (handle) => {
          this.handle = handle;
        },
      },
    );
```

The predicate field is `visible?: (termWidth: number, termHeight: number) => boolean`,
confirmed in `@earendil-works/pi-tui/dist/tui.d.ts`; it is called every render
cycle, so it must stay cheap. `nonCapturing?: boolean` is also available if the
panel should ever stop taking focus.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/unit/panel-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the extension**

In `extensions/index.ts`: create one `PanelState` per repo alongside the runtime, construct the feeders, register `/panel`, and install the raw input handler in `session_start` (pushing its unsubscribe onto the existing `footerUnsubscribes` drain). Feed the same `onPhase` events already wired for the footer into `LedgerFeeder.onPhase`, and refresh the `WorkspaceFeeder` when the panel opens and on `agent_settled`.

- [ ] **Step 6: Document and smoke-test**

Add a README section describing `/panel`, the keys (`↑↓`, `→`/`enter`, `←`, `esc`, `ctrl+p`), the fullscreen-only mouse caveat, and `PI_PANEL_CHORD` (default `ctrl+p`, `none` to disable). Add `panel` to the expected command list in `scripts/smoke-commands.ts`.

- [ ] **Step 7: Verify and commit**

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
git add src/panel/PanelController.ts extensions/index.ts src/index.ts README.md scripts/smoke-commands.ts test/unit/panel-controller.test.ts
git commit -m "feat(panel): /panel overlay with a configurable hotkey"
```

---

## Done when

`/panel` and `ctrl+p` toggle a right-anchored overlay; it shows the run tree during an engineering run and the working tree when idle; arrow keys move, enter expands a section or opens a file, escape returns from a file to the tree and closes the panel from the tree; a candidate diff and a working-tree file both open in a bounded view; a failing git or unreadable artifact marks its section and leaves the rest of the panel working; every rendered line respects the width contract; `npm run lint`, `npm run typecheck`, `npm test` and `npm run test:e2e` pass.

Track 3 (tabs, session narrative, memory readout, persisted layout, search, copy) follows in its own plan.
