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
  assert.deepEqual(result.warnings, []);
  assert.equal(result.summary, "safe=true;blockers=0;stale=0;inFlight=0;warnings=0");
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
  assert.equal(result.summary, "safe=false;blockers=1;stale=0;inFlight=1;warnings=0");
});

test("running worker without mission does NOT block, adds a warning instead", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle" },
    { sessionId: "wk-1", role: "worker", state: "running" },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.equal(result.blockers.length, 0);
  assert.deepEqual(result.warnings, ["worker wk-1 is running without a mission"]);
  assert.equal(result.summary, "safe=true;blockers=0;stale=2;inFlight=0;warnings=1");
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
  assert.equal(result.summary, "safe=true;blockers=0;stale=0;inFlight=0;warnings=0");
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

test("terminated sessions are ignored (excluded from stale, blocking, and in-flight)", () => {
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

// ---- New tests from the review gap ----

test("terminated supervisor alone -> safe with empty blockers", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "terminated", lastHeartbeatAt: hb(10 * 60 * 1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
});

test("running sup-1 then idle sup-2 -> unsafe with exactly one blocker naming sup-1", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "running", lastHeartbeatAt: hb(1000) },
    { sessionId: "sup-2", role: "supervisor", state: "idle", lastHeartbeatAt: hb(1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0]!, /sup-1/);
});

test("two idle supervisors -> safe", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle", lastHeartbeatAt: hb(1000) },
    { sessionId: "sup-2", role: "supervisor", state: "idle", lastHeartbeatAt: hb(1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.blockers, []);
});

test("paused worker with mission -> safe, inFlightMissions contains it", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle", lastHeartbeatAt: hb(1000) },
    { sessionId: "wk-1", role: "worker", state: "paused", missionId: "mission-a", lastHeartbeatAt: hb(1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.equal(result.safeToRestartSupervisor, true);
  assert.deepEqual(result.inFlightMissions, ["mission-a"]);
});

test("stale supervisor (old heartbeat) appears in staleSessions", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle", lastHeartbeatAt: hb(10 * 60 * 1000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, ["sup-1"]);
});

test("missing heartbeat -> stale (fail closed)", () => {
  const sessions: RestartStatusSession[] = [{ sessionId: "sup-1", role: "supervisor", state: "idle" }];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, ["sup-1"]);
});

test("unparseable heartbeat -> stale (fail closed)", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: "not-a-date" },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, ["wk-1"]);
});

test("boundary heartbeat (exactly now - staleAfterMs) -> not stale", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "wk-1", role: "worker", state: "idle", lastHeartbeatAt: hb(45000) },
  ];
  const result = computeRestartStatus(sessions, now);
  assert.deepEqual(result.staleSessions, []);
});

test("sessions not an array -> invalid input, unsafe", () => {
  // @ts-expect-error intentional invalid input
  const result = computeRestartStatus("nope", now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.deepEqual(result.blockers, ["invalid input: sessions is not an array"]);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("null entry -> invalid input, no throw", () => {
  const sessions = [null];
  const result = computeRestartStatus(sessions as unknown as RestartStatusSession[], now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /^invalid input:/);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("state 'bogus' -> invalid input", () => {
  const sessions = [{ sessionId: "wk-1", role: "worker", state: "bogus" }];
  const result = computeRestartStatus(sessions as unknown as RestartStatusSession[], now);
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /^invalid input:/);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("now = new Date(NaN) -> invalid input", () => {
  const result = computeRestartStatus([], new Date(Number.NaN));
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /^invalid input:/);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("staleAfterMs 0 -> invalid input", () => {
  const result = computeRestartStatus([], now, { staleAfterMs: 0 });
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /^invalid input:/);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("staleAfterMs -1 -> invalid input", () => {
  const result = computeRestartStatus([], now, { staleAfterMs: -1 });
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /^invalid input:/);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("staleAfterMs NaN -> invalid input", () => {
  const result = computeRestartStatus([], now, { staleAfterMs: Number.NaN });
  assert.equal(result.safeToRestartSupervisor, false);
  assert.match(result.blockers[0]!, /^invalid input:/);
  assert.equal(result.summary, "safe=false;invalid-input");
});

test("input immutability (deep snapshot before/after)", () => {
  const sessions: RestartStatusSession[] = [
    { sessionId: "sup-1", role: "supervisor", state: "idle", lastHeartbeatAt: hb(1000) },
    { sessionId: "wk-1", role: "worker", state: "running", lastHeartbeatAt: hb(1000) },
  ];
  const before = structuredClone(sessions);
  computeRestartStatus(sessions, now);
  assert.deepEqual(sessions, before);
});
