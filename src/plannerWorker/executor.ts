/**
 * The planner/worker execution mode (spec §2–§8, §17–§21).
 *
 *   plan (planner role) → contract DAG
 *   per ready contract, in parallel (existing Scheduler concurrency limit,
 *   one isolated git worktree each):
 *     [high risk: pre-implementation review]
 *     implement (implementer) → verification commands → review (reviewer)
 *       pass      → merge into the mission's integration worktree
 *       needs_fix → bounded correction contract → fixer → …
 *       stalled / exhausted → debugger diagnosis → retry → escalation model
 *       BLOCKED + evidence or replan → planner revises the remaining DAG
 *   low-risk contracts are reviewed in one batch
 *   final review of the integrated change → fast-forward the checkout
 *
 * Every role runs as a fresh worker session through the runtime's existing
 * WorkerExecutor, routed with `modelOverride`; models are resolved per role,
 * never named. All durable state is written to `stateDir/state.json`, so a
 * model disappearing never loses the mission.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WorkerRole } from "../core/types.ts";
import { GitRepo, type WorktreeInfo } from "../git/GitRepo.ts";
import { workerInactivityMs, workerTimeoutMs } from "../orchestration/broker.ts";
import { Scheduler } from "../sched/Scheduler.ts";
import { DEFAULT_STAGE_INACTIVITY_MS, runWithInactivityGuard } from "../verify/Verifier.ts";
import type { WorkerActivity, WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import { WAITING_FOR_INFERENCE_SUMMARY } from "../workers/activity.ts";
import { planTransition } from "./compatibility.ts";
import { dagLayers, scopeConflict } from "./contract.ts";
import { ConvergenceTracker, nextLadderAction, observeAttempt } from "./convergence.ts";
import {
  type AvailabilityError,
  type RouteEventFollower,
  RouteTracker,
  type ServedRoute,
  availabilityFromText,
  decideAvailability,
  parseAvailabilityError,
} from "./gateway.ts";
import { buildHandoff, renderHandoff } from "./handoff.ts";
import { acquireMissionLock } from "./missionLock.ts";
import { runPlanner } from "./planner.ts";
import { DEBUGGER_PROMPT, IMPLEMENTER_PROMPT } from "./prompts.ts";
import type { RoleResolver } from "./resolver.ts";
import {
  blockedEvidence,
  buildCorrectionContract,
  reviewPlanFor,
  runBatchReview,
  runReview,
  scopeViolations,
} from "./review.ts";
import { type ResolvedRole, servedIdentity } from "./roles.ts";
import { assertTransition, isTerminal } from "./stateMachine.ts";
import { RoleModelTelemetry } from "./telemetry.ts";
import { TransitionLog } from "./transitions.ts";
import {
  type ContractState,
  type ContractStatus,
  type ConvergenceConfig,
  DEFAULT_CONVERGENCE,
  DEFAULT_ESCALATION_LADDER,
  type DependencyResult,
  type EscalationLadder,
  type LocalLoopStalledEvent,
  type MissionBrief,
  type PlannerOutput,
  type PlannerWorkerReport,
  type PlannerWorkerRole,
  type ReviewVerdict,
  type TaskContract,
  type VerificationRun,
} from "./types.ts";

const exec = promisify(execFile);
const COMMITTER = ["-c", "user.name=pi-engineering", "-c", "user.email=pi-engineering@localhost"];

const IMPLEMENT_TOOLS = ["read", "grep", "find", "ls", "write", "edit", "bash"];
const WORKER_ROLE: Readonly<Record<PlannerWorkerRole, WorkerRole>> = {
  planner: "planner",
  researcher: "scout",
  implementer: "implementer",
  fixer: "implementer",
  debugger: "debugger",
  reviewer: "reviewer",
  escalation: "implementer",
};

export interface PlannerWorkerEvent {
  type: "phase" | "contract" | "transition" | "stalled" | "replan";
  text: string;
  task_id?: string;
  status?: ContractStatus;
}

export interface PlannerWorkerOptions {
  repoRoot: string;
  worker: WorkerExecutor;
  resolver: RoleResolver;
  stateDir: string;
  ladder?: EscalationLadder;
  convergence?: ConvergenceConfig;
  /** Concurrent contracts (existing scheduler limit). Default 2. */
  concurrency?: number;
  /**
   * Silence window per verification command (default 15 min). Not a duration
   * limit: a command that keeps printing runs as long as it needs.
   */
  verificationInactivityMs?: number;
  /**
   * A worker showing no activity for this long is treated as hung and
   * aborted. Default `workerInactivityMs()` (1 h; PI_ENGINEERING_WORKER_INACTIVITY_MS).
   */
  workerInactivityMs?: number;
  /** Opt-in total-duration limit per worker; none by default (`workerTimeoutMs()`). */
  workerTimeoutMs?: number;
  /** Fast-forward the checkout to the integrated result when it is clean. Default true. */
  applyToCheckout?: boolean;
  transitions?: TransitionLog;
  /** InferWeave route events, polled at every inference boundary (no restart on a swap). */
  routeEvents?: RouteEventFollower;
  onEvent?: (e: PlannerWorkerEvent) => void;
  signal?: AbortSignal;
}

