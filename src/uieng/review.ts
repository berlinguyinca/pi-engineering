/**
 * Independent review / diagnosis / implementation-spec generation for
 * autonomous UI engineering
 * (docs/specs/autonomous-ui-engineering/pi-engineering/06-review-diagnose.md).
 *
 * Four pure, deterministic pieces (no live browser, no model invocation):
 *  1. Partially-blind reviewer roles: each reviewer only sees a subset of
 *     {@link EvidenceBundle} fields, declares the capabilities it needs (for
 *     capability-based dispatch — never model names), and belongs to an
 *     independence group so reviewers from different groups can be served by
 *     different models without shared bias.
 *  2. Finding → source mapping + root-cause clustering: group findings that
 *     share a root cause into {@link RootCauseCluster}s and rank them
 *     deterministically by impact/leverage/confidence/expectedGain/effort/risk.
 *  3. A generated {@link ImplementationSpec} builder: pure/deterministic
 *     conversion of a ranked cluster into a persisted-ready implementation
 *     spec with evidence refs, invariants, tests, expected metric changes,
 *     rollback conditions, and affected files.
 *  4. Reviewer dispatch + disagreement: proportional {@link ReviewPlan}
 *     assembly per UI-impact level, and a deterministic pairwise
 *     {@link disagreementIndex} so large reviewer disagreement can be
 *     investigated before any verdict is trusted.
 *
 * Reuses the shared schema contracts from src/uieng/schemas.ts, metric ids
 * from src/uieng/rubric.ts, {@link AnalysisResult} from src/uieng/evidence.ts,
 * and {@link UiImpactLevel} from src/uieng/policy.ts. Reviewer-independence
 * follows the CAV independent-review pattern (src/cav/review.ts) and the
 * advisory vision-review pattern (src/cav/vision.ts).
 */

import type { UiImpactLevel } from "./policy.ts";
import { validateMetricIds } from "./rubric.ts";
import type { EvidenceBundle, ExecutionProvenance, Finding } from "./schemas.ts";

// ---------------------------------------------------------------------------
// 1. Partially-blind reviewer roles
// ---------------------------------------------------------------------------

/** A field of the shared {@link EvidenceBundle} a reviewer may inspect. */
export type EvidenceField = keyof EvidenceBundle;

export const REVIEWER_ROLE_IDS = [
  "visual_critic",
  "usability_agent",
  "code_critic",
  "deterministic",
  "diagnosis_architect",
] as const;
export type ReviewerRoleId = (typeof REVIEWER_ROLE_IDS)[number];

/** A typed partially-blind reviewer role. */
export interface ReviewerRole {
  roleId: ReviewerRoleId;
  label: string;
  /** Human-readable focus of this reviewer. */
  focus: string;
  /** The subset of EvidenceBundle fields this reviewer sees (partial blindness). */
  inputs: readonly EvidenceField[];
  /**
   * Capabilities required to serve this role, for capability-based dispatch.
   * These are capability tokens, NEVER model names.
   */
  requiredCapabilities: readonly string[];
  /**
   * Independence group: reviewers in the same group may share evidence and
   * model; reviewers in different groups should be served by independent
   * reviewers/models so no single bias propagates through the verdict.
   */
  independenceGroup: string;
}

