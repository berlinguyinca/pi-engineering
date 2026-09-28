import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  discoverSessions,
  queryAllSessions,
  requestSession,
  startSessionControl,
} from "../../src/sessionControl/SessionControl.ts";

const roots: string[] = [];
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-eng-control-test-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

test("two instances of one PI session stay distinct and clean up only their own files", async () => {
  const dir = await root();
  const control = join(dir, "control");
  const first = await startSessionControl({ rootDir: control, cwd: dir, sessionId: "same-session" });
  const second = await startSessionControl({ rootDir: control, cwd: dir, sessionId: "same-session" });
  try {
    assert.notEqual(first.instanceId, second.instanceId);
    assert.equal((await stat(control)).mode & 0o777, 0o700);
    assert.equal((await stat(first.descriptorPath)).mode & 0o777, 0o600);
    assert.equal((await stat(first.socketPath)).mode & 0o777, 0o600);
    assert.equal((await discoverSessions(control)).length, 2);
    const reply = await requestSession(first.descriptor, { version: 1, op: "ping", nonce: "fresh-1" });
    assert.equal(reply.ok, true);
    if (reply.ok) assert.equal(reply.data.nonce, "fresh-1");
    await first.close();
    assert.deepEqual(
      (await discoverSessions(control)).map((s) => s.instanceId),
      [second.instanceId],
    );
    assert.equal((await requestSession(second.descriptor, { version: 1, op: "ping", nonce: "fresh-2" })).ok, true);
  } finally {
    await first.close();
    await second.close();
  }
  assert.deepEqual(await readdir(control), []);
});

test("a fresh status reply separates process heartbeat, tool activity, and stale mission progress", async () => {
  const dir = await root();
  await mkdir(join(dir, ".pi-eng"));
  await writeFile(
    join(dir, ".pi-eng", "orchestration-snapshot.json"),
    JSON.stringify({
      generatedAt: "2026-09-28T20:39:12.867Z",
      missions: [
        {
          id: "MSN-1",
          status: "REPAIRING",
          goal: "private prompt body",
          tasks: [{ id: "TSK-1", status: "FAILED" }],
          observability: {
            health: "slow",
            lastHeartbeatAt: "2026-09-28T20:09:11.443Z",
            lastMeaningfulProgressAt: "2026-09-28T20:09:11.443Z",
            errors: [{ summary: "Worker timed out" }],
          },
        },
      ],
    }),
  );
  const server = await startSessionControl({ rootDir: join(dir, "control"), cwd: dir, sessionId: "s-1" });
  try {
    server.toolStarted("mission");
    server.toolUpdated("mission", "[mission MSN-1] repairing task TSK-1");
    const reply = await requestSession(server.descriptor, { version: 1, op: "status" });
    assert.equal(reply.ok, true);
    if (!reply.ok) return;
    assert.equal(reply.data.currentTool, "mission");
    assert.equal(reply.data.instanceId, server.instanceId);
    assert.equal(reply.data.missions[0]!.status, "REPAIRING");
    assert.equal(reply.data.missions[0]!.tasks[0]!.status, "FAILED");
    assert.equal(reply.data.missions[0]!.lastHeartbeatAt, "2026-09-28T20:09:11.443Z");
    assert.equal(JSON.stringify(reply.data).includes("private prompt body"), false);
    server.toolUpdated("mission", "[mission MSN-1] repair started");
    const updated = await requestSession(server.descriptor, { version: 1, op: "status" });
    if (updated.ok) assert.equal(updated.data.lastToolProgress, "[mission MSN-1] repair started");
  } finally {
    await server.close();
  }
});

