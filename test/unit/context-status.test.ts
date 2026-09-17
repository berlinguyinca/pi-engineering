import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { contextReading, planModelSwitch } from "../../src/context/usage.ts";
import { DEFAULT_STATUS_BAR_CONFIG } from "../../src/status/config.ts";
import { renderStatus } from "../../src/status/layout.ts";
import type { HarnessStatusState } from "../../src/status/state.ts";

process.env.HOME = "/home/u";

function state(overrides: Partial<HarnessStatusState> = {}): HarnessStatusState {
  return {
    cwd: "/home/u/src/myrepo",
    repository: "acme/widgets",
    repositoryRoot: "/home/u/src/myrepo",
    worktree: "wt:feat-x",
    branch: "feature/x",
    model: "qwen3.8-27b",
    provider: "acme",
    context: { usedTokens: 143_000, windowTokens: 262_144 },
    throughput: { phase: "idle", lastCompletedTokensPerSecond: 31 },
    ...overrides,
  };
}

test("context reading renders the compact ctx segment", () => {
  const reading = contextReading(143_000, 262_144);
  assert.equal(reading.label, "ctx 143k/262k 55%");
  assert.equal(reading.pressure, false);
  assert.equal(contextReading(250_000, 262_144).pressure, true, "under 20% left is pressure");
  assert.equal(contextReading(0, 262_144).label, "ctx 0/262k 0%");
  assert.equal(contextReading(Number.NaN, Number.NaN).windowTokens, 1, "never divides by zero");
});

test("the status line carries model, ctx, tps, branch and worktree", () => {
  const line = renderStatus(state(), 160, DEFAULT_STATUS_BAR_CONFIG);
  assert.match(line, /qwen3\.8-27b/);
  assert.match(line, /ctx 143k\/262k 55%/);
  assert.match(line, /⚡ 31\.0 t\/s/);
  assert.match(line, /feature\/x/);
  assert.match(line, /wt:feat-x/);
  assert.match(line, /acme\/widgets/);
});

test("the ctx segment follows the resolved window, not a hard-coded one", () => {
  const big = renderStatus(
    state({ context: { usedTokens: 400_000, windowTokens: 1_048_576 } }),
    160,
    DEFAULT_STATUS_BAR_CONFIG,
  );
  assert.match(big, /ctx 400k\/1M 38%/);
  assert.doesNotMatch(big, /260k/, "no 260K anywhere in the status line");

  const small = renderStatus(
    state({ context: { usedTokens: 20_000, windowTokens: 32_768 } }),
    160,
    DEFAULT_STATUS_BAR_CONFIG,
  );
  assert.match(small, /ctx 20k\/33k 61%/);
});

test("narrow terminals drop the ctx segment before the model", () => {
  const narrow = renderStatus(state(), 28, DEFAULT_STATUS_BAR_CONFIG);
  assert.ok(visibleWidth(narrow) <= 28, `line too wide: ${narrow}`);
  assert.match(narrow, /qwen3\.8-27b/, "model is preserved");
  assert.doesNotMatch(narrow, /ctx /, "ctx drops first");

  const mid = renderStatus(state(), 52, DEFAULT_STATUS_BAR_CONFIG);
  assert.ok(visibleWidth(mid) <= 52, `line too wide: ${mid}`);
  assert.match(mid, /ctx 143k\/262k 55%/);
});

test("PI_STATUS_BAR_SHOW_CONTEXT=0 hides the segment", () => {
  const line = renderStatus(state(), 160, { ...DEFAULT_STATUS_BAR_CONFIG, showContext: false });
  assert.doesNotMatch(line, /ctx /);
});

test("a stale capability window is marked, so the reading cannot be misread as truth", () => {
  const line = renderStatus(
    state({ context: { usedTokens: 10_000, windowTokens: 131_072, note: "stale" } }),
    160,
    DEFAULT_STATUS_BAR_CONFIG,
  );
  assert.match(line, /~ctx 10k\/131k 8%/);
});

test("model switch: same or larger window needs no action", () => {
  assert.equal(planModelSwitch(143_000, 262_144, 262_144).action, "none");
  assert.equal(planModelSwitch(143_000, 262_144, 1_048_576).action, "none");
});

test("model switch 1M -> 128K compacts before dispatch", () => {
  const decision = planModelSwitch(400_000, 1_048_576, 131_072, { reserveOutputTokens: 8_192 });
  assert.equal(decision.action, "compact");
  assert.ok(decision.overflowTokens > 0);
  assert.match(decision.reason, /compact/);
});

test("model switch that no compaction can save is refused, not attempted", () => {
  const decision = planModelSwitch(10_000, 262_144, 4_096, { reserveOutputTokens: 4_096 });
  assert.equal(decision.action, "reject");
  const unknown = planModelSwitch(1, 262_144, 0);
  assert.equal(unknown.action, "reject");
});

test("a narrower window that still holds the session dispatches immediately", () => {
  const decision = planModelSwitch(50_000, 1_048_576, 131_072, { reserveOutputTokens: 8_192 });
  assert.equal(decision.action, "none");
});

import { FooterController } from "../../src/status/footer.ts";

function footer(
  capabilityWindow: (modelId: string | undefined) => { windowTokens: number; note?: string } | undefined,
) {
  const ctx = {
    cwd: "/tmp/iw-context-footer-test",
    model: { provider: "p", id: "a" },
    ui: { setFooter: (_fn: unknown) => {} },
  };
  return new FooterController({
    ctx: ctx as never,
    config: DEFAULT_STATUS_BAR_CONFIG,
    capabilityWindow,
  });
}

test("switching to a model the capability layer does not know drops the previous window", () => {
  const known = new Map([
    ["a", { windowTokens: 262_144 }],
    ["b", { windowTokens: 131_072 }],
  ]);
  const f = footer((id) => (id ? known.get(id) : undefined));
  f.onModelSelect({ id: "a", contextWindow: 262_144 });
  f.setContextUsage(100_000);
  assert.equal(f.state.context?.windowTokens, 262_144);

  // A model the capability layer resolved: its window follows.
  f.onModelSelect({ id: "b", contextWindow: 131_072 });
  assert.equal(f.state.context?.windowTokens, 131_072);

  // A model with NO capability: the previous model's window must not survive.
  // Pi's own registry window for that model is the honest fallback.
  f.onModelSelect({ id: "unknown-70b", contextWindow: 49_152 });
  assert.equal(f.state.context?.windowTokens, 49_152, "registry window, not the 262K of the previous model");

  // No capability and no registry window either: show nothing, not a lie.
  f.onModelSelect({ id: "mystery" });
  assert.equal(f.state.context?.windowTokens, 0, "cleared, not carried over");
});
