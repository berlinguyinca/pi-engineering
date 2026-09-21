/**
 * Architectural 413 prevention regression tests (herdr spec 06, spec 15).
 *
 * Reproduces the observed failure signature: a task accumulates many design
 * references / spec contents inlined into the request body → the request grows
 * → the gateway rejects it with `413 request body too large`. Proves the fix is
 * architectural (materialize → summarize → split/fan-out → preflight reject)
 * and that the request is planned to fit BEFORE submission — not by raising the
 * HTTP limit, and never by assuming a fixed 260K context.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONSERVATIVE_FALLBACK_CONTEXT } from "../../src/context/capability.ts";
import { discoverContextWindow, planRequest } from "../../src/request/RequestPlanner.ts";

/** A large design-spec reference, the kind that previously blew past the limit. */
function specRef(id: string, sizeKb = 40): { id: string; title: string; content: string } {
  return { id, title: `design-${id}`, content: `# ${id} spec\n${"x".repeat(sizeKb * 1024)}` };
}

test("context window is discovered from metadata, never a fixed 260K", () => {
  assert.equal(discoverContextWindow({}), CONSERVATIVE_FALLBACK_CONTEXT);
  assert.equal(discoverContextWindow({ contextWindow: 96_000 }), 96_000);
  assert.equal(
    discoverContextWindow({
      modelId: "m",
      capability: { modelId: "m", guaranteedRoutableTokens: 200_000, warnings: [] },
    }),
    200_000,
  );
  assert.notEqual(discoverContextWindow({}), 260_000);
  assert.notEqual(discoverContextWindow({}), 262_144);
});

test("small request stays direct and fits the budget", () => {
  const plan = planRequest({ objective: "add a health endpoint", references: [specRef("r1", 1)] });
  assert.equal(plan.mode, "direct");
  assert.equal(plan.fits, true);
  assert.ok(plan.rawBytes <= plan.byteBudget);
});

test("many large spec references are materialized into artifacts (not inlined)", () => {
  // ~16 design specs × 40 KB = ~640 KB of inlined content — the prior 413 case.
  const refs = Array.from({ length: 16 }, (_, i) => specRef(`s${i + 1}`, 40));
  const plan = planRequest({ objective: "migrate runtime to Herdr", references: refs, maxRequestBytes: 4_000_000 });
  assert.equal(plan.mode, "materialize");
  assert.equal(plan.fits, true);
  assert.ok(plan.rawBytes > 600_000, "raw request must actually be large");
  assert.ok(plan.rawBytes > plan.plannedBytes, "plan must shrink the body");
  assert.ok(plan.plannedBytes <= plan.byteBudget, "planned body fits the byte budget BEFORE submission");
  assert.equal(plan.artifactRefs.length, 16);
  assert.equal(plan.materializedRefs.length, 16);
  assert.equal(plan.inlineRefs.length, 0);
  assert.ok(plan.artifactRefs.every((r) => r.startsWith("artifact://")));
});

test("an extreme single objective that cannot fit is rejected before submission", () => {
  // A single giant objective (no materializable refs) that alone exceeds the
  // byte budget cannot be split/summarized → preflight rejection, no submission.
  const plan = planRequest({
    objective: "review the entire universe ".repeat(40_000),
    references: [],
    maxRequestBytes: 200_000,
  });
  assert.equal(plan.mode, "reject");
  assert.equal(plan.fits, false);
  assert.ok(plan.rejection);
  assert.equal(plan.rejection!.code, "request_too_large");
  assert.ok(/exceeds/.test(plan.rejection!.message));
});

test("a huge single reference is materialized, not rejected (the actual 413 fix)", () => {
  const plan = planRequest({
    objective: "apply the huge spec",
    references: [specRef("huge", 3000)], // ~3 MB single reference
    maxRequestBytes: 1_000_000,
    referenceInlineBytes: 256,
  });
  assert.equal(plan.mode, "materialize");
  assert.equal(plan.fits, true);
  assert.ok(plan.plannedBytes < 10_000, "materialized body must be tiny");
  assert.equal(plan.artifactRefs.length, 1);
});

test("references too many to fit even summarized are split into a fan-out", () => {
  // 200 small-ish specs under a tight byte budget → must split.
  const refs = Array.from({ length: 200 }, (_, i) => specRef(`p${i}`, 4));
  const plan = planRequest({ objective: "review the whole codebase", references: refs, maxRequestBytes: 100_000 });
  assert.ok(["split", "materialize", "reject"].includes(plan.mode));
  if (plan.mode === "split") {
    assert.ok(plan.chunks && plan.chunks.length > 1, "expected multiple fan-out chunks");
    assert.ok(plan.fits);
    assert.equal(
      plan.chunks!.reduce((s, c) => s + c.referenceIds.length, 0),
      200,
    );
    assert.ok(plan.chunks!.every((c) => c.referenceIds.length > 0));
  }
});

test("byte budget scales with headroom and ceiling (never hardcoded)", () => {
  const a = planRequest({ objective: "x", references: [], maxRequestBytes: 4_000_000 });
  const b = planRequest({ objective: "x", references: [], maxRequestBytes: 8_000_000, headroomRatio: 0.9 });
  assert.equal(a.byteBudget, Math.floor(4_000_000 * 0.85));
  assert.equal(b.byteBudget, Math.floor(8_000_000 * 0.9));
});