/** The five reviewer roles. */
export const REVIEWER_ROLES: readonly ReviewerRole[] = [
  {
    roleId: "visual_critic",
    label: "Visual critic",
    focus: "Visual hierarchy, composition, spacing, alignment, contrast, iconography.",
    inputs: ["screenshots", "video", "computed_styles", "viewport"],
    requiredCapabilities: ["visual_analysis", "vision"],
    independenceGroup: "visual",
  },
  {
    roleId: "usability_agent",
    label: "Usability agent",
    focus: "Discoverability, navigation, task efficiency, feedback, keyboard/a11y behavior.",
    inputs: ["accessibility_tree", "interaction_traces", "console", "performance", "state", "route"],
    requiredCapabilities: ["task_analysis", "accessibility_analysis"],
    independenceGroup: "interaction",
  },
  {
    roleId: "code_critic",
    label: "Code critic",
    focus: "Component reuse, duplication, dead code, tokens, responsive implementation.",
    inputs: ["dom", "source_mapping", "computed_styles", "network"],
    requiredCapabilities: ["static_analysis", "code_analysis"],
    independenceGroup: "code",
  },
  {
    roleId: "deterministic",
    label: "Deterministic analyzer",
    focus: "Deterministic rubric analyzers over structured evidence (no model judgment).",
    inputs: ["bounds", "computed_styles", "dom", "accessibility_tree", "network", "console", "performance"],
    requiredCapabilities: ["deterministic_analysis"],
    independenceGroup: "deterministic",
  },
  {
    roleId: "diagnosis_architect",
    label: "Diagnosis architect",
    focus: "Synthesize findings into root-cause clusters and implementation specs.",
    inputs: [
      "screenshots",
      "video",
      "dom",
      "accessibility_tree",
      "bounds",
      "computed_styles",
      "network",
      "console",
      "performance",
      "interaction_traces",
      "source_mapping",
      "state",
      "route",
      "viewport",
    ],
    requiredCapabilities: ["root_cause_analysis", "synthesis", "long_context"],
    independenceGroup: "diagnosis",
  },
];

/** Lookup a reviewer role by id. */
export function reviewerRoleById(roleId: ReviewerRoleId): ReviewerRole {
  const role = REVIEWER_ROLES.find((r) => r.roleId === roleId);
  if (!role) throw new Error(`Unknown reviewer role "${roleId}"`);
  return role;
}

/** A single reviewer's scored output for disagreement computation. */
export interface ReviewerScore {
  roleId: ReviewerRoleId;
  /** 0..1 normalized score; lower = worse. */
  score: number;
  /** 0..1 confidence, optional for disagreement math. */
  confidence?: number;
}

/** A persisted-ready review record; reuses {@link ExecutionProvenance}. */
export interface ReviewerReview extends ReviewerScore {
  role: ReviewerRole;
  /** Finding ids the reviewer considered. */
  findingIds: string[];
  rationale?: string;
  /** How/where the review actually ran (reproducible). */
  provenance?: ExecutionProvenance;
}

// ---------------------------------------------------------------------------
// 2. Finding → source mapping + root-cause clustering
// ---------------------------------------------------------------------------

/** Effort/risk tri-state used by clusters and specs. */
export type EffortLevel = "low" | "medium" | "high";
export type RiskLevel = "low" | "medium" | "high";

/** A group of findings sharing one root cause. */
export interface RootCauseCluster {
  rootCause: string;
  findings: Finding[];
  /** Human-readable affected UI surface (files/states). */
  affectedSurface: string;
  /** 0..1 aggregate severity impact. */
  impact: number;
  /** 0..1 aggregate confidence. */
  confidence: number;
  /** 0..1 share of total findings this root cause explains. */
  leverage: number;
  /** 0..1 expected improvement from fixing this root cause. */
  expectedGain: number;
  effort: EffortLevel;
  risk: RiskLevel;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  info: 0.2,
  low: 0.4,
  medium: 0.6,
  high: 0.8,
  critical: 1,
};

/** Normalize a root-cause string so equivalent causes cluster together. */
export function normalizeRootCause(rootCause: string): string {
  return rootCause.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.]+$/, "");
}

/** Fallback root cause when a finding carries none; derived deterministically. */
export function deriveRootCause(finding: Finding): string {
  return finding.remediation ?? finding.impact ?? "unattributed UI defect";
}

/** Map a finding to the affected UI surface (source files, else states). */
export function mapFindingSurface(finding: Finding): string[] {
  const code = finding.affected_code ?? [];
  const states = finding.affected_states ?? [];
  const surface = code.length > 0 ? code : states;
  return surface.length > 0 ? [...surface] : ["unknown surface"];
}

