# Engineering panel (track 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the panel livable — tabs that cycle and are remembered, a width you can change, expansion that survives a restart, vim-style search, copy, a memory readout, and a model-generated session narrative.

**Architecture:** Track 2's split holds: pure shaping in `tree.ts`, painting in `PanelComponent`, lifecycle in `PanelController`. Track 3 adds four pure modules (`search.ts`, `layout.ts`, `clipboard.ts`, `narrator/deltas.ts`), one feeder (`MemoryFeeder`), and one effectful unit with an injected seam (`narrator/Narrator.ts`). Persisted layout lives in the agent profile, written atomically, owner-only.

**Tech Stack:** TypeScript (ESM, `.ts` imports), `node:test` + `node:assert/strict`, Biome, `@earendil-works/pi-tui` (`truncateToWidth`, `visibleWidth`), `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `ModelRuntime`).

**Spec:** `docs/specs/2026-09-15-engineering-panel-and-status-design.md`

## Global Constraints

- The panel remains a **read surface**: it never writes to the ledger, never mutates a worktree. The narrator is the single exception to "never starts model work", and is gated as described below.
- Render path performs no git, no network, no file reads, no unbounded work.
- Every `render(width)` line must satisfy `visibleWidth(line) <= width`.
- A failure in any new unit degrades that section and never throws into Pi's render loop.
- Persisted layout holds **no repository content and no credentials**. Written with `mode: 0o600` via write-temp-then-rename, exactly as `src/blackhole/connectionSetup.ts:163` does it.
- The narrative is **generated text, not a record**: labeled as generated, never written to the ledger, never read back as input to any decision (INV-006).
- Conventional commits. `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` pass before each commit.

## Two deviations from the spec, both verified in this repo

**1. Search primitives are not reusable.** The spec says to reuse
`findAltScreenSearchMatches` / `AltScreenSearchIndex` from `@earendil-works/pi-tui`.
They are **not exported** from the package index — `node -e 'import("@earendil-works/pi-tui")'`
shows no search exports; they are reachable only by deep-importing
`@earendil-works/pi-tui/dist/alt-screen-search.js`, which works today only because
the package publishes no `exports` map. They also return per-row/column
*segments* for highlighting a fullscreen transcript, not "which row is match N",
which is what the panel needs. Task 3 therefore writes a ~40-line pure matcher.
Do not deep-import `dist/`.

**2. OSC 52 cannot confirm a copy.** The spec says the panel "reports that the
copy did not happen" where a terminal refuses OSC 52. No such signal exists —
the escape sequence is write-only. Pi's own code says so at
`node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js:1218`: *"A bare OSC 52
write can show 'Copied!' while leaving the system clipboard untouched."*
Task 4 therefore reports the **action** ("sent to terminal clipboard"), never
success. Genuine failures — no TTY, a write that throws — are detected and
reported as failures.

---

### Task 1: Persisted layout

Everything else in this plan persists *into* this, so it lands first.

**Files:**
- Create: `src/panel/layout.ts`
- Test: `test/unit/panel-layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type PanelTabId = "files" | "reviews" | "tokens" | "session" | "memory";
export const PANEL_TABS: readonly PanelTabId[];

export interface PanelLayout {
  /** Overlay width as a percentage of terminal columns. */
  widthPercent: number;
  tab: PanelTabId;
  /** Section ids left expanded, sorted for a stable file. */
  expanded: string[];
}

export const DEFAULT_LAYOUT: PanelLayout;
export const MIN_WIDTH_PERCENT = 20;
export const MAX_WIDTH_PERCENT = 80;
export const WIDTH_STEP_PERCENT = 5;

export interface LayoutStoreOptions { profileDir?: string; env?: NodeJS.ProcessEnv; }

export class PanelLayoutStore {
  constructor(opts?: LayoutStoreOptions);
  /** Never throws: a missing or corrupt file yields DEFAULT_LAYOUT. */
  load(): PanelLayout;
  /** Never throws: an unwritable profile is a silently dropped preference. */
  save(layout: PanelLayout): void;
}

