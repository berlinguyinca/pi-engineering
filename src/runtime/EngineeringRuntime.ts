import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { ContextBroker } from "../context/ContextBroker.ts";
import { newRunId } from "../core/ids.ts";
import type {
  Actor,
  Candidate,
  RiskLevel,
  Task,
  TaskKind,
  Telemetry,
  WorkItem,
  WorkItemStatus,
  WorkerRole,
} from "../core/types.ts";
import { ROLE_BUDGETS, isMachineEvidence } from "../core/types.ts";
import { GitRepo } from "../git/GitRepo.ts";
import { Ledger } from "../ledger/Ledger.ts";
import { tasksConflict, topoSort } from "../plan/taskDag.ts";
import { buildCoreTools } from "../tools/coreTools.ts";
import { CommandVerifier, type VerificationProvider, type VerifyOutcome } from "../verify/Verifier.ts";
import { PiWorkerExecutor } from "../workers/PiWorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";

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

/** A planner's machine-readable task spec (spec §19.2). */
interface PlannerTaskSpec {
  title: string;
  kind: TaskKind;
  risk: RiskLevel;
  depends_on: number[];
  scope_paths: string[];
}

function isPlannerTaskSpec(v: unknown): v is PlannerTaskSpec {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    typeof o.kind === "string" &&
    (o.kind === "implementation" || o.kind === "investigation" || o.kind === "test" || o.kind === "review") &&
    (o.risk === "low" || o.risk === "medium" || o.risk === "high" || o.risk === "critical") &&
    (o.depends_on === undefined || Array.isArray(o.depends_on)) &&
    (o.scope_paths === undefined || Array.isArray(o.scope_paths))
  );
}

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

/** Deterministic tournament winner-selection strategies. */
export type TournamentStrategy = "findings" | "changes" | "stable";

/** Locale-independent string compare (deterministic across ICU collations). */
function idCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Compare two tournament survivors under the chosen deterministic strategy. */
function selectionCompare(a: TournamentEntry, b: TournamentEntry, strategy: TournamentStrategy): number {
  const fa = a.candidate.changed_files?.length ?? 0;
  const fb = b.candidate.changed_files?.length ?? 0;
  switch (strategy) {
    case "stable":
      return idCompare(a.candidate.id, b.candidate.id);
    case "changes":
      if (fa !== fb) return fa - fb;
      if (a.findings.length !== b.findings.length) return a.findings.length - b.findings.length;
      return idCompare(a.candidate.id, b.candidate.id);
    default:
      // "findings" (default): fewest material findings, then fewest files.
      if (a.findings.length !== b.findings.length) return a.findings.length - b.findings.length;
      if (fa !== fb) return fa - fb;
      return idCompare(a.candidate.id, b.candidate.id);
  }
}

function materialFindings(ledger: Ledger, candidateId: string | null): string[] {
  return ledger
    .listEntities("finding")
    .filter((f) => f.status === "open" && f.candidate_id === candidateId)
    .filter((f) => f.severity === "high" || f.severity === "medium" || f.severity === "critical")
    .map((f) => `${f.id}: ${f.claim}`);
}

/** Compact finding block fed back into the next implementer prompt (bounded). */
function findingsBlock(findings: string[]): string {
  const joined = findings.join("\n");
  return joined.length > 8000 ? `${joined.slice(0, 8000)}\n… [truncated]` : joined;
}

/** One tournament entrant and its independent assessment. */
export interface TournamentEntry {
  candidate: Candidate;
  outcome: VerifyOutcome;
  findings: string[];
  /** True only when an independent review COMPLETED for this candidate. */
  reviewCompleted: boolean;
  winner: boolean;
}

export interface PlanReport {
  plan_work_item: WorkItem;
  tasks: Task[];
  summary: string | null;
  outcome: "planned" | "failed" | "blocked";
  telemetry: Telemetry;
}

export interface DagReport {
  plan_work_item: WorkItem;
  tasks: Task[];
  /** Tasks in dependency (topological) order. */
  order: Task[];
  outcome: "completed" | "partial" | "failed" | "blocked";
  summary: string | null;
  telemetry: Telemetry;
}

export interface TournamentReport {
  work_item: WorkItem;
  risk: RiskLevel;
  n_candidates: number;
  entries: TournamentEntry[];
  incumbent_candidate: Candidate | null;
  evidence_ids: string[];
  outcome: "promoted" | "failed" | "blocked";
  telemetry: Telemetry;
}

export interface EngineeringRuntimeOptions {
  cwd: string;
  worker?: WorkerExecutor;
  /**
   * Optional distinct worker for the independent review + clean-room challenger
   * roles (spec §12.2, §19.3). Defaults to `worker`. Providing a different
   * model/worker here mitigates the single-model anchoring failure mode where
   * an implementer and reviewer share the same bias. This is OPTIONAL: the core
   * must not REQUIRE multiple models (project constraint) and falls back to the
   * single worker when omitted.
   */
  reviewerWorker?: WorkerExecutor;
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
  readonly reviewerWorker: WorkerExecutor | null;
  readonly verifier: VerificationProvider;
  readonly telemetry: Telemetry;

