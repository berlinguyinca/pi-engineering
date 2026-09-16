import assert from "node:assert/strict";
import { test } from "node:test";
import { PanelState } from "../../src/panel/PanelState.ts";
import { Narrator, type NarratorOptions } from "../../src/panel/narrator/Narrator.ts";

function harness(over: Partial<NarratorOptions> = {}) {
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
  });
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
  // that wait is unbounded, so acquiring first would park for minutes and then
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

test("narrator: a failed update is retried on the next change, not swallowed", async () => {
  let fail = true;
  let now = 1_000;
  const h = harness({
    summarize: async () => {
      if (fail) throw new Error("transient");
      return "recovered narrative";
    },
    now: () => now,
  });
  await h.narrator.observe(input);
  fail = false;
  now = 2_000;
  // The SAME observation: a failed call must not have recorded it as seen.
  assert.equal(await h.narrator.observe(input), true);
  assert.match(h.state.snapshot.narrative?.text ?? "", /recovered/);
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

test("narrator: a disposed narrator makes no further calls", async () => {
  const h = harness();
  h.narrator.dispose();
  assert.equal(await h.narrator.observe(input), false);
  assert.equal(h.calls.length, 0);
});

test("narrator: concurrent observations do not double-spend a model call", async () => {
  let resolveCall: ((v: string) => void) | undefined;
  let started = 0;
  const h = harness({
    summarize: () => {
      started++;
      return new Promise<string>((resolve) => {
        resolveCall = resolve;
      });
    },
  });
  const first = h.narrator.observe(input);
  const second = h.narrator.observe({ ...input, phase: "implement" });
  // observe() awaits acquire() before it calls summarize, so resolveCall is not
  // assigned until the microtask queue has drained.
  await new Promise((resolve) => setImmediate(resolve));
  resolveCall?.("a narrative");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(started, 1, "a second observation must not start a parallel summary");
  assert.equal(a !== b, true, "exactly one of them did the work");
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

test("session tab: the narrative is labeled as generated and stamped", async () => {
  const { buildRows } = await import("../../src/panel/tree.ts");
  const state = new PanelState();
  state.set({ narrative: { text: "started on the status bar, now on the panel", updatedAt: 1_000, generated: true } });
  const text = buildRows(state.snapshot, new Set(), "session", 1_000 + 5 * 60_000)
    .map((r) => r.label)
    .join("\n");
  assert.match(text, /started on the status bar/);
  assert.match(text, /generated/i, "generated text must be labeled as such");
  assert.match(text, /5m ago/, "the tab reports when it was last current, not that it is");
});

test("session tab: no narrative says so rather than rendering blank", async () => {
  const { buildRows } = await import("../../src/panel/tree.ts");
  const text = buildRows(new PanelState().snapshot, new Set(), "session", 0)
    .map((r) => r.label)
    .join("\n");
  assert.match(text, /no session narrative/i);
});

test("narrator: publishing its own narrative does not feed itself a new call", async () => {
  // The extension subscribes the narrator to panel state, and the narrator
  // writes narrative INTO that state — so its own publish re-enters observe().
  // Deltas are computed from run/file state only, so there is nothing new.
  let started = 0;
  const state = new PanelState();
  const narrator = new Narrator({
    state,
    summarize: async () => {
      started++;
      return "a narrative";
    },
    cooldownRemainingMs: () => 0,
    acquire: async () => ({ release: () => {} }),
    minIntervalMs: 0,
    now: () => 1_000,
  });
  const input = { workItemId: "WI-1", goal: "g", phase: "scout", files: [] };
  state.subscribe(() => void narrator.observe(input));
  await narrator.observe(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1, "a self-triggered observation must find nothing new");
  narrator.dispose();
});

test("narrator: a failed call is still paced, so a broken gateway is not hammered", async () => {
  // `lastCallAt` used to advance only on success, which meant a FAILING
  // narrator had no debounce at all: every panel state change started another
  // call. Against a saturated gateway — the one condition that makes these
  // calls fail — that is a busy-retry adding load to the thing already
  // failing, and the panel refresh loop drives state changes every few
  // seconds. Found by a live dogfood run refused with `queue_timeout`.
  let now = 0;
  let calls = 0;
  const narrator = new Narrator({
    state: new PanelState(),
    summarize: async () => {
      calls++;
      throw new Error("429 queue_timeout");
    },
    cooldownRemainingMs: () => 0,
    acquire: async () => ({ release: () => {} }),
    minIntervalMs: 60_000,
    now: () => now,
  });

  assert.equal(await narrator.observe({ workItemId: "w", phase: "a", files: ["x.ts"] }), false);
  assert.equal(calls, 1);

  now += 1_000;
  assert.equal(await narrator.observe({ workItemId: "w", phase: "b", files: ["x.ts", "y.ts"] }), false);
  assert.equal(calls, 1, "a second change one second later must not start a second call");

  now += 60_000;
  assert.equal(await narrator.observe({ workItemId: "w", phase: "c", files: ["x.ts", "z.ts"] }), false);
  assert.equal(calls, 2, "but the interval still lets it try again");
});

test("narrator: a failed call does not swallow the change it failed to describe", async () => {
  // The original intent behind recording only on success, which the pacing fix
  // had to preserve: `previous` must NOT advance on failure, or the deltas that
  // call failed to describe are lost and never retried.
  let now = 0;
  const prompts: string[] = [];
  let fail = true;
  const narrator = new Narrator({
    state: new PanelState(),
    summarize: async (prompt) => {
      prompts.push(prompt);
      if (fail) throw new Error("429 queue_timeout");
      return "a narrative";
    },
    cooldownRemainingMs: () => 0,
    acquire: async () => ({ release: () => {} }),
    minIntervalMs: 0,
    now: () => now,
  });

  await narrator.observe({ workItemId: "w", phase: "implementing", files: ["a.ts"] });
  fail = false;
  now += 1;
  assert.equal(await narrator.observe({ workItemId: "w", phase: "implementing", files: ["a.ts"] }), true);
  assert.ok(prompts[1]?.includes("a.ts"), "the retry still carries the file the failed call was about");
});
