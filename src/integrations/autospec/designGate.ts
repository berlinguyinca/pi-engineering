/**
 * Design-gate evidence (T04). PURE: parse + judge a report that AutoSpec's own
 * `scripts/autospec-design-gates.sh` wrote to `.autospec/reports/design-gates.json`.
 *
 * Pi executes nothing here and trusts the report only as far as it can bind it:
 *  - the verdict is RECOMPUTED from `gates[]`, never read from `status`;
 *  - it is valid only for the commit it states (`commit_sha`, or a sidecar), and
 *    only when that commit is HEAD and no UI file has changed since;
 *  - SKIPPED / missing is "not run", never a pass; `not_applicable` is decided
 *    by Pi's own `ui_paths`, never by the report;
 *  - `vlm` / `review` rules are advisory checklist items, never credited as pass,
 *    even if a crafted report lists them as executed;
 *  - the report's own absolute paths (rules_file, config_path) are never followed.
 */

import type { GateItem } from "../../lifecycle/types.ts";

export type RuleCheckClass = "auto" | "vlm" | "review";

export type DesignGateState =
  | "passed"
  | "failed"
  | "not_run" // missing or SKIPPED
  | "incomplete" // pass, but nothing credited, or an unmapped blocker
  | "unbound" // no commit stated
  | "stale" // commit != HEAD, or UI edits newer than the report
  | "invalid" // malformed or self-contradictory
  | "not_applicable"; // Pi's ui_paths say no UI file changed

export interface AdvisoryItem {
  id: string;
  check: string;
  criteria: string;
  /** True if the report claimed to have executed it; the claim is not credited. */
  reportedAsExecuted?: boolean;
}

export interface DesignGateEvidence {
  state: DesignGateState;
  reason: string;
  /** Blocking gate ids that failed (state = failed). */
  failedGates: string[];
  /** Blocker-severity auto gates that did not run (unmapped). */
  unmappedBlockers: string[];
  /** Checklist: vlm / review rules and pack quality gates. Never "passed". */
  advisory: AdvisoryItem[];
  packQualityGates: string[];
  commitSha: string | null;
}

export interface DesignGateInput {
  /** Parsed JSON, or undefined when the report file is missing. */
  report: unknown;
  /** Commit stated by a sidecar next to the report, if any. */
  sidecarCommit?: string | null;
  headCommit: string;
  /** Pi determined (from its OWN ui_paths) that a UI file is part of this change. */
  uiTouched: boolean;
  /** At least one UI file is uncommitted (staged/unstaged/untracked). */
  uiUncommitted: boolean;
  /** Rule id -> class from a Pi-configured rules.yaml; overrides the report's view. */
  ruleClasses?: ReadonlyMap<string, RuleCheckClass>;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

class Invalid extends Error {}

const base = (state: DesignGateState, reason: string, extra: Partial<DesignGateEvidence> = {}): DesignGateEvidence => ({
  state,
  reason,
  failedGates: [],
  unmappedBlockers: [],
  advisory: [],
  packQualityGates: [],
  commitSha: null,
  ...extra,
});

export function evaluateDesignGate(input: DesignGateInput): DesignGateEvidence {
  if (!input.uiTouched) {
    return base("not_applicable", "no file matching the configured ui_paths changed");
  }
  if (input.report === undefined) {
    return base("not_run", "design gate not run: no .autospec/reports/design-gates.json");
  }
  try {
    return judge(input);
  } catch (e) {
    if (e instanceof Invalid) return base("invalid", `design-gates report rejected: ${e.message}`);
    throw e;
  }
}

function judge(input: DesignGateInput): DesignGateEvidence {
  const r = input.report;
  if (!isRecord(r)) throw new Invalid("not a JSON object");
  if (r.version !== 1) throw new Invalid(`unsupported version ${JSON.stringify(r.version)}`);
  if (typeof r.generated_at !== "string") throw new Invalid("generated_at missing");
  if (r.status !== "pass" && r.status !== "fail" && r.status !== "skipped") {
    throw new Invalid(`unknown status ${JSON.stringify(r.status)}`);
  }
  const line = String(r.status).toUpperCase();
  if (r.status_line !== line)
    throw new Invalid(`status_line ${JSON.stringify(r.status_line)} disagrees with status ${r.status}`);
  if (!Array.isArray(r.gates) || !Array.isArray(r.critic_checklist) || !Array.isArray(r.pack_quality_gates)) {
    throw new Invalid("gates, critic_checklist and pack_quality_gates must be arrays");
  }
  const counts = r.counts;
  if (
    !isRecord(counts) ||
    ["run", "failed", "unmapped"].some((k) => !Number.isInteger(counts[k]) || (counts[k] as number) < 0)
  ) {
    throw new Invalid("counts must hold non-negative integers run, failed, unmapped");
  }

  // Commit binding. A report with no commit is not evidence for any commit.
  const stated = r.commit_sha === undefined ? null : r.commit_sha;
  if (stated !== null && (typeof stated !== "string" || !SHA.test(stated)))
    throw new Invalid("commit_sha is not a hex commit id");
  const sidecar = input.sidecarCommit ?? null;
  if (sidecar !== null && !SHA.test(sidecar)) throw new Invalid("sidecar commit is not a hex commit id");
  if (stated !== null && sidecar !== null && stated !== sidecar)
    throw new Invalid("commit_sha disagrees with the sidecar commit");
  const commitSha = (stated ?? sidecar) as string | null;

  // Classification of every rule the report talks about.
  const classOf = (id: string, reported: string | undefined): RuleCheckClass => {
    const mine = input.ruleClasses?.get(id);
    if (mine) return mine;
    return reported === "vlm" || reported === "review" ? reported : "auto";
  };
  const advisory: AdvisoryItem[] = [];
  const advisoryIds = new Set<string>();
  for (const c of r.critic_checklist) {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.pass_criteria !== "string")
      throw new Invalid("critic_checklist item malformed");
    const check = typeof c.check === "string" ? c.check : "review";
    if (check !== "vlm" && check !== "review") throw new Invalid(`critic_checklist item ${c.id} has check ${check}`);
    advisoryIds.add(c.id);
    advisory.push({ id: c.id, check, criteria: c.pass_criteria });
  }
  const pack = r.pack_quality_gates.map((q) => {
    if (typeof q !== "string") throw new Invalid("pack_quality_gates must be strings");
    return q;
  });

