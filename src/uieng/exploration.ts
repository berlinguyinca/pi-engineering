/**
 * Automatic design exploration + diffusion planning
 * (docs/specs/autonomous-ui-engineering/pi-engineering/03-design-exploration.md).
 *
 * When a change triggers exploration (new UI, substantial UI surface, or major
 * redesign) this module:
 *
 *   1. `explorationTrigger` / `shouldExplore` decide whether exploration runs.
 *   2. `explorationPlan` analyzes product goals, canonical tasks, existing
 *      workflows, the UI genome and constraints, then produces a set of
 *      genuinely different UX-architecture hypotheses plus a requirements
 *      coverage checklist and the diffusion capability id.
 *   3. `requestCapability` dispatches a capability/task-based request to
 *      InferWeave (ux_architecture, diffusion/image_generation,
 *      responsive_family, visual_ideation) — capability ids, never
 *      hard-coded model names.
 *   4. `familyPlan` turns a hypothesis into a responsive design family
 *      covering desktop/tablet/phone plus key pages and empty/loading/error
 *      states.
 *   5. `checkRequirementsCoverage` verifies the family satisfies the plan's
 *      requirements before presentation.
 *   6. Selection operations (Select, More-like-this, Combine, Feedback,
 *      Let-Pi-choose) and `convertDesignDirection` support pi-web's data model
 *      for picking a direction and folding it back into the versioned UI genome.
 *
 * Diffusion images produced here are VISUAL IDEATION / REFERENCE, never
 * functional truth; they are consumed for inspiration, not rendered as UI.
 */

import type { ConstitutionRule, GenomeContracts, UiGenome } from "./genome.ts";
import type { UiImpactLevel } from "./policy.ts";
import type { DesignArtifact, TaskRequest } from "./schemas.ts";
import type { CanonicalTask } from "./usability.ts";

/** Canonical, machine-readable note attached to every diffusion family. */
export const DIFFUSION_REFERENCE_NOTE = "Diffusion images are visual ideation/reference, not functional truth.";

/** How many canonical tasks indicate a "substantial UI surface". */
export const SUBSTANTIAL_TASK_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// 1. Exploration trigger + plan
// ---------------------------------------------------------------------------

/** Why automatic design exploration is (or is not) triggered. */
export type ExplorationTriggerKind = "new_ui" | "substantial_ui_surface" | "major_redesign" | "none";

export const EXPLORATION_TRIGGERS: readonly ExplorationTriggerKind[] = [
  "new_ui",
  "substantial_ui_surface",
  "major_redesign",
  "none",
];

/** Inputs to exploration planning (spec step 1). */
export interface ExplorationInputs {
  /** Product goals to satisfy (free-form strings). */
  productGoals: string[];
  /** Canonical tasks (src/uieng/usability.ts) describing key workflows. */
  canonicalTasks: CanonicalTask[];
  /** Existing workflow/surface names discovered in the app. */
  existingWorkflows: string[];
  /** The versioned UI genome, if the repo already has one. */
  uiGenome?: UiGenome;
  /** Constraints (accessibility, tech stack, brand, perf, etc.). */
  constraints?: string[];
}

/**
 * Deterministically classify whether automatic design exploration should run
 * and why. Major design-system changes are always major redesigns; a repo with
 * no existing workflow surface and product goals is a new UI; many canonical
 * tasks imply a substantial UI surface.
 */
export function explorationTrigger(inputs: ExplorationInputs, uiImpactLevel: UiImpactLevel): ExplorationTriggerKind {
  if (uiImpactLevel === "L3_system_design_system") return "major_redesign";
  // Only existing workflow/surface (not canonical goals) indicates an established app.
  const hasSurface = inputs.existingWorkflows.length > 0;
  const hasGenome = inputs.uiGenome !== undefined && Object.keys(inputs.uiGenome.contracts).length > 0;
  if (!hasSurface && !hasGenome && inputs.productGoals.length > 0) return "new_ui";
  if (inputs.canonicalTasks.length >= SUBSTANTIAL_TASK_THRESHOLD) return "substantial_ui_surface";
  return "none";
}

/** Convenience predicate: `true` whenever exploration should actually run. */
export function shouldExplore(inputs: ExplorationInputs, uiImpactLevel: UiImpactLevel): boolean {
  return explorationTrigger(inputs, uiImpactLevel) !== "none";
}

/** A single entry in the requirements coverage checklist. */
export interface ExplorationRequirement {
  id: string;
  description: string;
  category: RequirementCategory;
}

