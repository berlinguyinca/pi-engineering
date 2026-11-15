import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyError } from "../../src/guard/transient.ts";
import { OmpWorkerExecutor, OmpWorkerUnavailable } from "../../src/omp/OmpWorkerExecutor.ts";
import {
  FallbackWorkerExecutor,
  OMP_WORKER_ENV,
  fallbackSummary,
  selectOmpWorker,
} from "../../src/omp/selectWorker.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest, WorkerRun } from "../../src/workers/WorkerExecutor.ts";

const FAKE = fileURLToPath(new URL("../support/fakeOmpRpc.mjs", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../fixtures/omp-frames/agent-turn-write-then-worker-result.jsonl", import.meta.url),
);
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "omp-exec-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const exec = (mode: string, extra: Partial<ConstructorParameters<typeof OmpWorkerExecutor>[0]> = {}) =>
  new OmpWorkerExecutor({
    launch: { command: process.execPath, args: [FAKE] },
    env: { ...process.env, FAKE_OMP_MODE: mode, FAKE_OMP_FIXTURE: FIXTURE },
    startTimeoutMs: 1_500,
    ...extra,
  });
const req = (over: Partial<WorkerRequest> = {}): WorkerRequest => ({
  role: "implementer",
  task: "t",
  tools: ["read", "write", "worker_result"],
  cwd: tmp(),
  ...over,
});

describe("OmpWorkerExecutor against a real rpc child replaying captured frames", () => {
  it("returns the normalized worker_result, usage and tool-call count", async () => {
    const run = await exec("replay").run(req());
    assert.equal(run.result.status, "completed");
    assert.equal(run.result.summary, "done");
    assert.equal(run.toolCalls, 2);
    assert.equal(run.usage?.input, 1800);
    assert.equal(run.usage?.turns, 3);
    assert.equal((run.structured as { status: string }).status, "completed");
  });

  it("a reviewer run completes from the review_result verdict summary", async () => {
    const run = await exec("replay").run(req({ role: "reviewer", resultTool: "review_result", tools: ["read"] }));
    // The fixture calls worker_result, which a review session does not offer: the host rejects it and no verdict arrives.
    assert.equal(run.result.status, "failed");
  });

  it("an agent that never calls the result tool is a failed run, not unavailable", async () => {
    const run = await exec("no-result").run(req());
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /no worker_result/);
  });

  it("a prompt error is a failed run carrying the reason", async () => {
    const run = await exec("prompt-error").run(req());
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /prompt error: provider exploded/);
  });

  it("a crash after the prompt is a failed run (never re-run)", async () => {
    const run = await exec("crash-after-prompt").run(req());
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /exited before completing/);
  });

  it("silence after the prompt hits the inactivity guard", async () => {
    const run = await exec("hang-after-prompt").run(req({ timeoutMs: 400 }));
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /no omp frame for 400ms \(running\)/);
  });

  it("a silent bash call in flight does not trip the inactivity guard; the run still completes", async () => {
    const run = await exec("silent-bash", {
      env: {
        ...process.env,
        FAKE_OMP_MODE: "silent-bash",
        FAKE_OMP_FIXTURE: FIXTURE,
        FAKE_OMP_SILENCE_MS: "700",
        FAKE_OMP_FINAL: JSON.stringify({ status: "completed", summary: "fin" }),
      },
    }).run(req({ timeoutMs: 250 }));
    assert.equal(run.result.status, "completed", run.error);
  });

  it("a bash call that never ends is bounded by bashMaxMs, not by the inactivity window", async () => {
    const started = Date.now();
    const run = await exec("silent-bash-hang", { bashMaxMs: 700 }).run(req({ timeoutMs: 200 }));
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /no omp frame for 700ms \(running, bash in flight\)/);
    assert.ok(Date.now() - started >= 650);
  });

  it("the owner's abort signal ends the run", async () => {
    const ac = new AbortController();
    const pending = exec("hang-after-prompt").run(req({ signal: ac.signal, timeoutMs: 30_000 }));
    setTimeout(() => ac.abort(), 300);
    const run = await pending;
    assert.match(run.error ?? "", /aborted by owner/);
  });

  it("an already-aborted signal is an aborted run, not a fallback", async () => {
    const ac = new AbortController();
    ac.abort();
    const run = await exec("replay").run(req({ signal: ac.signal }));
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /aborted by owner/);
  });

  it("abort before ready is an aborted run, never Unavailable (no legacy fallback)", async () => {
    const ac = new AbortController();
    const pending = exec("hang-before-ready", { startTimeoutMs: 30_000 }).run(req({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    const run = await pending;
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /aborted by owner/);
  });

  it("frames buffered after the inactivity timeout are ignored: one failed run, no result", async () => {
    const run = await exec("late-burst").run(req({ timeoutMs: 200 }));
    assert.equal(run.result.status, "failed");
    assert.match(run.error ?? "", /no omp frame for 200ms/);
    assert.equal(run.structured, undefined);
  });
});

