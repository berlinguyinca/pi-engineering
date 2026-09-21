import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VIEWPORTS,
  VISUAL_DIFF_SCHEMA_VERSION,
  VisualVerificationWorker,
  isVisualDiffObservation,
  planResponsiveViewports,
  renderVisualDiffMarkdown,
  validateVisualDiffObservation,
} from "../../src/vision/visual.ts";
import type { VisualDifference } from "../../src/vision/visual.ts";

const baseRequest = {
  route: "/dashboard",
  viewport: { width: 390, height: 844 },
  reference: "dashboard-reference.png",
  referenceSummary: "Header 64px, badge blue, sidebar hidden on mobile",
  screenshotSummary: "Header 60px, badge red, sidebar hidden on mobile",
};

test("visual: DEFAULT_VIEWPORTS covers the five standard breakpoints from spec §27", () => {
  assert.deepEqual(
    DEFAULT_VIEWPORTS.map((v) => `${v.width}x${v.height}`),
    ["390x844", "768x1024", "1024x768", "1440x900", "1920x1080"],
  );
});

test("visual: planResponsiveViewports includes project breakpoints and dedupes", () => {
  const plan = planResponsiveViewports([
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
  ]);
  assert.equal(plan.length, 6);
  assert.ok(plan.some((v) => v.width === 820 && v.height === 1180));
});

test("visual: worker returns a valid empty-diff observation for an equal screenshot", async () => {
  const worker = new VisualVerificationWorker();
  const result = await worker.run(baseRequest);
  assert.equal(result.schemaVersion, VISUAL_DIFF_SCHEMA_VERSION);
  assert.equal(result.observation.route, "/dashboard");
  assert.deepEqual(result.observation.viewport, { width: 390, height: 844 });
  assert.equal(result.observation.differences.length, 0);
  assert.equal(result.observation.overallConfidence, 1);
  assert.ok(isVisualDiffObservation(result.observation));
});

test("visual: worker passes bounded summaries to a custom compare callback", async () => {
  const seen: string[] = [];
  const worker = new VisualVerificationWorker((req) => {
    seen.push(req.referenceSummary, req.screenshotSummary);
    const diffs: VisualDifference[] = [
      {
        component: "header",
        severity: "medium",
        difference: "header height differs (64px vs 60px)",
        recommendation: "increase header to 64px",
      },
    ];
    return diffs;
  });
  const result = await worker.run(baseRequest);
  assert.equal(seen[0], baseRequest.referenceSummary);
  assert.equal(seen[1], baseRequest.screenshotSummary);
  assert.equal(result.observation.differences.length, 1);
  assert.equal(result.observation.differences[0]!.component, "header");
});

test("visual: renderVisualDiffMarkdown is text-only and lists differences", async () => {
  const worker = new VisualVerificationWorker(() => [
    {
      component: "badge",
      severity: "high",
      difference: "badge color is red, expected blue",
      recommendation: "use blue badge color token",
    },
  ]);
  const result = await worker.run(baseRequest);
  const md = renderVisualDiffMarkdown(result.observation);
  assert.ok(md.includes("/dashboard"));
  assert.ok(md.includes("badge"));
  assert.ok(md.includes("blue badge color token"));
  assert.ok(!md.includes(".png"));
});

test("visual: validateVisualDiffObservation rejects bad severity and non-finite confidence", () => {
  const bad = {
    route: "/",
    viewport: { width: 390, height: 844 },
    differences: [{ component: "x", severity: "urgent", difference: "d", recommendation: "r" }],
    overallConfidence: Number.NaN,
  };
  const errors = validateVisualDiffObservation(bad);
  assert.ok(errors.some((e) => e.includes("severity")));
  assert.ok(errors.some((e) => e.includes("overallConfidence")));
  assert.ok(!isVisualDiffObservation(bad));
});
