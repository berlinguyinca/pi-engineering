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

test("panel state: clearing an absent error is a no-op, not a notification", () => {
  const state = new PanelState();
  let calls = 0;
  state.subscribe(() => calls++);
  state.clearError("run");
  assert.equal(calls, 0);
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
