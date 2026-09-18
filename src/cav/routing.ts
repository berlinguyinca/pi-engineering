/**
 * CAV-15 Model Routing: route implement/review/vision/bounded tasks through
 * distinct model capabilities.
 *
 * Reconciles with the existing capability router (src/capability/adapter.ts)
 * and the standing routing decision (DECISION-UKyKbi, DECISION-RQ4OGM):
 * implementer, reviewer, planner and vision roles must run on DIFFERENT models
 * so review is genuinely independent, and vision review uses a vision-capable
 * model. This helper returns the model override for a role.
 */
export type CavRole = "implementer" | "reviewer" | "planner" | "vision";

export interface CavRoute {
  provider: string;
  id: string;
  reason: string;
}

/** Default routing table for the metabolomics provider. */
const DEFAULT_ROUTES: Record<CavRole, CavRoute> = {
  implementer: { provider: "metabolomics", id: "deepseek-v4-flash", reason: "primary implementer" },
  planner: { provider: "metabolomics", id: "qwen3.8-flash-next", reason: "distinct planner model" },
  reviewer: { provider: "metabolomics", id: "qwen3.8-27b", reason: "independent reviewer, distinct from implementer" },
  vision: {
    provider: "metabolomics",
    id: "qwen3.8-27b-vision",
    reason: "vision-capable model for visual review (DECISION-RQ4OGM)",
  },
};

export function routeRole(role: CavRole, overrides: Partial<Record<CavRole, string>> = {}): CavRoute {
  const base = DEFAULT_ROUTES[role];
  const overrideId = overrides[role];
  return overrideId ? { ...base, id: overrideId, reason: `${base.reason} (overridden to ${overrideId})` } : base;
}

/** Distinctness check: the reviewer must not be the implementer model. */
export function assertReviewerDistinct(implementerId: string, reviewerId: string): boolean {
  return implementerId !== reviewerId;
}

/** Vision review must use a vision-capable model. */
export function assertVisionCapable(role: CavRole, modelId: string): boolean {
  if (role !== "vision") return true;
  return /vision/i.test(modelId);
}
