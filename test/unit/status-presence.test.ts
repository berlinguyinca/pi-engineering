import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import {
  type PresenceRow,
  type PresenceView,
  presenceMarker,
  presenceRank,
  projectPresence,
  renderWidgetLines,
  storeOnlyEvent,
} from "../../src/status/presence.ts";

const T = Date.parse("2026-10-27T10:10:00.000Z");

/** A strip with no rows is a bug, not an empty assertion. */
function row0(view: PresenceView): PresenceRow {
  const row = view.rows[0];
  assert.ok(row, "expected the strip to render at least one row");
  return row;
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  assert.ok(line, `expected a widget line at ${index}`);
  return line;
}

function mission(overrides: Partial<RuntimeMissionActivityEvent> = {}): RuntimeMissionActivityEvent {
  return {
    missionId: "MSN-1",
    title: "presence strip",
    phase: "EXECUTING",
    state: "EXECUTING",
    health: "active",
    approximatePercent: 40,
    acceptanceCoverage: { completed: 2, total: 5, approximatePercent: 40 },
    workflowProgress: { completed: 2, total: 5, approximatePercent: 40 },
    summary: "editing src/status/presence.ts",
    activeWorkers: 1,
    waitingWorkers: 0,
    failedWorkers: 0,
    lastMeaningfulProgressAt: "2026-10-27T10:00:00.000Z",
    lastHeartbeatAt: "2026-10-27T10:09:00.000Z",
    action: "CONTINUE",
    reason: "active",
    recovery: { attempt: 0, maxAttempts: 0 },
    nextAction: "monitor",
    nextActionAt: null,
    owner: "owner",
    repository: "/repo",
    task: "t1",
    preservedWork: [],
    ...overrides,
  };
}

const needsYou = mission({ missionId: "MSN-needs", state: "NEEDS_ATTENTION", health: "blocked" });
const blocked = mission({ missionId: "MSN-blocked", state: "BLOCKED", health: "blocked" });
const stalled = mission({ missionId: "MSN-stalled", state: "EXECUTING", health: "stalled" });
const waiting = mission({ missionId: "MSN-wait", state: "WAITING_FOR_LLM", health: "waiting" });
const complete = mission({ missionId: "MSN-done", state: "COMPLETE", health: "complete" });

test("ranks needs-you above blocked, blocked above stalled, and terminal above idle", () => {
  assert.ok(presenceRank(needsYou) < presenceRank(blocked));
  assert.ok(presenceRank(blocked) < presenceRank(stalled));
  assert.ok(presenceRank(stalled) < presenceRank(waiting));
  assert.ok(presenceRank(waiting) < presenceRank(complete));
  assert.deepEqual(
    projectPresence([complete, waiting, stalled, blocked, needsYou], 8, T).rows.map((row) => row.missionId),
    ["MSN-needs", "MSN-blocked", "MSN-stalled", "MSN-wait", "MSN-done"],
  );
});

test("marks the attention markers from mission state", () => {
  assert.equal(presenceMarker(needsYou), "!");
  assert.equal(presenceMarker(blocked), "#");
  assert.equal(presenceMarker(stalled), "*");
  assert.equal(presenceMarker(waiting), "~");
  assert.equal(presenceMarker(complete), "v");
  assert.equal(presenceMarker(mission({ state: "FAILED", health: "failed" })), "x");
  assert.equal(presenceMarker(mission({ state: "PAUSED_INFRASTRUCTURE" })), "#");
  assert.equal(presenceMarker(mission({ state: "RECOVERING_PROCESS", health: "waiting" })), "~");
});

test("flags only needs-you and blocked rows as attention", () => {
  const view = projectPresence([needsYou, blocked, stalled, waiting, complete], 8, T);
  assert.deepEqual(
    view.rows.filter((row) => row.attention).map((row) => row.missionId),
    ["MSN-needs", "MSN-blocked"],
  );
});

test("heartbeat-only change does not reorder rows", () => {
  const quiet = mission({ missionId: "MSN-b", lastHeartbeatAt: undefined });
  const beating = mission({ missionId: "MSN-b", lastHeartbeatAt: "2026-10-27T10:09:30.000Z" });
  assert.deepEqual(
    projectPresence([beating], 4, T).rows.map((row) => row.missionId),
    projectPresence([quiet], 4, T).rows.map((row) => row.missionId),
  );
});

