/**
 * Mission custody survives an in-process reload (runtime isolation + Host).
 *
 * A reload stops the old generation by replaying session_shutdown, which
 * closes its EngineeringRuntime. The session itself continues, so its mission
 * custody must not be given away in the window before the next generation
 * re-claims it: a second LIVE process whose supervisor admits missions at that
 * moment must not take them. A real (non-reload) shutdown does give custody up.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { RuntimeSession } from "../../src/runtime/isolation/RuntimeSession.ts";
import { withReloadShutdown } from "../../src/runtime/isolation/reloadCustody.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";
import { makeGitRepo, startChild } from "../support/childSessions.ts";

let root = "";
const savedHome = process.env.HOME;
before(() => {
  root = mkdtempSync(join(tmpdir(), "rt-reload-custody-"));
  process.env.HOME = join(root, "home");
});
after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

async function admitFromSecondProcess(repo: string): Promise<string[]> {
  const child = startChild("admit", repo, process.env.PI_ENGINEERING_STATE_DIR as string, {
    env: { HOME: process.env.HOME },
  });
  const report = await child.report;
  await child.exited;
  assert.equal(report.ok, true, report.error);
  return report.heldLeases ?? [];
}

test("a reload keeps mission custody with the session; a second live process cannot admit the mission meanwhile", async () => {
  const repo = await makeGitRepo(join(root, "repo"));
  const first = await EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
  const mission = first.missionStore!.createMission({
    title: "custody across reload",
    goal: "keep custody",
    user_request: "keep custody",
    repository: repo,
    base_ref: "",
    risk_profile: "low",
    workflow_class: "conversation",
  });
  await first.missionStore!.flush();
  await first.close();

  // Generation 1 drives the mission: it holds its custody (as a dispatching mission does).
  const g1 = await EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
  await g1.missionOwnership!.acquire(mission.mission_id);
  const session = RuntimeSession.current();
  const custodyLease = () =>
    session
      .registry()
      ?.leases.list()
      .find((lease) => lease.resourceId.endsWith(`#mission:${mission.mission_id}`));
  const held = custodyLease();
  assert.equal(held?.sessionId, session.sessionId, "generation 1 holds custody");

  // The reload stops generation 1 ...
  await withReloadShutdown(() => g1.close());
  assert.equal(custodyLease()?.generationId, held?.generationId, "custody kept across the reload window");
  // ... and in that window another live session's supervisor tries to admit it.
  const otherHeld = await admitFromSecondProcess(repo);
  assert.equal(
    otherHeld.some((resource) => resource.endsWith(`#mission:${mission.mission_id}`)),
    false,
    "the other session did not take the mission",
  );

  // Generation 2 (same session) takes the mission over: custody never left the session.
  const g2 = await EngineeringRuntime.open({ cwd: repo, worker: new FakeWorkerExecutor({}) });
  await g2.missionOwnership!.acquire(mission.mission_id);
  assert.equal(custodyLease()?.sessionId, session.sessionId, "generation 2 holds custody");

  // A real shutdown (not a reload) gives custody up; then the other session may admit.
  await g2.close();
  assert.equal(custodyLease(), undefined, "released on a real shutdown");
  const adopted = await admitFromSecondProcess(repo);
  assert.equal(
    adopted.some((resource) => resource.endsWith(`#mission:${mission.mission_id}`)),
    true,
    "after a real shutdown another session may take custody",
  );
});
