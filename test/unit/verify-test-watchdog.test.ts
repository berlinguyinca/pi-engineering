import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";
import { CommandVerifier, DEFAULT_STAGE_INACTIVITY_MS, runWithInactivityGuard } from "../../src/verify/Verifier.ts";
import {
  DEFAULT_TEST_WATCHDOG,
  type ProgressSample,
  captureEvidence,
  classify,
  countTestEvents,
  initialWatchdogState,
  observe,
  resolveStageWatchdog,
} from "../../src/verify/testWatchdog.ts";

const sample = (over: Partial<ProgressSample> = {}): ProgressSample => ({
  outputBytes: 0,
  testEvents: 0,
  ioBytes: 0,
  children: "",
  ...over,
});

describe("test watchdog: pure classification", () => {
  it("defaults are 2, 5 and 10 minutes and there is no wall-clock limit", () => {
    assert.deepEqual(DEFAULT_TEST_WATCHDOG, {
      warnMs: 120_000,
      investigateMs: 300_000,
      stallMs: 600_000,
    });
    assert.equal("wallMs" in DEFAULT_TEST_WATCHDOG, false);
  });

  it("a sample with CPU growth only and no output for 600000 ms classifies stalled", () => {
    let state = initialWatchdogState(0);
    state = observe(state, sample(), 0);
    state = observe(state, sample({ cpuMs: 590_000 }), 600_000);
    assert.equal(state.lastProgressAtMs, 0, "CPU alone never resets lastProgressAt");
    assert.equal(classify(state, 600_000, DEFAULT_TEST_WATCHDOG), "stalled");
  });

  it("output growth at 590000 ms resets the stall clock", () => {
    let state = initialWatchdogState(0);
    state = observe(state, sample(), 0);
    state = observe(state, sample({ outputBytes: 12 }), 590_000);
    assert.equal(state.lastProgressAtMs, 590_000);
    assert.equal(state.lastProgressKind, "output");
    assert.equal(classify(state, 600_000, DEFAULT_TEST_WATCHDOG), "progressing");
  });

  it("walks progressing, quiet, investigate, stalled by silence", () => {
    const state = observe(observe(initialWatchdogState(0), sample(), 0), sample(), 0);
    const at = (ms: number) => classify(state, ms, DEFAULT_TEST_WATCHDOG);
    assert.equal(at(119_999), "progressing");
    assert.equal(at(120_000), "quiet");
    assert.equal(at(299_999), "quiet");
    assert.equal(at(300_000), "investigate");
    assert.equal(at(599_999), "investigate");
    assert.equal(at(600_000), "stalled");
  });

  it("I/O growth, a changed child set and test events each count as progress", () => {
    const base = observe(initialWatchdogState(0), sample({ ioBytes: 10, children: "1:a" }), 0);
    const io = observe(base, sample({ ioBytes: 11, children: "1:a" }), 1_000);
    assert.deepEqual([io.lastProgressAtMs, io.lastProgressKind], [1_000, "io"]);
    const kids = observe(base, sample({ ioBytes: 10, children: "1:a,2:b" }), 2_000);
    assert.deepEqual([kids.lastProgressAtMs, kids.lastProgressKind], [2_000, "children"]);
    const tests = observe(base, sample({ ioBytes: 10, children: "1:a", testEvents: 1, outputBytes: 9 }), 3_000);
    assert.deepEqual([tests.lastProgressAtMs, tests.lastProgressKind], [3_000, "test_event"]);
    const none = observe(base, sample({ ioBytes: 10, children: "1:a" }), 4_000);
    assert.equal(none.lastProgressAtMs, 0);
  });

  it("a counter going backwards (restarted child) is not progress", () => {
    const base = observe(initialWatchdogState(0), sample({ ioBytes: 100 }), 0);
    const lower = observe(base, sample({ ioBytes: 5 }), 1_000);
    assert.equal(lower.lastProgressAtMs, 0);
  });

  it("counts test start and finish lines from node:test, cargo and pytest style output", () => {
    assert.equal(countTestEvents("# Subtest: a\nok 1 - a\nnot ok 2 - b\n"), 3);
    assert.equal(countTestEvents("test foo::bar ... ok\ntest baz ... FAILED\n"), 2);
    assert.equal(countTestEvents("tests/test_x.py::test_y PASSED\n"), 1);
    assert.equal(countTestEvents("compiling things\nwarning: unused\n"), 0);
  });

  it("the 15 minute inactivity guard is still the backstop", () => {
    assert.equal(DEFAULT_STAGE_INACTIVITY_MS, 15 * 60_000);
  });
});