export const REQUIREMENT_CATEGORIES = [
  "responsive",
  "states",
  "pages",
  "ideation",
  "workflow",
  "accessibility",
  "constraint",
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

/** Distinct UX-architecture archetype for a hypothesis. */
export type HypothesisArchetype = "conservative_modernization" | "moderate_redesign" | "clean_sheet";

/** One genuinely different UX-architecture hypothesis from InferWeave. */
export interface UxHypothesis {
  id: string;
  name: string;
  archetype: HypothesisArchetype;
  rationale: string;
  /** ux_architecture capability request that produced this hypothesis. */
  capabilityRequest: CapabilityRequest;
  /** diffusion/image_generation capability request to route it through. */
  diffusionRequest: CapabilityRequest;
}

/** The full exploration plan (spec steps 1–2). */
export interface ExplorationPlan {
  trigger: ExplorationTriggerKind;
  /** Coverage checklist that a design family must satisfy before presentation. */
  requirements: ExplorationRequirement[];
  /** N genuinely different UX-architecture hypotheses. */
  hypotheses: UxHypothesis[];
  /** Capability id for image generation (NOT a model name). */
  diffusionCapability: string;
  generatedAt: string;
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const HYPOTHESIS_TEMPLATES: readonly { archetype: HypothesisArchetype; name: string; rationale: string }[] = [
  {
    archetype: "conservative_modernization",
    name: "Conservative Modernization",
    rationale:
      "Keep the existing information architecture and visual identity, modernize typography, spacing, tokens and interaction polish in place to de-risk the redesign.",
  },
  {
    archetype: "moderate_redesign",
    name: "Moderate Redesign",
    rationale:
      "Reorganize navigation and hierarchy around canonical tasks while preserving brand and terminology; introduces a refreshed layout system and responsive behavior.",
  },
  {
    archetype: "clean_sheet",
    name: "Clean Sheet",
    rationale:
      "Design a fresh information architecture and visual system from product goals and canonical tasks, ignoring legacy layout constraints for maximum improvement potential.",
  },
];

/**
 * Build the exploration plan: a requirements coverage checklist plus N
 * genuinely different UX-architecture hypotheses, each carrying its own
 * capability request, and the diffusion capability id.
 */
export function explorationPlan(inputs: ExplorationInputs, uiImpactLevel: UiImpactLevel): ExplorationPlan {
  const trigger = explorationTrigger(inputs, uiImpactLevel);
  const requirements = buildRequirements(inputs);
  const hypotheses = buildHypotheses(inputs);
  return {
    trigger,
    requirements,
    hypotheses,
    diffusionCapability: DIFFUSION_IMAGE_GENERATION_CAPABILITY,
    generatedAt: new Date(0).toISOString(), // deterministic instant; callers may stamp real time
  };
}

function buildRequirements(inputs: ExplorationInputs): ExplorationRequirement[] {
  const requirements: ExplorationRequirement[] = [
    {
      id: "responsive",
      description: "Responsive family covers desktop, tablet and phone.",
      category: "responsive",
    },
    {
      id: "states",
      description: "Family covers empty, loading and error states.",
      category: "states",
    },
    {
      id: "pages",
      description: "Family covers key pages and dialogs.",
      category: "pages",
    },
    {
      id: "ideation",
      description: "Diffusion reference images are generated for visual ideation.",
      category: "ideation",
    },
  ];
  for (const task of inputs.canonicalTasks) {
    requirements.push({
      id: `workflow:${slug(task.goal)}`,
      description: `Canonical workflow supported: ${task.goal}`,
      category: "workflow",
    });
  }
  for (const constraint of inputs.constraints ?? []) {
    requirements.push({
      id: `constraint:${slug(constraint)}`,
      description: `Constraint honored: ${constraint}`,
      category: "constraint",
    });
  }
  return requirements;
}

function buildHypotheses(inputs: ExplorationInputs): UxHypothesis[] {
  return HYPOTHESIS_TEMPLATES.map((template, index) => {
    const id = `ux-hypothesis-${index + 1}-${slug(template.name)}`;
    const context = [
      `UX architecture hypothesis: ${template.name}.`,
      ...inputs.productGoals.map((g) => `Goal: ${g}`),
      ...inputs.existingWorkflows.map((w) => `Existing workflow: ${w}`),
    ].join("\n");
    const capabilityRequest = requestCapability(UX_ARCHITECTURE_CAPABILITY, {
      id: `req-${id}-architecture`,
      type: "ux_architecture",
      context,
      reasoning_class: "deep",
    });
    const diffusionRequest = requestCapability(DIFFUSION_IMAGE_GENERATION_CAPABILITY, {
      id: `req-${id}-diffusion`,
      type: "diffusion/image_generation",
      context: `${context}\nArchetype: ${template.archetype}`,
      quality_class: "high",
    });
    return {
      id,
      name: template.name,
      archetype: template.archetype,
      rationale: template.rationale,
      capabilityRequest,
      diffusionRequest,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. Capability-based dispatch
// ---------------------------------------------------------------------------

/** Capability ids InferWeave understands for design exploration/diffusion. */
export const CAPABILITY_IDS = [
  "ux_architecture",
  "diffusion/image_generation",
  "responsive_family",
  "visual_ideation",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const UX_ARCHITECTURE_CAPABILITY: CapabilityId = "ux_architecture";
export const DIFFUSION_IMAGE_GENERATION_CAPABILITY: CapabilityId = "diffusion/image_generation";
export const RESPONSIVE_FAMILY_CAPABILITY: CapabilityId = "responsive_family";
export const VISUAL_IDEATION_CAPABILITY: CapabilityId = "visual_ideation";

/** Vision / image-generation flags implied by each capability. */
const CAPABILITY_FLAGS: Readonly<Record<CapabilityId, { vision: boolean; image_generation: boolean }>> = {
  ux_architecture: { vision: false, image_generation: false },
  "diffusion/image_generation": { vision: true, image_generation: true },
  responsive_family: { vision: true, image_generation: false },
  visual_ideation: { vision: true, image_generation: true },
};

/** Payload accepted by `requestCapability`. */
export interface CapabilityRequestPayload {
  /** Caller-supplied task id (>=3 chars). */
  id: string;
  context: string;
  type?: string;
  requiredCapabilities?: string[];
  optionalCapabilities?: string[];
  artifacts?: string[];
  structured_output_schema?: Record<string, unknown>;
  latency_class?: TaskRequest["latency_class"];
  quality_class?: TaskRequest["quality_class"];
  reasoning_class?: TaskRequest["reasoning_class"];
}

/** A capability request shaped as a TaskRequest (src/uieng/schemas.ts). */
export type CapabilityRequest = TaskRequest;

/**
 * Dispatch a capability/task-based request to InferWeave. The requested
 * capability id is placed first in `required_capabilities`, and the
 * vision / image_generation flags are derived from the capability — never a
 * model name.
 */
export function requestCapability(capabilityId: CapabilityId, payload: CapabilityRequestPayload): CapabilityRequest {
  const flags = CAPABILITY_FLAGS[capabilityId];
  return {
    schema_version: 1,
    kind: "task_request",
    id: payload.id,
    type: payload.type ?? capabilityId,
    required_capabilities: [capabilityId, ...(payload.requiredCapabilities ?? [])],
    optional_capabilities: payload.optionalCapabilities ?? [],
    artifacts: payload.artifacts ?? [],
    context: payload.context,
    structured_output_schema: payload.structured_output_schema,
    latency_class: payload.latency_class ?? "batch",
    quality_class: payload.quality_class ?? "medium",
    reasoning_class: payload.reasoning_class ?? "light",
    vision: flags.vision,
    image_generation: flags.image_generation,
  };
}

// ---------------------------------------------------------------------------
// 3. Diffusion family generation
// ---------------------------------------------------------------------------

/** Responsive device targets for a design family. */
export type DesignDevice = "desktop" | "tablet" | "phone";
/** UI states every family must cover. */
export type DesignState = "empty" | "loading" | "error" | "normal" | "dialog";

export const DESIGN_DEVICES: readonly DesignDevice[] = ["desktop", "tablet", "phone"];
export const DESIGN_STATES: readonly DesignState[] = ["empty", "loading", "error", "normal", "dialog"];

/** A key page / dialog in a design family. */
export interface DesignPage {
  key: string;
  name: string;
}

const STANDARD_KEY_PAGES: readonly DesignPage[] = [
  { key: "overview", name: "Overview / Home" },
  { key: "detail", name: "Entity Detail" },
  { key: "create", name: "Create / New" },
  { key: "settings", name: "Settings" },
  { key: "dialog", name: "Dialog / Modal" },
];

const CONSERVATIVE_KEY_PAGES: readonly DesignPage[] = [
  { key: "overview", name: "Overview / Home" },
  { key: "detail", name: "Entity Detail" },
  { key: "settings", name: "Settings" },
];

/** A responsive design family produced for one hypothesis. */
export interface DesignFamily {
  id: string;
  hypothesisId: string;
  devices: DesignDevice[];
  states: DesignState[];
  pages: DesignPage[];
  /** Diffusion image refs (visual ideation/reference, not functional truth). */
  referenceImages: string[];
  note: string;
}

/**
 * Produce the responsive family plan for a hypothesis: desktop/tablet/phone
 * plus key pages, dialogs and empty/loading/error states. Conservative
 * modernizations keep a leaner page set (existing surface), while redesigns
 * and clean-sheet explorations cover the full key-page set.
 */
export function familyPlan(hypothesis: UxHypothesis): DesignFamily {
  const pages =
    hypothesis.archetype === "conservative_modernization" ? [...CONSERVATIVE_KEY_PAGES] : [...STANDARD_KEY_PAGES];
  return {
    id: `family-${hypothesis.id}`,
    hypothesisId: hypothesis.id,
    devices: [...DESIGN_DEVICES],
    states: [...DESIGN_STATES],
    pages,
    referenceImages: pages.map((p) => `diffusion://reference/${hypothesis.id}/${p.key}.png`),
    note: DIFFUSION_REFERENCE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// 4. Requirements coverage check
// ---------------------------------------------------------------------------

/** Result of verifying a design family against the plan's requirements. */
export interface RequirementsCoverage {
  covered: string[];
  missing: string[];
}

/** Whether a single requirement is satisfied by a design family. */
export function coversRequirement(family: DesignFamily, requirement: ExplorationRequirement): boolean {
  switch (requirement.category) {
    case "responsive":
      return (
        family.devices.includes("desktop") && family.devices.includes("tablet") && family.devices.includes("phone")
      );
    case "states":
      return family.states.includes("empty") && family.states.includes("loading") && family.states.includes("error");
    case "pages":
      return family.pages.length > 0;
    case "ideation":
      return family.referenceImages.length > 0;
    case "workflow":
      return family.pages.length > 0;
    default:
      return true;
  }
}

/**
 * Verify requirements coverage before presentation. Returns the covered and
 * missing requirement ids so a caller can gate presentation on zero missing.
 */
export function checkRequirementsCoverage(
  family: DesignFamily,
  requirements: ExplorationRequirement[],
): RequirementsCoverage {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const requirement of requirements) {
    if (coversRequirement(family, requirement)) covered.push(requirement.id);
    else missing.push(requirement.id);
  }
  return { covered, missing };
}

// ---------------------------------------------------------------------------
// 5. pi-web selection operations (data model, not UI)
// ---------------------------------------------------------------------------

/** The design-selection operations pi-web supports over design artifacts. */
export type SelectionOp = "Select" | "More-like-this" | "Combine" | "Feedback" | "Let-Pi-choose";

export const SELECTION_OPS: readonly SelectionOp[] = [
  "Select",
  "More-like-this",
  "Combine",
  "Feedback",
  "Let-Pi-choose",
];

/** Result of applying a selection operation. */
export interface SelectionResult {
  op: SelectionOp;
  artifacts: DesignArtifact[];
  rationale: string;
}

const tokenSet = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/** Jaccard similarity between two artifacts based on title + description. */
function artifactSimilarity(a: DesignArtifact, b: DesignArtifact): number {
  const ta = tokenSet(`${a.title} ${a.description ?? ""}`);
  const tb = tokenSet(`${b.title} ${b.description ?? ""}`);
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function dedupe(artifacts: DesignArtifact[]): DesignArtifact[] {
  const seen = new Set<string>();
  const result: DesignArtifact[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) continue;
    seen.add(artifact.id);
    result.push(artifact);
  }
  return result;
}

/** Select a single design artifact. */
export function selectArtifact(artifact: DesignArtifact): SelectionResult {
  return {
    op: "Select",
    artifacts: [artifact],
    rationale: `Selected design artifact ${artifact.id}: ${artifact.title}`,
  };
}

/** Rank candidates most similar to a seed artifact. */
export function moreLikeThis(seed: DesignArtifact, candidates: DesignArtifact[], limit = 3): SelectionResult {
  const ranked = candidates
    .filter((c) => c.id !== seed.id)
    .map((artifact) => ({ artifact, score: artifactSimilarity(seed, artifact) }))
    .sort((a, b) => b.score - a.score || a.artifact.id.localeCompare(b.artifact.id))
    .slice(0, limit)
    .map((r) => r.artifact);
  return {
    op: "More-like-this",
    artifacts: ranked,
    rationale: `Ranked ${ranked.length} artifacts similar to ${seed.id}`,
  };
}

/** Combine several selections into one direction set (deduplicated). */
export function combineSelections(selections: DesignArtifact[]): SelectionResult {
  const unique = dedupe(selections);
  return { op: "Combine", artifacts: unique, rationale: `Combined ${unique.length} selection(s) into one direction` };
}

/** Attach human/model feedback to a selection set. */
export function applyFeedback(selections: DesignArtifact[], feedback: string): SelectionResult {
  return {
    op: "Feedback",
    artifacts: [...selections],
    rationale: `Feedback applied to ${selections.length} selection(s): ${feedback}`,
  };
}

/** Deterministic scoring used by Let-Pi-choose (prefers described, concrete plans). */
function directionScore(a: DesignArtifact): number {
  return (a.description ? 1 : 0) + (a.type === "implementation_plan" ? 1 : 0) + (a.type === "spec" ? 0.5 : 0);
}

/** Let pi deterministically choose the best-ranked design direction. */
export function letPiChoose(candidates: DesignArtifact[]): SelectionResult {
  if (candidates.length === 0) {
    return { op: "Let-Pi-choose", artifacts: [], rationale: "No candidates to choose from" };
  }
  const chosen = [...candidates].sort((a, b) => directionScore(b) - directionScore(a) || a.id.localeCompare(b.id))[0]!;
  return { op: "Let-Pi-choose", artifacts: [chosen], rationale: `Pi chose ${chosen.id} deterministically` };
}

/** Options for the generic `applySelectionOp` dispatcher. */
export interface SelectionOpOptions {
  seed?: DesignArtifact;
  feedback?: string;
  limit?: number;
}

/** Dispatch a named selection operation over design artifacts. */
export function applySelectionOp(
  op: SelectionOp,
  candidates: DesignArtifact[],
  options: SelectionOpOptions = {},
): SelectionResult {
  switch (op) {
    case "Select":
      return candidates[0] ? selectArtifact(candidates[0]) : { op, artifacts: [], rationale: "No artifact to select" };
    case "More-like-this": {
      const seed = options.seed ?? candidates[0];
      if (!seed) return { op, artifacts: [], rationale: "No seed artifact available" };
      return moreLikeThis(seed, candidates, options.limit);
    }
    case "Combine":
      return combineSelections(candidates);
    case "Feedback":
      return applyFeedback(candidates, options.feedback ?? "no feedback");
    case "Let-Pi-choose":
      return letPiChoose(candidates);
  }
}

/** A chosen design direction ready to be folded back into the UI genome. */
export interface SelectedDirection {
  name: string;
  rationale: string;
  /** Design artifacts supporting the direction (e.g. from a selection op). */
  artifacts: DesignArtifact[];
  /** Optional contract overrides to carry into the genome. */
  contractChanges?: GenomeContracts;
}

/**
 * Convert the selected design direction into an updated, versioned UiGenome:
 * the direction is recorded as a new constitution rule (advisory until
 * human/model approval) and any contract changes are merged, producing
 * `version + 1`.
 */
export function convertDesignDirection(selected: SelectedDirection, uiGenome: UiGenome): UiGenome {
  const baseConstitution = uiGenome.contracts.constitution ?? {
    version: 1,
    approved_rule_ids: [] as string[],
    rules: [] as ConstitutionRule[],
  };
  const rule: ConstitutionRule = {
    id: `direction-${slug(selected.name)}`,
    title: `Selected direction: ${selected.name}`,
    description: `${selected.rationale} (from artifacts: ${selected.artifacts.map((a) => a.id).join(", ") || "none"})`,
    approved: false,
    contracts: [],
  };
  const merged: GenomeContracts = {
    ...uiGenome.contracts,
    ...selected.contractChanges,
  };
  const constitution: NonNullable<GenomeContracts["constitution"]> = {
    ...(merged.constitution ?? baseConstitution),
    version: (merged.constitution?.version ?? baseConstitution.version) + 1,
    approved_rule_ids: merged.constitution?.approved_rule_ids ?? baseConstitution.approved_rule_ids,
    rules: [...(merged.constitution?.rules ?? baseConstitution.rules), rule],
  };
  return { version: uiGenome.version + 1, contracts: { ...merged, constitution } };
}