test("breaks ties on health, then oldest progress, then mission id", () => {
  const slow = mission({ missionId: "MSN-slow", health: "slow" });
  const active = mission({ missionId: "MSN-active", health: "active" });
  assert.deepEqual(
    projectPresence([active, slow], 4, T).rows.map((r) => r.missionId),
    ["MSN-slow", "MSN-active"],
  );

  const older = mission({ missionId: "MSN-zzz", lastMeaningfulProgressAt: "2026-10-27T09:00:00.000Z" });
  const newer = mission({ missionId: "MSN-aaa", lastMeaningfulProgressAt: "2026-10-27T10:05:00.000Z" });
  assert.deepEqual(
    projectPresence([newer, older], 4, T).rows.map((r) => r.missionId),
    ["MSN-zzz", "MSN-aaa"],
  );

  const twinA = mission({ missionId: "MSN-twin-a" });
  const twinB = mission({ missionId: "MSN-twin-b" });
  assert.deepEqual(
    projectPresence([twinB, twinA], 4, T).rows.map((r) => r.missionId),
    ["MSN-twin-a", "MSN-twin-b"],
  );
});

test("marks inferred progress as inferred", () => {
  const view = projectPresence([mission({ approximatePercent: 40 })], 4, T, new Map([["MSN-1", "inferred"]]));
  assert.equal(row0(view).percent, "~40% (inferred)");
});

test("shows no percentage when nothing is measured", () => {
  const view = projectPresence(
    [
      mission({
        approximatePercent: 0,
        acceptanceCoverage: { completed: 0, total: 0, approximatePercent: 0 },
        workflowProgress: { completed: 0, total: 0, approximatePercent: 0 },
      }),
    ],
    4,
    T,
  );
  assert.equal(row0(view).percent, "—");
  assert.match(row0(view).unit, /^workers 1a\/0w\/0f$/);
});

test("shows no proof of life yet instead of a fabricated age", () => {
  const view = projectPresence([mission({ lastMeaningfulProgressAt: null, lastHeartbeatAt: undefined })], 4, T);
  assert.equal(row0(view).age, "no proof of life yet");
});

test("caps rows at the budget and names the worst unshown mission in the overflow line", () => {
  const view = projectPresence([needsYou, stalled, waiting, blocked, complete], 2, T);
  assert.equal(view.rows.length, 2);
  assert.deepEqual(
    view.rows.map((row) => row.missionId),
    ["MSN-needs", "MSN-blocked"],
  );
  assert.match(view.overflow ?? "", /^3 more/);
  assert.match(view.overflow ?? "", /MSN-stalled/);
});

test("redacts secrets in titles", () => {
  const view = projectPresence([mission({ title: "uses sk-abc123def456abc123def456" })], 4, T);
  assert.doesNotMatch(row0(view).title, /sk-abc123/);
});

test("header counts running, needs-you and queued missions", () => {
  const queued = mission({ missionId: "MSN-queued", state: "QUEUED", health: "waiting" });
  const view = projectPresence([mission({}), needsYou, queued], 8, T);
  assert.match(view.header, /^Missions · 1 running · 1 needs you · 1 queued$/);
});

test("a mission with no observability state still renders, without a percentage", () => {
  const row = row0(
    projectPresence([storeOnlyEvent({ mission_id: "MSN-9", title: "queued leg", status: "QUEUED" })], 4, T),
  );
  assert.equal(row.marker, "~");
  assert.equal(row.percent, "—");
  assert.equal(row.age, "no proof of life yet");
});

test("the working line names the mission, its title and its phase", () => {
  const view = projectPresence([mission({ lastMeaningfulProgressAt: "2026-10-27T10:09:40.000Z" })], 4, T);
  assert.match(view.workingLine ?? "", /^Mission · MSN-1 · presence strip · 20s ago · EXECUTING ~40%$/);
  assert.equal(view.workingMissionId, "MSN-1");
});

test("the working line is absent when only terminal missions remain", () => {
  const view = projectPresence([complete], 4, T);
  assert.equal(view.workingLine, null);
  assert.equal(view.workingMissionId, null);
});

test("widget lines are header, rows and overflow in that order", () => {
  const view = projectPresence([needsYou, stalled, waiting], 2, T);
  const lines = renderWidgetLines(view);
  assert.equal(lines[0], view.header);
  assert.equal(lines.length, 4);
  assert.match(lineAt(lines, 1), /^! MSN-needs/);
  assert.match(lineAt(lines, 2), /^\* MSN-stalled/);
  assert.match(lineAt(lines, 3), /^1 more · worst MSN-wait/);
});
