/**
 * Convergence detection and the escalation ladder (spec §8, §21).
 *
 * The tracker keeps one compact observation per implementation attempt and
 * decides whether the local plan→implement→review loop is still making
 * measurable progress. The ladder turns that into the next action:
 *
 *   local retries → debugger diagnosis + local retry → escalation model → fail
 */

import { createHash } from "node:crypto";
import type {
  ContractState,
  ConvergenceConfig,
  EscalationLadder,
  LocalLoopStalledEvent,
  ReviewVerdict,
  TaskContract,
  VerificationRun,
} from "./types.ts";

export interface AttemptObservation {
  attempt: number;
  /** Stable signature of what failed (null when verification passed). */
  failureSignature: string | null;
  /** Normalised review findings raised against this attempt. */
  findings: string[];
  testsPassed: number;
  testsTotal: number;
  diffHash: string;
  changedFiles: string[];
  contractHash: string;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+(\.\d+)?m?s\b/g, "")
    .replace(/0x[0-9a-f]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function contractHash(c: TaskContract): string {
  return hash(JSON.stringify([c.objective, c.scope, c.acceptance, c.verification, c.constraints]));
}

export function observeAttempt(input: {
  attempt: number;
  contract: TaskContract;
  verification: VerificationRun[];
  verdict: ReviewVerdict | null;
  diff: string;
  changedFiles: string[];
}): AttemptObservation {
  const failed = input.verification.filter((v) => !v.passed);
  return {
    attempt: input.attempt,
    failureSignature:
      failed.length === 0
        ? null
        : hash(failed.map((v) => `${v.command}\n${normalise(v.output_tail).slice(-600)}`).join("\n")),
    findings: (input.verdict?.status === "pass" ? [] : (input.verdict?.issues ?? [])).map((i) => normalise(i.summary)),
    testsPassed: input.verification.filter((v) => v.passed).length,
    testsTotal: input.verification.length,
    diffHash: hash(input.diff),
    changedFiles: [...input.changedFiles].sort(),
    contractHash: contractHash(input.contract),
  };
}

export interface ProgressAssessment {
  progressed: boolean;
  reasons: string[];
}

/** Did `cur` make measurable progress over `prev`? Reasons explain a "no". */
export function assessProgress(prev: AttemptObservation, cur: AttemptObservation): ProgressAssessment {
  if (cur.contractHash !== prev.contractHash) return { progressed: true, reasons: ["contract changed"] };
  const reasons: string[] = [];
  if (cur.failureSignature !== null && cur.failureSignature === prev.failureSignature) {
    reasons.push("identical failure");
  }
  const prevFindings = new Set(prev.findings);
  if (cur.findings.length > 0 && cur.findings.every((f) => prevFindings.has(f))) reasons.push("repeated findings");
  if (cur.testsPassed <= prev.testsPassed && cur.failureSignature !== null) reasons.push("no test progress");
  if (cur.diffHash === prev.diffHash) reasons.push("diff unchanged");
  else if (
    cur.changedFiles.length > 0 &&
    cur.changedFiles.join("\n") === prev.changedFiles.join("\n") &&
    reasons.length > 0
  ) {
    reasons.push("same files rewritten");
  }
  const improved =
    cur.testsPassed > prev.testsPassed ||
    (cur.failureSignature === null && prev.failureSignature !== null) ||
    cur.findings.length < prev.findings.length;
  return { progressed: improved || reasons.length === 0, reasons };
}

/** Per-contract history of attempts with stall detection. */
export class ConvergenceTracker {
  private readonly history = new Map<string, AttemptObservation[]>();
  private readonly config: ConvergenceConfig;

  constructor(config: ConvergenceConfig) {
    this.config = config;
  }

  record(taskId: string, obs: AttemptObservation): void {
    const list = this.history.get(taskId) ?? [];
    list.push(obs);
    this.history.set(taskId, list);
  }

  observations(taskId: string): AttemptObservation[] {
    return this.history.get(taskId) ?? [];
  }

  /** LOCAL_LOOP_STALLED when the last `stall_after` attempts made no progress. */
  stalled(taskId: string, now: () => Date = () => new Date()): LocalLoopStalledEvent | null {
    const list = this.observations(taskId);
    const window = this.config.stall_after;
    if (list.length < window + 1) return null;
    const reasons = new Set<string>();
    for (let i = list.length - window; i < list.length; i++) {
      const a = assessProgress(list[i - 1]!, list[i]!);
      if (a.progressed) return null;
      for (const r of a.reasons) reasons.add(r);
    }
    return {
      type: "LOCAL_LOOP_STALLED",
      at: now().toISOString(),
      task_id: taskId,
      attempts: list.length,
      reasons: [...reasons],
    };
  }
}

export type LadderAction =
  | { kind: "retry"; rung: ContractState["rung"] }
  | { kind: "diagnose" }
  | { kind: "escalate" }
  | { kind: "fail"; reason: string };

/**
 * The next step after a failed attempt (spec §8). `attemptsOnRung` counts
 * implementation attempts made on the current rung.
 */
export function nextLadderAction(input: {
  rung: ContractState["rung"];
  attemptsOnRung: number;
  stalled: boolean;
  reviewerAskedEscalation: boolean;
  ladder: EscalationLadder;
  escalationAvailable: boolean;
}): LadderAction {
  const { rung, attemptsOnRung, ladder } = input;
  const escalateOrFail = (why: string): LadderAction =>
    input.escalationAvailable
      ? { kind: "escalate" }
      : { kind: "fail", reason: `${why}; no escalation model available` };
  if (rung === "escalated") {
    return attemptsOnRung < ladder.max_escalation_attempts
      ? { kind: "retry", rung }
      : { kind: "fail", reason: "escalation attempts exhausted" };
  }
  if (input.reviewerAskedEscalation) return escalateOrFail("reviewer requested escalation");
  if (rung === "local") {
    if (!input.stalled && attemptsOnRung < ladder.max_local_attempts) return { kind: "retry", rung };
    return ladder.max_diagnosed_attempts > 0 ? { kind: "diagnose" } : escalateOrFail("local attempts exhausted");
  }
  if (!input.stalled && attemptsOnRung < ladder.max_diagnosed_attempts) return { kind: "retry", rung };
  return escalateOrFail("diagnosed attempts exhausted");
}