/** Pure: clamp a width change into the allowed band. */
export function stepWidth(current: number, direction: -1 | 1): number;
/** Pure: cycle tabs with wrap-around. */
export function stepTab(current: PanelTabId, direction: -1 | 1): PanelTabId;
```

Layout path: `<profileDir | $PI_CODING_AGENT_DIR | ~/.pi/agent>/engineering-panel/layout.json`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_LAYOUT,
  PanelLayoutStore,
  stepTab,
  stepWidth,
  MIN_WIDTH_PERCENT,
  MAX_WIDTH_PERCENT,
} from "../../src/panel/layout.ts";

async function tempProfile(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-panel-layout-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("layout: width steps are clamped to the allowed band", () => {
  assert.equal(stepWidth(35, 1), 40);
  assert.equal(stepWidth(35, -1), 30);
  assert.equal(stepWidth(MAX_WIDTH_PERCENT, 1), MAX_WIDTH_PERCENT, "never past the ceiling");
  assert.equal(stepWidth(MIN_WIDTH_PERCENT, -1), MIN_WIDTH_PERCENT, "never past the floor");
});

test("layout: tabs cycle with wrap-around in both directions", () => {
  assert.equal(stepTab("files", 1), "reviews");
  assert.equal(stepTab("memory", 1), "files", "forward wraps");
  assert.equal(stepTab("files", -1), "memory", "backward wraps");
});

test("layout: a missing profile loads defaults rather than failing", async () => {
  const p = await tempProfile();
  try {
    assert.deepEqual(new PanelLayoutStore({ profileDir: p.dir }).load(), DEFAULT_LAYOUT);
  } finally {
    await p.cleanup();
  }
});

test("layout: a saved layout round-trips through the file, not just memory", async () => {
  const p = await tempProfile();
  try {
    const written = new PanelLayoutStore({ profileDir: p.dir });
    written.save({ widthPercent: 50, tab: "reviews", expanded: ["files", "run"] });
    // A SEPARATE store instance: this is the restart the acceptance criteria mean.
    const reloaded = new PanelLayoutStore({ profileDir: p.dir }).load();
    assert.equal(reloaded.widthPercent, 50);
    assert.equal(reloaded.tab, "reviews");
    assert.deepEqual(reloaded.expanded, ["files", "run"]);
  } finally {
    await p.cleanup();
  }
});

test("layout: the file is owner-only and holds no repository content", async () => {
  const p = await tempProfile();
  try {
    new PanelLayoutStore({ profileDir: p.dir }).save({ widthPercent: 40, tab: "files", expanded: [] });
    const path = join(p.dir, "engineering-panel", "layout.json");
    const { stat } = await import("node:fs/promises");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const body = await readFile(path, "utf8");
    assert.doesNotMatch(body, /\//, "a path in the layout file would be repository content");
  } finally {
    await p.cleanup();
  }
});

test("layout: a corrupt file degrades to defaults instead of breaking the panel", async () => {
  const p = await tempProfile();
  try {
    await mkdir(join(p.dir, "engineering-panel"), { recursive: true });
    await writeFile(join(p.dir, "engineering-panel", "layout.json"), "{not json");
    assert.deepEqual(new PanelLayoutStore({ profileDir: p.dir }).load(), DEFAULT_LAYOUT);
  } finally {
    await p.cleanup();
  }
});

test("layout: an out-of-range persisted width is clamped on load", async () => {
  const p = await tempProfile();
  try {
    await mkdir(join(p.dir, "engineering-panel"), { recursive: true });
    await writeFile(
      join(p.dir, "engineering-panel", "layout.json"),
      JSON.stringify({ widthPercent: 500, tab: "files", expanded: [] }),
    );
    assert.equal(new PanelLayoutStore({ profileDir: p.dir }).load().widthPercent, MAX_WIDTH_PERCENT);
  } finally {
    await p.cleanup();
  }
});

test("layout: an unknown tab in the file falls back to the default tab", async () => {
  const p = await tempProfile();
  try {
    await mkdir(join(p.dir, "engineering-panel"), { recursive: true });
    await writeFile(
      join(p.dir, "engineering-panel", "layout.json"),
      JSON.stringify({ widthPercent: 35, tab: "not-a-tab", expanded: [] }),
    );
    assert.equal(new PanelLayoutStore({ profileDir: p.dir }).load().tab, DEFAULT_LAYOUT.tab);
  } finally {
    await p.cleanup();
  }
});

test("layout: an unwritable profile drops the preference without throwing", () => {
  // A preference is never worth failing the panel for.
  const store = new PanelLayoutStore({ profileDir: "/proc/nonexistent-layout-dir" });
  assert.doesNotThrow(() => store.save({ widthPercent: 40, tab: "files", expanded: [] }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/unit/panel-layout.test.ts`
Expected: FAIL — `Cannot find module '../../src/panel/layout.ts'`

- [ ] **Step 3: Implement `src/panel/layout.ts`**

Mirror `src/blackhole/connectionSetup.ts`: `mkdirSync(dirname, {recursive:true})`, then
`writeFileSync(tmp, body, { mode: 0o600, flag: "wx" })` followed by `renameSync(tmp, path)`,
with the temp file unlinked in a `finally` that swallows its own error. Validate
every field on load (`widthPercent` clamped, `tab` checked against `PANEL_TABS`,
`expanded` filtered to strings); anything unexpected falls back to that field's
default rather than rejecting the whole file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/unit/panel-layout.test.ts` → PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/layout.ts test/unit/panel-layout.test.ts
git commit -m "feat(panel): persist panel layout in the agent profile"
```

---

### Task 2: Tabs

**Files:**
- Modify: `src/panel/tree.ts` (row shaping becomes tab-aware)
- Modify: `src/panel/PanelComponent.ts` (tab bar, `tab`/`shift+tab`, `<`/`>`)
- Test: `test/unit/panel-tabs.test.ts`

**Interfaces:**
- Consumes: `PanelTabId`, `PANEL_TABS`, `stepTab`, `stepWidth` from Task 1; `buildRows`, `PanelRow`, `clampSelection` from track 2.
- Produces:

```ts
// tree.ts — buildRows gains a tab argument. The existing 3-arg call sites keep
// working because `tab` defaults to "files".
export function buildRows(state: PanelSnapshot, expanded: ReadonlySet<string>, tab?: PanelTabId): PanelRow[];
/** Pure: the tab bar line, active tab marked. */
export function renderTabBar(active: PanelTabId, width: number): string;

// PanelComponent.ts
export interface PanelComponentOptions {
  // ...existing fields...
  layout?: PanelLayout;
  /** Called when the operator changes tab, width, or expansion. */
  onLayoutChange?: (layout: PanelLayout) => void;
}
export class PanelComponent {
  get tab(): PanelTabId;
  get widthPercent(): number;
  /** Expansion lives here, not in PanelState: a Set does not survive the state store's JSON deep-equal. */
  get expandedIds(): string[];
}
```

