import assert from "node:assert/strict";
import { test } from "node:test";
import { maintenanceHandler } from "../../src/sessionControl/runtimeMaintenance.ts";

const sha = "a".repeat(40);
const runtime = {
  hostCommit: sha,
  commit: sha,
  generation: 2,
  capabilities: ["runtime.describe", "runtime.reload"],
  pending: false,
};
const request = {
  operationId: "resume-1",
  action: "resume" as const,
  expectedInstanceId: "instance",
  expectedCommit: sha,
  missionId: "MSN-owned",
  expectedRevision: 3,
  expectedResumptionGeneration: 0,
};

test("maintenance cannot resume a sibling mission or a mission under an unverified build", async () => {
  let calls = 0;
  const handler = maintenanceHandler({
    getHost: () => ({ describe: async () => runtime, reload: async () => ({ ok: true, commit: sha, generation: 3 }) }),
    getRuntime: async () => ({
      resumeMissionAfterMaintenance: async () => {
        calls++;
        return { status: "resumed", mission: { mission_id: "MSN-owned" } };
      },
    }),
    ownedMissionIds: async () => ["MSN-owned"],
  });
  await assert.rejects(handler({ ...request, missionId: "MSN-sibling" }), /mission_not_owned/);
  await assert.rejects(handler({ ...request, expectedCommit: "b".repeat(40) }), /loaded_commit_mismatch/);
  assert.equal(calls, 0);
  assert.equal((await handler(request)).status, "succeeded");
  assert.equal(calls, 1);
});

test("an unavailable host and a busy drain cannot be presented as an activated runtime", async () => {
  const absent = maintenanceHandler({
    getHost: () => undefined,
    getRuntime: async () => null,
    ownedMissionIds: async () => [],
  });
  await assert.rejects(absent({ ...request, action: "describe" }), /host_maintenance_unavailable/);
  const busy = maintenanceHandler({
    getHost: () => ({ describe: async () => runtime, reload: async () => ({ ok: true, commit: sha, generation: 3 }) }),
    getRuntime: async () => ({
      prepareForMaintenance: async () => ({ status: "busy", reason: "integration in flight" }),
    }),
    ownedMissionIds: async () => [],
  });
  const result = await busy({ ...request, action: "prepare" });
  assert.equal(result.status, "skipped");
  assert.equal(result.result?.status, "busy");
});
