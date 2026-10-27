import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CatalogRecoveryProbe } from "../../src/resilience/probe.ts";

function goReport() {
  const updated = new Date().toISOString();
  return {
    enabled: true,
    closed: false,
    active: 3,
    queued: 0,
    selecting: 0,
    capacity_observations: [
      {
        model_id: "qwen-27b",
        provider_id: "worker-a",
        max_active_seats: 4,
        active_seats: 3,
        available_seats: 1,
        healthy: true,
        known: true,
        updated_at: updated,
        source: "slots",
      },
    ],
    models: {
      "qwen-27b": {
        capacity_known: true,
        capacity_source: "slots",
        capacity_updated_at: updated,
        active: 3,
        queued: 0,
        active_limit: 4,
        queue_limit: 8,
        capacity: 4,
        available: 1,
        borrowed: 0,
      },
    },
    runtimes: {},
    priorities: {},
  };
}

function probeFor(
  report: unknown,
  row: Record<string, unknown> = { id: "qwen-27b", owned_by: "inferweave", slots: 4 },
) {
  return new CatalogRecoveryProbe({
    resolve: async () => ({ baseUrl: "https://gateway.example/v1", modelId: String(row.id), apiKey: "secret" }),
    fetchImpl: async (url) => Response.json(String(url).endsWith("/models") ? { data: [row] } : report),
  });
}

describe("CatalogRecoveryProbe: deployed Go admission report", () => {
  it("recovers on fresh known model availability from the object-keyed report", async () => {
    const result = await probeFor(goReport()).probe();
    assert.equal(result.healthy, true);
    assert.equal(result.authoritative, true);
    assert.match(result.reason ?? "", /model-level.*headroom/);
    assert.match(result.reason ?? "", /caller.*not reported/);
  });

  it("does not mistake queue room, policy room, or catalogue slots for free capacity", async () => {
    for (const patch of [{ available: 0 }, { queued: 1 }, { active: 4 }, { active_limit: 3 }, { queued: 8 }]) {
      const report = goReport();
      Object.assign(report.models["qwen-27b"], patch);
      const result = await probeFor(report).probe();
      assert.equal(result.healthy, false, JSON.stringify(patch));
      assert.equal(result.authoritative, true, JSON.stringify(patch));
    }
    const closed = goReport();
    closed.closed = true;
    assert.equal((await probeFor(closed).probe()).healthy, false);
  });

  it("treats unknown, stale, future, and incomplete model capacity as non-authoritative", async () => {
    for (const patch of [
      { capacity_known: false },
      { capacity_updated_at: new Date(Date.now() - 91_000).toISOString() },
      { capacity_updated_at: new Date(Date.now() + 60_000).toISOString() },
      { capacity_updated_at: "invalid" },
      { available: undefined },
      { available: -1 },
      { available: 5 },
      { capacity: undefined },
    ]) {
      const report = goReport();
      Object.assign(report.models["qwen-27b"], patch);
      const result = await probeFor(report).probe();
      assert.equal(result.healthy, false, JSON.stringify(patch));
      assert.equal(result.authoritative, false, JSON.stringify(patch));
    }
  });

  it("handles idle policy placeholders and effective model/global policy diagnostics", async () => {
    const report = goReport();
    report.models["qwen-27b"].active = 0;
    report.models["qwen-27b"].active_limit = 0;
    report.models["qwen-27b"].queue_limit = 0;
    assert.equal(
      (await probeFor(report).probe()).healthy,
      true,
      "zero idle policy placeholders are not exhausted capacity",
    );
    const diagnostics = {
      policy: {
        model_default: { active: 4, queued: 8 },
        model_overrides: { "qwen-27b": { active: 1, queued: 4 } },
        scope_limits: { global: { active: 8, queued: 16 } },
      },
    };
    const scoped = { ...report, diagnostics };
    scoped.models["qwen-27b"].active = 1;
    assert.equal((await probeFor(scoped).probe()).healthy, false, "effective model override constrains physical seats");
    diagnostics.policy.model_overrides["qwen-27b"].active = 4;
    assert.equal((await probeFor(scoped).probe()).healthy, true);
    scoped.active = 8;
    assert.equal(
      (await probeFor(scoped).probe()).healthy,
      false,
      "global policy is enforced independently of model headroom",
    );
    scoped.active = 7;
    scoped.selecting = 1;
    assert.equal(
      (await probeFor(scoped).probe()).healthy,
      false,
      "selecting requests also consume global admission room",
    );
  });

  it("does not infer free capacity from raw observations when the model summary is unknown or absent", async () => {
    const report = goReport();
    report.models["qwen-27b"].capacity_known = false;
    const unknown = await probeFor(report).probe();
    assert.equal(unknown.healthy, false);
    assert.equal(unknown.authoritative, false);
    const absent = await probeFor({ ...report, models: {} }).probe();
    assert.equal(absent.healthy, false);
    assert.equal(absent.authoritative, false, "an idle untracked model is unknown, not zero capacity");
  });

  it("uses catalogue backing-model metadata for an alias without borrowing another model's availability", async () => {
    const report = goReport();
    const alias = { id: "coding", owned_by: "inferweave", x_alias: true, x_backing_model: "qwen-27b" };
    assert.equal((await probeFor(report, alias).probe()).healthy, true);
    assert.equal((await probeFor(report, { ...alias, x_backing_model: "other" }).probe()).healthy, false);
  });
});
