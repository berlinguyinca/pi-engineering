/**
 * Structured review, bounded correction contracts, BLOCKED detection and
 * risk-based review frequency (spec §5, §6, §7, §20).
 */

import type { WorkerExecutor, WorkerRun } from "../workers/WorkerExecutor.ts";
import { extractStructured, matchesScope } from "./contract.ts";
import { renderHandoff } from "./handoff.ts";
import type { ModelRef } from "./planner.ts";
import { REVIEWER_PROMPT } from "./prompts.ts";
import type {
  ContractRisk,
  ContractScope,
  CorrectionContract,
  HandoffArtifact,
  ReviewIssue,
  ReviewStatus,
  ReviewVerdict,
  TaskContract,
  VerificationRun,
} from "./types.ts";

export const MAX_CORRECTION_CHANGES = 6;
export const MAX_CORRECTION_ISSUES = 6;
export const REVIEWER_TOOLS = ["read", "grep", "find", "ls"];

const STATUSES: readonly ReviewStatus[] = ["pass", "needs_fix", "replan", "escalate"];
const SEVERITY_RANK: Record<ReviewIssue["severity"], number> = { blocking: 0, major: 1, minor: 2 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function severityOf(v: unknown): ReviewIssue["severity"] {
  if (v === "blocking" || v === "blocker" || v === "critical") return "blocking";
  if (v === "major" || v === "high") return "major";
  return v === "medium" ? "major" : "minor";
}

function issuesOf(raw: unknown): ReviewIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewIssue[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ severity: "major", summary: item.slice(0, 500) });
    } else if (isRecord(item)) {
      const summary = String(item.summary ?? item.title ?? item.detail ?? "").slice(0, 500);
      if (!summary) continue;
      out.push({
        severity: severityOf(item.severity),
        summary,
        ...(typeof item.file === "string" ? { file: item.file } : {}),
      });
    }
  }
  return out;
}

/** Normalise one verdict object (our shape, or the lifecycle review_result shape). */
export function normalizeVerdict(raw: unknown): ReviewVerdict | null {
  if (!isRecord(raw)) return null;
  let status: ReviewStatus | null = null;
  if (typeof raw.status === "string" && (STATUSES as readonly string[]).includes(raw.status)) {
    status = raw.status as ReviewStatus;
  } else if (raw.verdict === "approve") {
    status = "pass";
  } else if (raw.verdict === "request_changes") {
    status = "needs_fix";
  }
  if (!status) return null;
  const issues = issuesOf(raw.issues ?? raw.findings);
  const required_changes = Array.isArray(raw.required_changes)
    ? raw.required_changes.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  return { status, issues, required_changes, contract_violation: raw.contract_violation === true };
}

/** Read the structured verdict from a reviewer run, whichever channel carried it. */
export function parseReviewVerdict(run: WorkerRun): ReviewVerdict | null {
  for (const candidate of [run.structured, run.result.details, extractStructured(run.result.summary)]) {
    const v = normalizeVerdict(candidate);
    if (v) return v;
  }
  return null;
}

/** Files a worker changed outside its contract scope (deterministic contract check). */
export function scopeViolations(changed: string[], scope: ContractScope): string[] {
  return changed.filter((f) => !matchesScope(f, scope));
}

function bounded<T>(items: T[], max: number): T[] {
  return items.slice(0, max);
}

/**
 * A bounded correction contract (spec §6). Blocking/major issues displace minor
 * ones; the scope is inherited and never widened.
 */
export function buildCorrectionContract(input: {
  contract: TaskContract;
  attempt: number;
  verdict?: ReviewVerdict | null;
  failedVerification?: VerificationRun[];
  outOfScope?: string[];
  diagnosis?: { diagnosis: string; required_changes: string[] } | null;
}): CorrectionContract {
  const { contract } = input;
  const changes: string[] = [];
  const issues: ReviewIssue[] = [];
  for (const f of input.outOfScope ?? []) {
    issues.push({ severity: "blocking", summary: `changed ${f}, which is outside the contract scope`, file: f });
  }
  if ((input.outOfScope ?? []).length > 0) {
    changes.push(`revert every change outside scope (${bounded(input.outOfScope ?? [], 4).join(", ")})`);
  }
  for (const v of input.failedVerification ?? []) {
    const firstLine = v.output_tail.split("\n").find((l) => l.trim()) ?? "";
    changes.push(`make \`${v.command}\` exit 0${firstLine ? ` (currently: ${firstLine.slice(0, 160)})` : ""}`);
    issues.push({ severity: "blocking", summary: `verification failed: ${v.command}` });
  }
  if (input.diagnosis) changes.push(...input.diagnosis.required_changes);
  if (input.verdict) {
    changes.push(...input.verdict.required_changes);
    issues.push(...input.verdict.issues);
  }
  const sorted = [...issues].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const serious = sorted.filter((i) => i.severity !== "minor");
  const keptIssues = bounded(serious.length > 0 ? serious : sorted, MAX_CORRECTION_ISSUES);
  const dedupedChanges = bounded([...new Set(changes.map((c) => c.trim()).filter(Boolean))], MAX_CORRECTION_CHANGES);
  if (dedupedChanges.length === 0) {
    dedupedChanges.push(
      ...bounded(
        keptIssues.map((i) => `resolve: ${i.summary}`),
        MAX_CORRECTION_CHANGES,
      ),
    );
  }
  return {
    task_id: contract.task_id,
    attempt: input.attempt,
    objective: `Correct ${contract.task_id} so it satisfies its contract: ${contract.objective}`,
    required_changes: dedupedChanges,
    issues: keptIssues,
    verification: contract.verification,
    scope: contract.scope,
  };
}