function maxByRank<T>(items: readonly T[], rank: (t: T) => number): number {
  let max = 0;
  for (const it of items) max = Math.max(max, rank(it));
  return max;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const clampUnit = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

function aggregateEffort(findings: readonly Finding[]): EffortLevel {
  const levels = new Set(findings.map((f) => f.effort?.toLowerCase()).filter(Boolean) as string[]);
  if (levels.has("high")) return "high";
  if (levels.has("medium")) return "medium";
  return "low";
}

function aggregateRisk(findings: readonly Finding[]): RiskLevel {
  const levels = new Set(findings.map((f) => f.risk?.toLowerCase()).filter(Boolean) as string[]);
  if (levels.has("high")) return "high";
  if (levels.has("medium")) return "medium";
  return "low";
}

function buildCluster(rootCause: string, findings: readonly Finding[], totalFindings: number): RootCauseCluster {
  const surfaceSet = new Set<string>();
  for (const f of findings) for (const s of mapFindingSurface(f)) surfaceSet.add(s);
  const impact = maxByRank(findings, (f) => SEVERITY_RANK[f.severity]);
  const round4 = (n: number): number => Math.round(n * 10000) / 10000;
  const confidence = round4(clampUnit(mean(findings.map((f) => f.confidence))));
  const leverage = round4(clampUnit(totalFindings === 0 ? 0 : findings.length / totalFindings));
  const expectedGain = round4(clampUnit(leverage * impact));
  return {
    rootCause,
    findings: [...findings],
    affectedSurface: [...surfaceSet].sort().join(", "),
    impact: clampUnit(impact),
    confidence,
    leverage,
    expectedGain,
    effort: aggregateEffort(findings),
    risk: aggregateRisk(findings),
  };
}

/**
 * Cluster findings that share a root cause. Pure/deterministic: findings are
 * grouped by their normalized root cause (or a derived fallback), and each
 * cluster aggregates severity impact, mean confidence, leverage (share of
 * total findings), expected gain, effort, and risk from the member findings.
 */
export function clusterRootCauses(findings: readonly Finding[]): RootCauseCluster[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = normalizeRootCause(f.root_cause ?? deriveRootCause(f));
    const bucket = groups.get(key) ?? [];
    bucket.push(f);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([rootCause, fs]) => buildCluster(rootCause, fs, findings.length));
}

const EFFORT_PENALTY: Record<EffortLevel, number> = { low: 0, medium: -0.04, high: -0.08 };
const RISK_PENALTY: Record<RiskLevel, number> = { low: 0, medium: -0.02, high: -0.05 };

function clusterScore(cluster: RootCauseCluster): number {
  return (
    cluster.impact * 0.3 +
    cluster.leverage * 0.2 +
    cluster.confidence * 0.15 +
    cluster.expectedGain * 0.2 +
    EFFORT_PENALTY[cluster.effort] +
    RISK_PENALTY[cluster.risk]
  );
}

/**
 * Deterministically rank clusters by impact/leverage/confidence/expectedGain,
 * penalized by effort and risk (lower effort/risk rank higher). Ties break by
 * rootCause lexicographically so the order is fully reproducible. Returns a new
 * array; does not mutate the input.
 */
export function rankClusters(clusters: readonly RootCauseCluster[]): RootCauseCluster[] {
  return [...clusters].sort((a, b) => {
    const diff = clusterScore(b) - clusterScore(a);
    if (diff !== 0) return diff;
    return a.rootCause.localeCompare(b.rootCause);
  });
}

// ---------------------------------------------------------------------------
// 3. Generated implementation spec
// ---------------------------------------------------------------------------

/** Inputs to {@link buildSpec}; all persisted-ready, deterministic. */
export interface ImplementationSpecOptions {
  /** Evidence/artifact refs that support this spec (EvidenceBundle ids / artifact:// URIs). */
  evidenceRefs: string[];
  /** Invariants the change must preserve. */
  invariants: string[];
  /** Test ids/descriptions the change must satisfy. */
  tests: string[];
  /** Expected per-metric change keyed by rubric metric id (delta or target). */
  expectedMetricChanges: Record<string, number>;
  /** Conditions under which the change must be rolled back. */
  rollbackConditions: string[];
  /** Source files the change will touch. */
  affectedFiles: string[];
}

