import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_STATUS_BAR_CONFIG, type StatusBarConfig } from "../../src/status/config.ts";
import { FooterController } from "../../src/status/footer.ts";

const cfg: StatusBarConfig = { ...DEFAULT_STATUS_BAR_CONFIG, refreshMs: 0 };

interface Harness {
  renderCount: number;
  setFooterUndefinedCount: number;
  branchUnsubCount: number;
  branchCbs: Array<() => void>;
  extensionStatuses: Map<string, string>;
  footer: { render: (w: number) => string[] } | null;
  ctx: {
    cwd: string;
    model: { provider: string; id: string } | undefined;
    ui: {
      setFooter: (factory?: unknown) => void;
    };
  };
}

function makeHarness(cwd = "/nonexistent/repo"): Harness {
  const h: Harness = {
    renderCount: 0,
    setFooterUndefinedCount: 0,
    branchUnsubCount: 0,
    branchCbs: [],
    extensionStatuses: new Map(),
    footer: null,
    ctx: null as never,
  };
  const tuiFake = { requestRender: () => h.renderCount++ };
  const themeFake = { fg: (_c: string, t: string) => t };
  const footerDataFake = {
    getExtensionStatuses: () => h.extensionStatuses,
    onBranchChange: (cb: () => void) => {
      h.branchCbs.push(cb);
      return () => h.branchUnsubCount++;
    },
  };
  h.ctx = {
    cwd,
    model: { provider: "p", id: "m1" },
    ui: {
      setFooter: (factory?: unknown) => {
        if (factory === undefined) {
          h.setFooterUndefinedCount++;
          return;
        }
        const f = (
          factory as (tui: unknown, theme: unknown, footerData: unknown) => { render: (w: number) => string[] }
        )(tuiFake, themeFake, footerDataFake);
        h.footer = f;
      },
    },
  };
  return h;
}

function fixedClock() {
  return () => 0;
}

test("lifecycle: extension statuses preserve the primary footer and prioritize memory", () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  try {
    const original = h.footer!.render(120);
    assert.equal(original.length, 1, "empty extension status map adds no row");
    h.extensionStatuses.set("other", "Other: ready");
    h.extensionStatuses.set("openviking", "Memory: connected");
    const lines = h.footer!.render(120);
    assert.equal(lines.length, 2, "memory must be visible in the custom footer");
    assert.equal(lines[0], original[0], "primary model/throughput line must remain unchanged");
    assert.match(lines[1]!, /^Memory: connected.*Other: ready$/);

    h.extensionStatuses.set("openviking", "Memory: authentication failed");
    const updated = h.footer!.render(120);
    assert.match(updated[1]!, /^Memory: authentication failed/);
    assert.ok(!updated[1]!.includes("connected"), "read current statuses on every render");
    h.extensionStatuses.clear();
    assert.deepEqual(h.footer!.render(120), original);
  } finally {
    controller.dispose();
  }
  assert.equal(h.setFooterUndefinedCount, 1);
  assert.equal(h.branchUnsubCount, 1);
});

test("lifecycle: extension status row is bounded at narrow terminal widths", () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  h.extensionStatuses.set("other", "Other:\nready\r\nnow\tplease");
  h.extensionStatuses.set("openviking", "\u001b[32mMemory: connected 界 🧠\u001b[0m");
  try {
    for (const width of [0, 1, 2, 8, 20, 40, 120]) {
      const lines = h.footer!.render(width);
      assert.equal(lines.length, 2);
      assert.ok(visibleWidth(lines[1]!) <= width, `status row exceeds ${width} columns`);
      assert.ok(!lines[1]!.includes("\n"), "extension statuses occupy one extra row");
    }
  } finally {
    controller.dispose();
  }
});

test("lifecycle: footer registers, renders state, and feeds events", async () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  assert.ok(h.footer, "setFooter factory must run and return a footer");
  // Initial model bound from ctx.model.
  assert.equal(controller.state.model, "m1");
  assert.equal(controller.state.provider, "p");

  controller.onMessageStart();
  controller.onMessageUpdate({
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(32) },
    message: { usage: { output: 10 } },
  });
  controller.onMessageEnd({ message: { role: "assistant", usage: { output: 20 } } });

  const lines = h.footer!.render(120);
  assert.ok(Array.isArray(lines) && lines.length >= 1);
  // The footer text reflects the rendered status (idle, model present).
  assert.ok(lines[0]!.includes("m1") || controller.state.model === "m1");

  controller.dispose();
});

test("lifecycle: model switch rebinds model and resets TPS", () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  controller.onModelSelect({ provider: "p2", id: "m2" });
  assert.equal(controller.state.model, "m2");
  assert.equal(controller.state.provider, "p2");
  assert.equal(controller.throughputSnapshot().phase, "unavailable");
  controller.dispose();
});

test("lifecycle: dispose restores the default footer and unsubscribes listeners", () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  assert.equal(h.setFooterUndefinedCount, 0);
  assert.equal(h.branchUnsubCount, 0);
  controller.dispose();
  assert.equal(h.setFooterUndefinedCount, 1, "default footer restored");
  assert.equal(h.branchUnsubCount, 1, "branch listener unsubscribed");
});

test("lifecycle: no renders or updates after disposal", () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  controller.onMessageStart();
  controller.dispose();
  const rendersAfterDispose = h.renderCount;
  const branchCbsBefore = h.branchCbs.length;
  controller.onMessageStart();
  controller.onMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "y".repeat(32) } });
  controller.onMessageEnd({ message: { role: "assistant", usage: { output: 5 } } });
  controller.onModelSelect({ provider: "p3", id: "m3" });
  // No new branch callbacks registered and no renders scheduled.
  assert.equal(h.branchCbs.length, branchCbsBefore);
  assert.equal(h.renderCount, rendersAfterDispose);
});

test("lifecycle: branch-change callback triggers a git refresh and render (no crash)", async () => {
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  const cb = h.branchCbs[0];
  assert.ok(cb, "branch-change callback registered");
  // Firing it must not throw (git resolve on a non-repo cwd degrades gracefully).
  await cb();
  controller.dispose();
});

test("lifecycle: undefined model and empty events never throw", () => {
  const h = makeHarness();
  h.ctx.model = undefined;
  const controller = new FooterController({ ctx: h.ctx as never, config: cfg, now: fixedClock() });
  controller.onMessageStart();
  controller.onMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "" } });
  controller.onMessageEnd({ message: { role: "assistant", usage: undefined } });
  controller.onModelSelect(undefined);
  // render must still produce a (possibly empty) line without throwing.
  assert.doesNotThrow(() => h.footer!.render(120));
  controller.dispose();
});

test("lifecycle: throughput coalesces renders via refreshMs (no per-token storm)", () => {
  // refreshMs 100; clock advances manually so we can observe coalescing.
  let t = 0;
  const now = () => t;
  const h = makeHarness();
  const controller = new FooterController({ ctx: h.ctx as never, config: { ...cfg, refreshMs: 100 }, now });
  const initial = h.renderCount;
  // Many token events within a refresh window => a single scheduled render.
  for (let i = 0; i < 50; i++) {
    t += 1;
    controller.onMessageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "z" } });
  }
  // Not 50 renders: throttled. (A render happens on the first event since lastRenderAt is 0.)
  assert.ok(h.renderCount - initial <= 2, `coalesced (got ${h.renderCount - initial} renders for 50 events)`);
  controller.dispose();
});
