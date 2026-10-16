import assert from "node:assert/strict";
import { test } from "node:test";
import { type RestartStatusSession, computeRestartStatus } from "../../src/sessionControl/restartStatus.ts";

const now = new Date("2026-09-28T20:00:00.000Z");

function hb(msAgo: number): string {
  return new Date(now.getTime() - msAgo).toISOString();
}

test("empty sessions input -> safe to restart supervisor with empty lists", () => {
  const result = computeRestartStatus([], now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.staleSessions, []);
  assert.deepEqual(result.inFlightMissions, []);
  assert.equal(result.summary, "safe=true;blockers=0;stale=0;inFlight=0");
});

test("running worker blocks restart and names the session (and mission)", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle", lastHeartbeatAt: hb(1000) },
    { sessionId: "wk-1", role: "worker", state: "running", missionId: "mission-a", lastHeartbeatAt: hb(1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0]!, /wk-1/);
  assert.match(result.blockers[0]!, /mission-a/);
  assert.equal(result.summary, "safe=false;blockers=1;stale=0;inFlight=1");
});

test("running worker without mission still blocks and names the session", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle" },
    { sessionId: "wk-1", role: "worker", state: "running" },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0]!, /wk-1/);
  assert.doesNotMatch(result.blockers[0]!, /mission/);
});

test("stale heartbeat exactly at the 45000ms boundary is NOT stale", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: hb(45000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, []);
});

test("stale heartbeat just past the 45000ms boundary is stale", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: hb(45001) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, ["wk-1"]);
});

test("paused supervisor with idle workers -> safe", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "paused", lastHeartbeatAt: hb(1000) },
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: hb(1000) },
    { sessionId: "wk-2", role: "worker", state: "idle", lastHeartbeatAt: hb(1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.summary, "safe=true;blockers=0;stale=0;inFlight=0");
});

test("running supervisor makes restart unsafe", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "running", lastHeartbeatAt: hb(1000) },
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: hb(1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0]!, /supervisor/);
  assert.match(result.blockers[0]!, /sup-1/);
});

test("terminated sessions are ignored (excluded from stale and from blocking)", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "terminated", lastHeartbeatAt: hb(10 * 60 * 1000) },
    {
      sessionId: "wk-1",
      role: "worker",
      state: "terminated",
      missionId: "mission-x",
      lastHeartbeatAt: hb(10 * 60 * 1000),
    },
    { sessionId: "wk-2", role: "worker", state: "idle", lastHeartbeatAt: hb(10 * 60 * 1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, ["wk-2"]);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.inFlightMissions, []);
});

test("in-flight missions are distinct and in first-seen order across running and paused workers", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "wk-1", role: "worker", state: "running", missionId: "m-1" },
    { sessionId: "wk-2", role: "worker", state: "paused", missionId: "m-2" },
    { sessionId: "wk-3", role: "worker", state: "running", missionId: "m-1" },
    { sessionId: "wk-4", role: "worker", state: "idle", missionId: "m-3" },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.inFlightMissions, ["m-1", "m-2"]);
});

test("custom staleAfterMs threshold is respected", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: hb(5000) },
  ];
  const strict = computeRestartStatus(sessions, now, { staleAfterMs: 1000 });
  assert.deepEqual(strict.staleSessions, ["wk-1"]);
  const loose = computeRestartStatus(sessions, now, { staleAfterMs: 10000 });
  assert.deepEqual(loose.staleSessions, []);
});
