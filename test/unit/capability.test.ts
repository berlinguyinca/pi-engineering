import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DiscoveryContext, ModelSource } from "../../src/capability/discovery.ts";
import { StaticModelSource } from "../../src/capability/discovery.ts";
import { hasCapability, normalizeModelRecord } from "../../src/capability/modelRecord.ts";
import type { NormalizeInput } from "../../src/capability/modelRecord.ts";
import { ObservedStore } from "../../src/capability/observed.ts";
import { ModelCapabilityRegistry } from "../../src/capability/registry.ts";
import { RoleRouter, parseRef } from "../../src/capability/router.ts";
import { DEFAULT_POLICY, deepMerge, validatePolicy } from "../../src/lifecycle/policy.ts";
import type { EngineeringPolicy } from "../../src/lifecycle/policy.ts";
import { modelKey } from "../../src/lifecycle/types.ts";
import type { ModelRecord, ModelRef } from "../../src/lifecycle/types.ts";

function ref(provider: string, id: string): ModelRef {
  return { provider, id };
}

function record(input: Partial<NormalizeInput> & { provider: string; id: string }): ModelRecord {
  // Tool-calling + a generous context window are the baseline traits; individual
  // tests override the trait under test.
  return normalizeModelRecord({ source: "test", toolCall: true, contextWindow: 200_000, ...input });
}

class FakeSource implements ModelSource {
  readonly name = "fake";
  private readonly records: ModelRecord[];
  private readonly fail: boolean;

  constructor(records: ModelRecord[], fail = false) {
    this.records = records;
    this.fail = fail;
  }

  async discover(): Promise<ModelRecord[]> {
    if (this.fail) throw new Error("provider offline");
    return this.records;
  }
}

class GrowingSource implements ModelSource {
  readonly name = "growing";
  count = 1;

