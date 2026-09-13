import assert from "node:assert/strict";
import { test } from "node:test";
import { type ModelProvider, ModelRouter } from "../../src/routing/ModelRouter.ts";

function primary(): ModelProvider {
  return {
    id: "primary",
    name: "Primary",
    capabilities: ["implement", "review", "challenge", "plan", "scout", "test"],
    quota: 100,
  };
}
function flash(): ModelProvider {
  return {
    id: "flash",
    name: "Flash",
    capabilities: ["implement", "review", "challenge", "plan", "scout", "test", "cheap", "fast"],
    quota: 100,
  };
}

test("router: single provider degrades gracefully (no multi-model requirement)", () => {
  const r = new ModelRouter({ providers: [primary()] });
  const res = r.route("implementer");
  assert.ok(res);
  assert.equal(res.provider.id, "primary");
  assert.equal(res.diversified, false);
});

test("router: independent role diversifies away from the implementer provider when available", () => {
  const r = new ModelRouter({ providers: [primary(), flash()] });
  const impl = r.route("implementer", undefined)!;
  assert.equal(impl.provider.id, "primary");
  const rev = r.route("reviewer", impl.provider.id)!;
  assert.equal(rev.diversified, true);
  assert.notEqual(rev.provider.id, "primary");
});

test("router: independent role stays with one provider if no alternative exists", () => {
  const r = new ModelRouter({ providers: [primary()] });
  const impl = r.route("implementer")!;
  const rev = r.route("reviewer", impl.provider.id)!;
  assert.equal(rev.diversified, false);
  assert.equal(rev.provider.id, "primary");
});

test("router: quota exhaustion falls back to the next eligible provider", () => {
  const r = new ModelRouter({ providers: [primary(), flash()] });
  r.consume("primary", 100); // exhaust primary
  const res = r.route("implementer")!;
  assert.equal(res.provider.id, "flash");
  assert.equal(res.fallback, true); // preferred 'primary' was exhausted, so flash is a fallback
});

test("router: provider lacking a required capability is ineligible", () => {
  const implementOnly: ModelProvider = { id: "impl", name: "Impl", capabilities: ["implement"], quota: 10 };
  const r = new ModelRouter({ providers: [implementOnly] });
  assert.equal(r.route("reviewer"), null);
  assert.ok(r.route("implementer"));
});

test("router: consume clamps at zero and never goes negative", () => {
  const r = new ModelRouter({ providers: [primary()] });
  r.consume("primary", 1000);
  assert.equal(r.providersSnapshot()[0]!.quota, 0);
  assert.equal(r.route("implementer"), null);
});

test("router: fallback is set when the preferred provider is exhausted", () => {
  const a: ModelProvider = { id: "a", name: "A", capabilities: ["implement"], quota: 0 };
  const b: ModelProvider = { id: "b", name: "B", capabilities: ["implement"], quota: 10 };
  const r = new ModelRouter({ providers: [a, b] });
  const res = r.route("implementer")!;
  assert.equal(res.fallback, true, "preferred 'a' is exhausted, so 'b' is a fallback");
  assert.equal(res.provider.id, "b");
});

test("router: no fallback when the preferred provider serves", () => {
  const a: ModelProvider = { id: "a", name: "A", capabilities: ["implement"], quota: 10 };
  const b: ModelProvider = { id: "b", name: "B", capabilities: ["implement"], quota: 10 };
  const r = new ModelRouter({ providers: [a, b] });
  const res = r.route("implementer")!;
  assert.equal(res.fallback, false);
  assert.equal(res.provider.id, "a");
});

test("router: ties break by highest remaining quota then registration order", () => {
  const a: ModelProvider = { id: "a", name: "A", capabilities: ["implement"], quota: 5 };
  const b: ModelProvider = { id: "b", name: "B", capabilities: ["implement"], quota: 10 };
  const c: ModelProvider = { id: "c", name: "C", capabilities: ["implement"], quota: 10 };
  const r = new ModelRouter({ providers: [a, b, c] });
  const res = r.route("implementer")!;
  assert.equal(res.provider.id, "b"); // highest quota, earliest of the tie
});
