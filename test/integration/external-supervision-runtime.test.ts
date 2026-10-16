import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { MissionOwnership } from "../../src/orchestration/ownership.ts";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

const execFileAsync = promisify(execFile);

async function initGit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"],
    { cwd: root },
  );
}

async function openRuntime(root: string, workDir: string): Promise<EngineeringRuntime> {
  await initGit(root);
  const rt = await EngineeringRuntime.open({ cwd: root, workDir, worker: new FakeWorkerExecutor({}) });
  rt.missionSupervisor!.stop();
  return rt;
}

/**
 * The supervisor must not supervise an unadopted external mission (id MSN-ext-*,
 * status NEW) that the external pump still owns: supervising it while its
 * submission receipt lease is live would misread "no tasks yet" as
 * REQUIREMENT_AMBIGUITY and durably stop the mission before the pump can start it.
 * The external mission must remain NEW with no failure classification and no stop,
 * while a control non-external NEW mission is still supervised normally.
 */
test("supervisor leaves an unadopted external NEW mission alone but still supervises non-external missions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-ext-supervise-"));
  const rt = await openRuntime(root, join(root, ".pi-eng"));
  try {
    const store = rt.missionStore!;
    // Externally submitted mission: NEW, with a live submission-receipt lease held
    // by the external owner (renewBy in the future).
    store.createMission({
      mission_id: "MSN-ext-test1",
      title: "external test1",
      goal: "an unadopted external mission",
      user_request: "an unadopted external mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    const externalOwner = new MissionOwnership(store, { ownerId: "external-owner", leaseMs: 300_000 });
    await externalOwner.acquire("MSN-ext-test1");

    // Control: a non-external NEW mission with the same (empty) shape. The
    // supervisor must still reach it, which means it is diagnosed (no tasks yet,
    // no planning in flight) and durably stopped as REQUIREMENT_AMBIGUITY.
    store.createMission({
      mission_id: "MSN-control1",
      title: "control1",
      goal: "a non-external NEW mission",
      user_request: "a non-external NEW mission",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });

    // openRuntime already ran reconcileOnStartup (one pass through admit). Drive
    // at least two more explicit supervisor ticks to satisfy the acceptance.
    await rt.missionSupervisor!.tick();
    await rt.missionSupervisor!.tick();
    await rt.missionSupervisor!.tick();

    // The unadopted external mission is untouched: still NEW, no failure
    // classification, no stop.
    const external = store.getMission("MSN-ext-test1")!;
    assert.equal(external.status, "NEW");
    assert.equal(store.listFailureClassifications("MSN-ext-test1").length, 0);
    assert.equal(store.listMissionStops("MSN-ext-test1").length, 0);

    // The control non-external mission was supervised: it was diagnosed as
    // REQUIREMENT_AMBIGUITY (no tasks, no planning) and entered the recovery
    // lifecycle (WAITING_FOR_USER), leaving NEW with a failure classification.
    const control = store.getMission("MSN-control1")!;
    assert.notEqual(control.status, "NEW");
    const controlClassifications = store.listFailureClassifications("MSN-control1");
    assert.equal(controlClassifications.length, 1);
    assert.equal(controlClassifications[0]!.category, "REQUIREMENT_AMBIGUITY");
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});
