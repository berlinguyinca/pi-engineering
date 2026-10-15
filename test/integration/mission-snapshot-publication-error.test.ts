import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

test("snapshot publication failure names the error and records a finding", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-eng-snapshot-error-"));
  const workDir = join(root, ".pi-eng");
  const warnings: string[] = [];
  try {
    const runtime = await EngineeringRuntime.open({
      cwd: root,
      workDir,
      worker: new FakeWorkerExecutor({}),
      onMissionSnapshotError: (message) => warnings.push(message),
    });
    const mission = runtime.missionStore!.createMission({
      title: "publish failure",
      goal: "g",
      user_request: "g",
      repository: root,
      base_ref: "",
      risk_profile: "low",
      workflow_class: "engineering",
    });
    // Make every snapshot write fail: the work directory path becomes a file.
    await rm(workDir, { recursive: true, force: true });
    await writeFile(workDir, "not a directory", "utf8");
    assert.equal(await runtime.publishMissionSnapshot(), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /ENOTDIR|ENOENT/);
    const finding = runtime
      .missionStore!.listFindings(mission.mission_id)
      .find((f) => f.category === "snapshot-publication");
    assert.match(finding?.summary ?? "", /ENOTDIR|ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
