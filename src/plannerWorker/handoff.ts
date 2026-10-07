/**
 * Role handoff artifacts (spec §3, §18).
 *
 * A handoff is the ONLY thing that crosses a role boundary. It carries the
 * bounded mission summary, architectural context, the contract and the results
 * of dependencies — never the planner's reasoning transcript. Keeping the
 * implementer's input this small is what stops it re-planning the mission.
 */

import { stringify as toYaml } from "yaml";
import type {
  CorrectionContract,
  DependencyResult,
  HandoffArtifact,
  HandoffKind,
  MissionBrief,
  PlannerOutput,
  PlannerWorkerRole,
  TaskContract,
  VerificationRun,
} from "./types.ts";

/** The explicit "do not re-plan" instruction every implementer receives. */
export const WORKER_INSTRUCTION =
  "Implement the supplied contract. Do not redesign or re-plan the overall mission unless the contract is impossible or contradictory. If it is, stop and report BLOCKED with concrete evidence instead of changing the plan yourself.";

const MAX_DIFF_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 1_500;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

/** Rough token estimate (chars/4) — good enough for compatibility checks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface HandoffInput {
  kind: HandoffKind;
  brief: MissionBrief;
  plan: Pick<PlannerOutput, "decisions" | "architectural_context">;
  contract: TaskContract;
  from: PlannerWorkerRole;
  to: PlannerWorkerRole;
  dependencies?: DependencyResult[];
  correction?: CorrectionContract | null;
  workerOutcome?: { summary: string; changed_files: string[]; diff: string; verification: VerificationRun[] };
}

export function buildHandoff(input: HandoffInput): HandoffArtifact {
  const { brief, plan, contract } = input;
  const deps = (input.dependencies ?? []).filter((d) => contract.depends_on.includes(d.task_id));
  const handoff: HandoffArtifact = {
    kind: input.kind,
    mission_id: brief.mission_id,
    task_id: contract.task_id,
    from_role: input.from,
    to_role: input.to,
    mission_summary: clip(brief.summary, MAX_SUMMARY_CHARS),
    architectural_context: [...brief.architectural_context, ...plan.architectural_context],
    objective: contract.objective,
    relevant_files: contract.relevant_files,
    decisions: [...plan.decisions, ...contract.decisions],
    constraints: [...brief.constraints, ...contract.constraints],
    acceptance: contract.acceptance,
    verification: input.correction?.verification ?? contract.verification,
    scope: input.correction?.scope ?? contract.scope,
    dependency_results: deps.map((d) => ({ ...d, summary: clip(d.summary, MAX_SUMMARY_CHARS) })),
    ...(input.correction ? { correction: input.correction } : {}),
    ...(input.workerOutcome
      ? {
          worker_outcome: {
            ...input.workerOutcome,
            summary: clip(input.workerOutcome.summary, MAX_SUMMARY_CHARS),
            diff: clip(input.workerOutcome.diff, MAX_DIFF_CHARS),
          },
        }
      : {}),
    token_estimate: 0,
  };
  handoff.token_estimate = estimateTokens(renderHandoff(handoff));
  return handoff;
}

/** Render a handoff as the YAML document a role session reads. */
export function renderHandoff(handoff: HandoffArtifact): string {
  const { token_estimate: _ignored, worker_outcome, ...rest } = handoff;
  const doc: Record<string, unknown> = { handoff: rest };
  if (worker_outcome) {
    const { diff, ...outcome } = worker_outcome;
    doc.worker_outcome = outcome;
    return `${toYaml(doc)}\n--- diff ---\n${diff || "(no changes)"}\n`;
  }
  return toYaml(doc);
}
