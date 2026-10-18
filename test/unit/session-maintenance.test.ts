import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { requestSession, startSessionControl } from "../../src/sessionControl/SessionControl.ts";
import { runSessionsCommand } from "../../src/sessionControl/cli.ts";
import { MaintenanceOperations } from "../../src/sessionControl/maintenance.ts";

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "pi-maintenance-test-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("maintenance operation survives a new controller and executes a request only once", async () => {
  const dir = await root();
  let calls = 0;
  const operations = new MaintenanceOperations(dir, "conversation", async () => {
    calls++;
    return { status: "succeeded", result: { commit: "a".repeat(40) } };
  });
  const request = {
    operationId: "rollout-1-reload",
    action: "reload" as const,
    expectedInstanceId: "instance-1",
    expectedCommit: "a".repeat(40),
  };
  await operations.submit(request);
  await operations.waitForIdle();
  const restarted = new MaintenanceOperations(dir, "conversation", async () => {
    calls++;
    throw new Error("must not repeat");
  });
  const receipt = await restarted.submit(request);
  assert.equal(receipt.status, "succeeded");
  assert.equal(calls, 1);
  await assert.rejects(restarted.submit({ ...request, expectedCommit: "b".repeat(40) }), /operation_id_conflict/);
});

test("concurrent duplicate requests share one durable operation", async () => {
  const dir = await root();
  let calls = 0;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operations = new MaintenanceOperations(dir, "conversation", async () => {
    calls++;
    await done;
    return { status: "succeeded" };
  });
  const request = { operationId: "same", action: "prepare" as const, expectedInstanceId: "instance" };
  await Promise.all(Array.from({ length: 12 }, () => operations.submit(request)));
  finish();
  await operations.waitForIdle();
  assert.equal(calls, 1);
  assert.equal((await operations.get("same"))?.status, "succeeded");
});

test("socket rejects the wrong instance before maintenance can mutate anything", async () => {
  const dir = await root();
  let calls = 0;
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "conversation",
    maintenanceRoot: join(dir, "operations"),
    onMaintenance: async () => {
      calls++;
      return { status: "succeeded" };
    },
  });
  try {
    const response = await requestSession(server.descriptor, {
      version: 1,
      op: "maintenance",
      request: {
        operationId: "wrong-target",
        action: "prepare",
        expectedInstanceId: "wrong-instance",
      },
    });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error, "stale_session_instance");
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test("socket acknowledges running separately from completion and publishes actual runtime provenance", async () => {
  const dir = await root();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runtime = {
    hostCommit: "b".repeat(40),
    commit: "a".repeat(40),
    generation: 2,
    capabilities: ["runtime.describe", "runtime.reload"],
    pending: false,
  };
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "conversation",
    maintenanceRoot: join(dir, "operations"),
    getRuntime: () => runtime,
    onMaintenance: async () => {
      await done;
      return { status: "succeeded", result: runtime };
    },
  });
  try {
    const request = {
      operationId: "reload",
      action: "reload" as const,
      expectedInstanceId: server.instanceId,
      expectedCommit: "a".repeat(40),
    };
    const response = await requestSession(server.descriptor, { version: 1, op: "maintenance", request });
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.equal(response.data.maintenance?.status, "running");
      assert.equal(response.data.runtime?.commit, runtime.commit);
    }
    finish();
    await server.waitForMaintenance();
    const completed = await requestSession(server.descriptor, {
      version: 1,
      op: "maintenance",
      request: {
        operationId: "reload",
        action: "status",
        expectedInstanceId: server.instanceId,
      },
    });
    assert.equal(completed.ok, true);
    if (completed.ok) assert.equal(completed.data.maintenance?.status, "succeeded");
  } finally {
    finish();
    await server.close();
  }
});

test("owned missions are reported without tool progress and do not include sibling missions", async () => {
  const dir = await root();
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "owner",
    getOwnedMissions: async () => [
      {
        id: "MSN-owned",
        status: "BLOCKED",
        health: null,
        lastHeartbeatAt: null,
        lastMeaningfulProgressAt: null,
        tasks: [],
        lastError: null,
        revision: 7,
        resumptionGeneration: 1,
        operatorPaused: false,
        resumeEligible: true,
      },
    ],
  });
  try {
    const response = await requestSession(server.descriptor, { version: 1, op: "status" });
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.deepEqual(response.data.missionIds, ["MSN-owned"]);
      assert.equal(response.data.missions[0]?.revision, 7);
    }
  } finally {
    await server.close();
  }
});

