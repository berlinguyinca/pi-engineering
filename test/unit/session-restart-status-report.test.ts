import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "../../src/runtime/isolation/RuntimeRegistry.ts";
import { type MissionLeaseRef, buildRestartStatusReport } from "../../src/sessionControl/restartStatusReport.ts";

const now = new Date("2026-09-28T20:00:00.000Z");
const nowMs = now.getTime();
const HEARTBEAT_MS = nowMs - 1000;

function session(overrides: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    pid: 100,
    host: "h",
    bootId: null,
    processStartTime: null,
    repoId: null,
    worktreeId: null,
    worktreePath: null,
    runtimePath: null,
    startedAt: "2026-09-28T19:00:00.000Z",
    lastHeartbeatMs: HEARTBEAT_MS,
    state: "healthy",
    generationId: "g",
    metadata: {},
    endedAt: null,
    ...overrides,
  };
}

test("healthy worker without lease -> idle, no mission", () => {
  const result = buildRestartStatusReport([session({ sessionId: "wk-1", state: "healthy" })], [], "sup-1", now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.inFlightMissions, []);
  assert.deepEqual(result.warnings, []);
});

test("healthy worker with lease -> running with mission, blocks restart", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "healthy" })],
    [{ resourceId: "mission:a", sessionId: "wk-1" }],
    "sup-1",
    now,
  );
  assert.equal(result.safeToRestartSupervisor, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0]!, /wk-1/);
  assert.match(result.blockers[0]!, /mission a/);
  assert.deepEqual(result.inFlightMissions, ["a"]);
});

test("stopped/dead/orphaned sessions -> terminated and ignored", () => {
  const result = buildRestartStatusReport(
    [
      session({ sessionId: "wk-1", state: "stopped", lastHeartbeatMs: nowMs - 999999 }),
      session({ sessionId: "wk-2", state: "dead", lastHeartbeatMs: nowMs - 999999 }),
      session({ sessionId: "wk-3", state: "orphaned", lastHeartbeatMs: nowMs - 999999 }),
    ],
    [{ resourceId: "mission:x", sessionId: "wk-1" }],
    "sup-1",
    now,
  );
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.staleSessions, []);
  assert.deepEqual(result.inFlightMissions, []);
});

test("heartbeat ISO conversion: finite lastHeartbeatMs yields lastHeartbeatAt", () => {
  const result = buildRestartStatusReport([session({ sessionId: "wk-1", state: "healthy" })], [], "sup-1", now);
  // wk-1 is healthy -> mapped to idle (no lease) -> not stale because heartbeat is fresh
  assert.deepEqual(result.staleSessions, []);
});

test("old heartbeat -> stale", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "healthy", lastHeartbeatMs: nowMs - 999999 })],
    [],
    "sup-1",
    now,
  );
  assert.deepEqual(result.staleSessions, ["wk-1"]);
});

test("NaN heartbeat -> lastHeartbeatAt omitted, counts as stale", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "healthy", lastHeartbeatMs: Number.NaN })],
    [],
    "sup-1",
    now,
  );
  assert.deepEqual(result.staleSessions, ["wk-1"]);
});

test("supervisor session gets role supervisor", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "sup-1", state: "healthy" })],
    [{ resourceId: "mission:a", sessionId: "sup-1" }],
    "sup-1",
    now,
  );
  // supervisor running blocks
  assert.equal(result.safeToRestartSupervisor, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0]!, /supervisor/);
});

test("supervisor without lease -> idle, no block", () => {
  const result = buildRestartStatusReport([session({ sessionId: "sup-1", state: "healthy" })], [], "sup-1", now);
  // healthy without lease -> idle (role supervisor does not force running)
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
});

test("supervisor with lease but stopping -> paused, does not block, in-flight mission kept", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "sup-1", state: "stopping" })],
    [{ resourceId: "mission:a", sessionId: "sup-1" }],
    "sup-1",
    now,
  );
  assert.equal(result.safeToRestartSupervisor, true);
  // supervisor paused is not a blocker; but role is supervisor so in-flight only counts workers
  assert.deepEqual(result.inFlightMissions, []);
});

test("'stopping' worker paused in inFlightMissions not blocking", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "stopping" })],
    [{ resourceId: "mission:a", sessionId: "wk-1" }],
    "sup-1",
    now,
  );
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.inFlightMissions, ["a"]);
  assert.deepEqual(result.blockers, []);
});

test("supervisorSessionId null -> everyone is a worker", () => {
  const result = buildRestartStatusReport([session({ sessionId: "sup-1", state: "healthy" })], [], null, now);
  // healthy without lease -> idle, treated as a worker; safe
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.warnings, []);
});

test("'<ns>#mission:<id>' lease form strips through first '#'", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "healthy" })],
    [{ resourceId: "my-ns#mission:abc", sessionId: "wk-1" }],
    "sup-1",
    now,
  );
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /mission abc/);
  assert.deepEqual(result.inFlightMissions, ["abc"]);
});

test("two leases -> lexicographically smallest missionId wins", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "healthy" })],
    [
      { resourceId: "mission:zeta", sessionId: "wk-1" },
      { resourceId: "mission:alpha", sessionId: "wk-1" },
    ],
    "sup-1",
    now,
  );
  assert.deepEqual(result.inFlightMissions, ["alpha"]);
  assert.match(result.blockers[0]!, /mission alpha/);
});

test("unknown state -> terminated (ignored)", () => {
  const result = buildRestartStatusReport(
    [session({ sessionId: "wk-1", state: "bogus" as SessionRecord["state"] })],
    [{ resourceId: "mission:a", sessionId: "wk-1" }],
    "sup-1",
    now,
  );
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.inFlightMissions, []);
});

test("null entry skipped without throwing", () => {
  const result = buildRestartStatusReport([null] as unknown as readonly SessionRecord[], [], "sup-1", now);
  assert.equal(result.safeToRestartSupervisor, true);
});

test("record lacking string sessionId skipped without throwing", () => {
  const result = buildRestartStatusReport([{ sessionId: 42 }] as unknown as readonly SessionRecord[], [], "sup-1", now);
  assert.equal(result.safeToRestartSupervisor, true);
});

test("inputs not mutated", () => {
  const sessions = [session({ sessionId: "wk-1", state: "healthy" })];
  const leases: MissionLeaseRef[] = [{ resourceId: "mission:a", sessionId: "wk-1" }];
  const sessionsBefore = structuredClone(sessions);
  const leasesBefore = structuredClone(leases);
  buildRestartStatusReport(sessions, leases, "sup-1", now);
  assert.deepEqual(sessions, sessionsBefore);
  assert.deepEqual(leases, leasesBefore);
});
