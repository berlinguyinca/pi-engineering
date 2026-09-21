import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestBudgetManager } from "../../src/vision/budget.ts";
import type { PayloadBreakdown } from "../../src/vision/budget.ts";
import { validateDesignObservation } from "../../src/vision/observation.ts";
import {
  DESIGN_OBSERVATION_TEXT_ALLOWANCE_BYTES,
  PayloadRecoveryManager,
  buildDiagnostic,
  classifyBoundary,
} from "../../src/vision/recovery.ts";
import {
  IMPLEMENT_TASK,
  VISION_ANALYSIS_TASK,
  VISION_WORKER_INSTRUCTIONS,
  VISUAL_REGRESSION_TASK,
  VisionAnalysisWorker,
  buildVisionWorkerContext,
} from "../../src/vision/worker.ts";

const validObservation = {
  assetId: "asset-1",
  reference: "dashboard.png",
  summary: "Main dashboard layout",
  layouts: ["top navigation bar"],
  components: ["sidebar", "chart card"],
  navigation: ["top bar links"],
  responsiveBehavior: { desktop: [], tablet: [], mobile: [] },
  visualHierarchy: ["header prominent"],
  interactionPatterns: ["click-to-expand"],
  reusablePatterns: ["card component"],
  implementationConstraints: ["no external fonts"],
  accessibilityNotes: ["keyboard navigable"],
  unknowns: [],
  confidence: { overall: 0.85, layout: 0.8, typography: 0.7 },
};

const baseRequest = {
  assetId: "asset-1",
  reference: "dashboard.png",
  schemaVersion: "DesignObservation/v1",
  instructions: "Analyze the reference for implementation.",
  designContractFragment: "A large design contract fragment that is unrelated to the bounded fields",
  projectContext: "Pi-Web project context",
};

test("worker: task identifiers match spec §31 routing", () => {
  assert.equal(VISION_ANALYSIS_TASK, "analyze-ui-reference");
  assert.equal(VISUAL_REGRESSION_TASK, "visual-regression-review");
  assert.equal(IMPLEMENT_TASK, "implement-react-component");
  assert.ok(VISION_WORKER_INSTRUCTIONS.includes("Do not implement code"));
});

test("worker: buildVisionWorkerContext contains only bounded fields and omits large/unrelated content", () => {
  const context = buildVisionWorkerContext(baseRequest);
  assert.ok(context.includes("dashboard.png"));
  assert.ok(context.includes("DesignObservation/v1"));
  assert.ok(context.includes("Analyze the reference"));
  assert.ok(context.includes("A large design contract fragment"));
  assert.ok(context.includes("Pi-Web project context"));
  // The context must not contain unrelated session content.
  const requestWithNoExtras = { ...baseRequest, designContractFragment: undefined, projectContext: undefined };
  const minimal = buildVisionWorkerContext(requestWithNoExtras);
  assert.ok(!minimal.includes("Pi-Web project context"));
  assert.ok(!minimal.includes("fragment"));
});

test("worker: VisionAnalysisWorker.run validates and returns result for a valid stub", async () => {
  const worker = new VisionAnalysisWorker();
  const result = await worker.run(baseRequest);
  assert.equal(result.assetId, "asset-1");
  assert.equal(result.reference, "dashboard.png");
  assert.equal(result.schemaVersion, "DesignObservation/v1");
  assert.equal(validateDesignObservation(result.observation).length, 0);
});

test("worker: VisionAnalysisWorker.run throws on invalid observation", async () => {
  const worker = new VisionAnalysisWorker(() => ({ assetId: 42, reference: "x" }));
  await assert.rejects(() => worker.run(baseRequest), /invalid DesignObservation/);
});

test("worker: custom analyze callback is invoked with the bounded request", async () => {
  let received: unknown;
  const worker = new VisionAnalysisWorker((req) => {
    received = req;
    return validObservation;
  });
  const result = await worker.run(baseRequest);
  assert.ok(received !== undefined);
  assert.deepEqual(result.observation, validObservation);
});

