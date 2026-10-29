import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { LedgerWorkProjection } from "../../src/work/ledgerProjection.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeFixtureRepo } from "../fixtures/make-fixture.ts";

test("engineer() records a finished run per worker, bound to its work item and session", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      implementer: async (req) => {
        await writeFile(join(req.cwd, "README.md"), "Corrected spelling\n");
        return { status: "completed", summary: "edited" };
      },
      reviewer: () => ({ status: "completed", summary: "reviewed", details: { findings: [] } }),
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
    const report = await rt.engineer("Fix README typo");
    const projection = new LedgerWorkProjection(rt.ledger);
    projection.catchUp();
    const runs = projection.graph().runs.filter((r) => r.task_id === report.work_item.id);
    assert.ok(runs.length >= 1, "at least the implementer run is visible");
    for (const run of runs) {
      assert.equal(run.health, "finished");
      assert.equal(run.outcome, "completed");
      assert.ok(run.session_id, "a run names its session");
      assert.ok(run.started_at && run.ended_at);
    }
    const started = rt.ledger.events().filter((e) => e.type === "agent.started");
    assert.equal(new Set(started.map((e) => e.run_id)).size, started.length, "one start per run");
  } finally {
    await fixture.cleanup();
  }
});

test("a worker that throws leaves a failed run, never an active one", async () => {
  const fixture = await makeFixtureRepo();
  try {
    const worker = new FakeWorkerExecutor({
      implementer: () => {
        throw new Error("boom");
      },
    });
    const rt = await EngineeringRuntime.open({ cwd: fixture.root, worker });
    await rt.engineer("Fix README typo").catch(() => undefined);
    const projection = new LedgerWorkProjection(rt.ledger);
    projection.catchUp();
    const runs = projection.graph().runs;
    assert.ok(
      runs.some((r) => r.health === "failed"),
      "the thrown worker is a failed run",
    );
    assert.ok(
      runs.every((r) => r.health !== "active"),
      "no run is left active",
    );
  } finally {
    await fixture.cleanup();
  }
});
