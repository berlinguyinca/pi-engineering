import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_INFERWEAVE_CAPABILITIES,
  InferWeaveCapabilityClient,
  TASK_ANALYZE_UI,
  TASK_IMPLEMENT,
  TASK_VISUAL_REGRESSION,
  capabilitiesToJson,
  routeTask,
} from "../../src/vision/inferweave.ts";
import type { InferWeaveCapabilities, VisionTask, VisionTaskRoute } from "../../src/vision/inferweave.ts";

test("routeTask: returns correct route per task", () => {
  const analyze = routeTask(TASK_ANALYZE_UI);
  assert.deepEqual(analyze, {
    task: TASK_ANALYZE_UI,
    capability: "vision",
    preferredModelRole: "vision-analyst",
  });

  const implement = routeTask(TASK_IMPLEMENT);
  assert.deepEqual(implement, {
    task: TASK_IMPLEMENT,
    capability: "code",
    preferredModelRole: "implementer",
  });

  const regression = routeTask(TASK_VISUAL_REGRESSION);
  assert.deepEqual(regression, {
    task: TASK_VISUAL_REGRESSION,
    capability: "vision",
    preferredModelRole: "visual-reviewer",
  });
});

test("routeTask: throws on unknown task", () => {
  assert.throws(() => routeTask("bogus-task" as VisionTask), /unknown vision task/);
});

test("InferWeaveCapabilityClient: defaults match DEFAULT_INFERWEAVE_CAPABILITIES", async () => {
  const client = new InferWeaveCapabilityClient();
  const caps = await client.capabilities();
  assert.deepEqual(caps, DEFAULT_INFERWEAVE_CAPABILITIES);
  assert.equal(await client.maxRequestBytes(), DEFAULT_INFERWEAVE_CAPABILITIES.maxRequestBytes);
  assert.equal(await client.supportsVision(), true);
  assert.equal(await client.preferredImageLongEdge(), 1800);
  assert.equal(await client.maxImagesPerRequest(), 8);
});

test("InferWeaveCapabilityClient: custom fetch is used and cached", async () => {
  let calls = 0;
  const custom: InferWeaveCapabilities = {
    maxRequestBytes: 1024,
    maxContextTokens: 512,
    supportsVision: false,
    preferredImageLongEdge: 640,
    maxImagesPerRequest: 2,
  };
  const client = new InferWeaveCapabilityClient(async () => {
    calls += 1;
    return custom;
  });
  const first = await client.capabilities();
  const second = await client.capabilities();
  assert.deepEqual(first, custom);
  assert.deepEqual(second, custom);
  assert.equal(calls, 1, "capabilities should be cached after first fetch");
  assert.equal(await client.maxRequestBytes(), 1024);
  assert.equal(await client.supportsVision(), false);
});

test("buildRequestBudgetManager: constructs a budget from advertised limits", async () => {
  const custom: InferWeaveCapabilities = { maxRequestBytes: 8000, maxContextTokens: 2000 };
  const client = new InferWeaveCapabilityClient(async () => custom);
  const budget = await client.buildRequestBudgetManager();
  assert.equal(budget.maxRequestBytes, 8000);
  assert.equal(budget.maxContextTokens, 2000);
});

test("capabilitiesToJson: round-trips", () => {
  const caps = DEFAULT_INFERWEAVE_CAPABILITIES;
  const json = capabilitiesToJson(caps);
  const parsed = JSON.parse(json) as InferWeaveCapabilities;
  assert.deepEqual(parsed, caps);
  // Ensure the JSON is stable/parseable for advertising/debug.
  assert.equal(typeof json, "string");
});
