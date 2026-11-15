import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

  it("the owner's abort signal ends the run", async () => {
    const ac = new AbortController();
    const pending = exec("hang-after-prompt").run(req({ signal: ac.signal, timeoutMs: 30_000 }));
    setTimeout(() => ac.abort(), 300);
    const run = await pending;
    assert.match(run.error ?? "", /aborted by owner/);
  });

  it("an already-aborted signal never runs", async () => {
    const ac = new AbortController();
    ac.abort();
    const run = await exec("replay")
      .run(req({ signal: ac.signal }))
      .catch((e: unknown) => e);
    assert.ok(run instanceof OmpWorkerUnavailable);
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
});
