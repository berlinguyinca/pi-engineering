import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Model } from "@earendil-works/pi-ai/compat";
import type {
  Actor,
  Candidate,
  RiskLevel,
  Telemetry,
  WorkItem,
  WorkerRole,
} from "../core/types.ts";
import { ROLE_BUDGETS, isMachineEvidence } from "../core/types.ts";
import { Ledger } from "../ledger/Ledger.ts";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { ContextBroker } from "../context/ContextBroker.ts";
import { GitRepo } from "../git/GitRepo.ts";
import { CommandVerifier, type VerificationProvider, type VerifyOutcome } from "../verify/Verifier.ts";
import type { WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";
import { PiWorkerExecutor } from "../workers/PiWorkerExecutor.ts";
import { buildCoreTools } from "../tools/coreTools.ts";
import { newRunId } from "../core/ids.ts";

export interface EngineerReport {
  work_item: WorkItem;
  risk: RiskLevel;
  incumbent_candidate: Candidate | null;
  scout_summary: string | null;
  review_summary: string | null;
  challenge_summary: string | null;
  verification: VerifyOutcome | null;
  evidence_ids: string[];
  rounds: number;
  outcome: "promoted" | "failed" | "blocked";
  /** Aggregate context/autonomy telemetry for the run (spec §41). */
  telemetry: Telemetry;
}

/** Read-only tool allowlist (scout/reviewer/challenger). */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
/** Implementation tool allowlist. */
const IMPLEMENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function classifyRisk(goal: string): RiskLevel {
  if (/typo|spelling|doc\b|comment|readme|label|rename\s+variable|format/i.test(goal)) return "low";
  if (/data\s+loss|payment|security|critical|auth|schema|breaking/i.test(goal)) return "critical";
  if (/migrat|concurr|race|api\s+compat/i.test(goal)) return "high";
  return "medium";
}

/** Compact diff block for prior-attempt feedback (kept out of the main prompt). */
function diffBlock(diff: string | null): string {
  return diff ? `Prior diff:\n${diff.slice(0, 4000)}` : "Prior diff: none";
}

function materialFindings(ledger: Ledger, candidateId: string | null): string[] {
  return ledger
    .listEntities("finding")
    .filter((f) => f.status === "open" && f.candidate_id === candidateId)
    .filter((f) => f.severity === "high" || f.severity === "medium" || f.severity === "critical")
    .map((f) => `${f.id}: ${f.claim}`);
}

export interface EngineeringRuntimeOptions {
  cwd: string;
  worker?: WorkerExecutor;
  verifier?: VerificationProvider;
  model?: Model<any>;
  agentDir?: string;
  /** Override the durable state directory (default: <repoRoot>/.pi-eng). */
  workDir?: string;
}

/**
 * The Engineering Runtime facade. Owns the ledger, artifact store, context
 * broker, git provider, verifier, and worker executor for one repository, and
 * exposes the vertical-slice workflows: scout, implement, verify, review,
 * challenge, and the adaptive `engineer` pipeline.
 */
export class EngineeringRuntime {
  ledger: Ledger;
  artifacts: ArtifactStore;
  broker: ContextBroker | null;
  git: GitRepo | null;
  readonly cwd: string;
  readonly workDir: string;
  readonly worker: WorkerExecutor;
  readonly verifier: VerificationProvider;
  readonly telemetry: Telemetry;

  private constructor(opts: EngineeringRuntimeOptions) {
    this.cwd = opts.cwd;
    this.workDir = opts.workDir ?? "";
    this.worker = opts.worker ?? new PiWorkerExecutor({ model: opts.model, agentDir: opts.agentDir });
    this.verifier = opts.verifier ?? new CommandVerifier();
    this.telemetry = {
      workers: {},
      toolCalls: 0,
      verifyStages: 0,
      evidence: 0,
      blockedOrFailedWorkers: 0,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      turns: 0,
    };
    // Assigned by open().
    this.ledger = undefined as unknown as Ledger;
    this.artifacts = undefined as unknown as ArtifactStore;
    this.broker = null;
    this.git = null;
  }

  static async open(opts: EngineeringRuntimeOptions): Promise<EngineeringRuntime> {
    const git = await GitRepo.open(opts.cwd);
    const repoRoot = git ? git.root : opts.cwd;
    const workDir = opts.workDir ?? join(repoRoot, ".pi-eng");
    await mkdir(workDir, { recursive: true });
    const ledger = await Ledger.create(join(workDir, "ledger.jsonl"));
    const artifacts = await ArtifactStore.create(join(workDir, "artifacts"));
    const broker = await ContextBroker.open(repoRoot);
    const rt = new EngineeringRuntime(opts);
    rt.ledger = ledger;
    rt.artifacts = artifacts;
    rt.broker = broker;
    rt.git = git;
    // Bind the semantic tools (ledger_read, repo_search, ...) to THIS runtime so
    // worker sessions get the tools their prompts require and always address the
    // shared ledger/broker regardless of their cwd (a candidate worktree must not
    // open a separate empty ledger).
    if (rt.worker instanceof PiWorkerExecutor) {
      rt.worker.setCustomTools(
        buildCoreTools(() => ({
          ledger: rt.ledger,
          artifacts: rt.artifacts,
          broker: rt.broker,
          currentWorkItemId: () => rt.ledger.listWorkItems().at(-1)?.id ?? null,
          actor: () => ({ type: "system" }),
        })),
      );
    }
    return rt;
  }

  actor(runId: string, role?: WorkerRole): Actor {
    return { type: "system", run_id: runId, role };
  }

  // ------------------------------------------------------------- run a worker

  private async runWorker(
    role: WorkerRole,
    task: string,
    opts: {
      cwd: string;
      tools: string[];
      context?: string;
      wi: WorkItem;
      timeoutMs?: number;
    },
  ) {
    const runId = newRunId();
    const budget = ROLE_BUDGETS[role];
            const req: WorkerRequest = {
      role,
      task,
      tools: opts.tools,
      cwd: opts.cwd,
      context: opts.context,
      timeoutMs: opts.timeoutMs ?? 300_000,
      maxContextTokens: budget?.hardMaxTokens,
    };
    const run = await this.worker.run(req);

    // Accumulate context/autonomy telemetry.
    this.telemetry.workers[role] = (this.telemetry.workers[role] ?? 0) + 1;
    this.telemetry.toolCalls += run.toolCalls ?? 0;
    if (run.result.status !== "completed") this.telemetry.blockedOrFailedWorkers++;
    if (run.usage) {
      this.telemetry.inputTokens += run.usage.input;
      this.telemetry.outputTokens += run.usage.output;
      this.telemetry.contextTokens = Math.max(this.telemetry.contextTokens, run.usage.contextTokens);
      this.telemetry.turns += run.usage.turns;
    }

    // Record claims as ledger hypotheses (INV-006). Only machine evidence
    // references mark a claim verified; agent-authored text stays an open
    // hypothesis until confirmed by real verification output.
    for (const claim of run.result.claims) {
      const machine = isMachineEvidence(claim.evidence);
      await this.ledger.recordEntity(
        "hypothesis",
        claim.claim,
        machine ? "verified" : "open",
        this.actor(runId, role),
        opts.wi.id,
        { evidence: machine ? [claim.evidence!] : [] },
      );
    }
    for (const h of run.result.new_hypotheses) {
      await this.ledger.recordEntity("hypothesis", h, "open", this.actor(runId, role), opts.wi.id);
    }
    // Persist worker output as an artifact so large output stays out of context.
    const artifact = await this.artifacts.put(
      "workers",
      runId,
      JSON.stringify({ role, task, result: run.result }, null, 2),
      `${role} result: ${run.result.status} — ${run.result.summary.slice(0, 200)}`,
    );
    return { runId, run, artifactUri: artifact.uri };
  }

  // ------------------------------------------------------------------- scout

  async scout(wi: WorkItem, goal: string, contextText: string): Promise<{ summary: string; artifactUri: string } | null> {
    if (!this.broker) return null;
    const task = `Investigate this repository and recommend the smallest relevant change surface for the goal:
"${goal}"
Report: relevant symbols/files, architecture constraints, testing implications, and any risks.
Use repo_search, symbol, ledger_read, and artifact_read. Do not edit files.`;
    const { run, artifactUri } = await this.runWorker("scout", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
    });
    return { summary: run.result.summary, artifactUri };
  }

  // ------------------------------------------------------------ implement

  private async createCandidateWorktree(
    wi: WorkItem,
    parentId: string | null,
    actor: Actor,
  ): Promise<{ candidate: Candidate; worktreePath: string } | { candidate: Candidate; worktreePath: null }> {
    if (!this.git) {
      // Non-git fallback: implement directly in cwd (no isolation).
      const candidate = await this.ledger.createCandidate(wi.id, "", "working", null, "implementer", "run", parentId, actor);
      return { candidate, worktreePath: null };
    }
    const baseCommit = await this.git.headCommit();
    const branch = `pi-eng-${candidateSeq(this.ledger, wi.id)}`;
    const wt = await this.git.createWorktree(baseCommit, branch);
    const runId = newRunId();
    const candidate = await this.ledger.createCandidate(wi.id, baseCommit, branch, wt.path, "implementer", runId, parentId, actor);
    return { candidate, worktreePath: wt.path };
  }

  private async implementIn(wi: WorkItem, candidate: Candidate, worktreePath: string | null, task: string, contextText: string) {
    const cwd = worktreePath ?? this.cwd;
    const run = await this.runWorker("implementer", task, {
      cwd,
      tools: IMPLEMENT_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 600_000,
    });
    // Commit and capture diff (git only).
    if (this.git && worktreePath) {
      // Check the worktree's own status (the main repo may have untracked
      // .pi-eng/ state that must not be mistaken for implementer changes).
      const changed = await this.git.statusIn(worktreePath);
      if (changed.trim()) {
        await this.git.commitAll(worktreePath, `${wi.id}: implementation candidate`);
        const head = await this.git.headCommitIn(worktreePath);
        const diff = await this.git.captureDiff(candidate.base_commit, head);
        const files = await this.git.changedFiles(candidate.base_commit, head);
        const diffArtifact = await this.artifacts.put("candidate", candidate.id, diff || "(empty diff)", `${files.length} file(s) changed`);
        await this.ledger.changeCandidate(candidate.id, { diff: diff || null, changed_files: files }, wi.id, this.actor(run.runId, "implementer"));
        return { ...run, diff: diff || null, changedFiles: files, diffArtifactUri: diffArtifact.uri };
      }
    }
    return { ...run, diff: null, changedFiles: [], diffArtifactUri: null };
  }

  async verify(wi: WorkItem, candidate: Candidate, worktreePath: string | null) {
    const cwd = worktreePath ?? this.cwd;
    const profile = await this.verifier.detect(cwd);
    const outcome = await this.verifier.run(cwd, profile, this.artifacts);
    const actor = this.actor(newRunId(), "reviewer");
    this.telemetry.verifyStages += outcome.stages.length;
    const evidenceIds: string[] = [];
    for (const ev of outcome.evidence) {
      this.telemetry.evidence++;
      const recorded = await this.ledger.recordEvidence(
        candidate.id, ev.type, ev.tool, ev.command, ev.exit_code, ev.status, ev.summary, ev.artifacts, ev.trust, wi.id, actor,
      );
      evidenceIds.push(recorded.id);
    }
    await this.ledger.changeCandidate(candidate.id, { status: outcome.passed ? "ELIGIBLE" : "VERIFYING" }, wi.id, actor);
    return { outcome, evidenceIds, profile };
  }

  // ----------------------------------------------------------------- review

  async review(wi: WorkItem, candidate: Candidate, requirement: string): Promise<{ summary: string; findingIds: string[] }> {
    const diff = candidate.diff ?? "(no captured diff)";
    const task = `Independently review candidate ${candidate.id} for the work item:
"${wi.goal}"
Requirement: ${requirement}

Candidate diff:
${diff.slice(0, 8000)}

Report concrete findings. Return your findings EXACTLY as details.findings, an array of objects { severity, claim, evidence } where severity is one of info|low|medium|high|critical. If there are NO material issues, set details.findings to an EMPTY array. Do not put findings in the claims field. You are a reviewer; you do not approve the work, you report findings. Use artifact_read to inspect logs if referenced.`;
    const { run, runId } = await this.runWorker("reviewer", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      wi,
      timeoutMs: 240_000,
    });
    // Findings come from the explicit details.findings contract; anything else
    // is recorded as a (non-blocking) hypothesis so a malformed review never
    // both invents blocking findings and silently promotes.
    const findingIds: string[] = [];
    const details = run.result.details as { findings?: Array<{ severity?: string; claim?: string; evidence?: string }> };
    for (const f of details?.findings ?? []) {
      if (!f.claim) continue;
      const entity = await this.ledger.recordEntity(
        "finding", f.claim, "open", this.actor(runId, "reviewer"), wi.id,
        { severity: (f.severity as never) ?? "medium", evidence: f.evidence ? [f.evidence] : [], candidateId: candidate.id },
      );
      findingIds.push(entity.id);
    }
    for (const c of run.result.claims) {
      await this.ledger.recordEntity("hypothesis", c.claim, "open", this.actor(runId, "reviewer"), wi.id, {
        evidence: isMachineEvidence(c.evidence) ? [c.evidence] : [],
      });
    }
    return { summary: run.result.summary, findingIds };
  }

  // -------------------------------------------------------------- challenge

  async challenge(wi: WorkItem, goal: string, contextText: string): Promise<{ summary: string; assessment: string } | null> {
    if (!this.broker) return null;
    const task = `You are a clean-room challenger. From the original requirement ONLY, derive an independent approach for:
"${goal}"
You must NOT inherit any prior candidate reasoning. Inspect the repository with repo_search/symbol to ground your approach. Propose your independent approach and call out any risks or alternative designs. Report your assessment.`;
    const { run } = await this.runWorker("clean-room-challenger", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
    });
    const details = run.result.details as { assessment?: string };
    return { summary: run.result.summary, assessment: details?.assessment ?? run.result.summary };
  }

  // --------------------------------------------------------------- engineer

  async engineer(goal: string): Promise<EngineerReport> {
    if (!this.git) {
      return {
        work_item: await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner")),
        risk: "medium",
        incumbent_candidate: null,
        scout_summary: "Skipped: not a git repository.",
        review_summary: null,
        challenge_summary: null,
        verification: null,
        evidence_ids: [],
        rounds: 0,
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    const risk = classifyRisk(goal);
    const wi = await this.ledger.createWorkItem(goal, risk, [this.cwd], this.actor(newRunId(), "planner"));
    await this.ledger.recordEntity("requirement", goal, "open", this.actor(newRunId(), "planner"), wi.id);

    // Assemble bounded task context.
    const requiredFiles: string[] = [];
    let contextText = "";
    if (this.broker) {
      const pkg = await this.broker.assembleContext(goal, ROLE_BUDGETS.implementer.targetTokens, requiredFiles);
      contextText = this.broker.renderContext(pkg);
    }

    // Scout (medium+).
    let scoutSummary: string | null = null;
    if (risk !== "low") {
      const scout = await this.scout(wi, goal, contextText);
      scoutSummary = scout?.summary ?? null;
    }

    // Clean-room challenge (spec §12.2): mandatory for high-risk work, to escape
    // anchoring and protect against a consensus built on a bad premise. The
    // independent assessment is recorded as a ledger decision.
    let challengeSummary: string | null = null;
    if ((risk === "high" || risk === "critical") && this.broker) {
      const chal = await this.challenge(wi, goal, contextText);
      if (chal) {
        challengeSummary = chal.summary;
        await this.ledger.recordEntity(
          "decision",
          `clean-room challenge: ${chal.assessment}`,
          "open",
          this.actor(newRunId(), "clean-room-challenger"),
          wi.id,
        );
      }
    }

    const maxRounds = 3;
    let parentId: string | null = null;
    let incumbent: Candidate | null = null;
    let reviewSummary: string | null = null;
    let lastVerify: VerifyOutcome | null = null;
    const evidenceIds: string[] = [];
    let rounds = 0;
    let feedback = "";

    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const { candidate, worktreePath } = await this.createCandidateWorktree(wi, parentId, this.actor(newRunId(), "implementer"));

      const implTask = `Implement the goal in this repository:
"${goal}"
Risk level: ${risk}. Make the smallest coherent change. Use the provided context and repository tools. Run a quick targeted check (e.g. the project test command) before finishing.${feedback ? `\n\nPRIOR ATTEMPT FEEDBACK (repair these issues):\n${feedback}` : ""}`;
      const impl = await this.implementIn(wi, candidate, worktreePath, implTask, contextText);

      const { outcome, evidenceIds: ids, profile } = await this.verify(wi, candidate, worktreePath);
      evidenceIds.push(...ids);
      lastVerify = outcome;

      // Clean up the worktree after verification, keeping the branch until the
      // promotion decision so a promoted candidate can be merged (INV-004).
      if (this.git && worktreePath) {
        await this.git.removeWorktree({ path: worktreePath, branch: candidate.branch }, { keepBranch: true }).catch(() => {});
      }

      if (!outcome.passed) {
        await this.ledger.rejectCandidate(candidate.id, wi.id, `verification failed: ${outcome.failedStage}`, this.actor(newRunId(), "reviewer"));
        await this.git?.deleteBranch(candidate.branch).catch(() => {});
        // Child candidate on next round, with the failing evidence as feedback.
        feedback = `${diffBlock(candidate.diff)}\nVerification failed at stage '${outcome.failedStage}' (exit ${outcome.stages.find((s) => !s.passed)?.exitCode ?? "?"}). Fix it.`;
        parentId = candidate.id;
        if (round === maxRounds - 1) break;
        continue;
      }

      // Independent review (separation of duties, INV-007).
      const rev = await this.review(wi, candidate, goal);
      reviewSummary = rev.summary;
      const findings = materialFindings(this.ledger, candidate.id);

      if (findings.length === 0) {
        // Controlled, evidence-gated promotion (INV-003, INV-005): merge the
        // verified candidate into the incumbent branch, then record it.
        const merge = this.git ? await this.git.mergeBranch(candidate.branch) : { merged: true, conflict: false };
        if (merge.merged) {
          await this.ledger.promoteCandidate(candidate.id, wi.id, this.actor(newRunId(), "reviewer"));
          incumbent = candidate;
          await this.git?.deleteBranch(candidate.branch).catch(() => {});
          break;
        }
        // Merge conflict: keep the incumbent immutable, treat as unresolved.
        await this.ledger.rejectCandidate(candidate.id, wi.id, `merge conflict with incumbent`, this.actor(newRunId(), "reviewer"));
        await this.git?.deleteBranch(candidate.branch).catch(() => {});
        if (round === maxRounds - 1) break;
        parentId = candidate.id;
        continue;
      }
      // Material findings remain: reject this candidate (it did not pass review)
      // and start a fix round; if rounds are exhausted, fail the work item.
      // Never promote with open material findings.
      await this.git?.deleteBranch(candidate.branch).catch(() => {});
      const rejectReason =
        round === maxRounds - 1
          ? `material findings unresolved after ${maxRounds} rounds`
          : `material findings: ${findings.slice(0, 3).join("; ")}`;
      await this.ledger.rejectCandidate(candidate.id, wi.id, rejectReason, this.actor(newRunId(), "reviewer"));
      feedback = `${diffBlock(candidate.diff)}\nReviewer findings to fix:\n${findings.join("\n")}`;
      if (round === maxRounds - 1) break;
      parentId = candidate.id;
    }

    await this.ledger.updateWorkItem(wi.id, { status: incumbent ? "COMPLETED" : "FAILED" }, this.actor(newRunId(), "planner"));

    return {
      work_item: wi,
      risk,
      incumbent_candidate: incumbent,
      scout_summary: scoutSummary,
      review_summary: reviewSummary,
      challenge_summary: challengeSummary,
      verification: lastVerify,
      evidence_ids: evidenceIds,
      rounds,
      outcome: incumbent ? "promoted" : "failed",
      telemetry: this.telemetry,
    };
  }
}

function candidateSeq(ledger: Ledger, workItemId: string): number {
  return ledger.listCandidates(workItemId).length + 1;
}