Keys: `\t` next tab, `\x1b[Z` (shift+tab) previous, `<` and `>` step width.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";
import { DEFAULT_LAYOUT } from "../../src/panel/layout.ts";
import { renderTabBar } from "../../src/panel/tree.ts";

function seeded(): PanelState {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    run: {
      workItemId: "WI-12",
      goal: "add retry to the gateway client",
      phase: "review",
      risk: "high",
      files: [{ path: "src/gateway/signals.ts", change: "added" }],
      findings: [
        { id: "E-1", severity: "high", claim: "retry loop can spin", role: "reviewer", model: "opus-5", status: "open" },
      ],
      spend: [{ model: "opus-5", input: 1000, output: 200, cost: 0.5 }],
    },
  });
  return state;
}

test("tabs: the bar names every tab and marks the active one", () => {
  const bar = renderTabBar("reviews", 80);
  for (const name of ["Files", "Reviews", "Tokens", "Session", "Memory"]) assert.match(bar, new RegExp(name, "i"));
  assert.ok(visibleWidth(bar) <= 80);
});

test("tabs: the bar is truncated, never wrapped, on a narrow panel", () => {
  assert.ok(visibleWidth(renderTabBar("files", 20)) <= 20);
});

test("tabs: tab and shift+tab cycle the active tab", () => {
  const c = new PanelComponent({ state: seeded(), requestRender: () => {} });
  c.render(80);
  assert.equal(c.tab, "files");
  c.handleInput("\t");
  assert.equal(c.tab, "reviews");
  c.handleInput("\x1b[Z");
  assert.equal(c.tab, "files");
  c.dispose();
});

test("tabs: each tab shows its own rows", () => {
  const c = new PanelComponent({ state: seeded(), requestRender: () => {} });
  const body = (tab: string) => {
    while (c.tab !== tab) c.handleInput("\t");
    return c.render(80).join("\n");
  };
  assert.match(body("files"), /signals\.ts/);
  assert.match(body("reviews"), /retry loop can spin/);
  assert.match(body("tokens"), /opus-5/);
  c.dispose();
});

test("tabs: the reviews tab names the reviewing role and the model", () => {
  // "who reviewed them, which models" is the whole point of the tab.
  const c = new PanelComponent({ state: seeded(), requestRender: () => {} });
  while (c.tab !== "reviews") c.handleInput("\t");
  const body = c.render(120).join("\n");
  assert.match(body, /reviewer/);
  assert.match(body, /opus-5/);
  c.dispose();
});

test("tabs: < and > step the width and report it", () => {
  const c = new PanelComponent({ state: seeded(), requestRender: () => {} });
  const start = c.widthPercent;
  c.handleInput(">");
  assert.ok(c.widthPercent > start);
  c.handleInput("<");
  assert.equal(c.widthPercent, start);
  c.dispose();
});

test("tabs: a layout change is announced so it can be persisted", () => {
  const seen: string[] = [];
  const c = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    onLayoutChange: (l) => seen.push(l.tab),
  });
  c.handleInput("\t");
  assert.deepEqual(seen, ["reviews"]);
  c.dispose();
});

test("tabs: the component opens on the persisted tab and width", () => {
  const c = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    layout: { ...DEFAULT_LAYOUT, tab: "tokens", widthPercent: 50 },
  });
  assert.equal(c.tab, "tokens");
  assert.equal(c.widthPercent, 50);
  c.dispose();
});

test("tabs: switching tabs never leaves the selection out of range", () => {
  const c = new PanelComponent({ state: new PanelState(), requestRender: () => {} });
  for (let i = 0; i < 12; i++) {
    c.handleInput("\t");
    c.render(80);
    assert.ok(c.selectedIndex >= -1 && c.selectedIndex < Math.max(1, c.rows.length));
  }
  c.dispose();
});

