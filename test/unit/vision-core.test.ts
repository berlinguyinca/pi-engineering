import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JSON_SERIALIZATION_OVERHEAD_BYTES,
  PAYLOAD_REDUCTION_ORDER,
  RequestBudgetManager,
  classifyBudget,
  estimatePayloadBytes,
  estimateTokensForBytes,
} from "../../src/vision/budget.ts";
import {
  SCHEMA_VERSION,
  isDesignObservation,
  renderObservationMarkdown,
  validateDesignObservation,
} from "../../src/vision/observation.ts";
import { ProviderLimitRegistry } from "../../src/vision/provider.ts";

const validObservation = {
  assetId: "asset-1",
  reference: "dashboard.png",
  summary: "Main dashboard layout",
  layouts: ["top navigation bar", "two-column content"],
  components: ["sidebar", "chart card"],
  navigation: ["top bar links", "breadcrumb"],
  responsiveBehavior: {
    desktop: ["full sidebar visible"],
    tablet: ["collapsed sidebar"],
    mobile: ["hamburger menu"],
  },
  visualHierarchy: ["header prominent"],
  interactionPatterns: ["click-to-expand"],
  reusablePatterns: ["card component"],
  implementationConstraints: ["no external fonts"],
  accessibilityNotes: ["keyboard navigable"],
  unknowns: ["chart color contrast"],
  confidence: { overall: 0.85, layout: 0.8, typography: 0.7 },
};

test("DesignObservation: valid object passes validation and type guard", () => {
  assert.equal(SCHEMA_VERSION, "DesignObservation/v1");
  assert.deepEqual(validateDesignObservation(validObservation), []);
  assert.equal(isDesignObservation(validObservation), true);
});

test("DesignObservation: malformed object returns validation errors", () => {
  const malformed = { ...validObservation, assetId: 42, layouts: "not-an-array" };
  const errors = validateDesignObservation(malformed);
  assert.equal(isDesignObservation(malformed), false);
  assert.ok(errors.some((e) => e.includes("assetId")));
  assert.ok(errors.some((e) => e.includes("layouts")));
  assert.ok(errors.length > 0);
});

test("DesignObservation: non-object returns a single structural error", () => {
  assert.equal(isDesignObservation(null), false);
  assert.equal(isDesignObservation("x"), false);
  assert.equal(isDesignObservation([1, 2]), false);
  const errors = validateDesignObservation(null);
  assert.ok(errors.length > 0);
});

test("Markdown renderer: contains section headings and confidence values", () => {
  const md = renderObservationMarkdown(validObservation);
  assert.ok(md.includes("## Overview"));
  assert.ok(md.includes("## Layouts"));
  assert.ok(md.includes("## Components"));
  assert.ok(md.includes("## Navigation"));
  assert.ok(md.includes("## Responsive Behavior"));
  assert.ok(md.includes("### Desktop"));
  assert.ok(md.includes("### Tablet"));
  assert.ok(md.includes("### Mobile"));
  assert.ok(md.includes("## Confidence"));
  assert.ok(md.includes("Overall: 0.85"));
  assert.ok(md.includes("dashboard.png"));
});

test("byte estimation sums components plus JSON overhead", () => {
  const total = estimatePayloadBytes({
    textBytes: 100,
    jsonOverheadBytes: 20,
    toolCallBytes: 30,
    encodedImageBytes: 500,
    messageMetadataBytes: 10,
    providerWrapperBytes: 40,
  });
  assert.equal(total, 100 + 20 + 30 + 500 + 10 + 40 + JSON_SERIALIZATION_OVERHEAD_BYTES);
  assert.equal(estimatePayloadBytes({}), JSON_SERIALIZATION_OVERHEAD_BYTES);
});

test("token estimation defaults to 4 bytes per token and rounds up", () => {
  assert.equal(estimateTokensForBytes(100), 25);
  assert.equal(estimateTokensForBytes(101), 26);
  assert.equal(estimateTokensForBytes(100, 10), 10);
});

