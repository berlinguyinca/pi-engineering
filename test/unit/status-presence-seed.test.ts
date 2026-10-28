import assert from "node:assert/strict";
import test from "node:test";

import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import type { MissionObservabilitySummary } from "../../src/orchestration/observability/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import type { RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import { MissionPresenceController, presenceOptionsFromEnv } from "../../src/status/MissionPresenceController.ts";
import { missionBelongsToSession, seedPresence } from "../../src/status/presenceSeed.ts";

const T0 = Date.parse("2026-10-27T10:10:00.000Z");

function harness(withObservability: boolean, parentSessionId?: string) {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "queued leg",
    goal: "goal",
    user_request: "request",
    repository: "repo",
    base_ref: "main",
    risk_profile: "low",
    workflow_class: "engineering",
    ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
  });
  const obs = withObservability ? new MissionObservability({ store, backend }) : null;
  obs?.missionCreated(mission.mission_id, mission.title);
  return { store, obs, missionId: mission.mission_id };
}

function controller() {
  const widget: string[][] = [];
  const working: (string | undefined)[] = [];
  const presence = new MissionPresenceController(
    {
      setWidget(_key, lines) {
        if (lines) widget.push(lines);
      },
      setWorkingMessage(text) {
        working.push(text);
      },
    },
    { now: () => T0, intervalMs: 0 },
  );
  return { presence, widget, working };
}

test("a mission with no observability state still renders a row", () => {
  const { store, missionId } = harness(false);
  const { presence, widget } = controller();
  seedPresence(presence, { missions: store.listMissions(), summary: () => null, scope: "all" });
  presence.tick();
  assert.equal(widget.length, 1);
  assert.match(widget[0]!.join("\n"), new RegExp(missionId));
  assert.match(widget[0]!.join("\n"), /~ MSN/);
  assert.match(widget[0]!.join("\n"), /no proof of life yet/);
  presence.dispose();
});

test("a mission with observability state renders its real state, not its store row", () => {
  const { store } = harness(true);
  const { presence, widget } = controller();
  // The durable row still says NEW; the read model knows better.
  const summary: MissionObservabilitySummary = {
    missionId: "MSN-seeded",
    title: "queued leg",
    state: "NEEDS_ATTENTION",
    phase: "EXECUTING",
    progress: { approximatePercent: 40, verifiedComplete: false, basis: "weighted_dag" },
    acceptanceCoverage: { completed: 2, total: 5, approximatePercent: 40 },
    workflowProgress: { completed: 3, total: 8, approximatePercent: 38, basis: "weighted_dag" },
    health: "stalled",
    workers: { active: 0, waiting: 1, failed: 0 },
    workersDetail: [],
    lastMeaningfulProgressAt: "2026-10-27T09:40:00.000Z",
    completionStatus: "not_ready",
    action: "WAIT",
    reason: "worker stalled",
    recovery: { attempt: 1, maxAttempts: 3 },
    nextAction: "retry",
    nextActionAt: null,
    owner: "owner",
    repository: "/repo",
    task: "t1",
    preservedWork: [],
  };
  seedPresence(presence, { missions: store.listMissions(), summary: () => summary, scope: "all" });
  presence.tick();
  const lines = widget[0]!.join("\n");
  assert.match(lines, /MSN-seeded/);
  assert.match(lines, /! MSN-seeded/);
  assert.match(lines, /~40%(?! \(inferred\))/, "the read model says the percentage is measured");
  assert.match(lines, /30m 00s ago/);
  assert.doesNotMatch(lines, /no proof of life yet/, "the read model proves when the mission last moved");
  presence.dispose();
});