/** A generated, persisted-ready implementation spec. */
export interface ImplementationSpec {
  specId: string;
  rootCause: string;
  affectedSurface: string;
  evidenceRefs: string[];
  invariants: string[];
  tests: string[];
  expectedMetricChanges: Record<string, number>;
  rollbackConditions: string[];
  affectedFiles: string[];
  rationale: string;
}

/** Deterministic FNV-1a 32-bit hash, used for stable spec ids. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Build a generated {@link ImplementationSpec} from a ranked cluster.
 * Pure/deterministic: metric ids are validated against the rubric registry and
 * the spec id is derived from the root cause + affected surface, so identical
 * inputs always yield an identical spec.
 */
export function buildSpec(cluster: RootCauseCluster, options: ImplementationSpecOptions): ImplementationSpec {
  validateMetricIds(Object.keys(options.expectedMetricChanges));
  const specId = `SPEC-${fnv1a(`${cluster.rootCause}::${cluster.affectedSurface}`).toString(36).toUpperCase()}`;
  return {
    specId,
    rootCause: cluster.rootCause,
    affectedSurface: cluster.affectedSurface,
    evidenceRefs: [...options.evidenceRefs],
    invariants: [...options.invariants],
    tests: [...options.tests],
    expectedMetricChanges: { ...options.expectedMetricChanges },
    rollbackConditions: [...options.rollbackConditions],
    affectedFiles: [...options.affectedFiles],
    rationale:
      `Address ${cluster.findings.length} finding(s) sharing root cause "${cluster.rootCause}" ` +
      `(impact ${cluster.impact.toFixed(2)}, leverage ${cluster.leverage.toFixed(2)}, ` +
      `expected gain ${cluster.expectedGain.toFixed(2)}).`,
  };
}

// ---------------------------------------------------------------------------
// 4. Reviewer dispatch + disagreement
// ---------------------------------------------------------------------------

/** A proportional review plan for a UI-impact level. */
export interface ReviewPlan {
  level: UiImpactLevel;
  roles: ReviewerRole[];
  /** Union of required capabilities for capability-based dispatch. */
  capabilities: string[];
  /** Distinct independence groups among the selected roles. */
  independenceGroups: string[];
}

/** Roles dispatched per UI-impact level (proportional gate). */
const ROLES_BY_LEVEL: Record<UiImpactLevel, readonly ReviewerRoleId[]> = {
  L0_none: ["deterministic"],
  L1_micro: ["visual_critic", "deterministic"],
  L2_feature_workflow: ["visual_critic", "usability_agent", "deterministic"],
  L3_system_design_system: ["visual_critic", "usability_agent", "code_critic", "deterministic", "diagnosis_architect"],
};

/**
 * Assemble a proportional {@link ReviewPlan} for a UI-impact level. Pure/
 * deterministic: selects the partially-blind reviewer roles for the level,
 * unions their required capabilities, and lists the distinct independence
 * groups so a caller can dispatch independent models per group.
 */
export function assembleReviewPlan(level: UiImpactLevel): ReviewPlan {
  const roleIds = ROLES_BY_LEVEL[level];
  const roles = roleIds.map((id) => reviewerRoleById(id));
  const capabilities = [...new Set(roles.flatMap((r) => r.requiredCapabilities))].sort();
  const independenceGroups = [...new Set(roles.map((r) => r.independenceGroup))].sort();
  return { level, roles, capabilities, independenceGroups };
}

/**
 * Pairwise disagreement among reviewer scores (0..1). Computes the mean
 * absolute difference between every pair of reviewer scores so a large value
 * flags that reviewers strongly disagree and the divergence warrants
 * investigation before a verdict is trusted. Returns 0 for fewer than two
 * reviews.
 */
export function disagreementIndex(reviews: readonly ReviewerScore[]): number {
  if (reviews.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < reviews.length; i++) {
    for (let j = i + 1; j < reviews.length; j++) {
      total += Math.abs((reviews[i]?.score ?? 0) - (reviews[j]?.score ?? 0));
      pairs++;
    }
  }
  return pairs === 0 ? 0 : clampUnit(total / pairs);
}
