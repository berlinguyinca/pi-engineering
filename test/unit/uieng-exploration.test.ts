import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DIFFUSION_IMAGE_GENERATION_CAPABILITY,
  DIFFUSION_REFERENCE_NOTE,
  type DesignFamily,
  SELECTION_OPS,
  UX_ARCHITECTURE_CAPABILITY,
  applySelectionOp,
  checkRequirementsCoverage,
  combineSelections,
  convertDesignDirection,
  explorationPlan,
  explorationTrigger,
  familyPlan,
  letPiChoose,
  moreLikeThis,
  requestCapability,
  selectArtifact,
  shouldExplore,
} from "../../src/uieng/exploration.ts";
import type { UiGenome } from "../../src/uieng/genome.ts";
import type { UiImpactLevel } from "../../src/uieng/policy.ts";
import type { DesignArtifact, TaskRequest } from "../../src/uieng/schemas.ts";
import type { CanonicalTask } from "../../src/uieng/usability.ts";

function canonicalTask(goal: string, id = goal): CanonicalTask {
  return {
    id,
    goal,
    mode: "first_time",
    required_states: ["loading", "error"],
    success_criteria: [`${goal} completes`],
    viewport_targets: ["mobile", "tablet", "desktop"],
  };
}

function genome(version = 1): UiGenome {
  return { version, contracts: {} };
}

function genomeWithContract(version = 1): UiGenome {
  return { version, contracts: { tokens: { colors: { primary: "#1a73e8" } } } };
}

function artifact(id: string, title: string, description = "", type = "spec"): DesignArtifact {
  return {
    schema_version: 1,
    kind: "design_artifact",
    id,
    type,
    title,
    description,
    content_ref: `artifact://${id}`,
    created_at: "2026-09-15T00:00:00.000Z",
  };
}

const baseInputs = {
  productGoals: ["Onboard users quickly"],
  canonicalTasks: [] as CanonicalTask[],
  existingWorkflows: [] as string[],
  uiGenome: undefined as UiGenome | undefined,
  constraints: ["WCAG AA"],
};

describe("exploration trigger", () => {
  it("triggers major redesign for a design-system-level change", () => {
    assert.equal(explorationTrigger(baseInputs, "L3_system_design_system"), "major_redesign");
    assert.equal(shouldExplore(baseInputs, "L3_system_design_system"), true);
  });

  it("triggers new UI when there is no existing surface or genome", () => {
    assert.equal(explorationTrigger(baseInputs, "L1_micro"), "new_ui");
  });

  it("does not explore an established surface at low impact", () => {
    const inputs = { ...baseInputs, existingWorkflows: ["onboarding", "billing"], uiGenome: genome() };
    assert.equal(explorationTrigger(inputs, "L1_micro"), "none");
    assert.equal(shouldExplore(inputs, "L1_micro"), false);
  });

  it("triggers substantial UI surface from many canonical tasks", () => {
    const tasks = ["a", "b", "c", "d"].map((g) => canonicalTask(`task ${g}`));
    const inputs = { ...baseInputs, canonicalTasks: tasks, uiGenome: genomeWithContract() };
    assert.equal(explorationTrigger(inputs, "L1_micro"), "substantial_ui_surface");
  });
});

describe("explorationPlan", () => {
  it("builds a coverage checklist, hypotheses and a diffusion capability id", () => {
    const inputs = {
      ...baseInputs,
      canonicalTasks: [canonicalTask("create a report")],
      constraints: ["WCAG AA", "no new deps"],
    };
    const plan = explorationPlan(inputs, "L1_micro");
    assert.equal(plan.trigger, "new_ui");
    assert.equal(plan.diffusionCapability, "diffusion/image_generation");
    assert.equal(plan.hypotheses.length, 3);
    const archetypes = plan.hypotheses.map((h) => h.archetype).sort();
    assert.deepEqual(archetypes, ["clean_sheet", "conservative_modernization", "moderate_redesign"]);
    // each hypothesis carries a capability request + diffusion request
    for (const h of plan.hypotheses) {
      assert.equal(h.capabilityRequest.required_capabilities[0], UX_ARCHITECTURE_CAPABILITY);
      assert.equal(h.diffusionRequest.required_capabilities[0], DIFFUSION_IMAGE_GENERATION_CAPABILITY);
      assert.equal(h.diffusionRequest.image_generation, true);
    }
    // coverage checklist includes base + workflow + constraint entries
    const categories = plan.requirements.map((r) => r.category);
    assert.ok(categories.includes("responsive"));
    assert.ok(categories.includes("states"));
    assert.ok(categories.includes("pages"));
    assert.ok(categories.includes("workflow"));
    assert.ok(categories.includes("constraint"));
  });

  it("is deterministic across calls", () => {
    const a = explorationPlan(baseInputs, "L1_micro");
    const b = explorationPlan(baseInputs, "L1_micro");
    assert.equal(a.hypotheses.length, b.hypotheses.length);
    assert.deepEqual(
      a.hypotheses.map((h) => h.id),
      b.hypotheses.map((h) => h.id),
    );
  });
});

