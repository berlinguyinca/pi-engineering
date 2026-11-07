/**
 * Role handoff artifacts (spec §3, §18).
 *
 * A handoff is the ONLY thing that crosses a role boundary. It carries the
 * bounded mission summary, architectural context, the contract and the results
 * of dependencies — never the planner's reasoning transcript. Keeping the
 * implementer's input this small is what stops it re-planning the mission.
 */

import { canonicalHash } from "../bootstrap/resultGate.ts";
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

export interface HandoffInput {
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

/**
 * Sealed authority envelope (T08). `HandoffArtifact` carries no hash field and none may be added
 * (types.ts is frozen for this unit), so contract authority travels BESIDE the artifact in an
 * envelope this module owns. Authority covers `objective`, `constraints` (sorted copy),
 * `acceptance` (sorted copy) and `scope`, digested with `canonicalHash` from
 * `src/bootstrap/resultGate.ts` — the canonicalizer `src/bootstrap/taskAuthority.ts` (T01) hashes
 * operator task authority with, so a handoff hash is comparable to a task authority hash.
 * `mission_summary`, `decisions`, `architectural_context`, `dependency_results`, `correction`,
 * `worker_outcome` and `token_estimate` are NOT authority-bearing: that is what lets a resumed
 * worker receive a new summary without moving the handoff's authority.
 */
export const MAX_TRANSCRIPT_CHARS = 2_000; // excerpt bound; the full transcript is never retained
export interface HandoffAuthority { authority_hash: string; objective_sha256: string; constraints_sha256: string; acceptance_sha256: string; scope_sha256: string; transcript_excerpt: string; transcript_truncated: boolean; transcript_chars: number }
export interface SealedHandoff { handoff: HandoffArtifact; authority: HandoffAuthority }
export type HandoffAuthorityCheck = { ok: true; authority: HandoffAuthority } | { ok: false; reasons: string[]; authority?: HandoffAuthority };
const AUTHORITY_FIELDS = ["objective", "constraints", "acceptance", "scope"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Recomputed digests of the authority-bearing parts; defensive so verification never throws, and it never mutates the handoff. */
function digests(handoff: unknown) {
  const h: Partial<HandoffArtifact> = isRecord(handoff) ? handoff : {};
  const objective = typeof h.objective === "string" ? h.objective : String(h.objective ?? "");
  const constraints = Array.isArray(h.constraints) ? [...h.constraints].sort() : []; const acceptance = Array.isArray(h.acceptance) ? [...h.acceptance].sort() : [];
  const scope = h.scope ?? { allowed: [], forbidden: [] };
  return { objective: canonicalHash(objective), constraints: canonicalHash(constraints), acceptance: canonicalHash(acceptance), scope: canonicalHash(scope), authority_hash: canonicalHash({ objective, constraints, acceptance, scope }) };
}
/** Seal a handoff: digest its authority-bearing parts, retain at most MAX_TRANSCRIPT_CHARS of the transcript. */
export function sealHandoff(handoff: HandoffArtifact, transcript?: unknown): SealedHandoff {
  const d = digests(handoff); const text = typeof transcript === "string" ? transcript.trim() : "";
  return { handoff, authority: { authority_hash: d.authority_hash, objective_sha256: d.objective, constraints_sha256: d.constraints, acceptance_sha256: d.acceptance, scope_sha256: d.scope, transcript_excerpt: text.slice(0, MAX_TRANSCRIPT_CHARS), transcript_truncated: text.length > MAX_TRANSCRIPT_CHARS, transcript_chars: text.length } };
}
/** Recompute authority from the handoff actually carried; a missing or non-string expected hash fails closed. Never throws. */
export function verifyHandoffAuthority(sealed: SealedHandoff, expectedAuthorityHash?: unknown): HandoffAuthorityCheck {
  const recorded: Record<string, unknown> = isRecord(sealed?.authority) ? sealed.authority : {}; const want = digests(sealed?.handoff); const reasons: string[] = [];
  for (const field of AUTHORITY_FIELDS) { const got = recorded[`${field}_sha256`]; if (got !== want[field]) reasons.push(`${field} diverged: ${String(got)} != ${want[field]}`); }
  const expected = typeof expectedAuthorityHash === "string" ? expectedAuthorityHash.trim() : "";
  if (expected === "") reasons.push(`expected authority hash missing: recomputed ${want.authority_hash}`);
  else if (expected !== want.authority_hash) reasons.push(`authority mismatch: expected ${expected} != recomputed ${want.authority_hash}`);
  return reasons.length > 0 ? { ok: false, reasons, authority: sealed.authority } : { ok: true, authority: sealed.authority };
}
/** Resume a worker: reject a malformed envelope, then an envelope whose recorded hashes disagree with the handoff it carries (naming the altered part), then verify authority. */
export function resumeHandoff(env: unknown, expectedAuthorityHash?: unknown): HandoffAuthorityCheck {
  if (!isRecord(env) || !isRecord(env.handoff) || !isRecord(env.authority)) return { ok: false, reasons: ["malformed envelope"] };
  const want = digests(env.handoff); const recorded = env.authority; const reasons: string[] = [];
  for (const field of AUTHORITY_FIELDS) { const got = recorded[`${field}_sha256`]; if (got !== want[field]) reasons.push(`envelope altered: ${field}_sha256 ${String(got)} != ${want[field]}`); }
  if (recorded.authority_hash !== want.authority_hash) reasons.push(`envelope altered: authority_hash ${String(recorded.authority_hash)} != ${want.authority_hash}`);
  if (reasons.length > 0) return { ok: false, reasons, authority: recorded as unknown as HandoffAuthority };
  return verifyHandoffAuthority(env as unknown as SealedHandoff, expectedAuthorityHash);
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
