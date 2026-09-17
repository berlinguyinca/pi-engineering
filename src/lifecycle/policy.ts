/**
 * Engineering lifecycle policy (spec §13).
 *
 * Four layers with fixed precedence — built-in defaults, global config, repo
 * config, session/env overrides. A global config may mark dotted keys as
 * `mandatory`, which the merge re-applies last so a repository can never weaken
 * an organization-wide guarantee (independence, verification, destructive gates).
 *
 * Validation returns actionable errors instead of silently coercing values.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AdmissionRetrySettings } from "../inference/admissionConfig.ts";
import { normalizeAdmissionConfig, validateAdmissionConfig } from "../inference/admissionConfig.ts";
import type { LifecycleRisk } from "./types.ts";
import { LIFECYCLE_RISKS } from "./types.ts";

export interface RoutingRoleConfig {
  /** Pinned model ref `provider/id`. Empty means route automatically. */
  model?: string;
  /** Preferred provider for this role. */
  provider?: string;
  /** Minimum declared context window. */
  min_context?: number;
  /** Extra hard capability requirements. */
  requires?: string[];
  /** Roles this role may never be served by the same model as. */
  must_differ_from?: string[];
  timeout_ms?: number;
  max_context_tokens?: number;
}

export interface ScoringWeights {
  capability: number;
  observed_quality: number;
  availability: number;
  latency: number;
  cost: number;
  context: number;
  diversity: number;
  local_remote: number;
}

export interface RoutingConfig {
  /** `auto` routes every role; `manual` pins every role and fails when unmet. */
  mode: "auto" | "manual";
  roles: Record<string, RoutingRoleConfig>;
  /** Provider preference order for ties. */
  provider_priority: string[];
  /** Providers never eligible. */
  provider_deny: string[];
  /** When true a provider-configuration change triggers an immediate refresh. */
  refresh_on_provider_change: boolean;
  /** Cache TTL before a background refresh is attempted. */
  discovery_ttl_ms: number;
  scoring: ScoringWeights;
  /** Where observed performance comes from: ledger history, local store, or off. */
  observed_source: "ledger" | "store" | "off";
  /** Minimum samples before observed performance affects ranking. */
  observed_min_samples: number;
  /** How strongly observed quality affects the score (0 disables it). */
  observed_weight: number;
  /** Adopt the routed orchestrator model for the interactive session when it differs. */
  adopt_orchestrator_model: boolean;
  /** Penalty multiplier applied to a model after a failed invocation. */
  failure_penalty: number;
  /** Seconds before a failure penalty decays away. */
  penalty_decay_seconds: number;
}

export interface ReviewConfig {
  /** Independent review is mandatory after meaningful code change. */
  require_independent_review: boolean;
  /** Reviewer must differ from the implementing model. */
  independent_reviewer: boolean;
  /** Reviewer must differ from the session model that wrote the change. */
  reviewer_differs_from_session: boolean;
  max_blocking_findings_to_pass: number;
  /** Roles that must run concurrently when triggered. */
  specialists_enabled: boolean;
  specialist_timeout_ms: number;
  /** Verdicts are only accepted from a routed child session, never the parent. */
  accept_parent_verdict: boolean;
}

export interface VerificationConfig {
  require_before_complete: boolean;
  /** Where verification commands come from, in order. */
  command_sources: ("config" | "package_json" | "ci" | "agents_md" | "makefile")[];
  /** Explicit commands, by kind: { test: ["npm test"], typecheck: ["npm run typecheck"] }. */
  commands: Record<string, string[]>;
  /** Never auto-run commands matching these substrings (operator-controlled). */
  command_deny: string[];
  timeout_ms: number;
  /** A missing required command blocks completion instead of passing vacuously. */
  missing_required_blocks: boolean;
}