  private constructor(opts: EngineeringRuntimeOptions) {
    this.cwd = opts.cwd;
    this.workDir = opts.workDir ?? "";
    this.worker = opts.worker ?? new PiWorkerExecutor({ model: opts.model, agentDir: opts.agentDir });
    this.reviewerWorker = opts.reviewerWorker ?? null;
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
    const tools = buildCoreTools(() => ({
      ledger: rt.ledger,
      artifacts: rt.artifacts,
      broker: rt.broker,
      currentWorkItemId: () => rt.ledger.listWorkItems().at(-1)?.id ?? null,
      actor: () => ({ type: "system" }),
    }));
    if (rt.worker instanceof PiWorkerExecutor) rt.worker.setCustomTools(tools);
    // A distinct reviewer worker also needs the shared-ledger tools bound.
    if (rt.reviewerWorker instanceof PiWorkerExecutor) rt.reviewerWorker.setCustomTools(tools);
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
      /** Override the worker (e.g. a distinct reviewer worker). Defaults to this.worker. */
      worker?: WorkerExecutor;
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
    const executor = opts.worker ?? this.worker;
    const run = await executor.run(req);

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

  async scout(
    wi: WorkItem,
    goal: string,
    contextText: string,
  ): Promise<{ summary: string; artifactUri: string; relevantFiles: string[] } | null> {
    if (!this.broker) return null;
    const task = `Investigate this repository and recommend the smallest relevant change surface for the goal:
"${goal}"
Report: relevant symbols/files, architecture constraints, testing implications, and any risks.
Also return the concrete files you think the implementer must touch as an array in details.relevant_files (paths relative to the repo root).
Use repo_search, symbol, ledger_read, and artifact_read. Do not edit files.`;
    const { run, artifactUri } = await this.runWorker("scout", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
    });
    const details = run.result.details as { relevant_files?: unknown };
    const relevantFiles = Array.isArray(details?.relevant_files)
      ? details.relevant_files.filter((f): f is string => typeof f === "string").slice(0, 10)
      : [];
    return { summary: run.result.summary, artifactUri, relevantFiles };
  }

  // ------------------------------------------------------------ implement

  private async createCandidateWorktree(
    wi: WorkItem,
    parentId: string | null,
    actor: Actor,
  ): Promise<{ candidate: Candidate; worktreePath: string } | { candidate: Candidate; worktreePath: null }> {
    if (!this.git) {
      // Non-git fallback: implement directly in cwd (no isolation).
      const candidate = await this.ledger.createCandidate(
        wi.id,
        "",
        "working",
        null,
        "implementer",
        "run",
        parentId,
        actor,
      );
      return { candidate, worktreePath: null };
    }
    const baseCommit = await this.git.headCommit();
    // The branch name must be unique even under concurrent candidate creation
    // (parallel tournament legs), so a readable per-workitem sequence is
    // suffixed with a random token rather than relied on for uniqueness.
    const branch = `pi-eng-${candidateSeq(this.ledger, wi.id)}-${newRunId().slice(4).toLowerCase()}`;
    const wt = await this.git.createWorktree(baseCommit, branch);
    const runId = newRunId();
    const candidate = await this.ledger.createCandidate(
      wi.id,
      baseCommit,
      branch,
      wt.path,
      "implementer",
      runId,
      parentId,
      actor,
    );
    return { candidate, worktreePath: wt.path };
  }

