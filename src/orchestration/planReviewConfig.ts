/**
 * `plan_review` block of `.pi/engineering.yaml` / `~/.pi/agent/engineering.yaml`
 * (the repo's existing policy layers). Absent or `enabled: false` means OFF and
 * the runtime behaves exactly as before.
 *
 *   plan_review:
 *     enabled: true
 *     max_revisions: 3
 *     modes: {low: skip, medium: offer, high: require, critical: require}
 *     override: {mode: skip, reason: "why", operator: "name"}   # recorded in the ledger
 *     plannotator:
 *       command: herdr-plannotator          # Herdr host CLI
 *       args: ["--control-plane", "https://..."]
 *       cwd: /path/to/workspace
 *       timeout_ms: 600000
 *
 * An enabled block that is malformed FAILS CLOSED: every risk class becomes
 * `require` with no reviewer, so nothing proceeds on a config typo.
 */

import { join } from "node:path";
import { loadPolicy } from "../lifecycle/policy.ts";
import { createHerdrPlannotatorTransport } from "../platform/HerdrPlannotatorTransport.ts";
import { FilePendingPlanStore, PlannotatorAdapter } from "../platform/Plannotator.ts";
import { resolveStateRoot } from "../runtime/isolation/stateDir.ts";
import { PLAN_REVIEW_MODES, type PlanReviewMode, type PlanReviewPolicyConfig } from "./planRecords.ts";
import type { PlanGateInput } from "./planReview.ts";

export type PlanReviewSettings = Pick<PlanGateInput, "adapter" | "policy" | "maxRevisions">;

const RISKS = ["low", "medium", "high", "critical"] as const;
type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === "object" && !Array.isArray(v);

class ConfigError extends Error {}

const mode = (v: unknown, where: string): PlanReviewMode => {
  if (typeof v === "string" && PLAN_REVIEW_MODES.includes(v as PlanReviewMode)) return v as PlanReviewMode;
  throw new ConfigError(`${where} must be one of ${PLAN_REVIEW_MODES.join("|")}`);
};

/** Pure parse of the raw YAML value; null when disabled/absent. Exported for tests. */
export function parsePlanReviewConfig(raw: unknown, stateDir: string): PlanReviewSettings | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlain(raw) || raw.enabled !== true) return null;
  try {
    const policy: PlanReviewPolicyConfig = {};
    if (raw.modes !== undefined) {
      if (!isPlain(raw.modes)) throw new ConfigError("plan_review.modes must be a mapping");
      const modes: NonNullable<PlanReviewPolicyConfig["modes"]> = {};
      for (const [k, v] of Object.entries(raw.modes)) {
        if (!(RISKS as readonly string[]).includes(k))
          throw new ConfigError(`plan_review.modes.${k} is not a risk class`);
        modes[k as (typeof RISKS)[number]] = mode(v, `plan_review.modes.${k}`);
      }
      policy.modes = modes;
    }
    if (raw.override !== undefined) {
      const o = raw.override;
      if (!isPlain(o)) throw new ConfigError("plan_review.override must be a mapping");
      if (typeof o.reason !== "string" || !o.reason.trim())
        throw new ConfigError("plan_review.override.reason is required");
      policy.override = {
        mode: mode(o.mode, "plan_review.override.mode"),
        reason: o.reason,
        ...(typeof o.operator === "string" ? { operator: o.operator } : {}),
      };
    }
    let maxRevisions: number | undefined;
    if (raw.max_revisions !== undefined) {
      if (
        typeof raw.max_revisions !== "number" ||
        !Number.isInteger(raw.max_revisions) ||
        raw.max_revisions < 1 ||
        raw.max_revisions > 20
      ) {
        throw new ConfigError("plan_review.max_revisions must be an integer 1..20");
      }
      maxRevisions = raw.max_revisions;
    }
    const p = raw.plannotator === undefined ? {} : raw.plannotator;
    if (!isPlain(p)) throw new ConfigError("plan_review.plannotator must be a mapping");
    if (p.command !== undefined && (typeof p.command !== "string" || !p.command))
      throw new ConfigError("plannotator.command must be a string");
    if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some((a) => typeof a !== "string")))
      throw new ConfigError("plannotator.args must be a list of strings");
    if (p.cwd !== undefined && typeof p.cwd !== "string") throw new ConfigError("plannotator.cwd must be a string");
    if (
      p.timeout_ms !== undefined &&
      (typeof p.timeout_ms !== "number" || p.timeout_ms < 1000 || p.timeout_ms > 86_400_000)
    ) {
      throw new ConfigError("plannotator.timeout_ms must be 1000..86400000");
    }
    const timeoutMs = typeof p.timeout_ms === "number" ? p.timeout_ms : undefined;
    const adapter = new PlannotatorAdapter({
      transport: createHerdrPlannotatorTransport({
        ...(typeof p.command === "string" ? { command: p.command } : {}),
        ...(Array.isArray(p.args) ? { args: p.args as string[] } : {}),
        ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
      store: new FilePendingPlanStore(join(stateDir, "plan-review", "pending-plans.jsonl")),
      decisionTimeoutMs: (timeoutMs ?? 10 * 60_000) + 5_000,
    });
    return { adapter, policy, ...(maxRevisions ? { maxRevisions } : {}) };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return {
      adapter: null,
      policy: { modes: { low: "require", medium: "require", high: "require", critical: "require" } },
    };
  }
}

/** Load from the repo's policy layers. Unreadable policy => OFF (the policy loader already reports why). */
export async function loadPlanReviewSettings(cwd: string, agentDir?: string): Promise<PlanReviewSettings | null> {
  try {
    const { policy } = await loadPolicy({ cwd, ...(agentDir ? { agentDir } : {}) });
    return parsePlanReviewConfig(policy.plan_review, resolveStateRoot());
  } catch {
    return null;
  }
}