/** Review frequency by risk (spec §20). */
export interface ReviewPlan {
  preReview: boolean;
  review: "batch" | "immediate";
}

export function reviewPlanFor(risk: ContractRisk): ReviewPlan {
  if (risk === "low") return { preReview: false, review: "batch" };
  if (risk === "high") return { preReview: true, review: "immediate" };
  return { preReview: false, review: "immediate" };
}

/** A BLOCKED worker report must carry evidence to trigger replanning (spec §7). */
export function blockedEvidence(run: WorkerRun): string | null {
  if (run.result.status !== "blocked") return null;
  const d = run.result.details;
  const evidence = typeof d?.evidence === "string" ? d.evidence : run.result.summary;
  return evidence && evidence.trim().length >= 10 ? evidence.trim().slice(0, 2000) : null;
}

const INVALID: ReviewVerdict = {
  status: "needs_fix",
  issues: [{ severity: "blocking", summary: "reviewer returned no structured verdict" }],
  required_changes: [],
  contract_violation: false,
};

export interface ReviewRun {
  verdict: ReviewVerdict;
  run: WorkerRun;
  valid: boolean;
}

/** Run the reviewer on one worker→reviewer handoff. */
export async function runReview(opts: {
  worker: WorkerExecutor;
  handoff: HandoffArtifact;
  cwd: string;
  model?: ModelRef;
  mode?: "post" | "pre";
  signal?: AbortSignal;
}): Promise<ReviewRun> {
  const pre =
    opts.mode === "pre"
      ? "PRE-IMPLEMENTATION REVIEW: no code exists yet. Judge whether the contract is sound, bounded and safe to implement. Use pass, or replan with required_changes describing how the contract must change.\n\n"
      : "";
  const run = await opts.worker.run({
    role: "reviewer",
    task: pre + renderHandoff(opts.handoff),
    tools: REVIEWER_TOOLS,
    cwd: opts.cwd,
    systemPromptOverride: REVIEWER_PROMPT,
    ...(opts.model ? { modelOverride: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const verdict = run.result.status === "failed" ? null : parseReviewVerdict(run);
  return { verdict: verdict ?? INVALID, run, valid: verdict !== null };
}

/** One reviewer pass over several low-risk contracts (spec §20 "batch review"). */
export async function runBatchReview(opts: {
  worker: WorkerExecutor;
  handoffs: HandoffArtifact[];
  cwd: string;
  model?: ModelRef;
  signal?: AbortSignal;
}): Promise<{ verdicts: Map<string, ReviewVerdict>; run: WorkerRun }> {
  const task = [
    'BATCH REVIEW: judge each contract independently. Reply with ONE JSON object: {"reviews": [{"task_id": "...", "status": ..., "issues": [...], "required_changes": [...], "contract_violation": false}]}',
    ...opts.handoffs.map(renderHandoff),
  ].join("\n\n---\n\n");
  const run = await opts.worker.run({
    role: "reviewer",
    task,
    tools: REVIEWER_TOOLS,
    cwd: opts.cwd,
    systemPromptOverride: REVIEWER_PROMPT,
    ...(opts.model ? { modelOverride: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const verdicts = new Map<string, ReviewVerdict>();
  for (const candidate of [run.structured, run.result.details, extractStructured(run.result.summary)]) {
    const reviews = isRecord(candidate) ? candidate.reviews : undefined;
    if (!Array.isArray(reviews)) continue;
    for (const r of reviews) {
      const v = normalizeVerdict(r);
      if (v && isRecord(r) && typeof r.task_id === "string") verdicts.set(r.task_id, v);
    }
    if (verdicts.size > 0) break;
  }
  for (const h of opts.handoffs) if (!verdicts.has(h.task_id)) verdicts.set(h.task_id, INVALID);
  return { verdicts, run };
}