test("a seeded row never overwrites activity the runtime already reported", () => {
  const { store, missionId } = harness(false);
  const { presence, working } = controller();
  const event: RuntimeMissionActivityEvent = {
    missionId,
    title: "queued leg",
    phase: "EXECUTING",
    state: "EXECUTING",
    health: "active",
    approximatePercent: 40,
    acceptanceCoverage: { completed: 2, total: 5, approximatePercent: 40 },
    workflowProgress: { completed: 2, total: 5, approximatePercent: 40 },
    summary: "editing src/a.ts",
    activeWorkers: 1,
    waitingWorkers: 0,
    failedWorkers: 0,
    lastMeaningfulProgressAt: "2026-10-27T10:09:40.000Z",
    lastHeartbeatAt: "2026-10-27T10:09:50.000Z",
    action: "CONTINUE",
    reason: "active",
    recovery: { attempt: 0, maxAttempts: 0 },
    nextAction: "monitor",
    nextActionAt: null,
    owner: "owner",
    repository: "/repo",
    task: "t1",
    preservedWork: [],
  };
  presence.update(event);
  seedPresence(presence, { missions: store.listMissions(), summary: () => null, scope: "all" });
  presence.tick();
  assert.match(working.at(-1) ?? "", /EXECUTING ~40%/, "the store row is a backstop, not a downgrade");
  presence.dispose();
});

test("durable seeding draws this session's missions and leaves other windows' alone", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const base = {
    goal: "goal",
    user_request: "request",
    repository: "repo",
    base_ref: "main",
    risk_profile: "low" as const,
    workflow_class: "engineering" as const,
  };
  const mine = store.createMission({ ...base, title: "mine", parent_session_id: "SES-mine" });
  const theirs = store.createMission({ ...base, title: "theirs", parent_session_id: "SES-other" });
  const orphan = store.createMission({ ...base, title: "no owner" });

  const { presence, widget } = controller();
  seedPresence(presence, { missions: store.listMissions(), summary: () => null, sessionId: "SES-mine" });
  presence.tick();

  assert.equal(widget.length, 1, "the strip is drawn");
  const lines = widget[0]!.join("\n");
  assert.match(lines, new RegExp(mine.mission_id), "a mission this session started belongs on this strip");
  assert.doesNotMatch(lines, new RegExp(theirs.mission_id), "another window's mission is not this window's queue");
  assert.doesNotMatch(lines, new RegExp(orphan.mission_id), "an unowned row belongs to no session");
  presence.dispose();
});

test("a strip that cannot name its own session draws no durable rows", () => {
  const { store, missionId } = harness(false);
  const { presence, widget } = controller();
  seedPresence(presence, { missions: store.listMissions(), summary: () => null });
  presence.tick();
  assert.equal(widget.length, 0, "without a session id, ownership is unknowable, so nothing is claimed");
  presence.dispose();
});

test("scope: all restores the machine-wide strip", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const base = {
    goal: "goal",
    user_request: "request",
    repository: "repo",
    base_ref: "main",
    risk_profile: "low" as const,
    workflow_class: "engineering" as const,
  };
  const mine = store.createMission({ ...base, title: "mine", parent_session_id: "SES-mine" });
  const theirs = store.createMission({ ...base, title: "theirs", parent_session_id: "SES-other" });

  const { presence, widget } = controller();
  seedPresence(presence, { missions: store.listMissions(), summary: () => null, scope: "all" });
  presence.tick();
  const lines = widget[0]!.join("\n");
  assert.match(lines, new RegExp(mine.mission_id));
  assert.match(lines, new RegExp(theirs.mission_id), "the opt-in draws every window's mission");
  presence.dispose();
});

test("ownership is the starting session, and only the starting session", () => {
  assert.equal(missionBelongsToSession({ parent_session_id: "SES-a" }, "SES-a"), true);
  assert.equal(missionBelongsToSession({ parent_session_id: "SES-b" }, "SES-a"), false);
  assert.equal(missionBelongsToSession({ parent_session_id: null }, "SES-a"), false);
  assert.equal(missionBelongsToSession({ parent_session_id: "SES-a" }, null), false);
});

test("presence is session-scoped unless the operator asks for the machine-wide strip", () => {
  assert.equal(presenceOptionsFromEnv({}).scope, "session");
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_PRESENCE_SCOPE: "all" }).scope, "all");
  assert.equal(presenceOptionsFromEnv({ PI_MISSION_PRESENCE_SCOPE: "anything-else" }).scope, "session");
});