describe("unavailable before the prompt", () => {
  for (const [name, executor, pattern] of [
    ["crash before ready", exec("crash-before-ready"), /exited before completing/],
    ["silence before ready", exec("hang-before-ready", { startTimeoutMs: 300 }), /no omp frame for 300ms \(starting\)/],
    [
      "binary absent",
      new OmpWorkerExecutor({ launch: { command: "/nonexistent/omp-bin", args: [] }, startTimeoutMs: 1_000 }),
      /ENOENT/,
    ],
  ] as const) {
    it(`${name} rejects with OmpWorkerUnavailable`, async () => {
      await assert.rejects(
        executor.run(req()),
        (e: unknown) => e instanceof OmpWorkerUnavailable && pattern.test(e.detail),
      );
    });
  }
});

describe("FallbackWorkerExecutor", () => {
  const legacyRun: WorkerRun = {
    result: {
      status: "completed",
      summary: "legacy",
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {},
    },
    usage: null,
  };
  const legacy: WorkerExecutor = { run: async () => legacyRun };

  it("falls back and records a deterministic reason when the primary is unavailable", async () => {
    const seen: WorkerActivity[] = [];
    const fb = new FallbackWorkerExecutor(exec("crash-before-ready"), legacy);
    const run = await fb.run(req({ onActivity: (e) => seen.push(e) }));
    assert.equal(run.result.summary, "legacy");
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.summary ?? "", /^omp worker unavailable \(omp exited before completing/);
    assert.equal(fallbackSummary("x"), "omp worker unavailable (x); using legacy executor");
  });

  it("does not fall back after the prompt ran", async () => {
    const run = await new FallbackWorkerExecutor(exec("crash-after-prompt"), legacy).run(req());
    assert.equal(run.result.status, "failed");
  });

  it("rethrows unrelated errors", async () => {
    const boom: WorkerExecutor = {
      run: async () => {
        throw new Error("boom");
      },
    };
    await assert.rejects(new FallbackWorkerExecutor(boom, legacy).run(req()), /boom/);
  });
});