test("recovery: classifyBoundary maps each hint", () => {
  assert.equal(classifyBoundary(413, "https://inferweave.example/generate"), "inferweave_to_model_runtime");
  assert.equal(classifyBoundary(413, "https://inferweave.example/analyze-ui-reference"), "pi_to_inferweave");
  assert.equal(classifyBoundary(413, "nginx-gateway"), "reverse_proxy");
  assert.equal(classifyBoundary(413, "traefik"), "reverse_proxy");
  assert.equal(classifyBoundary(413, "https://pi-web.example/upload"), "browser_to_piweb");
  assert.equal(classifyBoundary(413, "unknown-host"), "unknown");
  assert.equal(classifyBoundary(200, undefined), "unknown");
});

test("recovery: buildDiagnostic builds a MODEL_REQUEST_TOO_LARGE diagnostic with all safe fields", () => {
  const d = buildDiagnostic({
    httpStatus: 413,
    requestBytesEstimated: 12_000_000,
    activeImages: 3,
    encodedImageBytes: 3_000_000,
    tokenEstimate: 40_000,
    provider: "openai",
    endpoint: "https://api.example/v1",
    recoveryAction: "drop_raw_visual_assets",
    retrySucceeded: true,
  });
  assert.equal(d.type, "MODEL_REQUEST_TOO_LARGE");
  assert.equal(d.httpStatus, 413);
  assert.equal(d.requestBytesEstimated, 12_000_000);
  assert.equal(d.activeImages, 3);
  assert.equal(d.encodedImageBytes, 3_000_000);
  assert.equal(d.tokenEstimate, 40_000);
  assert.equal(d.provider, "openai");
  assert.equal(d.endpoint, "https://api.example/v1");
  assert.equal(d.retrySucceeded, true);
});

test("recovery: recover drops encodedImageBytes and reduces below threshold", async () => {
  // 10MB max / 12MB request with 3MB encoded images should drop below 10MB after reduction.
  const budget = new RequestBudgetManager(10_000_000, 262_144);
  const mgr = new PayloadRecoveryManager(budget);
  const breakdown: PayloadBreakdown = {
    textBytes: 100,
    jsonOverheadBytes: 1_000,
    toolCallBytes: 0,
    encodedImageBytes: 3_000_000,
    messageMetadataBytes: 0,
    providerWrapperBytes: 0,
    totalEstimatedBytes: 3_001_100,
  };
  const input = {
    httpStatus: 413,
    activeImages: 3,
    encodedImageBytes: 3_000_000,
    tokenEstimate: 40_000,
    provider: "openai",
    endpoint: "https://api.example/v1",
    recoveryAction: "drop_raw_visual_assets",
  };
  const result = await mgr.recover(breakdown, input);
  assert.equal(result.retryPayload.encodedImageBytes, 0);
  assert.ok(result.retried);
  assert.ok(result.retrySucceeded);
  assert.equal(result.diagnostic.type, "MODEL_REQUEST_TOO_LARGE");
  assert.equal(result.diagnostic.retrySucceeded, true);
  // Reduced payload must fit within the 10MB budget.
  assert.ok(budget.preflight(result.retryPayload).allowed);
  assert.ok(result.retryPayload.textBytes! >= DESIGN_OBSERVATION_TEXT_ALLOWANCE_BYTES);
});

test("recovery: recover never retries when maxRetries is 0", async () => {
  const budget = new RequestBudgetManager(1_000_000, 262_144);
  const mgr = new PayloadRecoveryManager(budget, { maxRetries: 0 });
  const breakdown: PayloadBreakdown = {
    textBytes: 100,
    jsonOverheadBytes: 1_000,
    toolCallBytes: 0,
    encodedImageBytes: 5_000_000,
    messageMetadataBytes: 0,
    providerWrapperBytes: 0,
    totalEstimatedBytes: 5_001_100,
  };
  const input = {
    httpStatus: 413,
    activeImages: 5,
    encodedImageBytes: 5_000_000,
    tokenEstimate: 60_000,
    provider: "anthropic",
    endpoint: "https://api.example/v1",
    recoveryAction: "drop_raw_visual_assets",
  };
  const result = await mgr.recover(breakdown, input);
  assert.equal(result.retried, false);
  assert.equal(result.retrySucceeded, false);
  assert.equal(result.diagnostic.retrySucceeded, false);
});
