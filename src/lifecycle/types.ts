/**
 * Domain types for the automatic engineering lifecycle and the capability-aware
 * model router.
 *
 * These types are deliberately harness-owned: the parent model cannot assert a
 * lifecycle state, gate status, or completion. Every value here is produced by
 * observation (git, tool events, command evidence) or by a routed child session
 * whose result the harness parses and validates.
 */

import type { RiskLevel } from "../core/types.ts";

// ---------------------------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------------------------

export const LIFECYCLE_STATES = [
  "RECEIVED",
  "CLASSIFIED",
  "PLAN_PENDING",
  "PLANNED",
  "IMPLEMENTATION_PENDING",
  "IMPLEMENTING",
  "IMPLEMENTED",
  "CHANGE_CLASSIFIED",
  "VERIFYING",
  "VERIFIED",
  "VERIFICATION_FAILED",
  "REVIEW_PENDING",
  "REVIEWING",
  "REVIEWED",
  "REVIEW_FAILED",
  "SPECIALIST_REVIEW_PENDING",
  "SPECIALIST_REVIEWED",
  "SPECIALIST_REVIEW_FAILED",
  "SPEC_VERIFY_PENDING",
  "SPEC_VERIFIED",
  "SPEC_VERIFY_FAILED",
  "FINAL_VERIFY_PENDING",
  "FINAL_VERIFIED",
  "REMEDIATION_REQUIRED",
  "REMEDIATING",
  "BLOCKED",
  "ESCALATED",
  "COMPLETE",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** Terminal states never admit further automatic transitions. */
export const TERMINAL_STATES: readonly LifecycleState[] = ["COMPLETE", "BLOCKED", "ESCALATED"];

// ---------------------------------------------------------------------------------------------
// Gate / verification vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * A gate item status. "not run" is never represented as a pass: every status
 * other than `passed` is explicit about why the item did not contribute.
 */
export type GateStatus = "passed" | "failed" | "not_applicable" | "unavailable" | "skipped";

/** Work categories produced by intent + path + diff + command classification. */
export const WORK_CATEGORIES = [
  "chat",
  "feature",
  "bugfix",
  "refactor",
  "build_system",
  "runtime_system",
  "database",
  "api",
  "infra",
  "config",
  "security",
  "auth",
  "frontend",
  "backend",
  "docs",
  "test",
  "migration",
  "dependency",
  "visual",
  "ui_ux",
  "accessibility",
  "performance",
  "observability",
  "remote_administration",
  "deployment",
  "service_management",
  "server_lifecycle",
  "destructive",
  "unknown",
] as const;

export type WorkCategory = (typeof WORK_CATEGORIES)[number];

/** Spec risk ladder. Mapped onto the ledger's coarser {@link RiskLevel}. */
export const LIFECYCLE_RISKS = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
export type LifecycleRisk = (typeof LIFECYCLE_RISKS)[number];

export function riskToLedgerLevel(risk: LifecycleRisk): RiskLevel {
  switch (risk) {
    case "LOW":
      return "low";
    case "NORMAL":
      return "medium";
    case "HIGH":
      return "high";
    case "CRITICAL":
      return "critical";
  }
}

export function ledgerLevelToRisk(level: RiskLevel): LifecycleRisk {
  switch (level) {
    case "low":
      return "LOW";
    case "medium":
      return "NORMAL";
    case "high":
      return "HIGH";
    case "critical":
      return "CRITICAL";
  }
}

/** Why a piece of work needs a plan (spec §6.4). */
export const PLAN_TRIGGERS = [
  "cross_module",
  "public_api",
  "data_model",
  "security",
  "migration",
  "infra",
  "cost",
  "user_visible",
  "ambiguous",
  "large_change",
] as const;
export type PlanTrigger = (typeof PLAN_TRIGGERS)[number];

// ---------------------------------------------------------------------------------------------
// Change observation
// ---------------------------------------------------------------------------------------------

export interface ChangeFile {
  path: string;
  added: boolean;
  deleted: boolean;
  renamed?: string;
  linesAdded: number;
  linesDeleted: number;
  binary: boolean;
  /** Where the change lives: committed-vs-base, index, worktree, or untracked. */
  scope: "base" | "staged" | "unstaged" | "untracked";
}

/** A complete picture of the work in progress (committed + staged + unstaged + untracked). */
export interface ChangeSnapshot {
  capturedAt: string;
  baseRef: string;
  headRef: string;
  headCommit: string;
  /** Stable fingerprint of the whole snapshot; used for idempotent gates. */
  fingerprint: string;
  files: ChangeFile[];
  diffExcerpt: string;
  diffChars: number;
  truncated: boolean;
  /** Tool activity observed during the session that produced this snapshot. */
  mutationsObserved: number;
  commandsObserved: string[];
  isGit: boolean;
}

export const EMPTY_CHANGE_SNAPSHOT: ChangeSnapshot = {
  capturedAt: "1970-01-01T00:00:00.000Z",
  baseRef: "HEAD",
  headRef: "HEAD",
  headCommit: "",
  fingerprint: "empty",
  files: [],
  diffExcerpt: "",
  diffChars: 0,
  truncated: false,
  mutationsObserved: 0,
  commandsObserved: [],
  isGit: false,
};

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface Classification {
  categories: WorkCategory[];
  risk: LifecycleRisk;
  planTriggers: PlanTrigger[];
  /** Specialist roles this change requires, in priority order. */
  specialists: string[];
  visionRequired: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------------------------
// Capability + routing
// ---------------------------------------------------------------------------------------------

export interface ModelRef {
  provider: string;
  id: string;
}

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

export function parseModelRef(ref: string): ModelRef | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { provider: trimmed, id: trimmed };
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export type CapabilitySource = "declared" | "curated" | "inferred" | "observed";

/** Provenance-tagged capability flags (spec §10.1: never conflate sources). */
export interface ModelCapabilities {
  values: Record<string, boolean>;
  source: CapabilitySource;
}

export interface ObservedPerformance {
  samples: number;
  /** Mean reviewer-grade quality in [0,1] across completed runs. */
  meanQuality: number;
  failures: number;
  timeouts: number;
  lastLatencyMs?: number;
  meanLatencyMs?: number;
  lastSeenAt?: string;
}

/** Normalized view of one model from any provider source (spec §9.1). */
export interface ModelRecord {
  provider: string;
  id: string;
  name?: string;
  family?: string;
  endpoint?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** Raw modality list as declared by the provider. */
  modalities: string[];
  capabilities: ModelCapabilities;
  reasoning: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
  /** Local/remote posture: never inferred from a name alone. */
  local: boolean;
  priceInputUsdPerMTok?: number;
  priceOutputUsdPerMTok?: number;
  enabled: boolean;
  /** Health of the provider/credential, not of the model's quality. */
  healthy: boolean;
  healthReason?: string;
  /** True when the provider reports the model as currently selectable. */
  available: boolean;
  /** Per-provider load/capacity signal in [0,1] when a source supplies it. */
  load?: number;
  queuedJobs?: number;
  source: string;
  discoveredAt: string;
  observed?: ObservedPerformance;
  tags: string[];
  /** Transient routing penalty applied after a failure (decays over time). */
  penalty?: number;
  penaltyReason?: string;
}

export type RoleIsolation = "own" | "parent" | "inherit";

export interface RoleRequirements {
  /** Declared capabilities the model MUST have. */
  requires: string[];
  /** Preferred traits used only for scoring. */
  prefers: string[];
  minContext?: number;
  /** Score weight for candidate ranking. */
  qualityWeight: number;
  costWeight: number;
  latencyWeight: number;
  /** True when the role must not be the model that produced the change. */
  independent: boolean;
  readOnly: boolean;
  isolation: RoleIsolation;
  tools: string[];
}

export type RejectionStage =
  | "disabled"
  | "health"
  | "capability"
  | "context"
  | "role_policy"
  | "separation_of_duties"
  | "repo_policy"
  | "override"
  | "penalty";

export interface CandidateRejection {
  model: ModelRef;
  stage: RejectionStage;
  reason: string;
}

export interface ScoreBreakdown {
  model: ModelRef;
  total: number;
  parts: Record<string, number>;
}

export interface RankedCandidate {
  model: ModelRef;
  score: number;
  parts: Record<string, number>;
}

export interface RoutingDecision {
  role: string;
  selected?: ModelRef;
  /** Ordered best-first list of eligible candidates (selected first when present). */
  candidates: RankedCandidate[];
  rejected: CandidateRejection[];
  rationale: string[];
  overrideApplied?: { override: string; source: string };
  fallbackOf?: ModelRef;
  /** Requesting model, when separation-of-duties applied. */
  requester?: ModelRef;
  decidedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export type CheckKind = "test" | "typecheck" | "lint" | "format" | "build" | "security" | "custom";

export interface CheckSpec {
  kind: CheckKind;
  name: string;
  command?: string;
  /** Why the check is in the plan (package.json, CI config, AGENTS.md, policy, operator). */
  origin: string;
  required: boolean;
  reason?: string;
  timeoutMs: number;
}

export interface CheckOutcome {
  spec: CheckSpec;
  status: GateStatus;
  exitCode?: number;
  durationMs: number;
  summary: string;
  artifactUri?: string;
  evidenceId?: string;
}

export interface VerificationReport {
  round: number;
  stage: "implementation" | "final";
  at: string;
  outcomes: CheckOutcome[];
  status: GateStatus;
  blocking: string[];
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export const FINDING_SEVERITIES = ["blocker", "critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface ReviewFinding {
  fingerprint: string;
  role: string;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  endLine?: number;
  title: string;
  detail: string;
  confidence: number;
  suggestion?: string;
  /** Categories attached by the reviewer (drives routing of the fixer). */
  categories: WorkCategory[];
}

export interface MissingTest {
  description: string;
  file?: string;
  severity: FindingSeverity;
}

export interface SpecGap {
  requirement: string;
  status: "missing" | "partial" | "divergent" | "unverifiable";
  detail: string;
  severity: FindingSeverity;
}

export interface ReviewReport {
  role: string;
  model: ModelRef;
  round: number;
  verdict: "approve" | "request_changes" | "failed";
  findings: ReviewFinding[];
  missingTests: MissingTest[];
  specGaps: SpecGap[];
  confidence: number;
  summary: string;
  at: string;
  durationMs: number;
  artifactUri?: string;
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------------------------

export interface GateItem {
  key: string;
  status: GateStatus;
  required: boolean;
  reason: string;
  blockers: string[];
}

export interface GateEvaluation {
  pass: boolean;
  items: GateItem[];
  blockers: string[];
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle run (persisted)
// ---------------------------------------------------------------------------------------------

export interface RemediationRecord {
  round: number;
  at: string;
  fingerprints: string[];
  instruction: string;
  target: "session" | "worker";
  fixerModel?: ModelRef;
  resolvedFingerprints: string[];
  outcome: "pending" | "resolved" | "unresolved" | "escalated";
}

/** Durable, harness-owned record of one engineering effort. */
export interface LifecycleRun {
  runId: string;
  sessionKey: string;
  /** Idempotency key: the user request that opened the run. */
  requestKey: string;
  request: string;
  requirementIds: string[];
  specPaths: string[];
  state: LifecycleState;
  classification?: Classification;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  maxRounds: number;
  baseCommit: string;
  lastSnapshotFingerprint: string;
  /** Model that produced the change (session model or routed worker). */
  authorModel?: string;
  /** Plan artifact produced before implementation when the risk demands one. */
  planArtifactUri?: string;
  /** Fingerprints of findings already escalated/ignored. */
  ignoredFingerprints: string[];
  routing: RoutingDecision[];
  reviews: ReviewReport[];
  verifications: VerificationReport[];
  remediations: RemediationRecord[];
  gate?: GateEvaluation;
  /** Verification command names the harness should prefer (repo-declared or configured). */
  checkOverrides: string[];
  /** Fingerprints of findings still open as of the latest review round. */
  openFingerprints: string[];
  notes: string[];
  completedAt?: string;
}

export type LifecycleTrigger =
  | "request"
  | "tool_activity"
  | "turn_settled"
  | "remediation_settled"
  | "command"
  | "resume";

/** One appended record in the lifecycle event log. */
export interface LifecycleEvent {
  at: string;
  runId: string;
  state: LifecycleState;
  trigger: LifecycleTrigger;
  detail?: string;
  /** Monotonic per-run sequence; duplicate deliveries are ignored on replay. */
  seq: number;
}