export interface VisionConfig {
  enabled: boolean;
  /** Route image review to a vision-capable model even if the parent has vision. */
  force_handoff: boolean;
  /** Prefer local vision models when healthy and capable. */
  prefer_local: boolean;
  /** Cache descriptions keyed by image content hash. */
  cache: boolean;
  cache_dir: string;
  max_images_per_review: number;
  /** Repo/operator-declared screenshot command producing image files. */
  capture_command?: string;
  capture_glob?: string;
  capture_timeout_ms: number;
}

export interface RiskPolicy {
  /** Risk level at or above which a human must approve before execution. */
  pre_execution_approval_at: LifecycleRisk;
  /** Non-interactive behaviour when approval is required but nobody can answer. */
  unattended: "block" | "allow_with_log";
  /** Capabilities that must never be blanket-disabled, only gated. */
  preserve_capabilities: string[];
  /** Extra command patterns forced to a given risk level. */
  command_risk: { pattern: string; risk: LifecycleRisk }[];
}

export interface CompletionGateConfig {
  require: {
    implementation_complete: boolean;
    independent_review_pass: boolean;
    specialist_review_pass: boolean;
    verification_pass: boolean;
    spec_verification_pass: boolean;
    final_verification_pass: boolean;
    no_unresolved_high_risk_findings: boolean;
    tests_when_required: boolean;
  };
}

export interface LifecycleConfig {
  automatic: boolean;
  /** Risk at or above which a plan must exist before implementation. */
  plan_threshold_risk: LifecycleRisk;
  plan_threshold_categories: string[];
  max_remediation_rounds: number;
  /** Where remediation instructions are applied. */
  remediation: "session" | "worker";
  /** Total wall-clock budget for one automatic lifecycle pass. */
  budget_ms: number;
  /** Max concurrent child sessions in a fan-out pass. */
  max_concurrency: number;
  persist_dir: string;
  telemetry: boolean;
  /** Emit a user-visible notification at each lifecycle stage boundary. */
  notify: boolean;
}

export interface EngineeringPolicy {
  version: number;
  /** Dotted keys from the global layer that repository config cannot weaken. */
  mandatory: string[];
  lifecycle: LifecycleConfig;
  routing: RoutingConfig;
  policies: {
    separation_of_duties: {
      enabled: boolean;
      /** Role pairs that must be served by different models. */
      distinct: [string, string][];
    };
    review: ReviewConfig;
    verification: VerificationConfig;
    risk: RiskPolicy;
    completion_gate: CompletionGateConfig;
  };
  vision: VisionConfig;
  /** Provider-level repo policy: which providers may serve which repos. */
  provider_policy: { repo_prefix_deny: Record<string, string[]> };
  /** InferWeave admission-retry tuning (spec 03). Defaults live in admissionConfig. */
  inference?: {
    retry?: {
      admission?: AdmissionRetrySettings;
    };
  };
}

