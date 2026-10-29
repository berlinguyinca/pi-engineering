import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CONTEXT_PRESSURE_RATIO,
  DEFAULT_CONTEXT_THRESHOLDS,
  contextLevel,
  evaluateCrossing,
  loadContextThresholdConfig,
  parseContextThresholdConfig,
  resolveContextThresholds,
  validateThresholds,
} from "../../src/context/thresholds.ts";
import { PHASE_HANDOFF_THRESHOLD } from "../../src/orchestration/phaseBoundaryHandoff.ts";

describe("context thresholds: one triple", () => {
  it("defaults are 0.70 / 0.80 / 0.90", () => {
    assert.deepEqual(DEFAULT_CONTEXT_THRESHOLDS, { soft: 0.7, preferred: 0.8, emergency: 0.9 });
  });

  it("the legacy constants derive from the triple", () => {
    assert.equal(CONTEXT_PRESSURE_RATIO, DEFAULT_CONTEXT_THRESHOLDS.preferred);
    assert.equal(PHASE_HANDOFF_THRESHOLD, DEFAULT_CONTEXT_THRESHOLDS.soft);
  });

  it("contextLevel is a pure step function with inclusive lower bounds", () => {
    assert.equal(contextLevel(null), "ok");
    assert.equal(contextLevel(0), "ok");
    assert.equal(contextLevel(0.6999), "ok");
    assert.equal(contextLevel(0.7), "soft");
    assert.equal(contextLevel(0.7999), "soft");
    assert.equal(contextLevel(0.8), "preferred");
    assert.equal(contextLevel(0.8999), "preferred");
    assert.equal(contextLevel(0.9), "emergency");
    assert.equal(contextLevel(1.2), "emergency");
    assert.equal(contextLevel(Number.NaN), "ok");
  });

  it("validateThresholds demands 0 < soft < preferred < emergency <= 1", () => {
    assert.equal(validateThresholds({ soft: 0.5, preferred: 0.6, emergency: 1 }).ok, true);
    for (const bad of [
      { soft: 0.8, preferred: 0.8, emergency: 0.9 },
      { soft: 0.7, preferred: 0.9, emergency: 0.8 },
      { soft: 0, preferred: 0.8, emergency: 0.9 },
      { soft: 0.7, preferred: 0.8, emergency: 1.01 },
      { soft: "0.7", preferred: 0.8, emergency: 0.9 },
      null,
    ]) {
      assert.equal(validateThresholds(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("context thresholds: YAML config", () => {
  it("absent block = defaults, no notes", () => {
    const { config, notes } = parseContextThresholdConfig(undefined);
    assert.deepEqual(resolveContextThresholds(config, { model: "x" }), DEFAULT_CONTEXT_THRESHOLDS);
    assert.deepEqual(notes, []);
  });

  it("model beats runtime beats default; partial overrides merge onto the layer below", () => {
    const { config, notes } = parseContextThresholdConfig({
      preferred: 0.82,
      runtimes: { "llama.cpp": { soft: 0.6, preferred: 0.7, emergency: 0.85 } },
      models: { "glm-*": { emergency: 0.95 }, "glm-5.1": { preferred: 0.75 } },
    });
    assert.deepEqual(notes, []);
    assert.deepEqual(resolveContextThresholds(config, {}), { soft: 0.7, preferred: 0.82, emergency: 0.9 });
    assert.deepEqual(resolveContextThresholds(config, { runtime: "llama.cpp" }), {
      soft: 0.6,
      preferred: 0.7,
      emergency: 0.85,
    });
    // the glob applies first, the exact id on top of it
    assert.deepEqual(resolveContextThresholds(config, { model: "glm-5.1" }), {
      soft: 0.7,
      preferred: 0.75,
      emergency: 0.95,
    });
    assert.deepEqual(resolveContextThresholds(config, { model: "glm-4" }), {
      soft: 0.7,
      preferred: 0.82,
      emergency: 0.95,
    });
    // model layer sits on top of the runtime layer
    assert.deepEqual(resolveContextThresholds(config, { model: "glm-4", runtime: "llama.cpp" }), {
      soft: 0.6,
      preferred: 0.7,
      emergency: 0.95,
    });
  });

  it("an invalid layer is ignored with a note, never partly applied", () => {
    const { config, notes } = parseContextThresholdConfig({
      models: { bad: { soft: 0.9, preferred: 0.8 } },
      emergency: "high",
    });
    assert.ok(notes.length >= 2, notes.join("|"));
    assert.deepEqual(resolveContextThresholds(config, { model: "bad" }), DEFAULT_CONTEXT_THRESHOLDS);
  });

  it("loads from the global engineering.yaml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxthr-"));
    try {
      writeFileSync(join(dir, "engineering.yaml"), "context_thresholds:\n  preferred: 0.85\n  emergency: 0.95\n");
      const { config } = await loadContextThresholdConfig(dir);
      assert.deepEqual(resolveContextThresholds(config, {}), { soft: 0.7, preferred: 0.85, emergency: 0.95 });
      const none = await loadContextThresholdConfig(join(dir, "missing"));
      assert.deepEqual(resolveContextThresholds(none.config, {}), DEFAULT_CONTEXT_THRESHOLDS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluateCrossing: once per crossing", () => {
  const T = DEFAULT_CONTEXT_THRESHOLDS;
  it("preferred fires only at a safe point, and only once", () => {
    let s = { fired: "ok" as const } as ReturnType<typeof evaluateCrossing>["state"];
    let r = evaluateCrossing(s, "preferred", false);
    assert.equal(r.action, null, "not at a safe point");
    s = r.state;
    r = evaluateCrossing(s, "preferred", true);
    assert.equal(r.action, "preferred");
    s = r.state;
    for (let i = 0; i < 20; i++) {
      r = evaluateCrossing(s, "preferred", true);
      assert.equal(r.action, null, `poll ${i} must not re-fire`);
      s = r.state;
    }
  });

  it("emergency fires immediately (no safe point needed), once, and still fires after preferred", () => {
    let r = evaluateCrossing({ fired: "preferred" }, "emergency", false);
    assert.equal(r.action, "emergency");
    r = evaluateCrossing(r.state, "emergency", false);
    assert.equal(r.action, null);
    r = evaluateCrossing(r.state, "preferred", true);
    assert.equal(r.action, null, "emergency already actioned; preferred must not follow it");
  });

  it("re-arms only once the level is back below soft; hovering around preferred does not re-fire", () => {
    let r = evaluateCrossing({ fired: "ok" }, "preferred", true);
    assert.equal(r.action, "preferred");
    for (let i = 0; i < 10; i++) {
      r = evaluateCrossing(r.state, i % 2 ? "preferred" : "soft", true);
      assert.equal(r.action, null, "oscillation between soft and preferred is the same crossing");
    }
    r = evaluateCrossing(r.state, "ok", true);
    assert.equal(r.action, null);
    r = evaluateCrossing(r.state, "preferred", true);
    assert.equal(r.action, "preferred", "a second, real crossing fires again");
    void T;
  });

  it("soft and ok never act", () => {
    assert.equal(evaluateCrossing({ fired: "ok" }, "soft", true).action, null);
    assert.equal(evaluateCrossing({ fired: "ok" }, "ok", true).action, null);
  });
});
