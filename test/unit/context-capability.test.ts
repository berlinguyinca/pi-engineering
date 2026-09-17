import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONSERVATIVE_FALLBACK_CONTEXT,
  FORBIDDEN_FALLBACK_CONTEXTS,
  formatTokens,
  normalizeCapability,
  resolveModelContext,
} from "../../src/context/capability.ts";

// The whole point of the matrix in spec 05: the same client code must give each
// model its own discovered window, and must never invent a big one.

test("capability parsing matrix: every documented spelling resolves", () => {
  const cases: Array<[unknown, number | undefined]> = [
    [{ id: "m", context_window: 32_768 }, 32_768],
    [{ id: "m", max_model_len: 65_536 }, undefined],
    [{ id: "m", context_window: 131_072, max_model_len: 262_144 }, 131_072],
    [{ id: "m", inferweave: { guaranteed_routable_tokens: 1_048_576 } }, undefined],
    [{ id: "m" }, undefined],
    [{ id: "m", context_window: "nonsense" }, undefined],
    [{ id: "m", context_window: 0 }, undefined],
  ];
  for (const [entry, expectedContextWindow] of cases) {
    const capability = normalizeCapability(entry);
    assert.equal(capability.contextWindow, expectedContextWindow);
    assert.equal(capability.modelId, "m");
  }
});

test("precedence: guaranteed routable beats every other field", () => {
  const capability = normalizeCapability({
    id: "m",
    context_window: 262_144,
    max_model_len: 262_144,
    inferweave: { guaranteed_routable_tokens: 131_072, max_routable_tokens: 1_048_576 },
  });
  const resolved = resolveModelContext("m", capability);
  assert.equal(resolved.contextWindow, 131_072, "the guarantee, not the largest backend");
  assert.equal(resolved.basis, "guaranteed_routable_tokens");
  assert.equal(resolved.heterogeneous, false);
});

test("precedence: context_window then max_model_len", () => {
  assert.equal(
    resolveModelContext("m", normalizeCapability({ id: "m", context_window: 65_536 })).contextWindow,
    65_536,
  );
  const only = resolveModelContext("m", normalizeCapability({ id: "m", max_model_len: 32_768 }));
  assert.equal(only.contextWindow, 32_768);
  assert.equal(only.basis, "max_model_len");
});

test("precedence: no capability lands on the 128K floor and never on 260K", () => {
  const resolved = resolveModelContext("m", undefined);
  assert.equal(resolved.contextWindow, CONSERVATIVE_FALLBACK_CONTEXT);
  assert.equal(resolved.basis, "conservative_fallback");
  assert.ok(resolved.warnings.some((w) => w.includes("floor")));
  for (const forbidden of FORBIDDEN_FALLBACK_CONTEXTS) {
    assert.notEqual(resolved.contextWindow, forbidden);
  }
  assert.equal(CONSERVATIVE_FALLBACK_CONTEXT, 128_000);
});

test("precedence: fresh last-known-good is used before the floor", () => {
  const resolved = resolveModelContext("m", undefined, {
    lastKnownGood: { contextWindow: 262_144, observedAt: 100, maxAgeSeconds: 600 },
    now: 400,
  });
  assert.equal(resolved.contextWindow, 262_144);
  assert.equal(resolved.basis, "last_known_good");

  const aged = resolveModelContext("m", undefined, {
    lastKnownGood: { contextWindow: 262_144, observedAt: 100, maxAgeSeconds: 600 },
    now: 10_000,
  });
  assert.equal(aged.contextWindow, CONSERVATIVE_FALLBACK_CONTEXT, "an old value is not a capability");
});

test("expired capability may not expand the window", () => {
  const expired = normalizeCapability({
    id: "m",
    inferweave: { guaranteed_routable_tokens: 1_048_576, freshness: "expired" },
  });
  const resolved = resolveModelContext("m", expired);
  assert.notEqual(resolved.contextWindow, 1_048_576);
  assert.equal(resolved.stale, true);
  assert.ok(resolved.warnings.some((w) => w.includes("expired")));
});

test("local override: smaller is trusted, larger needs an explicit unsafe flag", () => {
  const capability = normalizeCapability({ id: "m", inferweave: { guaranteed_routable_tokens: 131_072 } });
  const smaller = resolveModelContext("m", capability, { localOverride: { modelId: "m", contextWindow: 65_536 } });
  assert.equal(smaller.contextWindow, 65_536);
  assert.equal(smaller.basis, "local_override");

  const larger = resolveModelContext("m", capability, { localOverride: { modelId: "m", contextWindow: 1_048_576 } });
  assert.equal(larger.contextWindow, 131_072, "an unsafe expansion is refused");
  assert.ok(larger.warnings.some((w) => w.includes("allowUnsafeOverride")));

  const explicit = resolveModelContext("m", capability, {
    localOverride: { modelId: "m", contextWindow: 1_048_576, allowUnsafeOverride: true },
  });
  assert.equal(explicit.contextWindow, 1_048_576);
  assert.ok(explicit.warnings.some((w) => w.includes("unsafe override")));
});

test("maxTokens comes from the gateway and is clamped below the window", () => {
  const advertised = resolveModelContext(
    "m",
    normalizeCapability({ id: "m", context_window: 262_144, max_tokens: 32_768 }),
  );
  assert.equal(advertised.maxTokens, 32_768);

  const absurd = resolveModelContext("m", normalizeCapability({ id: "m", context_window: 32_768, max_tokens: 32_768 }));
  assert.ok(absurd.maxTokens < absurd.contextWindow);
  assert.ok(absurd.warnings.some((w) => w.includes("clamped")));
});

test("heterogeneous deployment is visible to the caller", () => {
  const capability = normalizeCapability({
    id: "m",
    inferweave: { guaranteed_routable_tokens: 131_072, max_routable_tokens: 1_048_576, heterogeneous: true },
  });
  const resolved = resolveModelContext("m", capability);
  assert.equal(resolved.heterogeneous, true);
  assert.equal(resolved.contextWindow, 131_072, "a 1M backend does not raise the advertised window");
});

test("formatTokens renders the compact form the status bar uses", () => {
  assert.equal(formatTokens(143_000), "143k");
  assert.equal(formatTokens(262_144), "262k");
  assert.equal(formatTokens(32_768), "33k");
  assert.equal(formatTokens(1_048_576), "1M");
  assert.equal(formatTokens(900), "900");
});