  let run = 0;
  let failedCount = 0;
  let unmapped = 0;
  let credited = 0;
  const failedGates: string[] = [];
  const unmappedBlockers: string[] = [];
  let blockingFailure = false;
  for (const g of r.gates) {
    if (!isRecord(g) || typeof g.id !== "string" || typeof g.blocking !== "boolean" || typeof g.severity !== "string") {
      throw new Invalid("gates item malformed");
    }
    if (g.status !== "pass" && g.status !== "fail" && g.status !== "unmapped")
      throw new Invalid(`gate ${g.id} has status ${String(g.status)}`);
    const cls = advisoryIds.has(g.id) ? "review" : classOf(g.id, typeof g.check === "string" ? g.check : undefined);
    if (g.status === "unmapped") {
      unmapped++;
      if (cls === "auto" && g.severity === "blocker") unmappedBlockers.push(g.id);
      continue;
    }
    run++;
    if (g.status === "fail") {
      failedCount++;
      if (g.blocking || cls !== "auto") {
        // A failure is never forgiven; an advisory-class failure is still reported.
        blockingFailure = true;
        failedGates.push(g.id);
      }
    } else if (cls === "auto") {
      credited++;
    } else {
      const known = advisory.find((a) => a.id === g.id);
      if (known) known.reportedAsExecuted = true;
      else {
        advisory.push({
          id: g.id,
          check: cls,
          criteria: typeof g.pass_criteria === "string" ? g.pass_criteria : "",
          reportedAsExecuted: true,
        });
      }
    }
  }
  if (counts.run !== run || counts.failed !== failedCount || counts.unmapped !== unmapped) {
    throw new Invalid("counts disagree with gates[]");
  }
  if (r.status === "pass" && blockingFailure) throw new Invalid("status pass but gates[] holds a blocking failure");
  if (r.status === "fail" && !blockingFailure && r.reason !== "strict-unmapped-blocker") {
    throw new Invalid("status fail but gates[] holds no blocking failure");
  }
  if (r.status === "skipped" && (r.gates.length > 0 || run > 0))
    throw new Invalid("status skipped but gates[] is not empty");

  const common = { advisory, packQualityGates: pack, commitSha, failedGates, unmappedBlockers };

  if (r.status === "skipped") {
    // A UI change was made yet the report says it was not UI (or no config): not run, never n/a.
    return base(
      "not_run",
      `design gate SKIPPED (${String(r.reason ?? "no reason")}) although UI files changed`,
      common,
    );
  }
  // Binding comes before the verdict: a stale FAIL or PASS says nothing about this tree.
  if (!commitSha) return base("unbound", "report states no commit_sha and no sidecar commit accompanies it", common);
  if (commitSha !== input.headCommit) {
    return base("stale", `report is for ${commitSha.slice(0, 12)}, HEAD is ${input.headCommit.slice(0, 12)}`, common);
  }
  if (input.uiUncommitted) {
    return base("stale", "UI files changed after the commit the report was produced for (uncommitted edits)", common);
  }
  if (blockingFailure) return base("failed", `blocking design gate(s) failed: ${failedGates.join(", ")}`, common);
  if (unmappedBlockers.length > 0) {
    return base(
      "incomplete",
      `blocker rule(s) have no mapped command and did not run: ${unmappedBlockers.join(", ")}`,
      common,
    );
  }
  if (credited === 0) return base("incomplete", "no executable design gate ran", common);
  return base("passed", `${credited} executable design gate(s) passed at ${commitSha.slice(0, 12)}`, common);
}

/** Map evidence onto the completion gate vocabulary. "Not run" is never a pass. */
export function designGateItem(evidence: DesignGateEvidence, required: boolean): GateItem {
  const key = "design_gate";
  const mk = (status: GateItem["status"], blockers: string[] = []): GateItem => ({
    key,
    status,
    required,
    reason: evidence.reason,
    blockers,
  });
  switch (evidence.state) {
    case "passed":
      return mk("passed");
    case "not_applicable":
      return mk("not_applicable");
    case "failed":
      return mk("failed", [`design_gate: ${evidence.failedGates.join(", ")}`]);
    case "not_run":
      return mk("skipped");
    default:
      return mk("unavailable");
  }
}

/** Human checklist lines for the finalization output. Advisory items are never "passed". */
export function designGateChecklist(evidence: DesignGateEvidence): string[] {
  const lines: string[] = [];
  lines.push(`Design gate: ${evidence.state.replace("_", " ")} - ${evidence.reason}`);
  for (const a of evidence.advisory) {
    lines.push(
      `  [advisory, not verified] ${a.id} (${a.check}): ${a.criteria}${a.reportedAsExecuted ? " (report claimed it ran; not credited)" : ""}`,
    );
  }
  for (const q of evidence.packQualityGates) lines.push(`  [pack quality gate, not verified] ${q}`);
  return lines;
}
