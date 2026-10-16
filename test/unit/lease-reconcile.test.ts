/**
 * Unit tests for the pure lease reconciliation module (AGENT-002/AGENT-003).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeaseRecord } from "../../src/runtime/isolation/LeaseManager.ts";
import {
  TERMINAL_MISSION_STATUSES,
  incarnationKey,
  missionIdOf,
  reconcileLeases,
} from "../../src/runtime/isolation/leaseReconcile.ts";

const NOW_MS = 1_000_000;
const TTL_MS = 45_000;

let seq = 0;
function lease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  seq += 1;
  return {
    resourceId: `ns#mission:m${seq}`,
    sessionId: `s${seq}`,
    pid: 100 + seq,
    host: "h1",
    bootId: "boot1",
    processStartTime: "t1",
    generationId: `g${seq}`,
    acquiredAtMs: NOW_MS - TTL_MS,
    heartbeatAtMs: NOW_MS - TTL_MS,
    expiresAtMs: NOW_MS + TTL_MS,
    ...overrides,
  };
}

function liveIncarnations(...ls: Array<Pick<LeaseRecord, "sessionId" | "pid" | "processStartTime">>): Set<string> {
  return new Set(ls.map((l) => incarnationKey(l)));
}

test("TERMINAL_MISSION_STATUSES contains COMPLETE, FAILED, CANCELED", () => {
  assert.deepEqual([...TERMINAL_MISSION_STATUSES].sort(), ["CANCELED", "COMPLETE", "FAILED"]);
});

test("reconcile: keep when live and unexpired", () => {
  const l = lease();
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set([l.sessionId]),
    liveIncarnations: liveIncarnations(l),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.deepEqual(verdict, [
    {
      resourceId: l.resourceId,
      sessionId: l.sessionId,
      generationId: l.generationId,
      decision: "keep",
      reason: "live",
    },
  ]);
});

test("reconcile: reclaim when session unregistered", () => {
  const l = lease();
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set(),
    liveIncarnations: liveIncarnations(l),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.equal(verdict[0]!.decision, "reclaim");
  assert.equal(verdict[0]!.reason, "session_unregistered");
});

test("reconcile: reclaim when holder incarnation superseded", () => {
  const l = lease();
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set([l.sessionId]),
    liveIncarnations: new Set(["other|1|t2"]),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.equal(verdict[0]!.decision, "reclaim");
  assert.equal(verdict[0]!.reason, "holder_incarnation_superseded");
});

test("reconcile: reclaim when expired non-mission resource", () => {
  const l = lease({ resourceId: "repository:leases", expiresAtMs: NOW_MS - 1 });
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set([l.sessionId]),
    liveIncarnations: liveIncarnations(l),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.equal(verdict[0]!.decision, "reclaim");
  assert.equal(verdict[0]!.reason, "lease_expired");
});

test("reconcile: reclaim when expired and mission terminal", () => {
  const l = lease({ resourceId: "ns#mission:m1", expiresAtMs: NOW_MS - 1 });
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set([l.sessionId]),
    liveIncarnations: liveIncarnations(l),
    missionStatuses: { m1: "COMPLETE" },
    nowMs: NOW_MS,
  });
  assert.equal(verdict[0]!.decision, "reclaim");
  assert.equal(verdict[0]!.reason, "lease_expired_terminal");
});

test("reconcile: quarantine when expired and mission unknown", () => {
  const l = lease({ resourceId: "ns#mission:m1", expiresAtMs: NOW_MS - 1 });
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set([l.sessionId]),
    liveIncarnations: liveIncarnations(l),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.equal(verdict[0]!.decision, "quarantine");
  assert.equal(verdict[0]!.reason, "lease_expired_unknown_mission");
});

test("reconcile: quarantine when expired and mission present but live", () => {
  const l = lease({ resourceId: "ns#mission:m1", expiresAtMs: NOW_MS - 1 });
  const verdict = reconcileLeases({
    leases: [l],
    liveSessions: new Set([l.sessionId]),
    liveIncarnations: liveIncarnations(l),
    missionStatuses: { m1: "EXECUTING" },
    nowMs: NOW_MS,
  });
  assert.equal(verdict[0]!.decision, "quarantine");
  assert.equal(verdict[0]!.reason, "lease_expired_live_mission");
});

test("reconcile: quarantine duplicates sharing a resourceId", () => {
  const a = lease({ resourceId: "ns#mission:m1", sessionId: "s1", generationId: "g1" });
  const b = lease({ resourceId: "ns#mission:m1", sessionId: "s2", generationId: "g2" });
  const verdict = reconcileLeases({
    leases: [a, b],
    liveSessions: new Set([a.sessionId, b.sessionId]),
    liveIncarnations: liveIncarnations(a, b),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.equal(verdict.length, 2);
  for (const v of verdict) {
    assert.equal(v.decision, "quarantine");
    assert.equal(v.reason, "duplicate_holder");
  }
});

test("incarnationKey joins sessionId, pid, processStartTime", () => {
  assert.equal(incarnationKey({ sessionId: "s1", pid: 42, processStartTime: "t1" }), "s1|42|t1");
  assert.equal(incarnationKey({ sessionId: "s1", pid: 42, processStartTime: null }), "s1|42|");
});

test("missionIdOf maps namespaced and bare mission resources", () => {
  assert.equal(missionIdOf("ns#mission:m1"), "m1");
  assert.equal(missionIdOf("mission:m1"), "m1");
  assert.equal(missionIdOf("repository:r1"), null);
  assert.equal(missionIdOf("garbage"), null);
});

test("reconcile output is sorted by resourceId then sessionId", () => {
  const l1 = lease({ resourceId: "ns#mission:a", sessionId: "s2", expiresAtMs: NOW_MS - 1 });
  const l2 = lease({ resourceId: "ns#mission:a", sessionId: "s1", expiresAtMs: NOW_MS - 1 });
  const l3 = lease({ resourceId: "ns#mission:b", sessionId: "s1", expiresAtMs: NOW_MS - 1 });
  const verdict = reconcileLeases({
    leases: [l1, l3, l2],
    liveSessions: new Set([l1.sessionId, l2.sessionId, l3.sessionId]),
    liveIncarnations: liveIncarnations(l1, l2, l3),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.deepEqual(
    verdict.map((v) => `${v.resourceId}:${v.sessionId}`),
    ["ns#mission:a:s1", "ns#mission:a:s2", "ns#mission:b:s1"],
  );
});

test("reconcile: empty input yields empty verdicts", () => {
  const verdict = reconcileLeases({
    leases: [],
    liveSessions: new Set(),
    liveIncarnations: new Set(),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.deepEqual(verdict, []);
});

test("reconcile does not mutate input leases", () => {
  const a = lease({ resourceId: "ns#mission:a", sessionId: "s1", expiresAtMs: NOW_MS - 1 });
  const b = lease({ resourceId: "ns#mission:b", sessionId: "s1", expiresAtMs: NOW_MS + 1 });
  const leases = [a, b];
  const before = structuredClone(leases);
  reconcileLeases({
    leases,
    liveSessions: new Set(["s1"]),
    liveIncarnations: liveIncarnations(a, b),
    missionStatuses: {},
    nowMs: NOW_MS,
  });
  assert.deepEqual(leases, before);
});
