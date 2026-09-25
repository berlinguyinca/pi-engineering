/**
 * Per-model compaction tuning (pure parts).
 *
 * Pi's compaction defaults (reserveTokens 16384, keepRecentTokens 20000) are
 * sized for ~128k windows. On the gateway's 262k-window models, which think by
 * default, that leaves too little headroom: compaction starts at 245k tokens,
 * its summary is capped at 0.8 x 16384, and the verbatim tail is 20k.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  effectiveCompaction,
  readUserCompactionValues,
  shouldAutoCompact,
  tunedCompactionTokens,
} from "../../src/compaction/autoTune.ts";

test("policy table: reserve follows the output allowance and the window; keep follows the window", () => {
  const rows: Array<[number, number | undefined, number, number]> = [
    // window, maxTokens, reserve, keep
    [262_144, 32_768, 32_768, 39_322],
    [131_072, 32_768, 32_768, 20_000], // the output-allowance term wins at 128k
    [131_072, 16_384, 16_384, 20_000],
    [131_072, 8_192, 16_384, 20_000], // never below Pi's default
    [1_048_576, 32_768, 65_536, 80_000], // capped: do not compact 128k early on a 1M window
    [200_000, 64_000, 32_768, 30_000], // allowance term capped at 32k
    [32_768, 4_096, 16_384, 20_000],
    [262_144, undefined, 32_768, 39_322], // unknown maxTokens: the window term alone
  ];
  for (const [contextWindow, maxTokens, reserveTokens, keepRecentTokens] of rows) {
    assert.deepEqual(
      tunedCompactionTokens({ contextWindow, maxTokens }),
      { reserveTokens, keepRecentTokens },
      `${contextWindow}/${maxTokens}`,
    );
  }
  assert.equal(tunedCompactionTokens({ contextWindow: 0, maxTokens: 32_768 }), undefined);
  assert.equal(tunedCompactionTokens({}), undefined);
});

const MODEL = { provider: "metabolomics", id: "qwen3.8-27b", contextWindow: 262_144, maxTokens: 32_768 };

test("effective values: tuned where the user set nothing, the user's value wherever they did", () => {
  const tuned = effectiveCompaction(MODEL, {});
  assert.deepEqual(
    { ...tuned, reason: undefined },
    {
      enabled: true,
      reserveTokens: 32_768,
      keepRecentTokens: 39_322,
      reserveSource: "tuned",
      keepSource: "tuned",
      reason: undefined,
    },
  );
  const mixed = effectiveCompaction(MODEL, { reserveTokens: 20_000 });
  assert.equal(mixed.reserveTokens, 20_000);
  assert.equal(mixed.reserveSource, "user");
  assert.equal(mixed.keepRecentTokens, 39_322);
  assert.equal(mixed.keepSource, "tuned");
  assert.equal(effectiveCompaction(MODEL, { enabled: false }).enabled, false);
  // No window: Pi's defaults, nothing tuned.
  const unknown = effectiveCompaction({ provider: "p", id: "m" }, {});
  assert.equal(unknown.reserveSource, "default");
  assert.equal(unknown.reserveTokens, 16_384);
});

function settingsDirs(global: unknown, project?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "compaction-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (global !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
  if (project !== undefined) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
  return { root, agentDir, cwd };
}

test("user values are read (read-only) with Pi's precedence: model override > project > global", () => {
  const dirs = settingsDirs(
    {
      compaction: {
        reserveTokens: 20_000,
        keepRecentTokens: 25_000,
        modelOverrides: { "metabolomics/qwen3.8-27b": { keepRecentTokens: 50_000 } },
      },
    },
    { compaction: { reserveTokens: 24_000, enabled: false } },
  );
  try {
    const values = readUserCompactionValues({ ...dirs, projectTrusted: true, model: MODEL });
    assert.deepEqual(values, { enabled: false, reserveTokens: 24_000, keepRecentTokens: 50_000 });
    // An untrusted project's settings are ignored, as Pi ignores them.
    const untrusted = readUserCompactionValues({ ...dirs, projectTrusted: false, model: MODEL });
    assert.deepEqual(untrusted, { reserveTokens: 20_000, keepRecentTokens: 50_000 });
    // Another model sees only the ordinary values.
    const other = readUserCompactionValues({ ...dirs, projectTrusted: false, model: { provider: "x", id: "y" } });
    assert.deepEqual(other, { reserveTokens: 20_000, keepRecentTokens: 25_000 });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("no settings files at all: nothing user-set", () => {
  const dirs = settingsDirs(undefined);
  try {
    assert.deepEqual(readUserCompactionValues({ ...dirs, projectTrusted: true, model: MODEL }), {});
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("debounce: compact once past the threshold, re-arm only after dropping back below it", () => {
  const window = 262_144;
  const reserve = 32_768; // threshold 229,376
  let state = { armed: true };
  const step = (tokens: number | null) => {
    const decision = shouldAutoCompact(state, tokens, window, reserve);
    state = { armed: decision.armed };
    return decision.compact;
  };
  assert.equal(step(200_000), false);
  assert.equal(step(230_000), true, "crossed the threshold");
  assert.equal(step(null), false, "right after compaction the size is unknown");
  assert.equal(step(235_000), false, "still above (compaction did not shrink it): no loop");
  assert.equal(step(120_000), false, "back below: re-armed");
  assert.equal(step(240_000), true, "grew past again: compact again");
});

test("an older Pi (no agent_settled, no per-model compaction) gets a one-time notice and no hooks", async () => {
  const { registerAutoCompaction } = await import("../../src/compaction/autoTune.ts");
  const { setTelemetrySink } = await import("../../src/telemetry/sink.ts");
  const notices: string[] = [];
  const uninstall = setTelemetrySink((n) => notices.push(n.text));
  try {
    const events: string[] = [];
    const host = { on: (event: string) => events.push(event) };
    assert.equal(registerAutoCompaction(host as never, { piVersion: "0.85.1" }), false);
    assert.deepEqual(events, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /needs Pi 0\.87\.1 or newer \(running 0\.85\.1\)/);

    assert.equal(registerAutoCompaction(host as never, { piVersion: "0.87.1", enabled: false }), false, "switched off");
    assert.equal(registerAutoCompaction(host as never, { piVersion: "0.87.1" }), true);
    assert.deepEqual(events.sort(), ["agent_settled", "model_select", "session_before_compact", "session_start"]);
  } finally {
    uninstall();
  }
});