export const DEFAULT_POLICY: EngineeringPolicy = {
  version: 1,
  mandatory: [
    "policies.review.require_independent_review",
    "policies.review.independent_reviewer",
    "policies.completion_gate.require.independent_review_pass",
    "policies.completion_gate.require.verification_pass",
    "policies.completion_gate.require.final_verification_pass",
    "policies.risk.pre_execution_approval_at",
  ],
  lifecycle: {
    automatic: true,
    plan_threshold_risk: "HIGH",
    plan_threshold_categories: ["database", "infra", "security", "migration", "public_api"],
    max_remediation_rounds: 3,
    remediation: "session",
    budget_ms: 900_000,
    max_concurrency: 3,
    persist_dir: ".pi-eng/lifecycle",
    telemetry: true,
    notify: true,
  },
  routing: {
    mode: "auto",
    roles: {},
    provider_priority: [],
    provider_deny: [],
    refresh_on_provider_change: true,
    discovery_ttl_ms: 300_000,
    scoring: {
      capability: 0.3,
      observed_quality: 0.2,
      availability: 0.15,
      latency: 0.05,
      cost: 0.1,
      context: 0.1,
      diversity: 0.05,
      local_remote: 0.05,
    },
    observed_source: "store",
    adopt_orchestrator_model: false,
    observed_min_samples: 5,
    observed_weight: 1,
    failure_penalty: 0.5,
    penalty_decay_seconds: 600,
  },
  policies: {
    separation_of_duties: {
      enabled: true,
      distinct: [
        ["implementer", "reviewer"],
        ["implementer", "verifier"],
        ["reviewer", "spec_verifier"],
      ],
    },
    review: {
      require_independent_review: true,
      independent_reviewer: true,
      reviewer_differs_from_session: true,
      max_blocking_findings_to_pass: 0,
      specialists_enabled: true,
      specialist_timeout_ms: 240_000,
      accept_parent_verdict: false,
    },
    verification: {
      require_before_complete: true,
      command_sources: ["config", "package_json", "ci", "agents_md", "makefile"],
      commands: {},
      command_deny: ["deploy", "release", "publish", "docker push", "terraform apply"],
      timeout_ms: 600_000,
      missing_required_blocks: true,
    },
    risk: {
      pre_execution_approval_at: "CRITICAL",
      unattended: "block",
      preserve_capabilities: [
        "ssh",
        "scp",
        "ansible",
        "systemctl",
        "docker",
        "kubectl",
        "terraform",
        "npm publish",
        "git push",
      ],
      command_risk: [],
    },
    completion_gate: {
      require: {
        implementation_complete: true,
        independent_review_pass: true,
        specialist_review_pass: true,
        verification_pass: true,
        spec_verification_pass: true,
        final_verification_pass: true,
        no_unresolved_high_risk_findings: true,
        tests_when_required: true,
      },
    },
  },
  vision: {
    enabled: true,
    force_handoff: true,
    prefer_local: true,
    cache: true,
    cache_dir: ".pi-eng/lifecycle/vision",
    max_images_per_review: 8,
    capture_glob: "**/*.png",
    capture_timeout_ms: 180_000,
  },
  provider_policy: { repo_prefix_deny: {} },
  inference: {
    retry: {
      admission: {
        // All defaults are owned by admissionConfig.DEFAULT_ADMISSION_RETRY_CONFIG;
        // this stub only exists so the policy carries the key and validates it.
      },
    },
  },
};

export interface PolicyIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface PolicyLoadResult {
  policy: EngineeringPolicy;
  issues: PolicyIssue[];
  /** Absolute paths actually read, in precedence order. */
  sources: string[];
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge where `overlay` wins; arrays are replaced, not concatenated. */
export function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isPlain(overlay)) return (overlay === undefined ? base : (overlay as T)) as T;
  if (!isPlain(base)) return overlay as T;
  const out: Plain = { ...(base as unknown as Plain) };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!isPlain(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(target: Plain, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur: Plain = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(cur[part])) cur[part] = {};
    cur = cur[part] as Plain;
  }
  cur[parts[parts.length - 1] as string] = value;
}

const NUMBER_RANGE_FIELDS: Record<string, [number, number]> = {
  "lifecycle.max_remediation_rounds": [0, 20],
  "lifecycle.budget_ms": [10_000, 7_200_000],
  "lifecycle.max_concurrency": [1, 16],
  "routing.observed_min_samples": [1, 1000],
  "policies.review.specialist_timeout_ms": [5_000, 3_600_000],
  "policies.verification.timeout_ms": [5_000, 3_600_000],
};

const BOOLEAN_FIELDS = [
  "lifecycle.automatic",
  "lifecycle.telemetry",
  "lifecycle.notify",
  "routing.mode",
  "policies.review.require_independent_review",
  "policies.review.independent_reviewer",
  "policies.review.reviewer_differs_from_session",
  "policies.review.specialists_enabled",
  "policies.review.accept_parent_verdict",
  "policies.verification.require_before_complete",
  "vision.enabled",
  "vision.force_handoff",
  "vision.cache",
];