  private async implementIn(
    wi: WorkItem,
    candidate: Candidate,
    worktreePath: string | null,
    task: string,
    contextText: string,
  ) {
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
        const diffArtifact = await this.artifacts.put(
          "candidate",
          candidate.id,
          diff || "(no captured diff)",
          `${files.length} file(s) changed`,
        );
        await this.ledger.changeCandidate(
          candidate.id,
          { diff: diff || null, diff_artifact_uri: diffArtifact.uri, changed_files: files },
          wi.id,
          this.actor(run.runId, "implementer"),
        );
        return { ...run, diff: diff || null, changedFiles: files, diffArtifactUri: diffArtifact.uri };
      }
    }
    return { ...run, diff: null, changedFiles: [], diffArtifactUri: null };
  }

  async verify(wi: WorkItem, candidate: Candidate, worktreePath: string | null) {
    const runCwd = worktreePath ?? this.cwd;
    // The verification PROFILE comes from the main working tree (the trusted
    // repo owner's config), NOT from the candidate worktree. Otherwise the
    // implementer worker could rewrite package.json in its own worktree (e.g.
    // set "test": "true") and neutralize the very gate that is supposed to
    // certify it (INV-003/005 integrity). Stages still RUN in the candidate
    // worktree so they exercise the candidate's actual code.
    const profile = await this.verifier.detect(this.cwd);
    const outcome = await this.verifier.run(runCwd, profile, this.artifacts);
    const actor = this.actor(newRunId(), "reviewer");
    this.telemetry.verifyStages += outcome.stages.length;
    const evidenceIds: string[] = [];
    for (const ev of outcome.evidence) {
      this.telemetry.evidence++;
      const recorded = await this.ledger.recordEvidence(
        candidate.id,
        ev.type,
        ev.tool,
        ev.command,
        ev.exit_code,
        ev.status,
        ev.summary,
        ev.artifacts,
        ev.trust,
        wi.id,
        actor,
      );
      evidenceIds.push(recorded.id);
    }
    await this.ledger.changeCandidate(
      candidate.id,
      { status: outcome.passed ? "ELIGIBLE" : "VERIFYING" },
      wi.id,
      actor,
    );
    return { outcome, evidenceIds, profile };
  }

  // ----------------------------------------------------------------- review

  async review(
    wi: WorkItem,
    candidate: Candidate,
    requirement: string,
  ): Promise<{ summary: string; findingIds: string[]; completed: boolean }> {
    const diff = candidate.diff ?? "(no captured diff)";
    // The full candidate diff stays OUT of the prompt as a lazily-retrieved
    // artifact (artifact-backed large-output handling). Only a compact inline
    // preview plus the artifact URI enter the reviewer's context, so a large
    // diff no longer consumes the reviewer's hard token budget up front and the
    // reviewer reads the rest on demand via artifact_read (INV-001).
    let diffUri: string;
    try {
      diffUri = await this.ensureDiffArtifact(candidate);
    } catch (err) {
      // A failure to persist the diff artifact must not yield a clean review:
      // treat it as a review that could not complete so the candidate is never
      // promoted on an unreviewed basis (INV-007).
      const msg = err instanceof Error ? err.message : String(err);
      return {
        summary: `Could not persist candidate diff artifact for review: ${msg}`,
        findingIds: [],
        completed: false,
      };
    }
    const preview = diff.length > 2000 ? `${diff.slice(0, 2000)}\n… [truncated; full diff in artifact]` : diff;
    const files = candidate.changed_files?.length ? candidate.changed_files.slice(0, 30).join(", ") : "(unknown)";
    const task = `Independently review candidate ${candidate.id} for the work item:
"${wi.goal}"
Requirement: ${requirement}

Changed files: ${files}
Candidate diff (compact preview):
${preview}

To inspect the COMPLETE candidate diff, call artifact_read with uri "${diffUri}". If the result is truncated, keep calling artifact_read with the reported offset (e.g. offset=<n>) until you have read the full diff. Always read the full diff artifact before judging.

Report concrete findings. Return your findings EXACTLY as details.findings, an array of objects { severity, claim, evidence } where severity is one of info|low|medium|high|critical. If there are NO material issues, set details.findings to an EMPTY array. Do not put findings in the claims field. You are a reviewer; you do not approve the work, you report findings. Use artifact_read to inspect logs if referenced.`;
    const { run, runId } = await this.runWorker("reviewer", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      wi,
      timeoutMs: 240_000,
      worker: this.reviewerWorker ?? undefined,
    });
    // Findings come from the explicit details.findings contract; anything else
    // is recorded as a (non-blocking) hypothesis so a malformed review never
    // both invents blocking findings and silently promotes.
    const completed = run.result.status === "completed";
    const findingIds: string[] = [];
    // Only a COMPLETED review contributes findings. A review that timed out or
    // hit the context budget returns a fallback failed result with empty
    // details; treating that as a clean review would silently promote a
    // candidate that was never independently reviewed (INV-007), so we surface
    // `completed: false` and let the caller gate promotion on it.
    const details = completed
      ? (run.result.details as { findings?: Array<{ severity?: string; claim?: string; evidence?: string }> })
      : {};
    for (const f of details?.findings ?? []) {
      if (!f.claim) continue;
      const entity = await this.ledger.recordEntity("finding", f.claim, "open", this.actor(runId, "reviewer"), wi.id, {
        severity: (f.severity as never) ?? "medium",
        evidence: f.evidence ? [f.evidence] : [],
        candidateId: candidate.id,
      });
      findingIds.push(entity.id);
    }
    for (const c of run.result.claims) {
      await this.ledger.recordEntity("hypothesis", c.claim, "open", this.actor(runId, "reviewer"), wi.id, {
        evidence: isMachineEvidence(c.evidence) ? [c.evidence] : [],
      });
    }
    return { summary: run.result.summary, findingIds, completed };
  }

  /**
   * Ensure the candidate's full diff is stored as a lazily-readable artifact
   * and return its `artifact://` URI. Candidates produced by `implementIn`
   * already carry a `diff_artifact_uri`; this covers candidates reviewed
   * directly (e.g. `/review`) whose artifact may be missing or predate artifact
   * storage. The stored content is VERIFIED against the candidate's current
   * `diff` and re-written if stale, so the reviewer can never judge an artifact
   * that diverges from the preview (a `Ledger.changeCandidate` that updates only
   * `diff` would otherwise leave a stale artifact).
   */
  private async ensureDiffArtifact(candidate: Candidate): Promise<string> {
    const content = candidate.diff ?? "(no captured diff)";
    const uri = candidate.diff_artifact_uri;
    if (uri) {
      const meta = this.artifacts.getByUri(uri);
      const stored = meta ? await this.artifacts.readContentByUri(uri) : undefined;
      if (stored === content) return uri; // fresh
    }
    // Missing, stale, or content-verified-mismatched: (re)write the artifact.
    const meta = await this.artifacts.put("candidate", candidate.id, content, "candidate diff (lazy)");
    return meta.uri;
  }

  /**
   * Run an independent review, retrying with a FRESH reviewer session when the
   * review fails to complete (budget/timeout). Each retry is a brand-new
   * session, so the accumulated context that caused the earlier overflow is
   * discarded. Returns the last result (which may still be `completed: false`
   * if every attempt failed).
   */
  private async reviewWithRetry(
    wi: WorkItem,
    candidate: Candidate,
    requirement: string,
    retries = 2,
  ): Promise<{ summary: string; findingIds: string[]; completed: boolean }> {
    let result = await this.review(wi, candidate, requirement);
    for (let i = 0; i < retries && !result.completed; i++) {
      result = await this.review(wi, candidate, requirement);
    }
    return result;
  }

  // -------------------------------------------------------------- challenge

  async challenge(
    wi: WorkItem,
    goal: string,
    contextText: string,
  ): Promise<{ summary: string; assessment: string } | null> {
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
      worker: this.reviewerWorker ?? undefined,
    });
    const details = run.result.details as { assessment?: string };
    return { summary: run.result.summary, assessment: details?.assessment ?? run.result.summary };
  }

  /**
   * Clean-room challenger pass over the top two tournament finalists: an
   * independent session inspects both candidates' diffs (via artifact_read) and
   * picks the better approach. Returns the chosen winner candidate id, or null
   * if the challenger could not complete.
   */
  private async challengeFinalists(
    wi: WorkItem,
    goal: string,
    a: Candidate,
    b: Candidate,
  ): Promise<{ winnerCandidateId: string; summary: string } | null> {
    if (!this.broker) return null;
    const task = `You are a clean-room challenger. Two candidate implementations competed for the goal:
"${goal}"
Candidate A: ${a.id} (changed ${a.changed_files?.length ?? 0} file(s)).
Candidate B: ${b.id} (changed ${b.changed_files?.length ?? 0} file(s)).

Inspect BOTH candidates' diffs with artifact_read (uri "${a.diff_artifact_uri ?? "(no captured diff)"}" and "${b.diff_artifact_uri ?? "(no captured diff)"}"), then judge which approach is better for correctness, minimality, and maintainability. Do not inherit prior reviewer reasoning.

Return details.winner_candidate_id set to "${a.id}" or "${b.id}" for your pick.`;
    const { run } = await this.runWorker("clean-room-challenger", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      wi,
      timeoutMs: 240_000,
      worker: this.reviewerWorker ?? undefined,
    });
    if (run.result.status !== "completed") return null;
    const details = run.result.details as { winner_candidate_id?: string };
    const pick = details.winner_candidate_id;
    if (pick !== a.id && pick !== b.id) return null;
    return { winnerCandidateId: pick, summary: run.result.summary };
  }

  /**
   * One parallel leg of a candidate tournament: create an isolated worktree,
   * implement, verify, remove the worktree, and (for survivors) run the
   * independent review. Runs entirely within its own candidate scope so it is
   * safe to invoke concurrently via Promise.all (spec §12.1).
   */
  private async runTournamentCandidate(
    wi: WorkItem,
    goal: string,
    index: number,
    n: number,
    risk: RiskLevel,
    contextText: string,
    actor: Actor,
  ): Promise<{ entry: TournamentEntry; evidenceIds: string[] }> {
    const { candidate, worktreePath } = await this.createCandidateWorktree(wi, null, actor);
    const task = `Independently implement the goal in this repository (candidate ${index + 1} of ${n}, take your own approach):\n"${goal}"\nRisk level: ${risk}. Make the smallest coherent change. Use the provided context and repository tools. Run a quick targeted check before finishing.`;
    await this.implementIn(wi, candidate, worktreePath, task, contextText);
    const { outcome, evidenceIds } = await this.verify(wi, candidate, worktreePath);
    if (this.git && worktreePath) {
      await this.git
        .removeWorktree({ path: worktreePath, branch: candidate.branch }, { keepBranch: true })
        .catch(() => {});
    }

    if (!outcome.passed) {
      await this.ledger.rejectCandidate(
        candidate.id,
        wi.id,
        `verification failed: ${outcome.failedStage}`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.git?.deleteBranch(candidate.branch).catch(() => {});
      return {
        entry: { candidate, outcome, findings: [], reviewCompleted: false, winner: false },
        evidenceIds,
      };
    }

    // Independent review of each survivor (INV-007). A candidate whose review
    // failed to complete is recorded as having no completed review and is
    // ineligible to win, so a review infrastructure failure can never hand the
    // tournament to an unreviewed candidate.
    const rev = await this.reviewWithRetry(wi, candidate, goal);
    if (!rev.completed) {
      await this.ledger.recordEntity(
        "finding",
        `Independent review of ${candidate.id} failed to complete (context budget/timeout) after retries; candidate ineligible to win.`,
        "open",
        this.actor(newRunId(), "reviewer"),
        wi.id,
        { severity: "critical", candidateId: candidate.id },
      );
    }
    return {
      entry: {
        candidate,
        outcome,
        findings: materialFindings(this.ledger, candidate.id),
        reviewCompleted: rev.completed,
        winner: false,
      },
      evidenceIds,
    };
  }

  // --------------------------------------------------------------- engineer

  /**
   * Candidate tournament (spec §12): spawn several INDEPENDENT implementations
   * from the same base commit, verify + review each, then deterministically
   * select and promote a winner. Falls back to a single candidate if N is 1.
   * Deterministic and testable with FakeWorkerExecutor.
   */
  async tournament(
    goal: string,
    opts: {
      n?: number;
      strategy?: TournamentStrategy;
      challengeFinalists?: boolean;
      /**
       * Run the independent candidates concurrently (default false). Safe
       * because each candidate owns an isolated worktree and nothing is merged
       * into the main branch until the winner is selected. A single serial
       * worker gains little; a concurrency-capable worker / distinct reviewer
       * worker benefits. Defaults to sequential to keep behavior conservative.
       */
      parallel?: boolean;
    } = {},
  ): Promise<TournamentReport> {
    const n = Math.max(1, Math.min(opts.n ?? 3, 5));
    const strategy = opts.strategy ?? "findings";
    const challengeFinalists = opts.challengeFinalists ?? false;
    const parallel = opts.parallel ?? false;
    const risk = classifyRisk(goal);
    const actor = this.actor(newRunId(), "planner");
    const wi = await this.ledger.createWorkItem(goal, risk, [this.cwd], actor);

    if (!this.broker) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        work_item: wi,
        risk,
        n_candidates: n,
        entries: [],
        incumbent_candidate: null,
        evidence_ids: [],
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    const contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, []);

    // Phase A: independent implementations (no parent lineage). Each candidate
    // runs in its own isolated worktree and merges nothing into the main branch
    // (only the winner is merged later), so candidates may be launched
    // CONCURRENTLY when requested. Ledger writes are serialized by the
    // EventStore so concurrent producers never corrupt the durable state.
    const entries: TournamentEntry[] = [];
    const evidenceIds: string[] = [];
    if (parallel) {
      const phaseAResults = await Promise.all(
        Array.from({ length: n }, (_, i) => this.runTournamentCandidate(wi, goal, i, n, risk, contextText, actor)),
      );
      for (const r of phaseAResults) {
        entries.push(r.entry);
        evidenceIds.push(...r.evidenceIds);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const r = await this.runTournamentCandidate(wi, goal, i, n, risk, contextText, actor);
        entries.push(r.entry);
        evidenceIds.push(...r.evidenceIds);
      }
    }

    // Phase B: deterministic winner selection among verified survivors. Only
    // candidates with a completed independent review are eligible to win.
    const survivors = entries.filter((e) => e.outcome.passed && e.reviewCompleted);
    if (survivors.length === 0) {
      // No eligible winner. Candidates that passed verification but whose review
      // never completed are still recorded as rejected and their branches are
      // cleaned up, so the worktree is never left with dangling ELIGIBLE
      // candidates or stray pi-eng-* branches (INV-003/004).
      for (const e of entries.filter((x) => x.outcome.passed && !x.reviewCompleted)) {
        await this.ledger.rejectCandidate(
          e.candidate.id,
          wi.id,
          `review did not complete`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.git?.deleteBranch(e.candidate.branch).catch(() => {});
      }
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      return {
        work_item: wi,
        risk,
        n_candidates: n,
        entries,
        incumbent_candidate: null,
        evidence_ids: evidenceIds,
        outcome: "failed",
        telemetry: this.telemetry,
      };
    }
    // Score per the selected deterministic winner-selection strategy.
    survivors.sort((a, b) => selectionCompare(a, b, strategy));

    // Optional clean-room challenger pass across the top finalists (spec §12.2,
    // §19.3). The challenger independently inspects the leading finalists' diffs
    // and may promote the runner-up if the leader's approach is judged worse.
    if (challengeFinalists && survivors.length >= 2 && (risk === "high" || risk === "critical")) {
      const lead = survivors[0]!;
      const runner = survivors[1]!;
      const verdict = await this.challengeFinalists(wi, goal, lead.candidate, runner.candidate);
      if (verdict && verdict.winnerCandidateId === runner.candidate.id) {
        survivors[0] = runner;
        survivors[1] = lead;
        await this.ledger.recordEntity(
          "decision",
          `challenger selected ${runner.candidate.id} over ${lead.candidate.id} as tournament winner: ${verdict.summary.slice(0, 200)}`,
          "accepted",
          this.actor(newRunId(), "clean-room-challenger"),
          wi.id,
        );
      }
    }
    // Reject survivors whose review never completed (they lost to the winner or
    // were ineligible), keeping them recorded rather than silently dropped.
    for (const e of entries.filter((x) => !x.winner && x.outcome.passed && !x.reviewCompleted)) {
      await this.ledger.rejectCandidate(
        e.candidate.id,
        wi.id,
        `review did not complete`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.git?.deleteBranch(e.candidate.branch).catch(() => {});
    }
    const winner = survivors[0]!;
    winner.winner = true;

    // Reject the losers (recorded, never silently dropped).
    for (const e of survivors.slice(1)) {
      await this.ledger.rejectCandidate(
        e.candidate.id,
        wi.id,
        `lost tournament to ${winner.candidate.id}`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.git?.deleteBranch(e.candidate.branch).catch(() => {});
    }

    // Phase C: promote the winner via controlled merge.
    const merge = this.git
      ? await this.git.mergeBranch(winner.candidate.branch)
      : { merged: true, conflict: false, reason: null };
    let outcome: TournamentReport["outcome"] = "failed";
    let incumbent: Candidate | null = null;
    if (merge.merged) {
      await this.ledger.promoteCandidate(winner.candidate.id, wi.id, this.actor(newRunId(), "reviewer"));
      incumbent = winner.candidate;
      outcome = "promoted";
      await this.git?.deleteBranch(winner.candidate.branch).catch(() => {});
    } else {
      await this.ledger.rejectCandidate(
        winner.candidate.id,
        wi.id,
        merge.conflict ? `merge conflict with incumbent` : `merge failed: ${merge.reason ?? "unknown"}`,
        this.actor(newRunId(), "reviewer"),
      );
      await this.git?.deleteBranch(winner.candidate.branch).catch(() => {});
    }

    await this.ledger.updateWorkItem(wi.id, { status: incumbent ? "COMPLETED" : "FAILED" }, actor);
    return {
      work_item: wi,
      risk,
      n_candidates: n,
      entries,
      incumbent_candidate: incumbent,
      evidence_ids: evidenceIds,
      outcome,
      telemetry: this.telemetry,
    };
  }

  // ------------------------------------------------------------------- DAG

  /**
   * Decompose a large goal into an ordered, dependency-aware task DAG (spec
   * §11, §19). A planner worker returns machine-readable tasks (title, kind,
   * risk, depends_on indices, write scope); each is recorded in the ledger with
   * its dependency edges resolved to task ids. The DAG is then runnable via
   * executePlan(), which pushes each task through the standard pipeline.
   */
  async plan(goal: string): Promise<PlanReport> {
    if (!this.git || !this.broker) {
      const wi = await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner"));
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, this.actor(newRunId(), "planner"));
      return {
        plan_work_item: wi,
        tasks: [],
        summary: "Blocked: not a git repository.",
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
    const risk = classifyRisk(goal);
    const actor = this.actor(newRunId(), "planner");
    const wi = await this.ledger.createWorkItem(goal, risk, [this.cwd], actor);
    await this.ledger.recordEntity("requirement", goal, "open", actor, wi.id);
    const contextText = await this.safeContext(goal, ROLE_BUDGETS.planner.targetTokens, []);

    const task = `You are a task planner. Decompose the goal below into a dependency-aware task DAG.
Each task is one independently-implementable unit that will later be run through the standard engineer pipeline (scout -> implement -> verify -> independent review) against the current repository, in the order you specify.

Return EXACTLY as details.tasks an array of task objects with these fields:
- "title": string (the concrete, self-contained goal for that task)
- "kind": one of "implementation" | "investigation" | "test" | "review"
- "risk": one of "low" | "medium" | "high" | "critical"
- "depends_on": array of 0-based indices into this tasks array that must complete first (may be empty)
- "scope_paths": array of files/directories the task will likely modify (for conflict detection)

Rules:
- Never put two tasks in parallel that write the same file (they conflict).
- Each task must depend only on EARLIER tasks in the array.
- Prefer a small number of coherent tasks (2-6) over many trivial ones.
- The tasks must together cover the whole goal.

Goal: "${goal}"`;
    const { run } = await this.runWorker("planner", task, {
      cwd: this.cwd,
      tools: READ_ONLY_TOOLS,
      context: contextText,
      wi,
      timeoutMs: 240_000,
    });
    const details = run.result.details as { tasks?: Array<PlannerTaskSpec> };
    const raw = Array.isArray(details?.tasks) ? details.tasks.filter(isPlannerTaskSpec) : [];
    // Never silently drop planner output: record a diagnostic when tasks are
    // truncated (cap of 10) or carry invalid dependency references.
    if (raw.length > 10) {
      await this.ledger.recordEntity(
        "decision",
        `plan: planner produced ${raw.length} tasks; truncated to 10 (spec §11 recommends 2-6). Extra tasks dropped.`,
        "accepted",
        actor,
        wi.id,
      );
    }
    for (let i = 0; i < raw.length; i++) {
      const invalid = (raw[i]!.depends_on ?? []).filter(
        (d) => !Number.isInteger(d) || d < 0 || d >= raw.length || d === i,
      );
      if (invalid.length) {
        await this.ledger.recordEntity(
          "finding",
          `plan task ${i} (${raw[i]!.title}) had invalid depends_on ${JSON.stringify(invalid)}; those edges dropped.`,
          "open",
          actor,
          wi.id,
          { severity: "low" },
        );
      }
    }
    const specs = raw.slice(0, 10);
    if (specs.length === 0) {
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        summary: run.result.summary,
        outcome: "failed",
        telemetry: this.telemetry,
      };
    }

    // Create tasks, then resolve depends_on (indices) to real task ids.
    const created: Task[] = [];
    for (const s of specs) {
      created.push(await this.ledger.createTask(wi.id, s.title, s.kind, s.risk, actor, s.scope_paths ?? [], []));
    }
    for (let i = 0; i < created.length; i++) {
      const s = specs[i]!;
      const deps = (s.depends_on ?? [])
        .filter((d) => Number.isInteger(d) && d >= 0 && d < created.length && d !== i)
        .map((d) => created[d]!.id);
      if (deps.length) await this.ledger.updateTask(created[i]!.id, { depends_on: deps }, wi.id, actor);
    }
    await this.ledger.recordEntity(
      "decision",
      `plan: ${created.length} tasks decomposed for "${goal}" (${run.result.summary.slice(0, 160)})`,
      "accepted",
      actor,
      wi.id,
    );
    return {
      plan_work_item: wi,
      tasks: created,
      summary: run.result.summary,
      outcome: "planned",
      telemetry: this.telemetry,
    };
  }

  /**
   * Execute a planned task DAG (spec §11). Runs each task through the standard
   * engineer pipeline in dependency (topological) order, blocks tasks whose
   * dependencies failed, and links each executed task to its result work item.
   * Execution is sequential (single-model constraint) with write-scope conflict
   * detection recorded so conflicting tasks are never run concurrently.
   */
  async executePlan(planWorkItemId: string): Promise<DagReport> {
    const actor = this.actor(newRunId(), "planner");
    const wi = this.ledger.getWorkItem(planWorkItemId);
    if (!wi) {
      throw new Error(`Unknown plan work item ${planWorkItemId}; run /plan first.`);
    }
    if (!this.git) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        order: [],
        outcome: "blocked",
        summary: "Blocked: not a git repository.",
        telemetry: this.telemetry,
      };
    }
    const tasks = this.ledger.listTasks(wi.id);
    if (tasks.length === 0) {
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        order: [],
        outcome: "failed",
        summary: "No tasks in this plan. Run /plan first.",
        telemetry: this.telemetry,
      };
    }

    let order: Task[];
    try {
      order = topoSort(tasks);
    } catch (err) {
      await this.ledger.updateWorkItem(wi.id, { status: "FAILED" }, actor);
      const msg = err instanceof Error ? err.message : String(err);
      await this.ledger.recordEntity("finding", msg, "open", actor, wi.id, { severity: "critical" });
      return { plan_work_item: wi, tasks, order: [], outcome: "failed", summary: msg, telemetry: this.telemetry };
    }

    // Record write-scope conflicts among tasks that are otherwise parallelizable
    // (informational; execution is sequential under the single-model constraint).
    for (const [i, a] of order.entries()) {
      for (const b of order.slice(i + 1)) {
        if (a.depends_on.includes(b.id) || b.depends_on.includes(a.id)) continue;
        if (tasksConflict(a, b)) {
          await this.ledger.recordEntity(
            "decision",
            `write-scope conflict: ${a.id} and ${b.id} both modify ${a.scope_paths.filter((p) => b.scope_paths.includes(p)).join(", ")}; will not run concurrently`,
            "accepted",
            actor,
            wi.id,
          );
        }
      }
    }

    const completed: string[] = [];
    const failed: string[] = [];
    const blocked: string[] = [];
    const failedSet = new Set<string>();
    const summaries: string[] = [];
    const seen = new Set<string>();
    for (const t of order) {
      seen.add(t.id);
      // Idempotent re-execution: never re-run a task that already finished.
      if (t.status === "completed") {
        completed.push(t.id);
        summaries.push(`${t.id} already completed (skipped)`);
        continue;
      }
      if (t.status === "failed" || t.status === "blocked") {
        failedSet.add(t.id);
        (t.status === "failed" ? failed : blocked).push(t.id);
        summaries.push(`${t.id} previously ${t.status} (skipped)`);
        continue;
      }
      // A dependency failed (or was blocked): this task cannot run. Failures
      // are discovered dynamically during execution, so we propagate per task;
      // the static blockedByFailure helper covers the up-front analysis case.
      if (t.depends_on.some((d) => failedSet.has(d))) {
        await this.ledger.setTaskStatus(t.id, "blocked", wi.id, actor);
        failedSet.add(t.id);
        blocked.push(t.id);
        summaries.push(`${t.id} blocked (dependency failed)`);
        continue;
      }
      await this.ledger.setTaskStatus(t.id, "started", wi.id, actor);
      summaries.push(`running ${t.id}: ${t.title}`);
      const report = await this.engineer(t.title);
      if (report.outcome === "promoted") {
        await this.ledger.setTaskStatus(t.id, "completed", wi.id, actor);
        await this.ledger.updateTask(t.id, { result_work_item_id: report.work_item.id }, wi.id, actor);
        completed.push(t.id);
        summaries.push(`${t.id} completed -> ${report.work_item.id}`);
      } else {
        // The task's own pipeline run failed (not dependency-blocked).
        await this.ledger.setTaskStatus(t.id, "failed", wi.id, actor);
        failedSet.add(t.id);
        failed.push(t.id);
        summaries.push(`${t.id} failed (${report.outcome})`);
      }
    }

    const status: WorkItemStatus =
      completed.length === tasks.length ? "COMPLETED" : completed.length === 0 ? "FAILED" : "PARTIAL";
    await this.ledger.updateWorkItem(wi.id, { status }, actor);
    const outcome: DagReport["outcome"] =
      status === "COMPLETED" ? "completed" : status === "FAILED" ? "failed" : "partial";
    return {
      plan_work_item: wi,
      tasks: this.ledger.listTasks(wi.id),
      order,
      outcome,
      summary: summaries.join("\n"),
      telemetry: this.telemetry,
    };
  }

  /**
   * Assemble + render the context package, degrading to an empty package (and
   * a ledger note) rather than aborting the whole run if the broker fails — a
   * context failure must not silently block otherwise-valid engineering work.
   */
  private async safeContext(goal: string, targetTokens: number, required: string[]): Promise<string> {
    if (!this.broker) return "";
    try {
      const pkg = await this.broker.assembleContext(goal, targetTokens, required);
      return this.broker.renderContext(pkg);
    } catch (err) {
      const note = `context assembly failed: ${String(err)}`;
      await this.ledger.recordEntity("decision", note, "open", this.actor(newRunId(), "planner"), null).catch(() => {});
      console.warn(note);
      return `# Task context (0 tokens, budget ${targetTokens})
(context assembly failed; worker must rely on tools)
`;
    }
  }

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
    let contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, []);

    // Scout (medium+).
    let scoutSummary: string | null = null;
    if (risk !== "low") {
      const scout = await this.scout(wi, goal, contextText);
      scoutSummary = scout?.summary ?? null;
      // The scout identified a concrete change surface: re-assemble the
      // implementer's context with those files as REQUIRED (content slices
      // included), so the implementer starts with the right files instead of
      // re-exploring the repo and burning tool round-trips.
      const scoutFiles = [...new Set(scout?.relevantFiles ?? [])];
      if (scoutFiles.length && this.broker) {
        contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, scoutFiles);
      }
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
      const { candidate, worktreePath } = await this.createCandidateWorktree(
        wi,
        parentId,
        this.actor(newRunId(), "implementer"),
      );

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
        await this.git
          .removeWorktree({ path: worktreePath, branch: candidate.branch }, { keepBranch: true })
          .catch(() => {});
      }

      if (!outcome.passed) {
        await this.ledger.rejectCandidate(
          candidate.id,
          wi.id,
          `verification failed: ${outcome.failedStage}`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.git?.deleteBranch(candidate.branch).catch(() => {});
        // Child candidate on next round, with the failing evidence as feedback.
        feedback = `${diffBlock(candidate.diff)}\nVerification failed at stage '${outcome.failedStage}' (exit ${outcome.stages.find((s) => !s.passed)?.exitCode ?? "?"}). Fix it.`;
        parentId = candidate.id;
        if (round === maxRounds - 1) break;
        continue;
      }

      // Independent review (separation of duties, INV-007). A candidate must
      // receive a COMPLETED independent review before it can be promoted; a
      // review that timed out or hit its budget is retried with a fresh session
      // and, if it still fails, treated as a blocking failure (never a clean
      // review).
      const rev = await this.reviewWithRetry(wi, candidate, goal);
      reviewSummary = rev.summary;
      const reviewCompleted = rev.completed;
      const findings = materialFindings(this.ledger, candidate.id);

      if (reviewCompleted && findings.length === 0) {
        // Controlled, evidence-gated promotion (INV-003, INV-005): merge the
        // verified candidate into the incumbent branch, then record it.
        const merge = this.git
          ? await this.git.mergeBranch(candidate.branch)
          : { merged: true, conflict: false, reason: null };
        if (merge.merged) {
          await this.ledger.promoteCandidate(candidate.id, wi.id, this.actor(newRunId(), "reviewer"));
          incumbent = candidate;
          await this.git?.deleteBranch(candidate.branch).catch(() => {});
          break;
        }
        // Merge conflict: keep the incumbent immutable, treat as unresolved.
        await this.ledger.rejectCandidate(
          candidate.id,
          wi.id,
          merge.conflict ? `merge conflict with incumbent` : `merge failed: ${merge.reason ?? "unknown"}`,
          this.actor(newRunId(), "reviewer"),
        );
        await this.git?.deleteBranch(candidate.branch).catch(() => {});
        if (round === maxRounds - 1) break;
        parentId = candidate.id;
        continue;
      }
      // Never promote with open material findings OR when the independent
      // review could not complete: reject this candidate and start a fix round;
      // if rounds are exhausted, fail the work item.
      await this.git?.deleteBranch(candidate.branch).catch(() => {});
      const reviewBlocked = !reviewCompleted;
      if (reviewBlocked) {
        // Record a blocking finding so the failure is visible in the ledger and
        // materialFindings reflects it for any downstream caller.
        await this.ledger.recordEntity(
          "finding",
          `Independent review of ${candidate.id} failed to complete (context budget/timeout) after retries; candidate not eligible for promotion.`,
          "open",
          this.actor(newRunId(), "reviewer"),
          wi.id,
          { severity: "critical", candidateId: candidate.id },
        );
      }
      const rejectReason = reviewBlocked
        ? round === maxRounds - 1
          ? `independent review could not complete after ${maxRounds} rounds`
          : `independent review did not complete; retrying with a fresh reviewer`
        : round === maxRounds - 1
          ? `material findings unresolved after ${maxRounds} rounds`
          : `material findings: ${findings.slice(0, 3).join("; ")}`;
      await this.ledger.rejectCandidate(candidate.id, wi.id, rejectReason, this.actor(newRunId(), "reviewer"));
      feedback = reviewBlocked
        ? `${diffBlock(candidate.diff)}\nIndependent review could not complete (context budget/timeout). The next candidate must be independently reviewed before promotion.`
        : `${diffBlock(candidate.diff)}\nReviewer findings to fix:\n${findingsBlock(findings)}`;
      if (round === maxRounds - 1) break;
      parentId = candidate.id;
    }

    await this.ledger.updateWorkItem(
      wi.id,
      { status: incumbent ? "COMPLETED" : "FAILED" },
      this.actor(newRunId(), "planner"),
    );

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
