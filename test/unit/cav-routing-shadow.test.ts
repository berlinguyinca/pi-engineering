import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRouting, type LiveChoice } from "../../src/cav/routingShadow.ts";
import type { GatewayModelEntry } from "../../src/models/gatewayCatalog.ts";

/**
 * Small in-memory catalogue shaped like a gateway `/models` listing parsed by
 * `src/models/gatewayCatalog.ts`: capabilities (`x_capabilities`), family
 * (`x_family`), tools (`x_tools`) and context window (`x_context_window`).
 */
function entry(id: string, family: string, capabilities: string[], extra: Partial<GatewayModelEntry> = {}) {
  return {
    id,
    contextWindow: 131_072,
    family,
    capabilities,
    tools: true,
    state: "warm",
    ...extra,
  } as GatewayModelEntry;
}

const CATALOG: GatewayModelEntry[] = [
  entry("alpha-coder", "alpha", ["tool_use", "coding.implementation", "coding.review", "coding.planning"]),
  entry("beta-reviewer", "beta", ["tool_use", "coding.implementation", "coding.review"]),
  entry("delta-eyes", "delta", ["tool_use", "vision"]),
];

const live: LiveChoice = { provider: "metabolomics", model: "alpha-coder" };

test("a live choice matching the shadow route agrees", () => {
  const r = compareRouting("implementer", CATALOG, live);
  assert.equal(r.role, "implementer");
  assert.deepEqual(r.live, live);
  assert.equal(r.agrees, true);
  assert.match(r.reason, /matches the shadow route/);
  assert.ok(!("status" in r.shadow), "shadow should be a route, not BLOCKED");
  assert.equal((r.shadow as { provider: string }).provider, "metabolomics");
  assert.equal((r.shadow as { id: string }).id, "alpha-coder");
});

test("a live choice differing from the shadow route does not agree", () => {
  const wrong: LiveChoice = { provider: "metabolomics", model: "beta-reviewer" };
  const r = compareRouting("implementer", CATALOG, wrong);
  assert.equal(r.agrees, false);
  assert.match(r.reason, /differs from the shadow route/);
  assert.equal((r.shadow as { id: string }).id, "alpha-coder");
});

test("a provider mismatch does not agree even when the model id matches", () => {
  const wrongProvider: LiveChoice = { provider: "other-provider", model: "alpha-coder" };
  const r = compareRouting("implementer", CATALOG, wrongProvider);
  assert.equal(r.agrees, false);
  assert.match(r.reason, /differs from the shadow route/);
});

test("a BLOCKED shadow route never agrees and reports the BLOCKED reason", () => {
  const r = compareRouting("reviewer", CATALOG, live);
  assert.equal(r.agrees, false);
  assert.equal((r.shadow as { status: string }).status, "BLOCKED");
  assert.match(r.reason, /shadow route for reviewer is BLOCKED/);
  assert.match(r.reason, /implementer's family/);
});

test("a null live choice never agrees even when the shadow route resolves", () => {
  const r = compareRouting("vision", CATALOG, null);
  assert.equal(r.live, null);
  assert.equal(r.agrees, false);
  assert.equal((r.shadow as { id: string }).id, "delta-eyes");
  assert.match(r.reason, /no live choice was recorded/);
});
