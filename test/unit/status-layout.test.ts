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

// ─── Wait segment (why the runtime is idle) ─────────────────────────────────

test("wait: renders a spinner, the reason and a countdown", () => {
  const s = state({
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  });
  assert.match(renderStatus(s, 200, cfg, 0), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] gateway 30s · queue_timeout/);
});

test("wait: the spinner advances with the clock so a long hold looks alive", () => {
  const s = state({
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 300_000 },
  });
  const frameOf = (t: number) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.exec(renderStatus(s, 200, cfg, t))?.[0];
  const frames = new Set([0, 250, 500, 750, 1_000].map(frameOf));
  assert.ok(frames.size > 1, "a still spinner reads as a hang");
});

test("wait: queue depth replaces the reason — position, not an error dump", () => {
  // The operator asked for "X/N in the queue", not the 429 body.
  const s = state({
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000, queued: 30, queueLimit: 100 },
  });
  const line = renderStatus(s, 200, cfg, 0);
  assert.match(line, /gateway 30s · queue 30\/100/);
  assert.doesNotMatch(line, /queue_timeout/, "the reason is noise once the position is known");
});

test("wait: a queue depth with no reported limit still shows the position", () => {
  const s = state({
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000, queued: 7 },
  });
  assert.match(renderStatus(s, 200, cfg, 0), /gateway 30s · queue 7/);
});

test("wait: countdown floors at 0s and never goes negative", () => {
  const s = state({
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 1_000 },
  });
  assert.match(renderStatus(s, 200, cfg, 9_000), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] gateway 0s · queue_timeout/);
});

test("wait: a wait with no deadline renders without a countdown", () => {
  const s = state({ throughput: { phase: "waiting" }, wait: { kind: "verify", detail: "npm test" } });
  const line = renderStatus(s, 200, cfg, 0);
  assert.match(line, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] verify · npm test/);
  assert.doesNotMatch(line, /\d+s ·/);
});

test("wait: the wait segment is the last thing standing as width shrinks", () => {
  const s = state({
    throughput: { phase: "streaming", currentTokensPerSecond: 247 },
    task: { workItemId: "WI-12", phase: "implement" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  });
  const narrow = renderStatus(s, 26, cfg, 0);
  assert.match(narrow, /gateway/);
  assert.ok(visibleWidth(narrow) <= 26, `line too wide: ${visibleWidth(narrow)}`);
});

test("wait: no wait state renders no wait segment", () => {
  assert.doesNotMatch(renderStatus(state(), 200, cfg, 0), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("wait: showWait=false hides the segment even while waiting", () => {
  const config: StatusBarConfig = { ...DEFAULT_STATUS_BAR_CONFIG, showWait: false };
  const s = state({
    throughput: { phase: "waiting" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  });
  assert.doesNotMatch(renderStatus(s, 200, config, 0), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

// ─── Task segment (the work item in flight) ─────────────────────────────────

test("task: names the work item and phase", () => {
  const s = state({ task: { workItemId: "WI-12", phase: "implement" } });
  assert.match(renderStatus(s, 200, cfg, 0), /WI-12 implement/);
});

test("task: appends a truncated goal label when there is room", () => {
  const s = state({
    task: { workItemId: "WI-12", phase: "implement", label: "add retry to the gateway client for real" },
  });
  const line = renderStatus(s, 200, cfg, 0);
  assert.match(line, /WI-12 implement · add retry to the gateway/);
  assert.doesNotMatch(line, /for real/);
});

test("task: outlives model and throughput but not the wait", () => {
  const s = state({
    throughput: { phase: "streaming", currentTokensPerSecond: 247 },
    task: { workItemId: "WI-12", phase: "implement" },
    wait: { kind: "gateway", detail: "queue_timeout", untilMs: 30_000 },
  });
  const line = renderStatus(s, 50, cfg, 0);
  assert.match(line, /WI-12 implement/);
  assert.match(line, /gateway/);
  assert.doesNotMatch(line, /qwen3\.8-27b/);
  assert.ok(visibleWidth(line) <= 50, `line too wide: ${visibleWidth(line)}`);
});

test("task: no task renders no task segment", () => {
  assert.doesNotMatch(renderStatus(state(), 200, cfg, 0), /WI-/);
});

test("task: showTask=false hides the segment", () => {
  const config: StatusBarConfig = { ...DEFAULT_STATUS_BAR_CONFIG, showTask: false };
  const s = state({ task: { workItemId: "WI-12", phase: "implement" } });
  assert.doesNotMatch(renderStatus(s, 200, config, 0), /WI-12/);
});