describe("test watchdog: evidence", () => {
  it("captureEvidence returns at least 1 process entry for a live child and the last 50 lines", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      assert.ok(child.pid);
      const output = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
      const evidence = await captureEvidence(child.pid, output);
      assert.ok(evidence.processes.length >= 1);
      const entry = evidence.processes.find((p) => p.pid === child.pid);
      assert.ok(entry, "the child itself is listed");
      assert.match(entry.command, /sleep/);
      assert.equal(evidence.lastLines.length, 50);
      assert.equal(evidence.lastLines.at(-1), "line 79");
      assert.equal(evidence.lastLines[0], "line 30");
    } finally {
      process.kill(-(child.pid as number), "SIGKILL");
    }
  });

  it("captureEvidence reports an empty tree for a group that does not exist", async () => {
    const evidence = await captureEvidence(2 ** 22 - 3, "");
    assert.deepEqual(evidence.processes, []);
  });
});

const SHORT = { warnMs: 150, investigateMs: 300, stallMs: 600, sampleMs: 50 };
const run = (script: string, watchdog: Record<string, number | undefined> | undefined, inactivityMs = 60_000) =>
  runWithInactivityGuard("node", ["-e", script], {
    cwd: process.cwd(),
    inactivityMs,
    ...(watchdog ? { watchdog: watchdog as never } : {}),
  });

describe("test watchdog: real child processes under short thresholds", () => {
  it("kills a silent child as stalled, with evidence, long before the inactivity backstop", async () => {
    const started = Date.now();
    const res = await run("setInterval(() => {}, 1000)", SHORT);
    assert.equal(res.hung, true);
    assert.equal(res.stalled?.level, "stalled");
    assert.ok((res.stalled?.evidence.processes.length ?? 0) >= 1);
    assert.match(res.stderr, /stalled/);
    assert.ok(Date.now() - started < 15_000, "killed promptly");
  });

  it("a child burning CPU in silence is still stalled", async () => {
    const res = await run("for (;;) {}", SHORT);
    assert.equal(res.stalled?.level, "stalled");
  });

  it("a quiet child that keeps printing is never stalled", async () => {
    const res = await run(
      "let n = 0; const t = setInterval(() => { console.log('tick', n++); if (n === 20) { clearInterval(t); } }, 100)",
      SHORT,
    );
    assert.equal(res.stalled, undefined);
    assert.equal(res.hung, false);
    assert.equal(res.code, 0);
  });

  it("a silent child that spawns a fresh process every tick keeps making progress", async () => {
    const script =
      "const { spawnSync } = require('node:child_process'); for (let i = 0; i < 12; i++) spawnSync('sleep', ['0.1']);";
    const res = await run(script, SHORT);
    assert.equal(res.stalled, undefined);
    assert.equal(res.code, 0);
  });

  it("a stage without a watchdog is untouched", async () => {
    const res = await run("setTimeout(() => {}, 900)", undefined);
    assert.equal(res.stalled, undefined);
    assert.equal(res.code, 0);
  });

  it("a chatty stage that keeps making progress is never cut off for running long", async () => {
    // No wall-clock limit exists: a stage that logs every 50 ms for well over the
    // stall threshold must finish on its own.
    const res = await run(
      "let n = 0; const t = setInterval(() => { console.log('x'); if (++n === 30) { clearInterval(t); } }, 50)",
      SHORT,
    );
    assert.equal(res.stalled, undefined);
    assert.equal(res.code, 0);
  });
});

describe("test watchdog: Verifier stage wiring", () => {
  it("fails a silent test stage as an infrastructure failure carrying the stall evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-wd-"));
    try {
      const store = await ArtifactStore.create(join(dir, "art"));
      const outcome = await new CommandVerifier().run(
        dir,
        {
          name: "wd",
          stages: [
            {
              name: "test",
              command: "node",
              args: ["-e", "setInterval(() => {}, 1000)"],
              required: true,
              watchdog: SHORT,
            },
          ],
        },
        store,
      );
      assert.equal(outcome.passed, false);
      const summary = outcome.stages[0]?.summary as Record<string, unknown>;
      assert.equal(summary.infrastructureFailure, true);
      assert.equal(summary.stalled, "stalled");
      assert.ok(Array.isArray((summary.stallEvidence as { processes: unknown[] }).processes));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives test stages the default thresholds and leaves other stages alone", () => {
    const test = resolveStageWatchdog({ name: "test" });
    assert.deepEqual(test, { warnMs: 120_000, investigateMs: 300_000, stallMs: 600_000, sampleMs: 5_000 });
    assert.ok(resolveStageWatchdog({ name: "test:full" }));
    assert.equal(resolveStageWatchdog({ name: "build" }), undefined);
    assert.equal(resolveStageWatchdog({ name: "typecheck" }), undefined);
    assert.equal(resolveStageWatchdog({ name: "test", watchdog: false }), undefined);
    assert.equal("wallMs" in (resolveStageWatchdog({ name: "test" }) ?? {}), false);
    assert.equal(resolveStageWatchdog({ name: "build", watchdog: { stallMs: 7 } })?.stallMs, 7);
  });
});
