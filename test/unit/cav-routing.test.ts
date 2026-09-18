import assert from "node:assert/strict";
import { test } from "node:test";
import { assertReviewerDistinct, assertVisionCapable, routeRole } from "../../src/cav/routing.ts";

test("roles route to distinct models (implementer vs reviewer vs planner vs vision)", () => {
  const impl = routeRole("implementer").id;
  const reviewer = routeRole("reviewer").id;
  const planner = routeRole("planner").id;
  const vision = routeRole("vision").id;
  const ids = [impl, reviewer, planner, vision];
  assert.equal(new Set(ids).size, 4, `roles must route to distinct models: ${ids.join(",")}`);
  assert.equal(assertReviewerDistinct(impl, reviewer), true);
  assert.equal(assertVisionCapable("vision", vision), true);
});

test("reviewer must be distinct from the implementer model", () => {
  assert.equal(assertReviewerDistinct("deepseek-v4-flash", "qwen3.8-27b"), true);
  assert.equal(assertReviewerDistinct("deepseek-v4-flash", "deepseek-v4-flash"), false);
});

test("vision role must use a vision-capable model", () => {
  assert.equal(assertVisionCapable("vision", "qwen3.8-27b-vision"), true);
  assert.equal(assertVisionCapable("vision", "qwen3.8-27b"), false);
  assert.equal(assertVisionCapable("reviewer", "qwen3.8-27b"), true);
});

test("overrides replace the model but keep the route shape", () => {
  const r = routeRole("reviewer", { reviewer: "some-other-model" });
  assert.equal(r.id, "some-other-model");
  assert.equal(r.provider, "metabolomics");
  assert.ok(r.reason.includes("overridden"));
});
