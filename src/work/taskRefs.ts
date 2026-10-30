/**
 * The durable ids a work task is linked to: commits, PRs, plans and verification evidence.
 *
 * Only ids read from durable data are ever returned, so a missing id means NO edge, never a guessed one. The Ledger
 * holds commits (candidate `head_commit`) and evidence rows; PRs and plan revisions live in the Mission/GitHub stores,
 * so they come in through the optional sources below. Everything is bounded and never throws into the caller.
 *
 * Node ids reuse the conventions the Mission side already emits, so the same PR/commit is ONE node whichever side
 * mentioned it:
 *  - PR       `pr:<host>/<owner>/<repo>#<n>`  (github/refs.ts canonicalId, as github/sync.ts)
 *  - commit   `commit:<full sha>`             (missionStore review evidence)
 *  - plan     `plan:<mission>/<revision>`     (orchestration/planReview.ts planNode)
 *  - evidence `artifact:evidence/<id>`        (commons kind; the Ledger evidence row id)
 */

import type { Candidate, Evidence, Task, WorkItem } from "../core/types.ts";
import { parseCanonicalId } from "../github/refs.ts";
import type { GithubLinkRecord } from "../github/types.ts";
import type { PlanArtifactRef } from "../orchestration/planRecords.ts";
import type { WorkTask } from "./types.ts";

export interface TaskPlanRef {
  missionId: string;
  revision: number;
  digest?: string;
  artifact?: PlanArtifactRef;
}

export interface TaskEvidenceRef {
  id: string;
  type: string;
  passed: boolean;
  /** The exact commit the run verified; without one the evidence cannot be bound and no `validated` edge is made. */
  commit?: string;
}

export interface TaskRefs {
  commits: string[];
  /** Canonical PR node ids. */
  prs: string[];
  plans: TaskPlanRef[];
  evidence: TaskEvidenceRef[];
}

export type TaskRefsSource = (task: WorkTask) => TaskRefs | undefined;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_COMMITS = 10;
const MAX_EVIDENCE = 20;
const MAX_PRS = 10;

export const emptyTaskRefs = (): TaskRefs => ({ commits: [], prs: [], plans: [], evidence: [] });

/** Active GitHub links of a task that point at a PR, as canonical node ids (the ids github/sync.ts emits). */
export function prRefsFromLinks(links: readonly GithubLinkRecord[], taskId: string): string[] {
  const out: string[] = [];
  for (const l of links) {
    if (l.status !== "active" || l.targetKind !== "pr") continue;
    if (!(l.subject.kind === "task" && l.subject.id === taskId)) continue;
    if (!parseCanonicalId(l.target) || out.includes(l.target)) continue;
    out.push(l.target);
    if (out.length >= MAX_PRS) break;
  }
  return out;
}

/** The slice of the Ledger this needs. */
export interface TaskRefsLedger {
  getWorkItem(id: string): WorkItem | undefined;
  getTask(id: string): Task | undefined;
  listCandidates(workItemId?: string): Candidate[];
  listEvidence(candidateId?: string): Evidence[];
}

export interface LedgerTaskRefsOptions {
  /** GitHub links recorded for a task (Mission store), when the caller has them. */
  githubLinks?: (taskId: string) => readonly GithubLinkRecord[];
  /** Plan revisions a task was planned under, when the caller has them. */
  plans?: (taskId: string) => readonly TaskPlanRef[];
}

/** Refs for Ledger-sourced tasks. Legacy Mission tasks return undefined: github/sync.ts and missionStore emit theirs. */
export function ledgerTaskRefs(ledger: TaskRefsLedger, opts: LedgerTaskRefsOptions = {}): TaskRefsSource {
  return (task) => {
    if (task.source !== "ledger") return undefined;
    try {
      const refs = emptyTaskRefs();
      const wiId = ledger.getWorkItem(task.id) ? task.id : (ledger.getTask(task.id)?.result_work_item_id ?? null);
      const wi = wiId ? ledger.getWorkItem(wiId) : undefined;
      if (wi) {
        const candidates = ledger.listCandidates(wi.id);
        for (const c of candidates) {
          const sha = c.head_commit?.toLowerCase();
          if (sha && FULL_SHA.test(sha) && !refs.commits.includes(sha) && refs.commits.length < MAX_COMMITS) {
            refs.commits.push(sha);
          }
        }
        const currentId = wi.current_candidate_id ?? wi.incumbent_candidate_id ?? null;
        const current = candidates.find((c) => c.id === currentId);
        if (current) {
          for (const e of ledger.listEvidence(current.id)) {
            if (e.trust === "unverified" || refs.evidence.length >= MAX_EVIDENCE) continue;
            const bound = (
              typeof e.summary.head_commit === "string" ? e.summary.head_commit : current.head_commit
            )?.toLowerCase();
            refs.evidence.push({
              id: e.id,
              type: e.type,
              passed: e.status === "passed",
              ...(bound && FULL_SHA.test(bound) ? { commit: bound } : {}),
            });
          }
        }
      }
      refs.prs = prRefsFromLinks(opts.githubLinks?.(task.id) ?? [], task.id);
      refs.plans = [...(opts.plans?.(task.id) ?? [])].slice(0, 5);
      return refs;
    } catch {
      return undefined;
    }
  };
}