test("two sessions in one repository report only their own attributed missions", async () => {
  const dir = await root();
  await mkdir(join(dir, ".pi-eng"));
  await writeFile(
    join(dir, ".pi-eng", "orchestration-snapshot.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      missions: [
        { id: "MSN-alpha", status: "EXECUTING", tasks: [] },
        { id: "MSN-beta", status: "REPAIRING", tasks: [] },
      ],
    }),
  );
  const control = join(dir, "control");
  const first = await startSessionControl({ rootDir: control, cwd: dir, sessionId: "same-repo-a" });
  const second = await startSessionControl({ rootDir: control, cwd: dir, sessionId: "same-repo-b" });
  try {
    first.toolStarted("mission");
    second.toolStarted("mission");
    first.toolUpdated("mission", "[mission MSN-alpha] task A started");
    second.toolUpdated("mission", "[mission MSN-beta] task B started");
    const a = await requestSession(first.descriptor, { version: 1, op: "status" });
    const b = await requestSession(second.descriptor, { version: 1, op: "status" });
    if (a.ok && b.ok) {
      assert.deepEqual(
        a.data.missions.map((m) => m.id),
        ["MSN-alpha"],
      );
      assert.deepEqual(
        b.data.missions.map((m) => m.id),
        ["MSN-beta"],
      );
    } else assert.fail("both sessions must respond");
  } finally {
    await first.close();
    await second.close();
  }
});

test("a process-owned runtime mission view overrides a stale shared snapshot", async () => {
  const dir = await root();
  await mkdir(join(dir, ".pi-eng"));
  await writeFile(
    join(dir, ".pi-eng", "orchestration-snapshot.json"),
    JSON.stringify({
      generatedAt: "2026-09-28T20:00:00Z",
      missions: [{ id: "MSN-own", status: "EXECUTING", tasks: [] }],
    }),
  );
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "owner",
    getMissions: async () => [
      {
        id: "MSN-own",
        status: "REPAIRING",
        health: "slow",
        lastHeartbeatAt: "2026-09-28T20:30:00Z",
        lastMeaningfulProgressAt: null,
        tasks: [{ id: "TSK-1", status: "FAILED" }],
        lastError: "worker timed out",
      },
    ],
  });
  try {
    server.toolStarted("mission");
    server.toolUpdated("mission", "[mission MSN-own] retrying task TSK-1");
    const reply = await requestSession(server.descriptor, { version: 1, op: "status" });
    if (!reply.ok) assert.fail("process status missing");
    assert.equal(reply.data.missionSource, "runtime");
    assert.equal(reply.data.missions[0]!.status, "REPAIRING");
    assert.equal(reply.data.missions[0]!.lastError, "worker timed out");
  } finally {
    await server.close();
  }
});

test("a bounded note is acknowledged once and delivered only to the UI callback", async () => {
  const dir = await root();
  const delivered: string[] = [];
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "s-2",
    onNote: (text) => {
      delivered.push(text);
    },
  });
  try {
    const id = randomUUID();
    const request = { version: 1 as const, op: "note" as const, messageId: id, text: "How is the mission doing?" };
    assert.equal((await requestSession(server.descriptor, request)).ok, true);
    assert.equal((await requestSession(server.descriptor, request)).ok, true);
    assert.deepEqual(delivered, ["How is the mission doing?"]);
    assert.equal(
      (await requestSession(server.descriptor, { ...request, messageId: randomUUID(), text: "x".repeat(1025) })).ok,
      false,
    );
    assert.equal((await requestSession(server.descriptor, { version: 1, op: "unknown" } as never)).ok, false);
    assert.equal(delivered.length, 1);
    const reply = await requestSession(server.descriptor, { version: 1, op: "status" });
    assert.equal(JSON.stringify(reply).includes("How is the mission doing?"), false);
  } finally {
    await server.close();
  }
});