test("tabs: every tab respects the width contract at every width", () => {
  const c = new PanelComponent({ state: seeded(), requestRender: () => {} });
  for (let i = 0; i < 5; i++) {
    for (const width of [20, 36, 80, 200]) {
      for (const line of c.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    c.handleInput("\t");
  }
  c.dispose();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test test/unit/panel-tabs.test.ts` → FAIL (`renderTabBar` is not exported)

- [ ] **Step 3: Implement**

In `tree.ts`, give `buildRows` a `tab` parameter defaulting to `"files"` and
branch the section list on it: Files → the existing files sections; Reviews →
findings grouped by candidate with `severity`, `role`, `model`; Tokens → spend
rows plus a total; Session → narrative (Task 7 fills it; until then a single
"no narrative yet" row); Memory → Task 5. Add `renderTabBar`, using
`truncateToWidth`.

In `PanelComponent`, hold `tab` and `widthPercent` from `opts.layout ?? DEFAULT_LAYOUT`,
handle the four keys, call `onLayoutChange` with `{widthPercent, tab, expanded: [...this.expanded].sort()}`
on every change, and prepend `renderTabBar` to `renderTree`'s output.

**Do not move `expanded` into `PanelState`.** It is a `Set`, and `PanelState.set()`
no-ops on `JSON.stringify` deep-equality, which does not compare Sets correctly.
It stays a component field and is read out at persist time.

- [ ] **Step 4: Run to verify they pass** → PASS (10 tests). Also re-run
`npx tsx --test test/unit/panel-tree.test.ts test/unit/panel-component.test.ts` —
the default `tab` argument must keep track 2's tests green.

- [ ] **Step 5: Commit**

```bash
git add src/panel/tree.ts src/panel/PanelComponent.ts test/unit/panel-tabs.test.ts
git commit -m "feat(panel): tabbed body with remembered tab and adjustable width"
```

---

### Task 3: Vim-style search

**Files:**
- Create: `src/panel/search.ts`
- Modify: `src/panel/PanelComponent.ts`
- Test: `test/unit/panel-search.test.ts`

**Interfaces:**
- Consumes: `PanelRow` from `tree.ts`.
- Produces:

```ts
export interface SearchState { query: string; matches: number[]; index: number; }
/** Pure. Smartcase: a lowercase query is case-insensitive, any uppercase makes it exact. */
export function findMatches(rows: readonly { label: string }[], query: string): number[];
/** Pure. Wrap-around step; -1 on an empty match list. */
export function stepMatch(matches: readonly number[], current: number, direction: -1 | 1): number;
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { findMatches, stepMatch } from "../../src/panel/search.ts";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

const rows = [
  { label: "src/gateway/signals.ts" },
  { label: "src/panel/Search.ts" },
  { label: "README.md" },
  { label: "src/gateway/config.ts" },
];

test("search: a lowercase query is case-insensitive (smartcase)", () => {
  assert.deepEqual(findMatches(rows, "search"), [1]);
});

test("search: any uppercase in the query makes the match exact", () => {
  assert.deepEqual(findMatches(rows, "Search"), [1]);
  assert.deepEqual(findMatches(rows, "SEARCH"), []);
});

test("search: every matching row is returned, in order", () => {
  assert.deepEqual(findMatches(rows, "gateway"), [0, 3]);
});

test("search: an empty query matches nothing rather than everything", () => {
  assert.deepEqual(findMatches(rows, ""), []);
  assert.deepEqual(findMatches(rows, "   "), []);
});

test("search: a query with regex metacharacters is matched literally", () => {
  // A user typing "config.ts" must not have "." treated as any-character.
  assert.deepEqual(findMatches([{ label: "configXts" }, { label: "config.ts" }], "config.ts"), [1]);
});

test("search: n and N wrap around in both directions", () => {
  const matches = [0, 3];
  assert.equal(stepMatch(matches, 0, 1), 1);
  assert.equal(stepMatch(matches, 1, 1), 0, "forward wraps");
  assert.equal(stepMatch(matches, 0, -1), 1, "backward wraps");
});

test("search: stepping an empty match list yields -1, never a crash", () => {
  assert.equal(stepMatch([], 0, 1), -1);
});

test("search: / opens a prompt, typing filters, and enter jumps to the first match", () => {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: {
      files: [
        { path: "src/alpha.ts", change: "modified" },
        { path: "src/beta.ts", change: "modified" },
      ],
    },
  });
  const c = new PanelComponent({ state, requestRender: () => {} });
  c.render(80);
  c.handleInput("/");
  for (const ch of "beta") c.handleInput(ch);
  assert.match(c.render(80).join("\n"), /\/beta/, "the query is shown while typing");
  c.handleInput("\r");
  assert.match(c.rows[c.selectedIndex]?.label ?? "", /beta/);
  c.dispose();
});

test("search: escape cancels the search and restores the prior selection", () => {
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: {
      files: [
        { path: "src/alpha.ts", change: "modified" },
        { path: "src/beta.ts", change: "modified" },
      ],
    },
  });
  const c = new PanelComponent({ state, requestRender: () => {} });
  c.render(80);
  const before = c.selectedIndex;
  c.handleInput("/");
  for (const ch of "beta") c.handleInput(ch);
  c.handleInput("\x1b");
  assert.equal(c.selectedIndex, before, "a cancelled search must not move the cursor");
  assert.doesNotMatch(c.render(80).join("\n"), /\/beta/);
  c.dispose();
});

test("search: escape during a search closes the search, not the panel", () => {
  let closed = 0;
  const c = new PanelComponent({ state: new PanelState(), requestRender: () => {}, onClose: () => closed++ });
  c.render(80);
  c.handleInput("/");
  c.handleInput("\x1b");
  assert.equal(closed, 0, "the first escape belongs to the search");
  c.handleInput("\x1b");
  assert.equal(closed, 1, "the second closes the panel");
  c.dispose();
});