describe("requestCapability", () => {
  it("produces a TaskRequest-shaped request with derived flags", () => {
    const req = requestCapability("diffusion/image_generation", {
      id: "WI-DIFF1",
      context: "generate reference imagery",
      quality_class: "high",
    });
    const required: TaskRequest = {
      schema_version: 1,
      kind: "task_request",
      id: req.id,
      type: req.type,
      required_capabilities: req.required_capabilities,
      optional_capabilities: req.optional_capabilities,
      artifacts: req.artifacts,
      context: req.context,
      latency_class: req.latency_class,
      quality_class: req.quality_class,
      reasoning_class: req.reasoning_class,
      vision: req.vision,
      image_generation: req.image_generation,
    };
    assert.equal(required.kind, "task_request");
    assert.equal(req.required_capabilities[0], "diffusion/image_generation");
    assert.equal(req.image_generation, true);
    assert.equal(req.vision, true);
  });

  it("derives flags per capability and never names a model", () => {
    const ux = requestCapability("ux_architecture", { id: "WI-UX1", context: "architecture" });
    assert.equal(ux.image_generation, false);
    const rf = requestCapability("responsive_family", { id: "WI-RF1", context: "responsive" });
    assert.equal(rf.vision, true);
    assert.equal(rf.image_generation, false);
    assert.ok(!JSON.stringify(rf).includes("model"));
  });
});

describe("familyPlan", () => {
  it("covers devices, states and key pages with a reference note", () => {
    const plan = explorationPlan(baseInputs, "L1_micro");
    const family = familyPlan(plan.hypotheses[0]!);
    assert.deepEqual(family.devices, ["desktop", "tablet", "phone"]);
    assert.ok(family.states.includes("empty"));
    assert.ok(family.states.includes("loading"));
    assert.ok(family.states.includes("error"));
    assert.ok(family.pages.length > 0);
    assert.ok(family.referenceImages.length > 0);
    assert.equal(family.note, DIFFUSION_REFERENCE_NOTE);
  });

  it("differentiates conservative modernization from clean sheet page sets", () => {
    const plan = explorationPlan(baseInputs, "L1_micro");
    const conservative = plan.hypotheses.find((h) => h.archetype === "conservative_modernization")!;
    const cleanSheet = plan.hypotheses.find((h) => h.archetype === "clean_sheet")!;
    const conservativeKeys = familyPlan(conservative)
      .pages.map((p) => p.key)
      .sort();
    const cleanKeys = familyPlan(cleanSheet)
      .pages.map((p) => p.key)
      .sort();
    assert.ok(cleanKeys.length > conservativeKeys.length);
    assert.ok(!conservativeKeys.includes("create"));
    assert.ok(cleanKeys.includes("create"));
  });
});

describe("checkRequirementsCoverage", () => {
  it("reports covered and missing requirement ids", () => {
    const plan = explorationPlan(baseInputs, "L1_micro");
    const family = familyPlan(plan.hypotheses[0]!);
    const result = checkRequirementsCoverage(family, plan.requirements);
    assert.ok(result.covered.includes("responsive"));
    assert.ok(result.covered.includes("states"));
    assert.ok(result.covered.includes("pages"));
    assert.ok(result.covered.includes("ideation"));
    assert.deepEqual(result.missing, []);
  });

  it("flags missing states when the family lacks them", () => {
    const plan = explorationPlan(baseInputs, "L1_micro");
    const family = familyPlan(plan.hypotheses[0]!);
    const stripped: DesignFamily = { ...family, states: ["normal", "dialog"] };
    const result = checkRequirementsCoverage(stripped, plan.requirements);
    assert.ok(result.missing.includes("states"));
    assert.ok(result.covered.includes("pages"));
  });
});

describe("selection operations", () => {
  const a = artifact("A-1", "Settings redesign spec", "modernize settings navigation", "spec");
  const b = artifact(
    "B-1",
    "Settings implementation plan",
    "implement settings navigation redesign",
    "implementation_plan",
  );
  const c = artifact("C-1", "Dashboard spec", "fresh dashboard layout", "spec");

  it("supports Select", () => {
    const result = selectArtifact(a);
    assert.equal(result.op, "Select");
    assert.deepEqual(result.artifacts, [a]);
  });

  it("supports More-like-this via similarity ranking", () => {
    const result = moreLikeThis(a, [a, b, c]);
    assert.equal(result.op, "More-like-this");
    assert.ok(result.artifacts.includes(b));
    assert.ok(!result.artifacts.includes(a));
  });

  it("supports Combine and deduplicates", () => {
    const result = combineSelections([a, b, a]);
    assert.equal(result.op, "Combine");
    assert.equal(result.artifacts.length, 2);
  });

  it("supports Let-Pi-choose deterministically preferring concrete plans", () => {
    const result = letPiChoose([a, b, c]);
    assert.equal(result.op, "Let-Pi-choose");
    assert.deepEqual(result.artifacts, [b]);
  });

  it("dispatches every named op", () => {
    for (const op of SELECTION_OPS) {
      const result = applySelectionOp(op, [a, b, c], { seed: a, feedback: "keep it clean" });
      assert.equal(result.op, op);
      assert.ok(Array.isArray(result.artifacts));
    }
  });
});

describe("convertDesignDirection", () => {
  it("bumps version and records the direction as an advisory rule", () => {
    const selected = {
      name: "Moderate Redesign",
      rationale: "Reorganize around canonical tasks",
      artifacts: [artifact("A-1", "Direction spec", "direction", "spec")],
      contractChanges: { tokens: { colors: { primary: "#1a73e8" } } },
    };
    const updated = convertDesignDirection(selected, genome(2));
    assert.equal(updated.version, 3);
    assert.deepEqual(updated.contracts.tokens, { colors: { primary: "#1a73e8" } });
    const constitution = updated.contracts.constitution!;
    const rule = constitution.rules.find((r) => r.id === "direction-moderate-redesign");
    assert.ok(rule, "direction rule recorded");
    assert.equal(rule.approved, false);
  });

  it("handles a genome without an existing constitution", () => {
    const updated = convertDesignDirection({ name: "Clean Sheet", rationale: "fresh", artifacts: [] }, genome(1));
    assert.equal(updated.version, 2);
    assert.ok(updated.contracts.constitution!.rules.some((r) => r.id === "direction-clean-sheet"));
  });
});