test("ping is a process-level response and concurrent tools do not make a session falsely idle", async () => {
  const dir = await root();
  const server = await startSessionControl({ rootDir: join(dir, "control"), cwd: dir, sessionId: "parallel" });
  try {
    server.toolStarted("mission", "tool-a");
    server.toolStarted("read", "tool-b");
    server.toolEnded("read", "tool-b");
    const ping = await requestSession(server.descriptor, { version: 1, op: "ping", nonce: "n" });
    assert.equal(ping.ok, true);
    if (ping.ok) {
      assert.equal(ping.data.currentTool, "mission");
      assert.equal(ping.data.missions.length, 0);
      assert.equal(ping.data.snapshotAt, null);
    }
    server.toolEnded("mission", "tool-a");
    const idle = await requestSession(server.descriptor, { version: 1, op: "ping", nonce: "n2" });
    if (idle.ok) assert.equal(idle.data.currentTool, null);
  } finally {
    await server.close();
  }
});

test("discovery handles 48 concurrent sessions and reports an unreachable descriptor", async () => {
  const dir = await root();
  const control = join(dir, "control");
  const servers = await Promise.all(
    Array.from({ length: 48 }, (_, i) => startSessionControl({ rootDir: control, cwd: dir, sessionId: `s-${i}` })),
  );
  try {
    const all = await queryAllSessions(control, { concurrency: 8, timeoutMs: 800 });
    assert.equal(all.length, 48);
    assert.equal(all.filter((row) => row.reply?.ok).length, 48);
    const staleId = randomUUID();
    const stale = { ...servers[0]!.descriptor, instanceId: staleId, socketPath: join(control, `${staleId}.sock`) };
    await writeFile(join(control, `${stale.instanceId}.json`), JSON.stringify(stale), { mode: 0o600 });
    const again = await queryAllSessions(control, { concurrency: 8, timeoutMs: 250 });
    assert.equal(again.length, 49);
    assert.equal(again.filter((row) => row.reachable === false).length, 1);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test("oversized raw requests are refused without delivering a note", async () => {
  const dir = await root();
  let notes = 0;
  const server = await startSessionControl({
    rootDir: join(dir, "control"),
    cwd: dir,
    sessionId: "s-3",
    onNote: () => {
      notes++;
    },
  });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const client = createConnection(server.socketPath);
      let body = "";
      client.on("connect", () => client.write(`${"x".repeat(9000)}\n`));
      client.on("data", (chunk) => {
        body += chunk;
      });
      client.on("end", () => resolve(body));
      client.on("error", reject);
    });
    assert.match(response, /request_too_large/);
    assert.equal(notes, 0);
  } finally {
    await server.close();
  }
});

test("discovery does not trust a socket that replies with the wrong ping nonce", async () => {
  const dir = await root();
  const control = join(dir, "control");
  const server = await startSessionControl({ rootDir: control, cwd: dir, sessionId: "honest" });
  const impostorId = randomUUID();
  const impostorPath = join(control, `${impostorId}.sock`);
  const impostor = (await import("node:net")).createServer((socket) => {
    socket.on("data", () =>
      socket.end(
        `${JSON.stringify({ version: 1, ok: true, data: { nonce: "wrong", instanceId: "forged-instance" } })}\n`,
      ),
    );
  });
  try {
    await new Promise<void>((resolve) => impostor.listen(impostorPath, resolve));
    await writeFile(
      join(control, `${impostorId}.json`),
      JSON.stringify({ ...server.descriptor, instanceId: impostorId, socketPath: impostorPath }),
      { mode: 0o600 },
    );
    const rows = await queryAllSessions(control);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.descriptor.instanceId === impostorId)?.reachable, false);
    const impostorDescriptor = rows.find((row) => row.descriptor.instanceId === impostorId)!.descriptor;
    await assert.rejects(requestSession(impostorDescriptor, { version: 1, op: "status" }), /identity/i);
  } finally {
    await new Promise<void>((resolve) => impostor.close(() => resolve()));
    await server.close();
  }
});

test("a symlinked control directory is rejected", async () => {
  const dir = await root();
  const target = join(dir, "target");
  await mkdir(target);
  await symlink(target, join(dir, "control"));
  await assert.rejects(
    startSessionControl({ rootDir: join(dir, "control"), cwd: dir, sessionId: "s" }),
    /symlink|directory/i,
  );
});
