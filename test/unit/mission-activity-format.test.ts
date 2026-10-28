import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeMissionActivityEvent } from "../../src/runtime/EngineeringRuntime.ts";
import { formatMissionActivity } from "../../src/status/missionActivity.ts";

/** A complete event so the formatter never reads an undefined field. */
function event(overrides: Partial<RuntimeMissionActivityEvent> = {}): RuntimeMissionActivityEvent {
  return {
    missionId: "MSN-1",
    title: "presence",
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
    lastHeartbeatAt: "2026-10-27T10:00:10.000Z",
    lastOutputAt: "2026-10-27T10:00:12.000Z",
    observedAt: "2026-10-27T10:00:20.000Z",
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

test("renders the recovery attempt token with the next verb", () => {
  const rendered = formatMissionActivity(
    event({ recovery: { attempt: 2, maxAttempts: 4 }, action: "recover", nextAction: "retry in 30s" }),
  );
  assert.equal(rendered.missionStatus.token, "R2/4 RECOVER→retry");
  assert.match(rendered.missionStatus.next, /retry in 30s/);
});

test("an operator pause reads as paused and names the resume command", () => {
  const rendered = formatMissionActivity(event({ operatorPausedAt: "2026-10-27T10:00:00.000Z" }));
  assert.equal(rendered.missionStatus.token, "R– PAUSED (operator)");
  assert.match(rendered.missionStatus.next, /\/mission resume MSN-1/);
});