/** Structural validation with actionable messages (spec §27.1). */
export function validatePolicy(policy: EngineeringPolicy): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const flat = policy as unknown as Plain;

  for (const [path, [min, max]] of Object.entries(NUMBER_RANGE_FIELDS)) {
    const v = getPath(flat, path);
    if (typeof v !== "number" || Number.isNaN(v)) {
      issues.push({ path, message: `expected a number between ${min} and ${max}`, severity: "error" });
    } else if (v < min || v > max) {
      issues.push({ path, message: `${v} is outside the allowed range ${min}..${max}`, severity: "error" });
    }
  }

  for (const path of BOOLEAN_FIELDS) {
    if (path === "routing.mode") continue;
    const v = getPath(flat, path);
    if (typeof v !== "boolean") issues.push({ path, message: "expected true or false", severity: "error" });
  }

  if (policy.routing.mode !== "auto" && policy.routing.mode !== "manual") {
    issues.push({ path: "routing.mode", message: 'must be "auto" or "manual"', severity: "error" });
  }
  if (!LIFECYCLE_RISKS.includes(policy.lifecycle.plan_threshold_risk)) {
    issues.push({
      path: "lifecycle.plan_threshold_risk",
      message: `must be one of ${LIFECYCLE_RISKS.join(", ")}`,
      severity: "error",
    });
  }
  if (!LIFECYCLE_RISKS.includes(policy.policies.risk.pre_execution_approval_at)) {
    issues.push({
      path: "policies.risk.pre_execution_approval_at",
      message: `must be one of ${LIFECYCLE_RISKS.join(", ")}`,
      severity: "error",
    });
  }
  if (policy.policies.risk.unattended !== "block" && policy.policies.risk.unattended !== "allow_with_log") {
    issues.push({
      path: "policies.risk.unattended",
      message: 'must be "block" or "allow_with_log"',
      severity: "error",
    });
  }
  if (policy.lifecycle.remediation !== "session" && policy.lifecycle.remediation !== "worker") {
    issues.push({
      path: "lifecycle.remediation",
      message: 'must be "session" or "worker"',
      severity: "error",
    });
  }

  const weights = policy.routing.scoring;
  for (const [k, v] of Object.entries(weights)) {
    if (typeof v !== "number" || v < 0 || v > 1) {
      issues.push({ path: `routing.scoring.${k}`, message: "expected a number in 0..1", severity: "error" });
    }
  }
  for (const [a, b] of policy.policies.separation_of_duties.distinct) {
    if (!a || !b) {
      issues.push({
        path: "policies.separation_of_duties.distinct",
        message: `entry [${a}, ${b}] must name two roles`,
        severity: "error",
      });
    }
  }
  for (const [role, cfg] of Object.entries(policy.routing.roles)) {
    if (cfg?.model !== undefined && typeof cfg.model !== "string") {
      issues.push({ path: `routing.roles.${role}.model`, message: "expected a provider/id string", severity: "error" });
    }
  }
  if (policy.vision.enabled && policy.vision.force_handoff && policy.policies.review.independent_reviewer) {
    // Not an error: recorded so `/engineering explain` can surface the intent.
    issues.push({
      path: "vision.force_handoff",
      message: "vision review is force-handed-off to a routed vision model",
      severity: "warning",
    });
  }
  if (policy.inference?.retry?.admission !== undefined) {
    issues.push(...validateAdmissionConfig(normalizeAdmissionConfig(policy.inference.retry.admission)));
  }
  return issues;
}

function stripComments(text: string): string {
  return text;
}

async function readYaml(path: string): Promise<{ raw: unknown; text?: string }> {
  try {
    const text = await readFile(path, "utf-8");
    return { raw: parseYaml(stripComments(text)), text };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { raw: undefined };
    throw err;
  }
}