interface Runtime {
  state: ContractState;
  worktree: WorktreeInfo | null;
  baseCommit: string;
  lastHead: string;
  attemptsOnRung: number;
  diagnosis: { diagnosis: string; required_changes: string[] } | null;
  preReviewed: boolean;
  verification: VerificationRun[];
  diff: string;
  pendingBatch: boolean;
  /** Needs another attempt loop launched by the DAG driver (after a batch review). */
  resume: boolean;
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await exec("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

/**
 * Run one verification command in a worktree (real child process, own process
 * group). There is no total-duration limit — missions are bounded by attempts
 * and convergence, not time — only an INACTIVITY guard: a command silent for
 * `inactivityMs` (default 15 min) is killed with everything it spawned, so a
 * dev server or watch mode holding the output open cannot wedge the mission.
 * `signal` (the mission's abort) kills the process group at once.
 */
export async function runVerification(
  command: string,
  cwd: string,
  opts: { inactivityMs?: number; signal?: AbortSignal } = {},
): Promise<VerificationRun> {
  const started = Date.now();
  try {
    const r = await runWithInactivityGuard("sh", ["-c", command], {
      cwd,
      env: verificationEnv(),
      inactivityMs: opts.inactivityMs ?? DEFAULT_STAGE_INACTIVITY_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const exit = r.hung ? 124 : r.code;
    return {
      command,
      exit_code: exit,
      passed: exit === 0,
      output_tail: `${r.stdout}${r.stderr}`.slice(-4000),
      duration_ms: Date.now() - started,
    };
  } catch {
    // Only an abort rejects: the process group is already killed.
    return { command, exit_code: 130, passed: false, output_tail: "[aborted]", duration_ms: Date.now() - started };
  }
}

export class PlannerWorkerExecutor {
  private readonly opts: PlannerWorkerOptions;
  private readonly ladder: EscalationLadder;
  private readonly tracker: ConvergenceTracker;
  readonly transitions: TransitionLog;
  readonly telemetry = new RoleModelTelemetry();
  private readonly routes = new RouteTracker();
  private readonly stalled: LocalLoopStalledEvent[] = [];
  private readonly contracts = new Map<string, Runtime>();
  private readonly results = new Map<string, DependencyResult>();
  private plan: PlannerOutput = { contracts: [], decisions: [], architectural_context: [] };
  private brief!: MissionBrief;
  private repo!: GitRepo;
  private integration!: WorktreeInfo;
  private integrationLock: Promise<unknown> = Promise.resolve();
  private plannerModel: string | null = null;
  private replans = 0;
  private finalFixUsed = false;
  private baseCommit = "";
  private applied = false;
  /** Worktrees of contracts superseded by a replan, removed at cleanup. */
  private readonly retired: WorktreeInfo[] = [];
  private status: PlannerWorkerReport["status"] | "running" = "running";
  private failureReason: string | null = null;
  private started = 0;

  constructor(opts: PlannerWorkerOptions) {
    this.opts = opts;
    this.ladder = opts.ladder ?? DEFAULT_ESCALATION_LADDER;
    this.tracker = new ConvergenceTracker(opts.convergence ?? DEFAULT_CONVERGENCE);
    this.transitions = opts.transitions ?? new TransitionLog({ path: join(opts.stateDir, "transitions.jsonl") });
  }

  private emit(e: PlannerWorkerEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // observers never break execution
    }
  }

  async run(brief: MissionBrief): Promise<PlannerWorkerReport> {
    this.brief = brief;
    this.started = Date.now();
    // One live owner per mission: a concurrent resume would delete our worktrees.
    const lock = await acquireMissionLock(this.opts.stateDir);
    try {
      const repo = await GitRepo.open(this.opts.repoRoot);
      if (!repo) throw new Error(`${this.opts.repoRoot} is not a git repository`);
      this.repo = repo;
      await this.opts.resolver.refresh();
      const base = await repo.headCommit();
      this.baseCommit = base;
      this.integration = await repo.createWorktree(base, `pi-eng-pw-${slug(brief.mission_id)}`);
      try {
        if (!(await this.planMission())) return await this.finish("failed");
        return await this.proceed();
      } finally {
        await this.cleanup();
      }
    } finally {
      await lock.release();
    }
  }

  /** Execute the DAG, review the whole, apply. Shared by `run` and `resume`. */
  private async proceed(): Promise<PlannerWorkerReport> {
    await this.executeDag();
    if (this.status === "running") await this.finalReview();
    if (this.status === "running") {
      await this.apply(this.baseCommit);
      return await this.finish("completed");
    }
    return await this.finish(this.status);
  }

  /**
   * Resume an interrupted mission from `stateDir/state.json`, contract by
   * contract: contracts whose merge is in the integration branch stay passed
   * (never re-run); everything else restarts from pending on the integration
   * head. Works after a clean abort and after a crash that left worktrees.
   */
  async resume(): Promise<PlannerWorkerReport> {
    // Refuse while another live process runs this mission: resuming rebuilds
    // the integration worktree and discards unfinished contracts' worktrees.
    const lock = await acquireMissionLock(this.opts.stateDir);
    try {
      return await this.resumeLocked();
    } finally {
      await lock.release();
    }
  }

  private async resumeLocked(): Promise<PlannerWorkerReport> {
    const saved = JSON.parse(await readFile(join(this.opts.stateDir, "state.json"), "utf8")) as ResumableState;
    if (!saved.brief || !saved.integration_branch || !saved.base_commit) {
      throw new Error(`${this.opts.stateDir} has no resumable planner-worker state`);
    }
    if (saved.status === "completed") throw new Error(`mission ${saved.mission_id} already completed`);
    this.brief = saved.brief;
    this.started = Date.now();
    const repo = await GitRepo.open(this.opts.repoRoot);
    if (!repo) throw new Error(`${this.opts.repoRoot} is not a git repository`);
    this.repo = repo;
    await this.opts.resolver.refresh();
    this.baseCommit = saved.base_commit;
    this.integration = await this.reattachIntegration(saved.integration_branch, saved.integration_path);
    try {
      this.plan = saved.plan;
      this.replans = saved.replans ?? 0;
      this.finalFixUsed = saved.contracts.some((c) => c.contract.task_id === "final-fix");
      this.telemetry.seed(saved.metrics ?? []);
      this.transitions.seed(saved.transitions ?? []);
      const integrated = (await git(this.integration.path, ["log", "--format=%s"])).stdout;
      let kept = 0;
      for (const prior of saved.contracts) {
        const id = prior.contract.task_id;
        const merged = prior.changed_files.length === 0 || integrated.includes(`pw: integrate ${id}\n`);
        if (prior.status === "passed" && merged) {
          if (prior.worktree) await this.dropWorktree({ path: prior.worktree, branch: this.branchFor(id) });
          this.addContract(prior.contract);
          const rt = this.contracts.get(id)!;
          rt.state = { ...prior, worktree: null };
          this.results.set(id, { task_id: id, summary: prior.summary, changed_files: prior.changed_files });
          kept++;
          continue;
        }
        // Interrupted, failed or never integrated: discard its worktree and start over.
        if (prior.worktree) await this.dropWorktree({ path: prior.worktree, branch: this.branchFor(id) });
        else await git(this.opts.repoRoot, ["branch", "-D", this.branchFor(id)]);
        this.addContract(prior.contract);
        const rt = this.contracts.get(id)!;
        rt.state.history = [
          ...prior.history,
          { at: new Date().toISOString(), from: prior.status, to: "pending", note: "resumed after interruption" },
        ];
      }
      this.emit({
        type: "phase",
        text: `resumed: ${kept} passed contract(s) kept, ${this.contracts.size - kept} to run`,
      });
      await this.persist();
      return await this.proceed();
    } finally {
      await this.cleanup();
    }
  }

  /** Re-open the mission's integration branch in a worktree (reusing a live one). */
  private async reattachIntegration(branch: string, path: string | undefined): Promise<WorktreeInfo> {
    if ((await git(this.opts.repoRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code !== 0) {
      throw new Error(`integration branch ${branch} is gone; the mission cannot be resumed`);
    }
    const target = path ?? join(dirname(this.repo.root), `pi-eng-resume-${branch}`);
    const live = (await git(target, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() === branch;
    if (live) {
      // A crash may have left a half-finished merge: drop it, keep the commits.
      await git(target, ["merge", "--abort"]);
      await git(target, ["reset", "-q", "--hard", "HEAD"]);
      return { path: target, branch };
    }
    await git(this.opts.repoRoot, ["worktree", "remove", "--force", target]);
    if (basename(target).startsWith("pi-eng-")) await rm(target, { recursive: true, force: true });
    // -f: a crashed worktree whose directory vanished may still register the branch.
    const add = await git(this.opts.repoRoot, ["worktree", "add", "-f", target, branch]);
    if (add.code !== 0) throw new Error(`cannot reattach ${branch}: ${add.stderr.trim()}`);
    return { path: target, branch };
  }

  // ---------------------------------------------------------------- planning

  private async planMission(): Promise<boolean> {
    this.emit({ type: "phase", text: "planning" });
    const planner = await this.opts.resolver.resolve("planner");
    this.plannerModel = planner ? servedIdentity(planner) : null;
    this.recordTransition("planner", "planner", planner, "planning", "plan");
    const result = await runPlanner({
      worker: this.roleWorker("planner", planner, "plan"),
      brief: this.brief,
      cwd: this.integration.path,
    });
    await writeFile(join(this.opts.stateDir, "planner-transcript.md"), result.transcript);
    if (!result.ok) {
      this.failureReason = `planner produced no valid contract DAG: ${result.errors.join("; ")}`;
      return false;
    }
    this.plan = result.plan;
    for (const c of result.plan.contracts) this.addContract(c);
    await this.persist();
    return true;
  }

  private addContract(c: TaskContract): void {
    this.contracts.set(c.task_id, {
      state: {
        contract: c,
        status: "pending",
        attempt: 0,
        rung: "local",
        last_model: null,
        correction: null,
        changed_files: [],
        summary: "",
        worktree: null,
        history: [],
      },
      worktree: null,
      baseCommit: "",
      lastHead: "",
      attemptsOnRung: 0,
      diagnosis: null,
      preReviewed: false,
      verification: [],
      diff: "",
      pendingBatch: false,
      resume: false,
    });
  }

  private setStatus(rt: Runtime, to: ContractStatus, note: string): void {
    const from = rt.state.status;
    if (from === to) return;
    assertTransition(from, to);
    rt.state.status = to;
    rt.state.history.push({ at: new Date().toISOString(), from, to, note });
    this.emit({ type: "contract", task_id: rt.state.contract.task_id, status: to, text: note });
    void this.persist();
  }

  // ------------------------------------------------------------- DAG driver

  private async executeDag(): Promise<void> {
    const scheduler = new Scheduler({ concurrency: Math.max(1, this.opts.concurrency ?? 2) });
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (this.opts.signal?.aborted) {
        // Never tear worktrees down under running workers.
        await Promise.allSettled(running.values());
        this.status = "failed";
        this.failureReason = "aborted";
        break;
      }
      this.promoteReady();
      // Launch ready contracts whose write scope does not overlap a running one.
      for (const rt of this.contracts.values()) {
        const id = rt.state.contract.task_id;
        const launchable = rt.state.status === "ready" || (rt.resume && rt.state.status === "running");
        if (!launchable || running.has(id)) continue;
        const clash = [...running.keys()].some((other) =>
          scopeConflict(rt.state.contract, this.contracts.get(other)!.state.contract),
        );
        if (clash) continue;
        const p = scheduler
          .schedule({
            id,
            source: "planner-worker",
            run: () => {
              const resume = rt.resume;
              rt.resume = false;
              return resume ? this.executeContractLoop(rt) : this.executeContract(rt);
            },
          })
          .then(
            () => undefined,
            (err: unknown) => {
              rt.state.blocked_reason = `executor error: ${err instanceof Error ? err.message : String(err)}`;
              if (!isTerminal(rt.state.status)) this.forceFail(rt, rt.state.blocked_reason);
            },
          )
          .finally(() => running.delete(id));
        running.set(id, p);
      }
      if (running.size > 0) {
        await Promise.race(running.values());
        continue;
      }
      // Nothing running: batch-review low-risk work, then replan blocked work.
      const batch = [...this.contracts.values()].filter((rt) => rt.pendingBatch);
      if (batch.length > 0) {
        await this.batchReview(batch);
        continue;
      }
      const blocked = [...this.contracts.values()].filter(
        (rt) => rt.state.status === "blocked" && rt.state.blocked_reason?.startsWith("evidence:"),
      );
      if (blocked.length > 0) {
        if (!(await this.replan(blocked[0]!))) break;
        continue;
      }
      break;
    }
    const states = [...this.contracts.values()].map((rt) => rt.state);
    if (this.status !== "running") return;
    if (states.every((s) => s.status === "passed")) return;
    const failed = states.filter((s) => s.status !== "passed");
    // "stalled" only when a stalled contract failed because the ladder ran out.
    const ladderExhausted = (s: ContractState) =>
      s.stalled !== undefined && /exhausted|no escalation model/.test(s.blocked_reason ?? "");
    this.status = failed.some((s) => s.rung === "escalated")
      ? "escalated"
      : failed.some(ladderExhausted)
        ? "stalled"
        : "failed";
    this.failureReason = failed
      .map((s) => `${s.contract.task_id}: ${s.status}${s.blocked_reason ? ` (${s.blocked_reason})` : ""}`)
      .join("; ");
  }

  /** pending → ready when dependencies passed; → blocked when one failed. */
  private promoteReady(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const rt of this.contracts.values()) {
        if (rt.state.status !== "pending") continue;
        const deps = rt.state.contract.depends_on.map(
          (d) => this.contracts.get(d)?.state.status ?? (this.results.has(d) ? "passed" : "failed"),
        );
        if (deps.every((s) => s === "passed")) {
          this.setStatus(rt, "ready", "dependencies passed");
          changed = true;
        } else if (deps.some((s) => s === "failed")) {
          rt.state.blocked_reason = "dependency failed";
          this.setStatus(rt, "blocked", "a dependency failed");
          this.setStatus(rt, "failed", "dependency failed");
          changed = true;
        }
      }
    }
  }

  private forceFail(rt: Runtime, reason: string): void {
    rt.state.blocked_reason = reason;
    if (rt.state.status === "passed" || rt.state.status === "failed") return;
    this.setStatus(rt, "failed", reason);
  }

  // -------------------------------------------------------- one contract

  private async executeContract(rt: Runtime): Promise<void> {
    const c = rt.state.contract;
    this.setStatus(rt, "running", "started");
    if (reviewPlanFor(c.risk).preReview && !rt.preReviewed) {
      rt.preReviewed = true;
      const verdict = await this.preReview(rt);
      if (verdict && (verdict.status === "replan" || verdict.status === "needs_fix")) {
        rt.state.blocked_reason = `evidence: pre-implementation review: ${verdict.issues.map((i) => i.summary).join("; ") || verdict.required_changes.join("; ")}`;
        this.setStatus(rt, "blocked", "pre-implementation review requires a revised contract");
        return;
      }
      if (verdict?.status === "escalate") {
        // Beyond the local implementer: start on the escalation rung.
        rt.state.rung = "escalated";
        this.setStatus(rt, "escalated", "pre-implementation review asked for escalation");
        this.setStatus(rt, "running", "escalated implementation");
      }
    }
    if (!rt.worktree) {
      const head = (await git(this.integration.path, ["rev-parse", "HEAD"])).stdout.trim();
      rt.worktree = await this.repo.createWorktree(head, this.branchFor(c.task_id));
      rt.baseCommit = head;
      rt.lastHead = head;
      rt.state.worktree = rt.worktree.path;
    }
    for (;;) {
      const outcome = await this.attempt(rt);
      if (outcome === "done") return;
    }
  }

  /** One implementation attempt; returns "done" when the contract left the running loop. */
  private async attempt(rt: Runtime): Promise<"again" | "done"> {
    const c = rt.state.contract;
    // An aborted mission starts no further work: the DAG driver waits for us.
    if (this.opts.signal?.aborted) {
      this.forceFail(rt, "aborted");
      return "done";
    }
    rt.state.attempt += 1;
    rt.attemptsOnRung += 1;
    const role: PlannerWorkerRole =
      rt.state.rung === "escalated" ? "escalation" : rt.state.correction ? "fixer" : "implementer";
    const avoid = this.avoidFor(role, rt);
    const deps = c.depends_on.map((d) => this.results.get(d)).filter((d): d is DependencyResult => d !== undefined);
    const handoff = buildHandoff({
      kind: role === "escalation" ? "to_escalation" : rt.state.correction ? "reviewer_to_fixer" : "planner_to_worker",
      brief: this.brief,
      plan: this.plan,
      contract: c,
      from: rt.state.correction ? "reviewer" : "planner",
      to: role,
      dependencies: deps,
      correction: rt.state.correction,
    });
    const resolved = await this.resolveCompatible(role, avoid, handoff.token_estimate);
    if (resolved === "reject") {
      this.forceFail(rt, `no model can take the ${role} handoff for ${c.task_id}`);
      return "done";
    }
    this.recordTransition(c.task_id, role, resolved, role, c.task_id);
    const run = await this.roleWorker(role, resolved, c.task_id).run({
      role: WORKER_ROLE[role],
      task: renderHandoff(handoff),
      tools: IMPLEMENT_TOOLS,
      cwd: rt.worktree!.path,
      isolatedWorktree: true,
      systemPromptOverride: IMPLEMENTER_PROMPT,
    });
    rt.state.last_model = modelName(resolved);
    rt.state.summary = run.result.summary.slice(0, 1500);

    if (run.result.status === "blocked") {
      const evidence = blockedEvidence(run);
      if (evidence) {
        rt.state.blocked_reason = `evidence: ${evidence}`;
        this.setStatus(rt, "blocked", "worker reported BLOCKED with evidence");
        return "done";
      }
    }
    // Snapshot the attempt as a commit in the contract worktree.
    const changed = await this.commitAttempt(rt);
    const outOfScope = scopeViolations(changed, c.scope);
    rt.verification = [];
    if (run.result.status !== "failed") {
      for (const cmd of rt.state.correction?.verification ?? c.verification) {
        if (this.opts.signal?.aborted) break;
        rt.verification.push(
          await runVerification(cmd, rt.worktree!.path, {
            ...(this.opts.verificationInactivityMs !== undefined
              ? { inactivityMs: this.opts.verificationInactivityMs }
              : {}),
            ...(this.opts.signal ? { signal: this.opts.signal } : {}),
          }),
        );
      }
    }
    const failedVerification = rt.verification.filter((v) => !v.passed);
    let verdict: ReviewVerdict | null = null;
    if (run.result.status === "failed" || run.result.status === "blocked") {
      verdict = {
        status: "needs_fix",
        issues: [
          {
            severity: "blocking",
            summary: `worker ${run.result.status}: ${(run.result.error ?? run.result.summary).slice(0, 300)}`,
          },
        ],
        required_changes:
          run.result.status === "blocked" ? ["implement the contract, or report BLOCKED with concrete evidence"] : [],
        contract_violation: false,
      };
    } else if (failedVerification.length === 0 && outOfScope.length === 0) {
      this.setStatus(rt, "reviewing", "verification passed");
      if (reviewPlanFor(c.risk).review === "batch") {
        rt.pendingBatch = true;
        return "done";
      }
      verdict = await this.review(rt);
      if (verdict.status === "pass") {
        return this.accept(rt, role);
      }
      this.telemetry.count(role, rt.state.last_model ?? "default", "review_failed");
      if (verdict.status === "replan") {
        rt.state.blocked_reason = `evidence: reviewer requested replan: ${verdict.issues.map((i) => i.summary).join("; ")}`;
        this.setStatus(rt, "blocked", "reviewer requested a replan");
        return "done";
      }
    }
    return this.afterFailure(rt, role, verdict, failedVerification, outOfScope);
  }

  /** Models a role must not share with roles it is separated from (spec §8). */
  private avoidFor(role: PlannerWorkerRole, rt?: Runtime): string[] {
    if (role === "implementer" || role === "fixer") return this.plannerModel ? [this.plannerModel] : [];
    if (role === "reviewer" || role === "escalation") return rt?.state.last_model ? [rt.state.last_model] : [];
    return [];
  }

  private async afterFailure(
    rt: Runtime,
    role: PlannerWorkerRole,
    verdict: ReviewVerdict | null,
    failedVerification: VerificationRun[],
    outOfScope: string[],
  ): Promise<"again" | "done"> {
    const c = rt.state.contract;
    const model = rt.state.last_model ?? "default";
    this.telemetry.count(role, model, "rejected");
    this.tracker.record(
      c.task_id,
      observeAttempt({
        attempt: rt.state.attempt,
        contract: c,
        verification: rt.verification,
        verdict,
        diff: rt.diff,
        changedFiles: rt.state.changed_files,
      }),
    );
    const stalled = this.tracker.stalled(c.task_id);
    if (stalled && !rt.state.stalled) {
      rt.state.stalled = stalled;
      this.stalled.push(stalled);
      this.emit({ type: "stalled", task_id: c.task_id, text: `LOCAL_LOOP_STALLED: ${stalled.reasons.join(", ")}` });
    }
    // Escalation is only useful on a model other than the one that just failed.
    const escalation = await this.opts.resolver.resolve("escalation", this.avoidFor("escalation", rt));
    const escalationAvailable = escalation !== null && servedIdentity(escalation) !== rt.state.last_model;
    const action = nextLadderAction({
      rung: rt.state.rung,
      attemptsOnRung: rt.attemptsOnRung,
      stalled: stalled !== null && rt.state.rung !== "escalated",
      reviewerAskedEscalation: verdict?.status === "escalate",
      ladder: this.ladder,
      escalationAvailable,
    });
    if (action.kind === "fail") {
      if (rt.state.status === "reviewing") this.setStatus(rt, "needs_fix", "review failed");
      this.forceFail(rt, action.reason);
      return "done";
    }
    if (rt.state.status !== "needs_fix") {
      this.setStatus(
        rt,
        rt.state.status === "running" || rt.state.status === "reviewing" ? "needs_fix" : rt.state.status,
        "correction needed",
      );
    }
    if (action.kind === "diagnose") {
      rt.diagnosis = await this.diagnose(rt, verdict, failedVerification);
      rt.state.rung = "diagnosed";
      rt.attemptsOnRung = 0;
    } else if (action.kind === "escalate") {
      rt.state.rung = "escalated";
      rt.attemptsOnRung = 0;
      this.telemetry.count(role, model, "escalated");
      this.setStatus(rt, "escalated", "local ladder exhausted; escalating");
    }
    rt.state.correction = buildCorrectionContract({
      contract: c,
      attempt: rt.state.attempt + 1,
      verdict,
      failedVerification,
      outOfScope,
      diagnosis: rt.diagnosis,
    });
    this.telemetry.count(role, model, "retry");
    this.setStatus(rt, "running", `attempt ${rt.state.attempt + 1} (${rt.state.rung})`);
    return "again";
  }

  /** Integrate a reviewed contract; "again" when a merge conflict needs another attempt. */
  private async accept(rt: Runtime, role: PlannerWorkerRole): Promise<"again" | "done"> {
    const c = rt.state.contract;
    const merged = await this.integrate(rt);
    if (!merged.ok) {
      // Conflicting with integrated work: start over from the integration head.
      await this.resetWorktree(rt);
      return this.afterFailure(
        rt,
        role,
        {
          status: "needs_fix",
          issues: [{ severity: "blocking", summary: `merge conflict with integrated work: ${merged.reason}` }],
          required_changes: ["re-implement the contract on top of the integrated changes"],
          contract_violation: false,
        },
        [],
        [],
      );
    }
    this.telemetry.count(role, rt.state.last_model ?? "default", "accepted");
    this.results.set(c.task_id, {
      task_id: c.task_id,
      summary: rt.state.summary,
      changed_files: rt.state.changed_files,
    });
    this.setStatus(rt, "passed", "review passed; integrated");
    return "done";
  }

  private async executeContractLoop(rt: Runtime): Promise<void> {
    for (;;) if ((await this.attempt(rt)) === "done") return;
  }

  // ------------------------------------------------------------- roles

  /** Resolve a role and check the handoff fits (spec §17). */
  private async resolveCompatible(
    role: PlannerWorkerRole,
    avoid: string[],
    handoffTokens: number,
  ): Promise<ResolvedRole | null | "reject"> {
    const resolved = await this.opts.resolver.resolve(role, avoid);
    if (!resolved) return null; // executor default model (single-model hosts)
    const plan = planTransition(
      this.opts.resolver.profileOf(resolved),
      { contextTokens: handoffTokens, handoffTokens, preferHandoff: true, needsTools: role !== "reviewer" },
      this.opts.resolver.alternatives(role, resolved.model.id, avoid),
    );
    if (plan.outcome === "reject") return "reject";
    if (plan.outcome === "other_model") {
      return {
        ...resolved,
        model: { provider: resolved.model.provider, id: plan.model.id },
        via: "capability",
        notes: [...resolved.notes, ...plan.notes],
      };
    }
    return resolved;
  }

  private recordTransition(
    lane: string,
    role: PlannerWorkerRole,
    resolved: ResolvedRole | null,
    reason: string,
    task: string,
  ): void {
    const to = modelName(resolved);
    const event = this.transitions.record({ lane, to, reason, task, role, context: "handoff" });
    if (event)
      this.emit({
        type: "transition",
        task_id: task,
        text: `MODEL_TRANSITION ${event.from ?? "-"} -> ${event.to} (${reason})`,
      });
  }

  /**
   * Invoke a role with failure-aware switching (spec §16): availability errors
   * wait, retry or switch model — bounded, never forever.
   */
  /** A WorkerExecutor bound to a role; `avoid` keeps failover replacements separated too. */
  private roleWorker(
    role: PlannerWorkerRole,
    resolved: ResolvedRole | null,
    task: string,
    avoid?: string[],
  ): WorkerExecutor {
    return {
      run: (req) => this.invoke(role, resolved, req, task, avoid ?? this.avoidFor(role, this.contracts.get(task))),
    };
  }

  private async invoke(
    role: PlannerWorkerRole,
    initial: ResolvedRole | null,
    req: WorkerRequest,
    task: string,
    avoid: string[],
  ): Promise<WorkerRun> {
    let resolved = initial;
    let strikes = 0;
    for (let guard = 0; guard < 8; guard++) {
      await this.syncRoutes(task, role);
      const t0 = Date.now();
      const run = await this.watched({ ...req, ...(resolved ? { modelOverride: resolved.model } : {}) });
      this.telemetry.invocation(role, modelName(resolved), run, Date.now() - t0);
      this.observeRoute(run, role, task);
      if (this.opts.signal?.aborted) return run;
      const availability = run.result.status === "failed" ? availabilityOf(run) : null;
      if (!availability || !resolved) return run;
      const decision = decideAvailability(availability.code, strikes, availability.retryAfterMs);
      strikes += 1;
      this.telemetry.count(role, modelName(resolved), "retry");
      if (decision.action === "wait") {
        await sleep(decision.ms, this.opts.signal);
        continue;
      }
      if (decision.action === "retry_same") continue;
      this.opts.resolver.exclude(servedIdentity(resolved));
      this.opts.resolver.exclude(resolved.model.id);
      this.opts.resolver.mergeCandidates(availability.candidates);
      const next = await this.opts.resolver.resolve(role, avoid);
      if (!next) return run;
      this.recordTransition(task, role, next, `failover:${availability.code}`, task);
      resolved = next;
      strikes = 0;
    }
    throw new Error(`${role} for ${task}: model availability did not settle`);
  }

  /**
   * Run one worker under its own liveness watchdog, whether or not the mission
   * has an abort signal: the worker is aborted (`InactivityError`) only after
   * `workerInactivityMs` with no activity at all. Any activity re-arms it, and
   * while THIS worker reports it is waiting for inference capacity the window
   * stays open however long the wait lasts — another worker's queue never
   * hides this one hanging. The worker always gets an owner signal, so the
   * executor's standalone fallback guard never applies, and waits for
   * gateway capacity without a retry cap. A total-duration limit exists only
   * when the operator opts in (`workerTimeoutMs`).
   */
  private async watched(req: WorkerRequest): Promise<WorkerRun> {
    const ctl = new AbortController();
    const mission = this.opts.signal;
    const onMissionAbort = (): void => ctl.abort(mission?.reason);
    if (mission?.aborted) onMissionAbort();
    else mission?.addEventListener("abort", onMissionAbort, { once: true });
    const windowMs = this.opts.workerInactivityMs ?? workerInactivityMs();
    let lastActivity = Date.now();
    let waitingForInference = false;
    const onActivity = (event: WorkerActivity): void => {
      if (event.kind !== "heartbeat") {
        lastActivity = Date.now();
        waitingForInference = event.summary === WAITING_FOR_INFERENCE_SUMMARY;
      }
      req.onActivity?.(event);
    };
    const watchdog = setInterval(
      () => {
        if (ctl.signal.aborted) return;
        const now = Date.now();
        if (waitingForInference) lastActivity = now;
        else if (now - lastActivity >= windowMs) {
          ctl.abort(new DOMException(`worker showed no activity for ${windowMs}ms (hung worker)`, "InactivityError"));
        }
      },
      Math.max(5, Math.min(30_000, Math.floor(windowMs / 4))),
    );
    const limit = this.opts.workerTimeoutMs ?? workerTimeoutMs();
    const deadline =
      limit === undefined
        ? undefined
        : setTimeout(
            () => ctl.abort(new DOMException(`worker exceeded its configured ${limit}ms limit`, "TimeoutError")),
            limit,
          );
    try {
      return await this.opts.worker.run({ ...req, signal: ctl.signal, onActivity, unboundedInferenceWait: true });
    } finally {
      clearInterval(watchdog);
      if (deadline) clearTimeout(deadline);
      mission?.removeEventListener("abort", onMissionAbort);
    }
  }

  /**
   * Apply InferWeave route events before the next request is resolved: a
   * re-bind or fallback becomes a MODEL_TRANSITION, drained/unloaded models
   * leave resolution, ready ones return, and the catalogue is re-read.
   */
  private async syncRoutes(task: string, role: PlannerWorkerRole): Promise<void> {
    if (!this.opts.routeEvents) return;
    const { events, dropped } = await this.opts.routeEvents.poll();
    let refresh = dropped > 0;
    for (const e of events) {
      if (
        (e.kind === "MODEL_ROUTE_CHANGED" || e.kind === "MODEL_FALLBACK" || e.kind === "MODEL_ROUTE_RESOLVED") &&
        e.route &&
        e.model
      ) {
        refresh = true;
        const lane = `route:${e.route}`;
        const event = this.transitions.record({
          lane,
          from: e.previousModel ?? this.transitions.last(lane),
          to: e.model,
          reason: e.kind,
          task,
          role,
          context: "direct",
        });
        if (event) {
          this.emit({
            type: "transition",
            task_id: task,
            text: `MODEL_TRANSITION ${event.from ?? "-"} -> ${event.to} (${e.kind} ${e.route})`,
          });
        }
      } else if (
        (e.kind === "MODEL_DRAINING" && e.reason !== "retire_refused_still_routed") ||
        e.kind === "MODEL_UNLOADED"
      ) {
        if (e.model) this.opts.resolver.exclude(e.model);
        refresh = true;
      } else if (e.kind === "MODEL_READY" && e.model) {
        this.opts.resolver.include(e.model);
        refresh = true;
      }
    }
    if (refresh) await this.opts.resolver.refresh();
  }

  private observeRoute(run: WorkerRun, role: PlannerWorkerRole, task: string): void {
    const served = (run.result.details as { served?: ServedRoute } | undefined)?.served;
    if (!served) return;
    const change = this.routes.observe(served);
    // Already logged from the route event stream.
    if (!change || this.transitions.last(`route:${change.alias}`) === change.to) return;
    const event = this.transitions.record({
      lane: `route:${change.alias}`,
      from: change.from,
      to: change.to,
      reason: "route_changed",
      task,
      role,
      context: "direct",
    });
    if (event)
      this.emit({
        type: "transition",
        task_id: task,
        text: `MODEL_TRANSITION ${change.from} -> ${change.to} (route ${change.alias} changed)`,
      });
  }

  // ------------------------------------------------------------- review

  private async review(rt: Runtime): Promise<ReviewVerdict> {
    const c = rt.state.contract;
    const reviewer = await this.opts.resolver.resolve("reviewer", this.avoidFor("reviewer", rt));
    this.recordTransition(c.task_id, "reviewer", reviewer, "review", c.task_id);
    const r = await runReview({
      worker: this.roleWorker("reviewer", reviewer, c.task_id),
      handoff: this.reviewHandoff(rt),
      cwd: rt.worktree!.path,
    });
    return r.verdict;
  }

  private reviewHandoff(rt: Runtime) {
    return buildHandoff({
      kind: "worker_to_reviewer",
      brief: this.brief,
      plan: this.plan,
      contract: rt.state.contract,
      from: "implementer",
      to: "reviewer",
      workerOutcome: {
        summary: rt.state.summary,
        changed_files: rt.state.changed_files,
        diff: rt.diff,
        verification: rt.verification,
      },
    });
  }

  private async preReview(rt: Runtime): Promise<ReviewVerdict | null> {
    const c = rt.state.contract;
    const reviewer = await this.opts.resolver.resolve("reviewer", []);
    this.recordTransition(c.task_id, "reviewer", reviewer, "pre-review", c.task_id);
    const r = await runReview({
      worker: this.roleWorker("reviewer", reviewer, c.task_id),
      handoff: buildHandoff({
        kind: "planner_to_worker",
        brief: this.brief,
        plan: this.plan,
        contract: c,
        from: "planner",
        to: "reviewer",
      }),
      cwd: this.integration.path,
      mode: "pre",
    });
    return r.valid ? r.verdict : null;
  }

  private async batchReview(batch: Runtime[]): Promise<void> {
    for (const rt of batch) rt.pendingBatch = false;
    const implementers = [...new Set(batch.map((rt) => rt.state.last_model).filter((m): m is string => m !== null))];
    const ids = batch.map((rt) => rt.state.contract.task_id);
    let verdicts: Map<string, ReviewVerdict>;
    // The reviewer reads a worktree holding the integrated work plus every batch candidate.
    let reviewTree: WorktreeInfo | null = null;
    try {
      const head = (await git(this.integration.path, ["rev-parse", "HEAD"])).stdout.trim();
      reviewTree = await this.repo.createWorktree(head, this.branchFor(`batch-review-${ids.join("-")}`));
      for (const rt of batch) {
        const merged = await git(reviewTree.path, [
          ...COMMITTER,
          "merge",
          "--no-ff",
          "-q",
          "-m",
          `review ${rt.state.contract.task_id}`,
          rt.worktree!.branch,
        ]);
        if (merged.code !== 0) await git(reviewTree.path, ["merge", "--abort"]);
      }
      const reviewer = await this.opts.resolver.resolve("reviewer", implementers);
      this.recordTransition("batch-review", "reviewer", reviewer, "batch review", ids.join(","));
      ({ verdicts } = await runBatchReview({
        worker: this.roleWorker("reviewer", reviewer, "batch-review", implementers),
        handoffs: batch.map((rt) => this.reviewHandoff(rt)),
        cwd: reviewTree.path,
      }));
    } catch (err) {
      for (const rt of batch)
        this.forceFail(rt, `batch review failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      if (reviewTree) await this.dropWorktree(reviewTree);
    }
    for (const rt of batch) {
      try {
        const verdict = verdicts.get(rt.state.contract.task_id)!;
        const role: PlannerWorkerRole = rt.state.correction ? "fixer" : "implementer";
        let outcome: "again" | "done";
        if (verdict.status === "pass") {
          outcome = await this.accept(rt, role);
        } else if (verdict.status === "replan") {
          rt.state.blocked_reason = `evidence: reviewer requested replan: ${verdict.issues.map((i) => i.summary).join("; ")}`;
          this.setStatus(rt, "blocked", "reviewer requested a replan");
          outcome = "done";
        } else {
          this.telemetry.count(role, rt.state.last_model ?? "default", "review_failed");
          outcome = await this.afterFailure(rt, role, verdict, [], []);
        }
        // Corrections run in parallel through the DAG driver.
        if (outcome === "again") rt.resume = true;
      } catch (err) {
        this.forceFail(rt, `executor error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async diagnose(
    rt: Runtime,
    verdict: ReviewVerdict | null,
    failed: VerificationRun[],
  ): Promise<{ diagnosis: string; required_changes: string[] } | null> {
    const c = rt.state.contract;
    const debuggerModel = await this.opts.resolver.resolve("debugger", []);
    this.recordTransition(c.task_id, "debugger", debuggerModel, "diagnosis", c.task_id);
    const evidence = {
      contract: c,
      attempts: rt.state.attempt,
      stalled: rt.state.stalled?.reasons ?? [],
      last_review: verdict,
      failed_verification: failed.map((v) => ({
        command: v.command,
        exit_code: v.exit_code,
        output_tail: v.output_tail.slice(-1500),
      })),
      diff: rt.diff.slice(0, 12_000),
    };
    const run = await this.roleWorker("debugger", debuggerModel, c.task_id).run({
      role: "debugger",
      task: JSON.stringify(evidence, null, 2),
      tools: ["read", "grep", "find", "ls"],
      cwd: rt.worktree!.path,
      systemPromptOverride: DEBUGGER_PROMPT,
    });
    const s = (run.structured ?? run.result.details) as { diagnosis?: unknown; required_changes?: unknown } | undefined;
    if (s && typeof s.diagnosis === "string") {
      const changes = Array.isArray(s.required_changes)
        ? s.required_changes.filter((x): x is string => typeof x === "string")
        : [];
      return { diagnosis: s.diagnosis, required_changes: changes.slice(0, 6) };
    }
    return run.result.summary ? { diagnosis: run.result.summary.slice(0, 1000), required_changes: [] } : null;
  }

  // ------------------------------------------------------------- replanning

  private async replan(rt: Runtime): Promise<boolean> {
    if (this.replans >= this.ladder.max_replans) {
      this.forceFail(rt, `replan budget exhausted (${this.ladder.max_replans}); ${rt.state.blocked_reason ?? ""}`);
      return true;
    }
    this.replans += 1;
    this.emit({
      type: "replan",
      task_id: rt.state.contract.task_id,
      text: `replanning after BLOCKED: ${rt.state.blocked_reason}`,
    });
    const passed = [...this.contracts.values()]
      .filter((x) => x.state.status === "passed")
      .map((x) => x.state.contract.task_id);
    const remaining = [...this.contracts.values()].filter((x) => x.state.status !== "passed");
    const planner = await this.opts.resolver.resolve("planner");
    this.recordTransition("planner", "planner", planner, "replanning", rt.state.contract.task_id);
    const result = await runPlanner({
      worker: this.roleWorker("planner", planner, "replan"),
      brief: this.brief,
      cwd: this.integration.path,
      replan: {
        passed,
        remaining: remaining.map((x) => x.state.contract),
        blocked: {
          task_id: rt.state.contract.task_id,
          evidence: (rt.state.blocked_reason ?? "").replace(/^evidence: /, ""),
        },
      },
    });
    if (!result.ok) {
      this.forceFail(rt, `replanning failed: ${result.errors.join("; ")}`);
      return true;
    }
    for (const old of remaining) {
      if (old.worktree) this.retired.push(old.worktree);
      this.contracts.delete(old.state.contract.task_id);
    }
    this.plan = {
      contracts: [
        ...passed.map((id) => this.plan.contracts.find((c) => c.task_id === id)!).filter(Boolean),
        ...result.plan.contracts,
      ],
      decisions: [...this.plan.decisions, ...result.plan.decisions],
      architectural_context: [...this.plan.architectural_context, ...result.plan.architectural_context],
    };
    for (const c of result.plan.contracts) this.addContract(c);
    await this.persist();
    return true;
  }

  // ------------------------------------------------------------- git

  private async commitAttempt(rt: Runtime): Promise<string[]> {
    const path = rt.worktree!.path;
    await git(path, ["add", "-A"]);
    const dirty = (await git(path, ["status", "--porcelain"])).stdout.trim() !== "";
    if (dirty) {
      // Repository hooks must not silently drop an attempt: a lost commit would
      // integrate nothing while verification passed on the working tree.
      const r = await git(path, [
        ...COMMITTER,
        "commit",
        "-q",
        "--no-verify",
        "-m",
        `pw: ${rt.state.contract.task_id} attempt ${rt.state.attempt}`,
      ]);
      if (r.code !== 0 || (await git(path, ["status", "--porcelain"])).stdout.trim() !== "") {
        throw new Error(`could not commit attempt ${rt.state.attempt}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      }
    }
    const head = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
    rt.diff = (await git(path, ["diff", rt.baseCommit, head, "--", ".", ":!package-lock.json"])).stdout;
    rt.lastHead = head;
    const names = (await git(path, ["diff", "--name-only", rt.baseCommit, head])).stdout;
    rt.state.changed_files = names.split("\n").filter(Boolean);
    return rt.state.changed_files;
  }

  private integrate(rt: Runtime): Promise<{ ok: boolean; reason: string }> {
    const run = async () => {
      if (rt.state.changed_files.length === 0) return { ok: true, reason: "" };
      const r = await git(this.integration.path, [
        ...COMMITTER,
        "merge",
        "--no-ff",
        "-q",
        "-m",
        `pw: integrate ${rt.state.contract.task_id}`,
        rt.worktree!.branch,
      ]);
      if (r.code === 0) return { ok: true, reason: "" };
      await git(this.integration.path, ["merge", "--abort"]);
      return { ok: false, reason: (r.stderr || r.stdout).split("\n")[0] ?? "merge failed" };
    };
    const p = this.integrationLock.then(run, run);
    this.integrationLock = p.catch(() => undefined);
    return p;
  }

  private async resetWorktree(rt: Runtime): Promise<void> {
    const head = (await git(this.integration.path, ["rev-parse", "HEAD"])).stdout.trim();
    await git(rt.worktree!.path, ["reset", "-q", "--hard", head]);
    rt.baseCommit = head;
    rt.lastHead = head;
  }

  // ------------------------------------------------------------- final

  private async finalReview(): Promise<void> {
    this.emit({ type: "phase", text: "final review" });
    const all = [...this.contracts.values()];
    const diff = all.map((rt) => rt.diff).join("\n");
    const implementers = [...new Set(all.map((rt) => rt.state.last_model).filter((m): m is string => m !== null))];
    const reviewer = await this.opts.resolver.resolve("reviewer", implementers);
    this.recordTransition("final", "reviewer", reviewer, "final review", "final");
    const finalContract: TaskContract = {
      task_id: "final-review",
      objective: this.brief.summary,
      depends_on: [],
      scope: { allowed: [...new Set(all.flatMap((rt) => rt.state.contract.scope.allowed))], forbidden: [] },
      acceptance:
        this.brief.acceptance_criteria.length > 0
          ? this.brief.acceptance_criteria
          : all.flatMap((rt) => rt.state.contract.acceptance),
      verification: [],
      constraints: this.brief.constraints,
      risk: "medium",
      relevant_files: all.flatMap((rt) => rt.state.changed_files),
      decisions: [],
    };
    const r = await runReview({
      worker: this.roleWorker("reviewer", reviewer, "final", implementers),
      handoff: buildHandoff({
        kind: "worker_to_reviewer",
        brief: this.brief,
        plan: this.plan,
        contract: finalContract,
        from: "implementer",
        to: "reviewer",
        dependencies: [...this.results.values()],
        workerOutcome: {
          summary: [...this.results.values()].map((d) => `${d.task_id}: ${d.summary}`).join("\n"),
          changed_files: finalContract.relevant_files,
          diff,
          verification: all.flatMap((rt) => rt.verification),
        },
      }),
      cwd: this.integration.path,
    });
    if (r.verdict.status === "pass") return;
    if (this.finalFixUsed || r.verdict.status === "escalate" || r.verdict.status === "replan") {
      this.status = "failed";
      this.failureReason = `final review: ${r.verdict.status}: ${r.verdict.issues.map((i) => i.summary).join("; ")}`;
      return;
    }
    // One bounded integration fix contract on top of everything, then re-review.
    this.finalFixUsed = true;
    const fix: TaskContract = {
      ...finalContract,
      task_id: "final-fix",
      objective: `Resolve the final review findings: ${r.verdict.required_changes.join("; ") || r.verdict.issues.map((i) => i.summary).join("; ")}`,
      depends_on: all.map((rt) => rt.state.contract.task_id),
      verification: [...new Set(all.flatMap((rt) => rt.state.contract.verification))],
    };
    this.plan = { ...this.plan, contracts: [...this.plan.contracts, fix] };
    this.addContract(fix);
    await this.executeDag();
    if (this.status === "running") await this.finalReview();
  }

  private async apply(base: string): Promise<void> {
    if (this.opts.applyToCheckout === false) return;
    const head = (await git(this.opts.repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const clean =
      (await git(this.opts.repoRoot, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim() === "";
    if (head !== base || !clean) {
      this.emit({ type: "phase", text: `checkout moved or dirty; result left on branch ${this.integration.branch}` });
      return;
    }
    const r = await git(this.opts.repoRoot, ["merge", "--ff-only", "-q", this.integration.branch]);
    this.applied = r.code === 0;
    this.emit({
      type: "phase",
      text: r.code === 0 ? "applied to checkout" : `fast-forward failed; result on ${this.integration.branch}`,
    });
  }

  private branchFor(id: string): string {
    return `pi-eng-pw-${slug(this.brief.mission_id)}-${slug(id)}`;
  }

  private async dropWorktree(info: WorktreeInfo, keepBranch = false): Promise<void> {
    await git(this.opts.repoRoot, ["worktree", "remove", "--force", info.path]);
    if (!keepBranch) await git(this.opts.repoRoot, ["branch", "-D", info.branch]);
  }

  private async cleanup(): Promise<void> {
    for (const rt of this.contracts.values()) if (rt.worktree) await this.dropWorktree(rt.worktree);
    for (const info of this.retired) await this.dropWorktree(info);
    // The integration branch is the result when it was not applied to the checkout.
    if (this.integration) await this.dropWorktree(this.integration, !this.applied);
    await this.transitions.flush();
  }

  private async finish(status: PlannerWorkerReport["status"]): Promise<PlannerWorkerReport> {
    this.status = status;
    const report = this.report();
    await this.persist();
    return report;
  }

  report(): PlannerWorkerReport {
    return {
      mission_id: this.brief.mission_id,
      mode: "planner-worker",
      status: this.status === "running" ? "failed" : this.status,
      contracts: [...this.contracts.values()].map((rt) => structuredClone(rt.state)),
      transitions: this.transitions.list(),
      stalled_events: [...this.stalled],
      metrics: this.telemetry.list(),
      replans: this.replans,
      wall_time_ms: Date.now() - this.started,
      failure_reason: this.failureReason,
    };
  }

  private persistQueue: Promise<void> = Promise.resolve();

  private persist(): Promise<void> {
    const snapshot = () => ({
      ...this.report(),
      status: this.status,
      brief: this.brief,
      base_commit: this.baseCommit,
      integration_branch: this.integration?.branch ?? null,
      integration_path: this.integration?.path ?? null,
      plan: this.plan,
      updated_at: new Date().toISOString(),
    });
    this.persistQueue = this.persistQueue
      .then(() => writeFile(join(this.opts.stateDir, "state.json"), `${JSON.stringify(snapshot(), null, 2)}\n`))
      .catch(() => undefined);
    return this.persistQueue;
  }
}

/**
 * Environment for verification commands. They come from planner output, so
 * credentials are withheld; a parent node test runner's context must not leak
 * into the repository's own test command either.
 */
function verificationEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** What `resume` reads back from state.json. */
interface ResumableState {
  mission_id: string;
  status: string;
  brief?: MissionBrief;
  base_commit?: string;
  integration_branch?: string;
  integration_path?: string;
  plan: PlannerOutput;
  contracts: ContractState[];
  transitions?: PlannerWorkerReport["transitions"];
  metrics?: PlannerWorkerReport["metrics"];
  replans?: number;
}

function slug(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]+/g, "-");
  // Truncation must never make two ids share a branch: keep a hash of the full id.
  return clean.length <= 40
    ? clean
    : `${clean.slice(0, 31)}-${createHash("sha256").update(s).digest("hex").slice(0, 8)}`;
}

function modelName(r: ResolvedRole | null): string {
  return r ? servedIdentity(r) : "default";
}

function availabilityOf(run: WorkerRun): AvailabilityError | null {
  const d = run.result.details as {
    gateway_status?: number;
    gateway_error?: { body?: unknown; headers?: Record<string, string> };
  };
  if (typeof d?.gateway_status === "number") {
    return parseAvailabilityError(d.gateway_status, d.gateway_error?.body, d.gateway_error?.headers ?? {});
  }
  const code = availabilityFromText(run.result.error ?? run.error ?? run.result.summary);
  return code ? { code, status: 0, message: run.result.error ?? "", candidates: [] } : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Contracts per DAG layer — exposed for `/engineering-plan`. */
export function planLayers(plan: PlannerOutput): string[][] {
  return dagLayers(plan.contracts).map((l) => l.map((c) => c.task_id));
}
