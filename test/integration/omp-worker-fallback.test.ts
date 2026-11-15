/**
 * Fallback of the OMP-backed worker, end to end through `/engineer` and with real
 * child processes (no mocks): a missing binary, a process that crashes or hangs
 * before it is ready. In every case the run completes on the legacy executor and
 * the reason is recorded deterministically. CI-runnable: no real omp needed.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { OmpWorkerExecutor } from "../../src/omp/OmpWorkerExecutor.ts";
import {
  FallbackWorkerExecutor,
  OMP_WORKER_ENV,
  fallbackSummary,
  selectOmpWorker,
} from "../../src/omp/selectWorker.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { CommandVerifier } from "../../src/verify/Verifier.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest } from "../../src/workers/WorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

const FAKE = fileURLToPath(new URL("../support/fakeOmpRpc.mjs", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../fixtures/omp-frames/agent-turn-write-then-worker-result.jsonl", import.meta.url),
);
const ADD_OK = "export function add(a, b) {\n  return a + b;\n}\n";

const legacyFake = (): FakeWorkerExecutor =>
  new FakeWorkerExecutor({
    scout: () => ({ status: "completed", summary: "scouted" }),
    implementer: async (req) => {
      await writeFile(join(req.cwd, "src", "add.js"), ADD_OK, "utf8");
      return { status: "completed", summary: "implemented" };
    },
    reviewer: () => ({ status: "completed", summary: "clean", details: { findings: [] } }),
  });

/** Records what the run told its owner, so the fallback reason is observable. */
const recording = (inner: WorkerExecutor, seen: string[]): WorkerExecutor => ({
  run: (req: WorkerRequest) =>
    inner.run({ ...req, onActivity: (a: WorkerActivity) => (a.kind === "state" ? seen.push(a.summary) : undefined) }),
});

async function engineerWith(worker: WorkerExecutor): Promise<string> {
  const fx = await makeFixtureRepo();
  try {
    const rt = await EngineeringRuntime.open({ cwd: fx.root, worker, verifier: new CommandVerifier() });
    try {
      return (await rt.engineer("Implement add(a, b) to return the sum of a and b")).outcome;
    } finally {
      await rt.close();
    }
  } finally {
    await fx.cleanup();
  }
}

const fakeEnv = (mode: string): NodeJS.ProcessEnv => ({
  ...process.env,
  [OMP_WORKER_ENV]: "1",
  PI_ENGINEERING_OMP_ADAPTER: "1",
  PI_ENGINEERING_OMP_BIN: process.execPath,
  PI_ENGINEERING_OMP_BIN_ARGS: FAKE,
  PI_ENGINEERING_OMP_TIMEOUT_MS: "1500",
  FAKE_OMP_MODE: mode,
  FAKE_OMP_FIXTURE: FIXTURE,
});

describe("flag selection falls back to legacy when omp is unavailable", () => {
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; reason: RegExp }> = [
    {
      name: "binary absent",
      env: { ...fakeEnv("replay"), PI_ENGINEERING_OMP_BIN: "/nonexistent/omp-bin", PI_ENGINEERING_OMP_BIN_ARGS: "" },
      reason: /^binary_absent/,
    },
    { name: "crash before ready", env: fakeEnv("crash-before-ready"), reason: /^crashed/ },
    { name: "hang before ready", env: fakeEnv("hang-before-ready"), reason: /^(timeout|handshake_timeout|timed_out)/ },
  ];
  for (const c of cases) {
    it(`${c.name}: legacy executor, reason recorded, /engineer still completes`, async () => {
      const legacy = legacyFake();
      const picked = await selectOmpWorker(() => legacy, c.env);
      assert.equal(picked?.selection.path, "legacy");
      assert.match((picked?.selection as { reason: string }).reason, c.reason);
      assert.equal(picked?.executor, legacy);
      assert.equal(await engineerWith(picked?.executor ?? legacy), "promoted");
    });
  }

  it("with the flag unset nothing is selected and nothing changes", async () => {
    assert.equal(await selectOmpWorker(legacyFake, { PI_ENGINEERING_OMP_ADAPTER: "1" }), undefined);
  });
});

describe("per-run fallback inside /engineer", () => {
  for (const mode of ["crash-before-ready", "hang-before-ready"]) {
    it(`${mode}: the run falls back to legacy and records a deterministic reason`, async () => {
      const seen: string[] = [];
      const omp = new OmpWorkerExecutor({
        launch: { command: process.execPath, args: [FAKE] },
        env: { ...process.env, FAKE_OMP_MODE: mode, FAKE_OMP_FIXTURE: FIXTURE },
        startTimeoutMs: 800,
      });
      const outcome = await engineerWith(recording(new FallbackWorkerExecutor(omp, legacyFake()), seen));
      assert.equal(outcome, "promoted");
      assert.ok(seen.length >= 3, "one fallback record per worker run (scout, implementer, reviewer)");
      for (const line of seen)
        assert.equal(line, fallbackSummary(line.slice(line.indexOf("(") + 1, line.lastIndexOf(")"))));
      assert.match(seen[0] ?? "", /^omp worker unavailable \(.+\); using legacy executor$/);
    });
  }
});