test("maintenance CLI carries structured requests and refuses mismatched targeting", async () => {
  const dir = await root();
  let calls = 0;
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "conversation",
    maintenanceRoot: join(dir, "operations"),
    onMaintenance: async () => {
      calls++;
      return { status: "succeeded" };
    },
  });
  try {
    let output = "";
    const request = { operationId: "cli-prepare", action: "prepare", expectedInstanceId: server.instanceId };
    const options = {
      rootDir: join(dir, "control"),
      write: (text: string) => {
        output += text;
      },
      error: () => {},
    };
    assert.equal(
      await runSessionsCommand(
        [
          "maintenance",
          server.instanceId,
          "--request-json",
          JSON.stringify({ ...request, expectedInstanceId: "stale" }),
        ],
        options,
      ),
      2,
    );
    assert.equal(calls, 0);
    assert.equal(
      await runSessionsCommand(["maintenance", server.instanceId, "--request-json", JSON.stringify(request)], options),
      0,
    );
    assert.equal(JSON.parse(output).maintenance.status, "running");
    await server.waitForMaintenance();
    output = "";
    assert.equal(
      await runSessionsCommand(
        ["maintenance", server.instanceId, "--request-json", JSON.stringify({ ...request, action: "status" })],
        options,
      ),
      0,
    );
    assert.equal(JSON.parse(output).maintenance.status, "succeeded");
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test("invalid maintenance requests never claim an operation or invoke a handler", async () => {
  const dir = await root();
  let calls = 0;
  const operations = new MaintenanceOperations(dir, "conversation", async () => {
    calls++;
    return { status: "succeeded" };
  });
  const request = {
    operationId: "invalid",
    action: "resume" as const,
    expectedInstanceId: "instance",
    expectedCommit: "a".repeat(40),
  };
  await assert.rejects(operations.submit(request), /mission_fence_required/);
  await assert.rejects(operations.submit({ ...request, operationId: "../escape" }), /invalid_operation_id/);
  assert.equal(calls, 0);
  assert.equal(await operations.get("invalid"), null);
});

test("different operation IDs cannot mutate one conversation concurrently across controllers", async () => {
  const dir = await root();
  let calls = 0;
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = new MaintenanceOperations(dir, "conversation", async () => {
    calls++;
    started();
    await done;
    return { status: "succeeded" };
  });
  const second = new MaintenanceOperations(dir, "conversation", async () => {
    calls++;
    return { status: "succeeded" };
  });
  await first.submit({
    operationId: "reload-1",
    action: "reload",
    expectedInstanceId: "instance",
    expectedCommit: "a".repeat(40),
  });
  await running;
  try {
    await second.submit({ operationId: "prepare-2", action: "prepare", expectedInstanceId: "instance" });
    await second.waitForIdle();
    assert.equal((await second.get("prepare-2"))?.status, "skipped");
    assert.equal((await second.get("prepare-2"))?.result?.status, "busy");
    assert.equal(calls, 1);
  } finally {
    finish();
    await first.waitForIdle();
  }
});

test("a matching instance alone does not authorize a different PID or conversation", async () => {
  const dir = await root();
  for (const mismatch of ["pid", "sessionId"] as const) {
    const socketPath = join(dir, `${mismatch}.sock`);
    const descriptor = {
      version: 1 as const,
      instanceId: "instance",
      sessionId: "conversation",
      cwd: dir,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      socketPath,
    };
    const fake = createServer((socket) =>
      socket.on("data", () =>
        socket.end(
          `${JSON.stringify({
            version: 1,
            ok: true,
            data: {
              instanceId: descriptor.instanceId,
              pid: process.pid,
              sessionId: descriptor.sessionId,
              [mismatch]: mismatch === "pid" ? process.pid + 1 : "other",
            },
          })}\n`,
        ),
      ),
    );
    await new Promise<void>((resolve) => fake.listen(socketPath, resolve));
    try {
      await assert.rejects(requestSession(descriptor, { version: 1, op: "status" }), /identity_mismatch/);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  }
});

test("retiring a session before its durable claim settles prevents a queued mutation", async () => {
  const dir = await root();
  let calls = 0;
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "conversation",
    maintenanceRoot: join(dir, "operations"),
    onMaintenance: async () => {
      calls++;
      return { status: "succeeded" };
    },
  });
  // Enter the real request handler directly to control the retirement boundary
  // before its asynchronous receipt write completes, without a timing sleep.
  const pending = (server as unknown as { reply(input: unknown): Promise<unknown> }).reply({
    version: 1,
    op: "maintenance",
    request: { operationId: "retired", action: "prepare", expectedInstanceId: server.instanceId },
  });
  await server.close();
  await pending;
  await server.waitForMaintenance();
  assert.equal(calls, 0);
});
