import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_STATUS_BAR_CONFIG, type StatusBarConfig } from "../../src/status/config.ts";
import { renderStatus } from "../../src/status/layout.ts";
import type { HarnessStatusState } from "../../src/status/state.ts";

// Use a stable fake home so the `~` abbreviation is deterministic regardless of
// the CI/agent HOME. Must be set before the first renderStatus call (homeDir caches).
process.env.HOME = "/home/u";

const cfg: StatusBarConfig = DEFAULT_STATUS_BAR_CONFIG;

function state(overrides: Partial<HarnessStatusState> = {}): HarnessStatusState {
  return {
    cwd: "/home/u/src/myrepo",
    repository: "acme/widgets",
    repositoryRoot: "/home/u/src/myrepo",
    worktree: "wt:feat-x",
    branch: "feature/x",
    model: "qwen3.8-27b",
    provider: "acme",
    throughput: {
      phase: "streaming",
      currentTokensPerSecond: 73.4,
      lastCompletedTokensPerSecond: 70,
      outputTokens: 1200,
    },
    ...overrides,
  };
}

const WIDTHS = [160, 120, 100, 80, 60, 40];

test("layout: never overflows and never wraps at any tested width", () => {
  const s = state();
  for (const width of WIDTHS) {
    const line = renderStatus(s, width, cfg);
    assert.ok(!line.includes("\n"), `no wrap at width ${width}: got ${JSON.stringify(line)}`);
    assert.ok(
      visibleWidth(line) <= width,
      `no overflow at width ${width}: got ${JSON.stringify(line)} (${visibleWidth(line)})`,
    );
  }
});

test("layout: model + TPS survive at every width", () => {
  const s = state();
  for (const width of WIDTHS) {
    const line = renderStatus(s, width, cfg);
    assert.ok(line.includes("qwen3.8-27b"), `model survives at width ${width}: ${line}`);
    assert.ok(line.includes("⚡"), `TPS survives at width ${width}: ${line}`);
  }
});

test("layout: wide width shows all segments", () => {
  const s = state();
  const line = renderStatus(s, 120, cfg);
  assert.ok(line.includes("~/src/myrepo"), "directory");
  assert.ok(line.includes("acme/widgets"), "repository");
  assert.ok(line.includes("wt:feat-x"), "worktree");
  assert.ok(line.includes("feature/x"), "branch");
  assert.ok(line.includes("acme/qwen3.8-27b"), "provider/model");
  assert.ok(line.includes("⚡ 73.4 t/s"), "throughput (full)");
});

test("layout: medium width abbreviates paths and drops directory first", () => {
  const s = state();
  const line = renderStatus(s, 60, cfg);
  assert.ok(!line.includes("myrepo"), "directory dropped at 60");
  assert.ok(line.includes("widgets"), "repository abbreviated (last segment)");
  assert.ok(line.includes("wt:feat-x"), "worktree kept");
});

test("layout: narrow width drops worktree and repository, keeps branch + model + TPS", () => {
  const s = state();
  const line = renderStatus(s, 40, cfg);
  assert.ok(!line.includes("widgets"), "repository dropped at 40");
  assert.ok(!line.includes("wt:"), "worktree dropped at 40");
  assert.ok(!line.includes("myrepo"), "directory dropped at 40");
  assert.ok(line.includes("feature/x"), "branch kept");
  assert.ok(line.includes("qwen3.8-27b"), "model kept");
  assert.ok(line.includes("⚡"), "TPS kept");
  assert.ok(line.includes("⚡73 t/s"), "throughput abbreviated");
});

test("layout: waiting phase shows the transient placeholder", () => {
  const s = state({ throughput: { phase: "waiting" } });
  const line = renderStatus(s, 120, cfg);
  assert.ok(line.includes("⚡ … t/s"), line);
});

test("layout: idle phase keeps the last completed TPS visible", () => {
  const s = state({ throughput: { phase: "idle", lastCompletedTokensPerSecond: 71.2 } });
  const line = renderStatus(s, 120, cfg);
  assert.ok(line.includes("⚡ 71.2 t/s"), line);
});

test("layout: unavailable throughput omits the TPS segment", () => {
  const s = state({ throughput: { phase: "unavailable" } });
  const line = renderStatus(s, 120, cfg);
  assert.ok(!line.includes("⚡"), line);
});

test("layout: detached HEAD renders as @<sha>", () => {
  const s = state({ branch: undefined, detachedHead: "9f12ab3" });
  const line = renderStatus(s, 120, cfg);
  assert.ok(line.includes("@9f12ab3"), line);
});

test("layout: config toggles remove segments", () => {
  const off = { ...cfg, showDirectory: false, showRepository: false, showWorktree: false };
  const s = state();
  const line = renderStatus(s, 120, off);
  assert.ok(!line.includes("myrepo"), "no directory");
  assert.ok(!line.includes("widgets"), "no repository");
  assert.ok(!line.includes("wt:"), "no worktree");
  assert.ok(line.includes("feature/x"));
  assert.ok(line.includes("qwen3.8-27b"));
});

test("layout: outside a git repo omits repository/worktree/branch gracefully", () => {
  const s = state({
    cwd: "/home/u/scratch",
    repository: undefined,
    repositoryRoot: undefined,
    worktree: undefined,
    branch: undefined,
    detachedHead: undefined,
    throughput: { phase: "streaming", currentTokensPerSecond: 71 },
  });
  const line = renderStatus(s, 120, cfg);
  assert.ok(!line.includes("widgets"));
  assert.ok(!line.includes("wt:"));
  assert.ok(line.includes("qwen3.8-27b"));
  assert.ok(line.includes("⚡"));
});
