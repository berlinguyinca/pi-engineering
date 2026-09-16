import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PanelComponent } from "../../src/panel/PanelComponent.ts";
import { PanelState } from "../../src/panel/PanelState.ts";

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
  // One line per row, plus the tab bar track 3 prepends. The invariant is that
  // a long path costs exactly one line, never two.
  assert.equal(lines.length, component.rows.length + 1, "one line per row: no wrapping");
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
  assert.ok(component.selectedIndex >= 0);
  for (let i = 0; i < 50; i++) component.handleInput("\x1b[A");
  assert.ok(component.selectedIndex >= 0);
  component.dispose();
});

test("component: left collapses a section and right expands it again", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.render(80);
  // Move to the "Changed files" section header.
  while (!(component.rows[component.selectedIndex]?.payload as { id?: string })?.id?.includes("files")) {
    component.handleInput("\x1b[B");
  }
  const expandedCount = component.rows.length;
  component.handleInput("\x1b[D"); // left: collapse
  component.render(80);
  assert.ok(component.rows.length < expandedCount, "collapsing must hide children");
  component.handleInput("\x1b[C"); // right: expand
  component.render(80);
  assert.equal(component.rows.length, expandedCount);
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

test("component: a truncated content view says so", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.showContent({ title: "big.log", lines: ["one"], truncated: true });
  assert.match(component.render(80).join("\n"), /truncated/i);
  component.dispose();
});

test("component: a content error is shown rather than an empty body", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.showContent({ title: "gone.ts", lines: [], truncated: false, error: "ENOENT" });
  assert.match(component.render(80).join("\n"), /ENOENT/);
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

test("component: an empty state renders its message without a cursor", () => {
  const component = new PanelComponent({ state: new PanelState(), requestRender: () => {} });
  const lines = component.render(60);
  assert.ok(lines.length > 0);
  assert.equal(component.selectedIndex, -1);
  for (const line of lines) assert.ok(visibleWidth(line) <= 60);
  component.dispose();
});

test("component: unknown input is ignored", () => {
  const component = new PanelComponent({ state: seeded(), requestRender: () => {} });
  component.render(80);
  const before = component.selectedIndex;
  component.handleInput("zzz");
  assert.equal(component.selectedIndex, before);
  component.dispose();
});

test("component: the panel fills the height it is given", () => {
  // An overlay is exactly as tall as the lines its component returns, so
  // without padding a panel with two rows of content renders as two rows
  // floating in a corner rather than a column beside the transcript.
  const state = new PanelState();
  state.set({ updatedAt: 1, workspace: { branch: "main", files: [{ path: "a.ts", change: "modified" }] } });
  const c = new PanelComponent({ state, requestRender: () => {}, fillHeight: () => 40 });

  const lines = c.render(50);
  assert.equal(lines.length, 40, "the panel must occupy its whole column");
  assert.ok(
    lines.every((l) => l.length === 0 || visibleWidth(l) <= 50),
    "padding must not overflow the width",
  );
  c.dispose();
});

test("component: content longer than the column is clipped, not overflowed", () => {
  // Otherwise the overlay runs past the bottom of the screen.
  const state = new PanelState();
  state.set({
    updatedAt: 1,
    workspace: {
      branch: "main",
      files: Array.from({ length: 60 }, (_, i) => ({ path: `file-${i}.ts`, change: "modified" as const })),
    },
  });
  const c = new PanelComponent({ state, requestRender: () => {}, fillHeight: () => 12 });

  assert.equal(c.render(50).length, 12);
  c.dispose();
});

test("component: without a height hint the panel renders only its content", () => {
  // The hint is unavailable until the overlay has rendered once, and a panel
  // that guessed a height before knowing one would flicker.
  const state = new PanelState();
  state.set({ updatedAt: 1, workspace: { branch: "main", files: [{ path: "a.ts", change: "modified" }] } });
  const c = new PanelComponent({ state, requestRender: () => {} });

  const lines = c.render(50);
  assert.ok(lines.length > 0 && lines.length < 20, `expected content-sized output, got ${lines.length}`);
  c.dispose();
});
