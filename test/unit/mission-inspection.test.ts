import assert from "node:assert/strict";
import { test } from "node:test";
import { MissionStore } from "../../src/orchestration/missionStore.ts";
import { MissionObservability } from "../../src/orchestration/observability/MissionObservability.ts";
import type { MissionProjection } from "../../src/orchestration/observability/types.ts";
import { JsonlEventStore } from "../../src/platform/eventstore/jsonl.ts";
import * as report from "../../src/tools/missionReport.ts";

test("mission inspection shows bounded worker activity, changes, tests, retries and blockers", () => {
  const backend = JsonlEventStore.inMemory();
  const store = MissionStore.open(backend);
  const mission = store.createMission({
    title: "inspect",
    goal: "goal",
    user_request: "request",
    repository: "repo",
    base_ref: "main",
    risk_profile: "low",
    workflow_class: "engineering",
  });
  const obs = new MissionObservability({ store, backend });
  obs.missionCreated(mission.mission_id, mission.title);
  const projection = obs.projection(mission.mission_id)!;
  projection.workers = [
    {
      workerId: "w1",
      state: "running",
      taskId: "t1",
      model: "metabolomics/flash-next",
      route: "fast",
      currentActivity: "running tests",
      repeatedFileReads: 0,
      repeatedToolCalls: 0,
      repeatedErrors: 0,
      repeatedCycles: 0,
    },
  ];
  projection.activity = Array.from({ length: 50 }, (_, i) => ({
    at: "2026-10-20T12:00:00Z",
    workerId: "w1",
    type: "running_command" as const,
    summary: `output-${i}`,
    meaningfulProgress: false,
  }));
  projection.changes.changedFiles = ["src/feature.ts"];
  projection.tests.passed = 4;
  projection.tests.failed = 1;
  projection.tests.retries = 2;
  projection.tests.failures = ["expected 200, got 500"];
  projection.review.blockingOpen = 1;
  projection.review.findings = [
    { findingId: "f1", severity: "blocking", status: "open", summary: "missing validation", repaired: false },
  ];
  const format = (report as Record<string, unknown>).formatMissionInspection;
  assert.equal(typeof format, "function");
  const text = (format as (p: MissionProjection, workerId?: string) => string)(projection, "w1");
  assert.match(text, /fast → metabolomics\/flash-next/);
  assert.match(text, /running tests/);
  assert.match(text, /src\/feature.ts/);
  assert.match(text, /4 passed.*1 failed.*2 retries/);
  assert.match(text, /missing validation/);
  assert.match(text, /output-49/);
  assert.doesNotMatch(text, /output-0\b/);
  assert.match(text, /tool output.*not recorded/i);
  const missing = (format as (p: MissionProjection, workerId?: string) => string)(projection, "absent");
  assert.match(missing, /Worker absent not found/);
  projection.activity.push({
    at: "now",
    type: "error",
    summary: "\u001b[31mAPI_KEY=supersecretvalue",
    workerId: "w1",
    meaningfulProgress: false,
  });
  const safe = (format as (p: MissionProjection) => string)(projection);
  assert.doesNotMatch(safe, /supersecretvalue/);
  assert.ok(!safe.includes("\u001b"));
  Object.assign(projection.workers[0]!, {
    lastOutputPreview: `\u001b[32mPASS auth.test.ts API_KEY=supersecretvalue ${"x".repeat(1_500)} OUTPUT_TAIL`,
    modelContent: "PRIVATE_MODEL_CONTENT",
    reasoning: "PRIVATE_REASONING",
  });
  const captured = (format as (p: MissionProjection, workerId?: string) => string)(projection, "w1");
  assert.match(captured, /Tool output \(latest captured preview\): PASS auth\.test\.ts/);
  assert.doesNotMatch(captured, /supersecretvalue|OUTPUT_TAIL|PRIVATE_MODEL_CONTENT|PRIVATE_REASONING/);
  assert.ok(!captured.includes("\u001b"));
  const preview = captured.split("\n").find((line) => line.includes("Tool output (latest captured preview):"))!;
  assert.ok(preview.length <= 1_045, "tool output is bounded independently of other inspection rows");
  delete projection.workers[0]!.lastOutputPreview;
  const unavailable = (format as (p: MissionProjection) => string)(projection);
  assert.match(unavailable, /Tool output: not recorded/);
  assert.doesNotMatch(unavailable, /PRIVATE_MODEL_CONTENT|PRIVATE_REASONING/);
});