test("search: backspace edits the query", () => {
  const c = new PanelComponent({ state: new PanelState(), requestRender: () => {} });
  c.handleInput("/");
  for (const ch of "abc") c.handleInput(ch);
  c.handleInput("\x7f");
  assert.match(c.render(80).join("\n"), /\/ab$/m);
  c.dispose();
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (no `search.ts`)

- [ ] **Step 3: Implement**

`findMatches`: return `[]` for a blank query; smartcase by testing `/[A-Z]/` on
the query; use `String.prototype.includes` on the (optionally lowercased) label —
**not** a `RegExp`, which is what makes the metacharacter test pass for free.

In `PanelComponent`, add a `search: SearchState | null` field. While non-null,
`handleInput` routes to the search: printable characters append, `\x7f` deletes,
`\r` commits and jumps to the first match, `\x1b` cancels and restores the
selection saved when `/` was pressed, `n`/`N` step. `renderTree` shows `/<query>`
as its last line while searching. Escape precedence: content view → search →
close panel.

- [ ] **Step 4: Run to verify they pass** → PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/search.ts src/panel/PanelComponent.ts test/unit/panel-search.test.ts
git commit -m "feat(panel): vim-style search over the visible rows"
```

---

### Task 4: Copy

**Files:**
- Create: `src/panel/clipboard.ts`
- Modify: `src/panel/PanelComponent.ts`
- Test: `test/unit/panel-clipboard.test.ts`

**Interfaces:**

```ts
export interface CopyResult { copied: boolean; message: string; }
export interface CopySink { isTTY: boolean; write(data: string): void; }
/**
 * Emit OSC 52. Reports the ACTION, never success: the sequence is write-only
 * and a terminal may discard it silently (see the plan header).
 */
export function copyToTerminal(text: string, sink?: CopySink): CopyResult;
export function osc52(text: string): string;
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { copyToTerminal, osc52 } from "../../src/panel/clipboard.ts";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

function sink() {
  const written: string[] = [];
  return { isTTY: true, write: (d: string) => written.push(d), written };
}

test("clipboard: the OSC 52 sequence carries base64 of the text", () => {
  assert.equal(osc52("hello"), `\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
});

test("clipboard: non-ASCII survives the encoding as UTF-8", () => {
  const seq = osc52("naïve ⚡");
  const b64 = seq.slice(seq.indexOf(";c;") + 3, -1);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "naïve ⚡");
});

test("clipboard: a copy writes the sequence and reports the action, not success", () => {
  const s = sink();
  const result = copyToTerminal("hello", s);
  assert.equal(s.written.length, 1);
  assert.equal(result.copied, true);
  // OSC 52 is write-only: claiming "copied!" would be a claim we cannot make.
  assert.doesNotMatch(result.message, /copied to (the )?(system )?clipboard/i);
  assert.match(result.message, /sent/i);
});

test("clipboard: a non-TTY is a real failure and is reported as one", () => {
  const result = copyToTerminal("hello", { isTTY: false, write: () => {} });
  assert.equal(result.copied, false);
  assert.match(result.message, /not a terminal/i);
});

test("clipboard: a throwing write is reported, never propagated", () => {
  const result = copyToTerminal("hello", {
    isTTY: true,
    write: () => {
      throw new Error("EPIPE");
    },
  });
  assert.equal(result.copied, false);
  assert.match(result.message, /EPIPE/);
});

test("clipboard: y copies the selected row and Y copies the visible body", () => {
  const state = new PanelState();
  state.set({ updatedAt: 1, workspace: { files: [{ path: "src/alpha.ts", change: "modified" }] } });
  const copied: string[] = [];
  const c = new PanelComponent({
    state,
    requestRender: () => {},
    copy: (text) => {
      copied.push(text);
      return { copied: true, message: "sent to terminal clipboard" };
    },
  });
  c.render(80);
  while (c.rows[c.selectedIndex]?.payload.kind !== "file") c.handleInput("\x1b[B");
  c.handleInput("y");
  assert.match(copied[0] ?? "", /alpha\.ts/);
  assert.equal(copied[0]?.includes("\n"), false, "y copies one row");
  c.handleInput("Y");
  assert.ok((copied[1] ?? "").includes("\n"), "Y copies the body");
  c.dispose();
});

test("clipboard: the copy result is shown to the operator", () => {
  const state = new PanelState();
  state.set({ updatedAt: 1, workspace: { files: [{ path: "src/alpha.ts", change: "modified" }] } });
  const c = new PanelComponent({
    state,
    requestRender: () => {},
    copy: () => ({ copied: false, message: "not a terminal" }),
  });
  c.render(80);
  c.handleInput("y");
  assert.match(c.render(80).join("\n"), /not a terminal/);
  c.dispose();
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (no `clipboard.ts`)

- [ ] **Step 3: Implement**

`copyToTerminal` defaults its sink to `{ isTTY: process.stdout.isTTY === true, write: (d) => process.stdout.write(d) }`.
Return `{copied:false}` for a non-TTY, wrap the write in try/catch, and phrase the
success message as *"sent to terminal clipboard"*.

In `PanelComponent`, add `copy?: (text: string) => CopyResult` to the options
(defaulting to `copyToTerminal`), handle `y`/`Y`, and hold the returned message in
a `notice: string | null` field rendered as the last body line until the next
keystroke.

- [ ] **Step 4: Run to verify they pass** → PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/clipboard.ts src/panel/PanelComponent.ts test/unit/panel-clipboard.test.ts
git commit -m "feat(panel): copy a row or the body over OSC 52"
```

---

### Task 5: Memory tab

**Files:**
- Create: `src/panel/feeders/MemoryFeeder.ts`
- Modify: `src/panel/PanelState.ts` (add `memory` to the snapshot), `src/panel/tree.ts` (Memory rows)
- Test: `test/unit/panel-memory-feeder.test.ts`

**Interfaces:**
- Consumes: `blackholeTelemetry(state)` from `src/blackhole/telemetry.ts`, which returns
  `{ enabled, version, provider, durableKind, sessions, activeSessions, entries, compactions, promotionCandidates, promoted, memoryWorkers: { observer, reflector, dropper } }`
  — verified against `src/blackhole/telemetry.ts:21`. Reached as `rt.blackhole?.state()`, which is
  `BlackholeManager | null` on the runtime (`src/runtime/EngineeringRuntime.ts:259`).
- Produces:

```ts
export interface PanelMemoryView {
  enabled: boolean;
  entries: number;
  promotionCandidates: number;
  promoted: number;
  compactions: number;
  workers: { observer: number; reflector: number; dropper: number };
}
export interface MemoryFeederOptions {
  state: PanelState;
  /** Null when Blackhole is not configured — the common case, it is off by default. */
  blackhole: { state(): BlackholeManagerState } | null;
}
export class MemoryFeeder {
  constructor(opts: MemoryFeederOptions);
  refresh(): void;   // never throws
  dispose(): void;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryFeeder } from "../../src/panel/feeders/MemoryFeeder.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

function managerState(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    version: "1",
    provider: "openviking",
    durableKind: "file",
    sessions: 2,
    activeSessions: 1,
    entries: 14,
    compactions: 3,
    promotionCandidates: 5,
    promoted: 2,
    memoryWorkersRun: { observer: 4, reflector: 1, dropper: 0 },
    ...over,
  } as never;
}

test("memory: counts reach panel state from blackhole telemetry", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: { state: () => managerState() } }).refresh();
  assert.equal(state.snapshot.memory?.enabled, true);
  assert.equal(state.snapshot.memory?.entries, 14);
  assert.equal(state.snapshot.memory?.promotionCandidates, 5);
  assert.equal(state.snapshot.memory?.promoted, 2);
  assert.equal(state.snapshot.memory?.workers.observer, 4);
});

test("memory: no blackhole reports disabled rather than zeros that look broken", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: null }).refresh();
  assert.equal(state.snapshot.memory?.enabled, false);
});

test("memory: a disabled manager is reported as disabled", () => {
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: { state: () => managerState({ enabled: false }) } }).refresh();
  assert.equal(state.snapshot.memory?.enabled, false);
});

test("memory: a throwing manager degrades instead of breaking the panel", () => {
  const state = new PanelState();
  const feeder = new MemoryFeeder({
    state,
    blackhole: {
      state: () => {
        throw new Error("blackhole exploded");
      },
    },
  });
  assert.doesNotThrow(() => feeder.refresh());
  assert.equal(state.snapshot.errors?.memory !== undefined, true, "the section is marked, not silently empty");
});

test("memory: the tab says Blackhole is off rather than showing zeros", () => {
  const { buildRows } = await import("../../src/panel/tree.ts");
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: null }).refresh();
  const text = buildRows(state.snapshot, new Set(["memory"]), "memory")
    .map((r) => r.label)
    .join("\n");
  assert.match(text, /off|disabled/i);
  assert.doesNotMatch(text, /\b0\b/, "zeros read as a failure, not as 'not running'");
});

test("memory: the tab reports this session's counts when enabled", () => {
  const { buildRows } = await import("../../src/panel/tree.ts");
  const state = new PanelState();
  new MemoryFeeder({ state, blackhole: { state: () => managerState() } }).refresh();
  const text = buildRows(state.snapshot, new Set(["memory"]), "memory")
    .map((r) => r.label)
    .join("\n");
  assert.match(text, /14/);
  assert.match(text, /promoted/i);
});
```

(Note: the two tests using `await import` must be declared `async`.)

- [ ] **Step 2: Run to verify it fails** → FAIL (no `MemoryFeeder.ts`)

- [ ] **Step 3: Implement**

`refresh()` wraps everything in try/catch, calling `noteError("memory", msg)` on
failure and `clearError("memory")` on success (both already exist on `PanelState`
from track 2). A null or disabled manager publishes `{enabled:false}` with zeroed
counters; `tree.ts` renders "Blackhole memory is off" for that case and never
prints the zeros.

- [ ] **Step 4: Run to verify they pass** → PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/feeders/MemoryFeeder.ts src/panel/PanelState.ts src/panel/tree.ts test/unit/panel-memory-feeder.test.ts
git commit -m "feat(panel): memory tab reporting this session's blackhole counts"
```

---

### Task 6: Narrative deltas (pure)

The narrator is split so that everything worth testing needs no model.

**Files:**
- Create: `src/panel/narrator/deltas.ts`
- Test: `test/unit/panel-narrator-deltas.test.ts`

**Interfaces:**

```ts
/** What the narrator is told about. Deltas, never transcripts. */
export interface NarrativeDelta { kind: "work-item" | "phase" | "files" | "commit"; text: string; }
export interface NarrativeInput { workItemId?: string; goal?: string; phase?: string; files: string[]; }
/** Pure: previous input + current input -> what changed. Empty means "do not ask a model". */
export function computeDeltas(previous: NarrativeInput | undefined, current: NarrativeInput): NarrativeDelta[];
/** Pure: deltas + the previous narrative -> the prompt. */
export function buildNarrativePrompt(deltas: readonly NarrativeDelta[], previous: string | undefined): string;
/** Pure: trim and bound a model's answer. Returns undefined for unusable output. */
export function sanitizeNarrative(raw: string, maxChars?: number): string | undefined;
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNarrativePrompt, computeDeltas, sanitizeNarrative } from "../../src/panel/narrator/deltas.ts";

test("deltas: a first observation is entirely new", () => {
  const d = computeDeltas(undefined, { workItemId: "WI-1", goal: "add a status bar", phase: "scout", files: [] });
  assert.ok(d.length > 0);
  assert.ok(d.some((x) => x.kind === "work-item"));
});

test("deltas: an unchanged observation produces nothing to say", () => {
  const input = { workItemId: "WI-1", goal: "add a status bar", phase: "scout", files: ["a.ts"] };
  assert.deepEqual(computeDeltas(input, { ...input, files: ["a.ts"] }), []);
});

test("deltas: a phase transition is a delta", () => {
  const before = { workItemId: "WI-1", goal: "g", phase: "scout", files: [] };
  const d = computeDeltas(before, { ...before, phase: "implement" });
  assert.equal(d.length, 1);
  assert.equal(d[0]?.kind, "phase");
  assert.match(d[0]?.text ?? "", /implement/);
});

test("deltas: only newly changed files are reported, not the whole set", () => {
  const before = { workItemId: "WI-1", goal: "g", phase: "implement", files: ["a.ts", "b.ts"] };
  const d = computeDeltas(before, { ...before, files: ["a.ts", "b.ts", "c.ts"] });
  const text = d.map((x) => x.text).join(" ");
  assert.match(text, /c\.ts/);
  assert.doesNotMatch(text, /b\.ts/, "a file already reported is not news");
});

test("deltas: the prompt carries the deltas and the previous narrative", () => {
  const prompt = buildNarrativePrompt(
    [{ kind: "phase", text: "moved to implement" }],
    "started on a status bar update",
  );
  assert.match(prompt, /moved to implement/);
  assert.match(prompt, /started on a status bar update/);
});

test("deltas: the prompt never carries file contents or a transcript", () => {
  // The narrator is fed deltas, not transcripts — this is the cost control.
  const prompt = buildNarrativePrompt([{ kind: "files", text: "changed src/a.ts" }], undefined);
  assert.ok(prompt.length < 2000, `prompt too large: ${prompt.length}`);
});

test("sanitize: whitespace is trimmed and the result bounded", () => {
  assert.equal(sanitizeNarrative("  we did a thing.  "), "we did a thing.");
  assert.equal((sanitizeNarrative("x".repeat(5000)) ?? "").length <= 400, true);
});

test("sanitize: empty or whitespace-only output is unusable", () => {
  assert.equal(sanitizeNarrative(""), undefined);
  assert.equal(sanitizeNarrative("   \n  "), undefined);
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (no `deltas.ts`)
- [ ] **Step 3: Implement** — plain comparisons; `sanitizeNarrative` defaults `maxChars` to 400.
- [ ] **Step 4: Run to verify they pass** → PASS (8 tests)
- [ ] **Step 5: Commit**

```bash
git add src/panel/narrator/deltas.ts test/unit/panel-narrator-deltas.test.ts
git commit -m "feat(panel): pure narrative delta computation"
```

---

### Task 7: The narrator and the extension wiring

**Files:**
- Create: `src/panel/narrator/Narrator.ts`
- Modify: `src/panel/PanelState.ts` (add `narrative`), `src/panel/tree.ts` (Session rows), `extensions/index.ts`
- Test: `test/unit/panel-narrator.test.ts`

**Interfaces:**

```ts
export interface NarrativeView {
  text: string;
  /** Epoch ms of the last successful update. The tab shows this rather than implying freshness. */
  updatedAt: number;
  /** Always true. The Session tab labels it, and nothing downstream may read it as evidence. */
  generated: true;
}
export interface NarratorOptions {
  state: PanelState;
  /** The injected model seam. Tests pass a fake; nothing here knows about a provider. */
  summarize: (prompt: string) => Promise<string>;
  /** Consulted BEFORE the gate: a narrative is never worth waiting out a cooldown. */
  cooldownRemainingMs: () => number;
  /** Explicit admission slot — the gate is not automatic (see the spec's implementer note). */
  acquire: () => Promise<{ release(): void }>;
  /** Minimum gap between model calls. Default 120_000. */
  minIntervalMs?: number;
  now?: () => number;
  enabled?: boolean;
}
export class Narrator {
  constructor(opts: NarratorOptions);
  /** Observe current state. Returns true only when a model call was actually made. */
  observe(input: NarrativeInput): Promise<boolean>;
  dispose(): void;
}
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Narrator } from "../../src/panel/narrator/Narrator.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let released = 0;
  const state = new PanelState();
  const narrator = new Narrator({
    state,
    summarize: async (p: string) => {
      calls.push(p);
      return "started on the status bar, now on the panel";
    },
    cooldownRemainingMs: () => 0,
    acquire: async () => ({ release: () => released++ }),
    minIntervalMs: 0,
    now: () => 1_000,
    ...over,
  } as never);
  return { narrator, state, calls, released: () => released };
}

const input = { workItemId: "WI-1", goal: "add a status bar", phase: "scout", files: [] };

test("narrator: a first observation produces a labeled narrative", async () => {
  const h = harness();
  assert.equal(await h.narrator.observe(input), true);
  assert.match(h.state.snapshot.narrative?.text ?? "", /status bar/);
  assert.equal(h.state.snapshot.narrative?.generated, true);
  assert.equal(h.state.snapshot.narrative?.updatedAt, 1_000);
  h.narrator.dispose();
});

test("narrator: nothing new means no model call", async () => {
  const h = harness();
  await h.narrator.observe(input);
  assert.equal(await h.narrator.observe(input), false);
  assert.equal(h.calls.length, 1);
  h.narrator.dispose();
});

test("narrator: it is skipped entirely while a gateway cooldown is active", async () => {
  // The gate is checked BEFORE acquire(): acquire() waits the cooldown out, and
  // the wait is unbounded, so acquiring first would park for minutes and then
  // fire a stale summary.
  let acquired = 0;
  const h = harness({
    cooldownRemainingMs: () => 30_000,
    acquire: async () => {
      acquired++;
      return { release: () => {} };
    },
  });
  assert.equal(await h.narrator.observe(input), false);
  assert.equal(h.calls.length, 0);
  assert.equal(acquired, 0, "a narrative is never worth waiting out a cooldown");
  h.narrator.dispose();
});

test("narrator: every model call takes and releases an admission slot", async () => {
  const h = harness();
  await h.narrator.observe(input);
  assert.equal(h.released(), 1);
  h.narrator.dispose();
});

test("narrator: the slot is released even when the model throws", async () => {
  const h = harness({
    summarize: async () => {
      throw new Error("model exploded");
    },
  });
  assert.equal(await h.narrator.observe(input), false);
  assert.equal(h.released(), 1, "a leaked slot would starve the runtime");
  h.narrator.dispose();
});

test("narrator: a failed update leaves the previous narrative and its timestamp intact", async () => {
  let fail = false;
  let now = 1_000;
  const h = harness({
    summarize: async () => {
      if (fail) throw new Error("gateway refused");
      return "first narrative";
    },
    now: () => now,
  });
  await h.narrator.observe(input);
  fail = true;
  now = 99_000;
  await h.narrator.observe({ ...input, phase: "implement" });
  assert.match(h.state.snapshot.narrative?.text ?? "", /first narrative/);
  assert.equal(h.state.snapshot.narrative?.updatedAt, 1_000, "a stale narrative must not claim to be fresh");
  h.narrator.dispose();
});

test("narrator: updates are debounced by the configured interval", async () => {
  let now = 1_000;
  const h = harness({ minIntervalMs: 60_000, now: () => now });
  await h.narrator.observe(input);
  now = 5_000;
  assert.equal(await h.narrator.observe({ ...input, phase: "implement" }), false, "too soon");
  now = 120_000;
  assert.equal(await h.narrator.observe({ ...input, phase: "review" }), true);
  h.narrator.dispose();
});

test("narrator: disabled means it never calls a model", async () => {
  const h = harness({ enabled: false });
  assert.equal(await h.narrator.observe(input), false);
  assert.equal(h.calls.length, 0);
  h.narrator.dispose();
});

test("narrator: unusable model output leaves the previous narrative alone", async () => {
  const h = harness({ summarize: async () => "   " });
  assert.equal(await h.narrator.observe(input), false);
  assert.equal(h.state.snapshot.narrative, undefined);
  h.narrator.dispose();
});

test("narrator: the narrative never reaches the ledger", async () => {
  // INV-006: generated text is not evidence. The Narrator's only sink is
  // PanelState — it is constructed without a ledger and has no way to reach one.
  const h = harness();
  await h.narrator.observe(input);
  assert.equal("ledger" in (h.narrator as unknown as Record<string, unknown>), false);
  h.narrator.dispose();
});
```

- [ ] **Step 2: Run to verify it fails** → FAIL (no `Narrator.ts`)

- [ ] **Step 3: Implement the narrator**

Order inside `observe`, and it matters:

1. `if (!enabled) return false`
2. `computeDeltas(previous, input)`; `if (deltas.length === 0) return false`
3. `if (now() - lastCallAt < minIntervalMs) return false`
4. `if (cooldownRemainingMs() > 0) return false` — **before** `acquire()`
5. `const slot = await acquire()`; `try { ... } finally { slot.release() }`
6. `sanitizeNarrative(await summarize(prompt))`; publish only on a usable result
7. record `previous = input` and `lastCallAt = now()` **only on success**, so a
   failed call retries on the next meaningful change rather than swallowing it

- [ ] **Step 4: Render the Session tab**

In `tree.ts`, the Session tab shows the narrative text, a `generated` label, and
`updated <n>m ago` — or "no narrative yet" when absent.

- [ ] **Step 5: Wire it in `extensions/index.ts`**

- Load `PanelLayoutStore` at `session_start`; pass `layout` into `PanelComponent`
  and persist from `onLayoutChange`.
- Construct `MemoryFeeder` alongside the other feeders in `panelFor()`, refreshing
  it from the panel's existing `onOpen`.
- Construct the `Narrator` with `cooldownRemainingMs: () => admission.cooldownRemainingMs()`
  and `acquire: () => admission.acquire()`, and a `summarize` built on
  `ModelRuntime.streamSimple` (the same runtime `PiWorkerExecutor` creates at
  `src/workers/PiWorkerExecutor.ts:114`).
- **Start the narrator only after the panel has been opened at least once.** A
  session that never opens `/panel` must not pay for summaries nobody reads.
- Gate the whole narrator on `PI_PANEL_NARRATOR` (default off — it spends money;
  the operator opts in).

- [ ] **Step 6: Run the full verification**

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(panel): admission-gated session narrative and track 3 wiring"
```

---

## Acceptance check (from the spec)

Track 3 is complete when:

- [ ] tabs cycle, and the active tab, width, and expansion survive a restart
      (Task 1's round-trip test goes through the file, not just the API)
- [ ] `/`, `n`, `N` search the visible rows
- [ ] `y` copies a row
- [ ] the Memory tab reports this session's counts, and says Blackhole is off
      when it is
- [ ] the Session tab shows a narrative that is debounced, skipped during a
      gateway cooldown, labeled as generated, absent from the ledger, and left
      intact with its timestamp when an update fails
