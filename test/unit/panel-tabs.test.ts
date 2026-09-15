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
        {
          id: "E-1",
          severity: "high",
          claim: "retry loop can spin",
          role: "reviewer",
          model: "opus-5",
          status: "open",
        },
      ],
      spend: [{ model: "opus-5", input: 1000, output: 200, cost: 0.5 }],
    },
  });
  return state;
}

test("tabs: the bar names every tab and marks the active one", () => {
  const bar = renderTabBar("reviews", 80);
  for (const name of ["Files", "Reviews", "Tokens", "Session", "Memory"]) {
    assert.match(bar, new RegExp(name, "i"));
  }
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
    return c.render(120).join("\n");
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

test("tabs: expansion is reported in the layout so it can survive a restart", () => {
  let last: string[] = [];
  const c = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    onLayoutChange: (l) => {
      last = l.expanded;
    },
  });
  c.render(80);
  // Collapse the files section; the layout must reflect it.
  while ((c.rows[c.selectedIndex]?.payload as { id?: string })?.id !== "files") c.handleInput("\x1b[B");
  c.handleInput("\x1b[D");
  assert.equal(last.includes("files"), false, "a collapsed section must not persist as expanded");
  c.handleInput("\x1b[C");
  assert.equal(last.includes("files"), true);
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

test("tabs: a persisted expansion set is honoured on open", () => {
  const c = new PanelComponent({
    state: seeded(),
    requestRender: () => {},
    layout: { ...DEFAULT_LAYOUT, tab: "files", widthPercent: 35, expanded: [] },
  });
  const labels = c.render(120).join("\n");
  assert.doesNotMatch(labels, /signals\.ts/, "nothing was persisted as expanded, so nothing is");
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
      for (const line of c.render(width)) assert.ok(visibleWidth(line) <= width, `too wide at ${width}: ${line}`);
    }
    c.handleInput("\t");
  }
  c.dispose();
});
