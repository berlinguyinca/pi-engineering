import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineeringRuntime } from "../../src/runtime/EngineeringRuntime.ts";
import { FakeWorkerExecutor } from "../../src/workers/FakeWorkerExecutor.ts";

for (const routing of ["standalone", "unavailable", "available"] as const) {
  test(`runtime custom reviewer honors ${routing} routing without requiring a Pi registry`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-custom-reviewer-"));
    let rt: EngineeringRuntime | undefined;
    let calls = 0;
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ]);
      rt = await EngineeringRuntime.open({
        cwd: root,
        agentDir: join(root, "agent"),
        workDir: join(root, "state"),
        worker: new FakeWorkerExecutor({
          reviewer: (req) => {
            calls++;
            assert.equal(req.modelOverride?.id, routing === "available" ? "custom-reviewer" : undefined);
            return { status: "completed", summary: "custom review completed" };
          },
        }),
        ...(routing === "standalone"
          ? {}
          : {
              roleRouter: {
                route: async () =>
                  routing === "available" ? { provider: "custom", id: "custom-reviewer" } : undefined,
              },
            }),
      });
      rt.missionSupervisor?.stop();
      const mission = rt.missionStore!.createMission({
        title: "custom review",
        goal: "custom review",
        user_request: "custom review",
        repository: root,
        base_ref: await rt.git!.headCommit(),
        risk_profile: "low",
        workflow_class: "engineering",
      });
      const task = rt.missionStore!.createTask({
        mission_id: mission.mission_id,
        kind: "agent",
        role: "reviewer",
        objective: "review",
        mutates_repo: false,
        isolation: "none",
      });
      const handle = await rt.orchestrator!.broker.execute({
        missionId: mission.mission_id,
        taskId: task.task_id,
        kind: "agent",
        role: "reviewer",
        objective: "review",
        mutatesRepo: false,
        isolation: "none",
      });
      const outcome = await handle.result();
      assert.equal(outcome.exitStatus, routing === "unavailable" ? "failed" : "succeeded", outcome.summary);
      assert.equal(calls, routing === "unavailable" ? 0 : 1);
      if (routing === "unavailable") assert.equal(outcome.error, "transient:model_unavailable");
    } finally {
      await rt?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