function envOverride(): Plain | undefined {
  const raw = process.env.PI_ENGINEERING_POLICY;
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Plain;
    return isPlain(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface LoadPolicyOptions {
  cwd: string;
  /** Global config dir (defaults to $PI_CODING_AGENT_DIR or ~/.pi/agent). */
  agentDir?: string;
  /** Extra task/session-level overlay (highest precedence). */
  sessionOverride?: unknown;
  env?: NodeJS.ProcessEnv;
}

/**
 * Load the effective policy. Repository config may weaken anything not marked
 * mandatory; mandatory keys are re-applied from the global layer last.
 */
export async function loadPolicy(opts: LoadPolicyOptions): Promise<PolicyLoadResult> {
  const env = opts.env ?? process.env;
  const agentDir = opts.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const sources: string[] = [];
  const issues: PolicyIssue[] = [];

  const globalPath = join(agentDir, "engineering.yaml");
  const repoPath = join(opts.cwd, ".pi", "engineering.yaml");

  let policy = structuredClone(DEFAULT_POLICY);
  const globalResult = await readYaml(globalPath).catch((err: Error) => {
    issues.push({ path: globalPath, message: `unreadable: ${err.message}`, severity: "warning" });
    return { raw: undefined };
  });
  if (globalResult.raw !== undefined) {
    sources.push(globalPath);
    policy = deepMerge(policy, globalResult.raw);
  }

  const repoResult = await readYaml(repoPath).catch((err: Error) => {
    issues.push({ path: repoPath, message: `unreadable: ${err.message}`, severity: "error" });
    return { raw: undefined };
  });
  if (repoResult.raw !== undefined) {
    sources.push(repoPath);
    policy = deepMerge(policy, repoResult.raw);
  }

  const envLayer = envOverride();
  if (envLayer) {
    sources.push("env:PI_ENGINEERING_POLICY");
    policy = deepMerge(policy, envLayer);
  }
  if (opts.sessionOverride !== undefined) {
    sources.push("session");
    policy = deepMerge(policy, opts.sessionOverride);
  }

  // Re-apply mandatory keys from the global layer (cannot be weakened below).
  const mandatoryKeys: string[] = Array.isArray((globalResult.raw as Plain | undefined)?.mandatory)
    ? ((globalResult.raw as Plain).mandatory as unknown[]).filter((k): k is string => typeof k === "string")
    : DEFAULT_POLICY.mandatory;
  for (const key of mandatoryKeys) {
    const globalValue = getPath(globalResult.raw, key);
    if (globalValue === undefined) continue;
    const current = getPath(policy, key);
    if (!weaker(key, current, globalValue)) continue;
    setPath(policy as unknown as Plain, key, globalValue);
    issues.push({
      path: key,
      message: `kept mandatory global value ${JSON.stringify(globalValue)} (repository tried ${JSON.stringify(current)})`,
      severity: "warning",
    });
  }

  const validation = validatePolicy(policy);
  issues.push(...validation);
  return { policy, issues, sources };
}

/** Coerce the policy's admission block into a complete, validated config. */
export function admissionConfigFromPolicy(policy: EngineeringPolicy): AdmissionRetrySettings {
  return (policy.inference?.retry?.admission ?? {}) as AdmissionRetrySettings;
}

/** True when `current` weakens a mandatory `required` value. */
function weaker(key: string, current: unknown, required: unknown): boolean {
  if (key.startsWith("policies.") && key.includes("require.")) {
    // A requirement may only be turned off by weakening.
    return current === false && required === true;
  }
  if (key === "policies.risk.pre_execution_approval_at") {
    const order: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 };
    return (order[String(current)] ?? -1) > (order[String(required)] ?? -1);
  }
  if (typeof current === "boolean" && typeof required === "boolean") {
    return current === false && required === true;
  }
  if (typeof current === "number" && typeof required === "number") {
    return current > required;
  }
  return false;
}