describe("selectOmpWorker", () => {
  const legacy: WorkerExecutor = { run: async () => ({ result: {} as never, usage: null }) };

  it("is a no-op when the flag is unset", async () => {
    assert.equal(await selectOmpWorker(() => legacy, {}), undefined);
  });

  it("uses legacy with a reason when the adapter flag is off", async () => {
    const sel = await selectOmpWorker(() => legacy, { [OMP_WORKER_ENV]: "1" });
    assert.equal(sel?.executor, legacy);
    assert.deepEqual(sel?.selection, { path: "legacy", reason: "disabled: PI_ENGINEERING_OMP_ADAPTER not enabled" });
  });

  it("uses legacy with the negotiation reason when the binary is absent", async () => {
    const sel = await selectOmpWorker(() => legacy, {
      [OMP_WORKER_ENV]: "1",
      PI_ENGINEERING_OMP_ADAPTER: "1",
      PI_ENGINEERING_OMP_BIN: "/nonexistent/omp-bin",
    });
    assert.equal(sel?.selection.path, "legacy");
    assert.match((sel?.selection as { reason: string }).reason, /^binary_absent/);
  });

  it("negotiates under the same HOME override as the workers", async () => {
    const env = {
      ...process.env,
      [OMP_WORKER_ENV]: "1",
      PI_ENGINEERING_OMP_ADAPTER: "1",
      PI_ENGINEERING_OMP_BIN: process.execPath,
      PI_ENGINEERING_OMP_BIN_ARGS: FAKE,
      FAKE_OMP_FIXTURE: FIXTURE,
      FAKE_OMP_EXPECT_HOME: "/pe/override-home",
      HOME: "/somewhere/else",
    };
    const without = await selectOmpWorker(() => legacy, env);
    assert.equal(without?.selection.path, "legacy", "the fake refuses a HOME that is not the override");
    const withHome = await selectOmpWorker(() => legacy, { ...env, PI_ENGINEERING_OMP_HOME: "/pe/override-home" });
    assert.deepEqual(withHome?.selection, { path: "omp" });
  });

  it("selects the omp path when negotiation succeeds", async () => {
    const sel = await selectOmpWorker(() => legacy, {
      ...process.env,
      [OMP_WORKER_ENV]: "1",
      PI_ENGINEERING_OMP_ADAPTER: "1",
      PI_ENGINEERING_OMP_BIN: process.execPath,
      PI_ENGINEERING_OMP_BIN_ARGS: FAKE,
      FAKE_OMP_FIXTURE: FIXTURE,
    });
    assert.deepEqual(sel?.selection, { path: "omp" });
    assert.ok(sel?.executor instanceof FallbackWorkerExecutor);
  });

  describe("OmpWorkerExecutor activity bridge (frames replayed by a real rpc child)", () => {
    const TELEMETRY = fileURLToPath(
      new URL("../fixtures/omp-frames/telemetry-failed-result-retry.jsonl", import.meta.url),
    );
    const readTool = {
      name: "read",
      description: "read",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [] }),
    } as unknown as Parameters<OmpWorkerExecutor["setCustomTools"]>[0][number];
    const activities = async (state: string): Promise<WorkerActivity[]> => {
      const e = new OmpWorkerExecutor({
        launch: { command: process.execPath, args: [FAKE] },
        env: { ...process.env, FAKE_OMP_MODE: "replay", FAKE_OMP_FIXTURE: TELEMETRY, FAKE_OMP_STATE: state },
        startTimeoutMs: 1_500,
      });
      e.setCustomTools([readTool]);
      const seen: WorkerActivity[] = [];
      const run = await e.run(req({ onActivity: (a) => seen.push(a) }));
      assert.equal(run.result.status, "completed");
      return seen;
    };
    const toolError = classifyError("ENOENT: spawn failed 429 rate limit").category;

    it("reports turns, streaming, bash-only tool progress, tool errors, pe_ renames and context usage", async () => {
      const seen = await activities("window:10000");
      assert.deepEqual(
        seen.map((a) => a.summary),
        [
          "Worker session started",
          "Model streaming",
          "Context usage",
          "Model response received",
          "Running tool: bash · npm test",
          "Tool still producing output",
          "Tool failed: bash",
          "Running tool: read · a.txt",
          "Finished tool: read",
          `Turn ended: stop=toolUse tool_error=${toolError}`,
          "Context usage",
          "Model response received",
          "Turn ended: stop=toolUse tool_error=none",
          "Context usage",
          "Model response received",
          "Turn ended: stop=toolUse tool_error=none",
        ],
      );
      assert.deepEqual(
        seen.filter((a) => a.summary === "Context usage").map((a) => a.context),
        [
          { tokens: 540, window: 10000, model: "scripted" },
          { tokens: 900, window: 10000, model: "scripted" },
          { tokens: 1200, window: 10000, model: "scripted" },
        ],
      );
    });

    it("a failed worker_result does not end reporting: the retried turns still report (M1)", async () => {
      const seen = await activities("window:10000");
      const failedAt = seen.findIndex((a) => a.context?.tokens === 900);
      assert.ok(failedAt > 0, "context usage after the failed worker_result is reported");
      assert.ok(
        seen.some((a) => a.context?.tokens === 1200),
        "the retry's turn is reported",
      );
      // The successful worker_result closes reporting: nothing follows its turn_end.
      assert.match(seen.at(-1)?.summary ?? "", /^Turn ended/);
      assert.equal(seen.filter((a) => a.context?.tokens === 1300).length, 0);
    });

    for (const state of ["error", "nowindow", "silent"]) {
      it(`get_state ${state}: no Context usage, no crash, everything else still reported`, async () => {
        const seen = await activities(state);
        assert.equal(seen.filter((a) => a.summary === "Context usage").length, 0);
        assert.ok(seen.some((a) => a.summary.startsWith("Turn ended")));
        assert.ok(seen.some((a) => a.summary === "Model streaming"));
      });
    }
  });
});