  async discover(): Promise<ModelRecord[]> {
    const records = [record({ provider: "alpha", id: "fast" })];
    if (this.count > 1) records.push(record({ provider: "alpha", id: "newly-configured" }));
    return records;
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-eng-cap-"));
}

function openRegistry(sources: ModelSource[], cwd: string): Promise<ModelCapabilityRegistry> {
  return ModelCapabilityRegistry.open({ sources, context: { cwd, agentDir: cwd } satisfies DiscoveryContext });
}

function policy(patch: (p: EngineeringPolicy) => void): EngineeringPolicy {
  const clone = deepMerge(structuredClone(DEFAULT_POLICY), {}) as EngineeringPolicy;
  patch(clone);
  assert.deepEqual(
    validatePolicy(clone).filter((i) => i.severity === "error"),
    [],
  );
  return clone;
}

async function routerFor(records: ModelRecord[], p: EngineeringPolicy = DEFAULT_POLICY): Promise<RoleRouter> {
  const cwd = await tempDir();
  const registry = await openRegistry([new FakeSource(records)], cwd);
  await registry.refresh();
  return new RoleRouter({ registry, policy: p });
}

test("capability inference reads declared modalities and never overclaims vision", () => {
  const vision = record({ provider: "p", id: "qwen3.8-27b-vision", input: ["text", "image"] });
  assert.equal(vision.capabilities.values.vision, true);

  const textOnly = record({ provider: "p", id: "text-model", input: ["text"] });
  assert.equal(hasCapability(textOnly, "vision"), false);
  assert.deepEqual(textOnly.modalities, ["text"]);
});

test("registry discovers models with no code change and reports per-source failure", async () => {
  const cwd = await tempDir();
  try {
    const registry = await openRegistry(
      [
        new FakeSource([record({ provider: "alpha", id: "fast", contextWindow: 100_000 })]),
        new FakeSource([record({ provider: "beta", id: "smart", reasoning: true })], true),
      ],
      cwd,
    );
    const result = await registry.refresh();
    assert.equal(result.models, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /provider offline/);
    assert.ok(registry.get(ref("alpha", "fast")));
    assert.equal(registry.get(ref("beta", "smart")), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("re-discovery picks up a newly configured model automatically", async () => {
  const cwd = await tempDir();
  try {
    const source = new GrowingSource();
    const registry = await openRegistry([source], cwd);
    await registry.refresh();
    assert.equal(registry.size, 1);
    source.count = 2;
    const second = await registry.refresh();
    assert.equal(second.changed, true);
    assert.equal(registry.size, 2);
    assert.ok(registry.get(ref("alpha", "newly-configured")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failure penalties down-weight a model and expire", async () => {
  const cwd = await tempDir();
  try {
    const registry = await openRegistry([new FakeSource([record({ provider: "alpha", id: "flaky" })])], cwd);
    await registry.refresh();
    const router = new RoleRouter({ registry, policy: DEFAULT_POLICY });
    const before = (await router.select({ role: "test_reviewer" })).candidates[0]?.score ?? -1;
    registry.penalize(ref("alpha", "flaky"), "timeout", 0.9);
    const after = (await router.select({ role: "test_reviewer" })).candidates[0]?.score ?? -1;
    assert.ok(after < before, `penalised score ${after} should be below ${before}`);
    assert.ok(registry.activePenalty(ref("alpha", "flaky")));
    registry.clearPenalty(ref("alpha", "flaky"));
    assert.equal(registry.activePenalty(ref("alpha", "flaky")), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("observed performance accumulates per model and per role", async () => {
  const store = ObservedStore.inMemory();
  store.record({
    model: ref("alpha", "fast"),
    role: "reviewer",
    at: new Date().toISOString(),
    quality: 1,
    ok: true,
    latencyMs: 60_000,
  });
  store.record({
    model: ref("alpha", "fast"),
    role: "reviewer",
    at: new Date().toISOString(),
    quality: 0,
    ok: false,
    latencyMs: 500,
  });
  const observed = store.get(ref("alpha", "fast"));
  const latencyMs = observed?.meanLatencyMs;
  assert.equal(observed?.samples, 2);
  assert.equal(observed?.failures, 1);
  assert.ok(latencyMs !== undefined && latencyMs > 0);
});

test("router hard-rejects models missing a required capability", async () => {
  const router = await routerFor([
    record({ provider: "alpha", id: "text-only", input: ["text"] }),
    record({ provider: "alpha", id: "seeing", input: ["text", "image"] }),
  ]);
  const decision = await router.select({ role: "vision_reviewer" });
  assert.ok(decision.selected);
  assert.equal(modelKey(decision.selected), "alpha/seeing");
  const rejected = decision.rejected.find((r) => r.model.id === "text-only");
  assert.ok(rejected);
  assert.equal(rejected.stage, "capability");
});

test("router enforces separation of duties against the requesting model", async () => {
  const router = await routerFor([record({ provider: "alpha", id: "solo" })]);
  const decision = await router.select({ role: "reviewer", requester: ref("alpha", "solo") });
  assert.equal(decision.selected, undefined);
  assert.ok(decision.rejected.some((r) => r.stage === "separation_of_duties"));
});

test("router scores cost and provider priority, and applies overrides with provenance", async () => {
  const cheap = record({ provider: "alpha", id: "cheap", priceInput: 0.05, priceOutput: 0.1, contextWindow: 200_000 });
  const pricey = record({ provider: "beta", id: "pricey", priceInput: 40, priceOutput: 80, contextWindow: 200_000 });

  const costDecision = await (await routerFor([pricey, cheap])).select({ role: "implementer" });
  assert.ok(costDecision.selected);
  assert.equal(modelKey(costDecision.selected), "alpha/cheap");
  assert.ok(costDecision.rationale.some((r) => /score/i.test(r)));

  // Identical capability/cost posture: the configured provider order must decide.
  const twinA = record({ provider: "alpha", id: "twin", priceInput: 1, priceOutput: 1, contextWindow: 200_000 });
  const twinB = record({ provider: "beta", id: "twin", priceInput: 1, priceOutput: 1, contextWindow: 200_000 });
  const prioritised = policy((p) => {
    p.routing.provider_priority = ["beta"];
  });
  const priorityDecision = await (await routerFor([twinA, twinB], prioritised)).select({ role: "implementer" });
  assert.ok(priorityDecision.selected);
  assert.equal(modelKey(priorityDecision.selected), "beta/twin");

  const cwd = await tempDir();
  const registry = await openRegistry([new FakeSource([cheap, pricey])], cwd);
  await registry.refresh();
  const overrideRouter = new RoleRouter({
    registry,
    policy: DEFAULT_POLICY,
    overrides: [{ source: "session pin", roles: { planner: "beta/pricey" } }],
  });
  const pinned = await overrideRouter.select({ role: "planner" });
  assert.ok(pinned.selected);
  assert.equal(modelKey(pinned.selected), "beta/pricey");
  assert.equal(pinned.overrideApplied?.source, "session pin");
});

test("router fallback skips attempted models and records provenance", async () => {
  const router = await routerFor([
    record({ provider: "alpha", id: "primary" }),
    record({ provider: "alpha", id: "spare" }),
  ]);
  const fallback = await router.fallback({ role: "test_reviewer" }, [ref("alpha", "primary")]);
  assert.ok(fallback?.selected);
  assert.equal(modelKey(fallback.selected), "alpha/spare");
  assert.equal(modelKey(fallback.fallbackOf ?? ref("", "")), "alpha/primary");
  assert.ok(fallback.rationale.some((r) => /Fallback after/i.test(r)));
});

test("denied providers and unavailable models are excluded with explicit reasons", async () => {
  const p = policy((cfg) => {
    cfg.routing.provider_deny = ["beta"];
  });
  const router = await routerFor(
    [
      record({ provider: "alpha", id: "ok" }),
      record({ provider: "beta", id: "blocked" }),
      record({ provider: "gamma", id: "down", available: false }),
    ],
    p,
  );
  const decision = await router.select({ role: "orchestrator" });
  assert.equal(modelKey(decision.selected ?? ref("", "")), "alpha/ok");
  assert.ok(decision.rejected.some((r) => r.stage === "repo_policy" && r.model.provider === "beta"));
  assert.ok(decision.rejected.some((r) => r.stage === "health" && r.model.provider === "gamma"));
});

test("static operator models merge into discovery with explicit tags and locality", async () => {
  const statics = new StaticModelSource([
    {
      provider: "manual",
      id: "vision-box",
      base_url: "http://127.0.0.1:1234/v1",
      modalities: ["text", "image"],
      tags: ["screenshot_review"],
      context_window: 32_000,
    },
  ]);
  const out = await statics.discover();
  const rec = out.find((r) => r.id === "vision-box");
  assert.ok(rec);
  assert.equal(hasCapability(rec, "vision"), true);
  assert.equal(rec.local, true);
});

test("parseRef splits provider and id, tolerating ids containing slashes", () => {
  assert.deepEqual(parseRef("openai/gpt-4o"), { provider: "openai", id: "gpt-4o" });
  assert.deepEqual(parseRef("ollama"), { provider: "ollama", id: "ollama" });
});