test("budget classification transitions across SAFE/WARNING/MITIGATE/CRITICAL boundaries", () => {
  assert.equal(classifyBudget(0.49), "SAFE");
  assert.equal(classifyBudget(0.5), "WARNING");
  assert.equal(classifyBudget(0.64), "WARNING");
  assert.equal(classifyBudget(0.65), "MITIGATE");
  assert.equal(classifyBudget(0.79), "MITIGATE");
  assert.equal(classifyBudget(0.8), "CRITICAL");
  assert.equal(classifyBudget(0.9), "CRITICAL");
});

test("RequestBudgetManager: estimate computes bytes, tokens, utilization, state", () => {
  const mgr = new RequestBudgetManager(10_000, 10_000);
  const est = mgr.estimate({ textBytes: 200, encodedImageBytes: 200 });
  const bytes = 200 + 200 + JSON_SERIALIZATION_OVERHEAD_BYTES;
  assert.equal(est.estimatedPayloadBytes, bytes);
  assert.equal(est.estimatedTokens, estimateTokensForBytes(bytes));
  assert.equal(est.utilization, bytes / 10_000);
  assert.equal(est.budgetState, "SAFE");
});

test("RequestBudgetManager: preflight allowed when within limits", () => {
  const mgr = new RequestBudgetManager(1_000, 1_000);
  const pf = mgr.preflight({ textBytes: 100 });
  assert.equal(pf.allowed, true);
  assert.deepEqual(pf.recommendedActions, []);
  assert.equal(pf.reductionRequired, 0);
  assert.equal(pf.maximumBytes, 1_000);
});

test("RequestBudgetManager: preflight blocked when over byte limit with recommended actions", () => {
  const mgr = new RequestBudgetManager(1_000, 100_000);
  const pf = mgr.preflight({ textBytes: 2_000, encodedImageBytes: 3_000 });
  assert.equal(pf.allowed, false);
  assert.ok(pf.estimatedBytes > 1_000);
  assert.equal(pf.reductionRequired, pf.estimatedBytes - 1_000);
  assert.deepEqual(pf.recommendedActions, [...PAYLOAD_REDUCTION_ORDER]);
  assert.equal(pf.recommendedActions[0], "drop_raw_visual_assets");
});

test("RequestBudgetManager: preflight blocked on token overrun even when bytes are within limit", () => {
  const mgr = new RequestBudgetManager(1_000_000, 50);
  const pf = mgr.preflight({ textBytes: 200 });
  assert.equal(pf.allowed, false);
  assert.ok(pf.recommendedActions.length > 0);
});

test("ProviderLimitRegistry: registered limits win over fallback", () => {
  const registry = new ProviderLimitRegistry();
  registry.register({
    provider: "anthropic",
    maxRequestBytes: 20_000,
    maxContextTokens: 200_000,
    supportsVision: true,
  });
  assert.equal(registry.get("anthropic")?.maxRequestBytes, 20_000);
  const resolved = registry.resolve("anthropic", { maxRequestBytes: 5_000, preferredImageLongEdge: 1024 });
  assert.equal(resolved.maxRequestBytes, 20_000);
  assert.equal(resolved.preferredImageLongEdge, 1024);
  assert.equal(resolved.provider, "anthropic");
});

test("ProviderLimitRegistry: fallback used for unknown provider, never throws", () => {
  const registry = new ProviderLimitRegistry();
  registry.register({ provider: "anthropic", maxRequestBytes: 20_000 });
  const resolved = registry.resolve("unknown-provider", { maxRequestBytes: 7_000, supportsVision: false });
  assert.equal(resolved.maxRequestBytes, 7_000);
  assert.equal(resolved.supportsVision, false);
  assert.equal(resolved.provider, "unknown-provider");
  assert.equal(registry.maxRequestBytesFor("unknown-provider", 9_000), 9_000);
  assert.equal(registry.maxRequestBytesFor("unknown-provider"), 0);
});
