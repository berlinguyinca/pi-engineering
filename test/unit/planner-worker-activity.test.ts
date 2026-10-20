import assert from "node:assert/strict";
import { test } from "node:test";
import { PlannerActivity, renderActivity, startPlannerDisplay } from "../../src/plannerWorker/activity.ts";
import { type PersistedState, renderWorkers } from "../../src/plannerWorker/status.ts";
import { WAITING_FOR_INFERENCE_SUMMARY } from "../../src/workers/activity.ts";

test("planner activity distinguishes elapsed silence, heartbeat, capacity wait and verified progress", () => {
  const activity = new PlannerActivity();
  const id = activity.start(
    "alpha",
    "implementer",
    { provider: "metabolomics", id: "coding" },
    "flash-next",
    60_000,
    1000,
  );
  activity.note(
    id,
    { kind: "tool", phase: "started", toolName: "bash", summary: "secret input", meaningfulProgress: false },
    2000,
  );
  activity.note(id, { kind: "heartbeat", summary: "alive", meaningfulProgress: false }, 10_000);
  const worker = activity.snapshot()[0]!;
  assert.equal(worker.last_event_at, 2000);
  assert.equal(worker.last_heartbeat_at, 10_000);
  assert.equal(worker.last_progress_at, null);
  assert.match(renderActivity(worker, 12_000), /metabolomics\/coding → flash-next/);
  assert.match(renderActivity(worker, 12_000), /Running tool: bash/);
  assert.match(renderActivity(worker, 12_000), /last event 10s ago/);
  assert.doesNotMatch(renderActivity(worker, 12_000), /secret input|\d+%/);
  activity.note(id, { kind: "state", summary: WAITING_FOR_INFERENCE_SUMMARY, meaningfulProgress: false }, 13_000);
  assert.match(renderActivity(activity.snapshot()[0]!, 90_000), /Waiting for inference capacity/);
  assert.doesNotMatch(renderActivity(activity.snapshot()[0]!, 90_000), /STALL/);
  activity.stall(id, "worker inactivity", 91_000);
  assert.match(renderActivity(activity.snapshot()[0]!, 91_000), /STALLED/);
});

test("planner activity history is bounded and terminal timers stop growing", () => {
  const activity = new PlannerActivity();
  const id = activity.start("alpha", "reviewer", undefined, undefined, 60_000, 1000);
  for (let n = 0; n < 60; n++)
    activity.note(
      id,
      { kind: "tool", phase: "completed", toolName: "read", summary: "", meaningfulProgress: false },
      2000 + n,
    );
  activity.finish(id, "completed", 3000);
  const worker = activity.snapshot()[0]!;
  assert.ok(worker.recent.length <= 12);
  assert.equal(renderActivity(worker, 4000), renderActivity(worker, 50_000));
});

test("planner display ticks without inventing events, clears on stop and only notifies stalls", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1000 });
  const widgets: Array<string[] | undefined> = [];
  const notices: string[] = [];
  const activity = new PlannerActivity();
  activity.start("alpha", "implementer", undefined, undefined, 60_000, 1000);
  const display = startPlannerDisplay(
    {
      setWidget: (_key, lines) => widgets.push(lines),
      setStatus: () => {},
      notify: (text) => notices.push(text),
    },
    "PW-live",
    () => ({ status: "running", passed: 0, total: 1, activity: activity.snapshot() }),
  );
  display.event({ type: "phase", text: "planning" });
  t.mock.timers.tick(2000);
  assert.ok(widgets.length >= 3);
  assert.match(widgets.at(-1)!.join("\n"), /2s/);
  assert.equal(activity.snapshot()[0]!.last_event_at, 1000);
  assert.deepEqual(notices, []);
  display.event({ type: "stalled", task_id: "alpha", text: "worker inactivity" });
  display.event({ type: "stalled", task_id: "alpha", text: "worker inactivity" });
  assert.equal(notices.length, 1);
  display.stop();
  const count = widgets.length;
  t.mock.timers.tick(5000);
  assert.equal(widgets.length, count);
  assert.equal(widgets.at(-1), undefined);
});

test("planner retains only actual sanitized bounded output for inspect, never live bars", () => {
  const activity = new PlannerActivity();
  const id = activity.start("alpha", "implementer", undefined, undefined, 60_000, 1000);
  activity.setOutputPreview(id, "[aborted]");
  assert.equal(activity.snapshot()[0]!.last_output_preview, undefined, "no output event means no verification preview");
  activity.note(id, { kind: "state", summary: "Model response received", meaningfulProgress: false }, 2000);
  assert.equal(
    activity.snapshot()[0]!.last_output_preview,
    undefined,
    "model response activity has no tool output preview",
  );
  activity.note(
    id,
    {
      kind: "tool",
      phase: "completed",
      toolName: "bash",
      summary: "",
      meaningfulProgress: false,
      outputPreview: `${"x".repeat(1500)}\u001b[31m tests passed token=supersecret-value`,
    },
    3000,
  );
  const worker = activity.snapshot()[0]!;
  assert.ok(worker.last_output_preview?.includes("tests passed"));
  assert.ok(worker.last_output_preview!.length <= 1000);
  assert.doesNotMatch(worker.last_output_preview!, /supersecret/);
  assert.equal(worker.last_output_preview!.includes("\u001b"), false);
  assert.equal(worker.last_output_at, 3000);
  assert.doesNotMatch(renderActivity(worker), /tests passed|REDACTED/);
  const state: PersistedState = {
    mission_id: "PW-test",
    status: "running",
    contracts: [],
    transitions: [],
    stalled_events: [],
    metrics: [],
    replans: 0,
    plan: { contracts: [], decisions: [], architectural_context: [] },
    integration_branch: null,
    failure_reason: null,
    updated_at: new Date().toISOString(),
    live_activity: activity.snapshot(),
  };
  assert.match(renderWorkers(state, "alpha"), /Output preview:.*tests passed/);
  assert.doesNotMatch(renderWorkers(state, "alpha"), /supersecret/);
  assert.equal(renderWorkers(state, "alpha").includes("\u001b"), false);
  assert.doesNotMatch(renderWorkers(state, "other-task"), /tests passed/);
});
