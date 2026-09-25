import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { BlackholeManager, type BlackholeManagerOptions } from "../blackhole/BlackholeManager.ts";
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
import { workflowMutatesRepo } from "../orchestration/intentRouter.ts";
import {
  MISSION_SNAPSHOT_FILENAME,
  type MissionSnapshotFile,
  buildMissionSnapshotFile,
} from "../orchestration/missionSnapshot.ts";
import { MissionStore } from "../orchestration/missionStore.ts";
import { MissionObservability } from "../orchestration/observability/MissionObservability.ts";
import { Orchestrator } from "../orchestration/orchestrator.ts";
import type { PlanTaskInput } from "../orchestration/orchestrator.ts";
import { realBackends } from "../orchestration/realBackends.ts";
import { tasksConflict, topoSort } from "../plan/taskDag.ts";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { resolveGatewayResilienceConfig } from "../resilience/config.ts";
import { HttpRecoveryProbe } from "../resilience/probe.ts";
import { Scheduler } from "../sched/Scheduler.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { buildCoreTools } from "../tools/coreTools.ts";
import { CommandVerifier, type VerificationProvider, type VerifyOutcome } from "../verify/Verifier.ts";
import { PiWorkerExecutor } from "../workers/PiWorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest } from "../workers/WorkerExecutor.ts";

/**
 * Build the mission gateway recovery probe. When the operator sets
 * PI_GATEWAY_HEALTH_URL, a lightweight HTTP readiness probe is used so recovery
 * from an outage is detected without starting a full worker session; otherwise
 * undefined is returned and the scheduler falls back to its pass-through probe
 * (recovery confirmed by the next real attempt).
 */
function buildGatewayRecoveryProbe(): HttpRecoveryProbe | undefined {
  const url = process.env.PI_GATEWAY_HEALTH_URL;
  if (!url) return undefined;
  return new HttpRecoveryProbe({ baseUrl: url, timeoutMs: 5_000 });
}

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
  outcome: "promoted" | "failed" | "blocked" | "stopped";
  /** Aggregate context/autonomy telemetry for the run (spec §41). */
  telemetry: Telemetry;
}

/** Read-only tool allowlist (scout/reviewer/challenger). */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
/** Implementation tool allowlist. */
const IMPLEMENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/**
 * Roles that may hydrate from SHARED durable memory. Independent reviewer and
 * clean-room challenger are deliberately excluded (INV-007): they must not
 * inherit prior candidate memory. Implementer/scout/planner may reuse promoted
 * project knowledge (constraints, decisions, root causes).
 */
const HYDRATION_ROLES: readonly string[] = ["scout", "planner", "implementer"];

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

/** Worker roles that map onto a reportable pipeline phase. */
const PHASE_FOR_ROLE: Partial<Record<WorkerRole, RuntimePhaseEvent["phase"]>> = {
  scout: "scout",
  implementer: "implement",
  reviewer: "review",
};

/**
 * Pipeline progress, for status surfaces (the footer today, the panel later).
 *
 * Emitted best-effort and synchronously: a listener is an observer, never a
 * participant, so a throwing or slow one must not affect an engineering run.
 */
/**
 * Opened orchestration event stores by path, so multiple runtimes over one
 * repo share a single durable store (the JSONL backend is single-instance).
 */
const openedOrchestrationStores = new Map<string, JsonlEventStore>();

export interface RuntimePhaseEvent {
  workItemId: string;
  phase: "scout" | "implement" | "verify" | "review" | "settled";
  /** The work item's goal, for a human-readable label. */
  goal?: string;
  /** Model that produced this phase, known only once a worker has run. */
  model?: string;
  /**
   * Token/cost usage for this phase, when a worker reported it.
   *
   * Per-model spend is not persisted anywhere — WorkerUsage is folded into the
   * runtime's aggregate telemetry and lost per model — so this event is the
   * source the panel accumulates from.
   */
  usage?: { input: number; output: number; cost: number };
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
  /**
   * Autonomous-stop gate (spec §14.5, roadmap spec §13). When the roadmap is
   * complete, `engineer()` refuses to invent new work. Returns true when the
   * roadmap is complete (new autonomous work must stop). Optional: omitted
   * means the gate is open (no autonomous stop).
   */
  roadmapComplete?: () => Promise<boolean>;
  /**
   * Optional Blackhole session-memory integration. When provided, each worker
   * session gets an isolated per-session memory store, background memory
   * workers can run, and promotion emits ledger events. Omitted or disabled
   * leaves the runtime behaving exactly as before (backward compatible).
   * The ledger is supplied by the runtime itself at open time.
   */
  blackhole?: Omit<BlackholeManagerOptions, "ledger">;
  /**
   * Optional progress hook for status surfaces. Best-effort: exceptions from a
   * listener are swallowed so status rendering can never fail a run.
   */
  onPhase?: (event: RuntimePhaseEvent) => void;
  /**
   * Optional concise user-facing mission-progress emitter (Communication Gate —
   * always open). Emitted on meaningful transitions (phase/task/worker/test/
   * review/stall/recovery/gate). Never suppresses ordinary Pi output.
   */
  onMissionObservabilityUpdate?: (missionId: string, message: string) => void;
  /**
   * Optional orchestrator planner (spec 06). Defaults to a single implementer
   * task. Injected so deterministic tests and the extension can supply one.
   */
  orchestrationPlanner?: (
    mission: import("../orchestration/types.ts").Mission,
    risk: import("../orchestration/types.ts").RiskProfile,
  ) => Promise<PlanTaskInput[]>;
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
  workDir: string;
  readonly worker: WorkerExecutor;
  readonly reviewerWorker: WorkerExecutor | null;
  readonly verifier: VerificationProvider;
  readonly telemetry: Telemetry;
  readonly roadmapComplete: (() => Promise<boolean>) | null;
  blackhole: BlackholeManager | null;
  /** Orchestration mission store (spec 00 §3) — durable, restart-recoverable. */
  missionStore: MissionStore | null;
  /** Orchestrator facade (spec 06) — auto-invokes workflows from intent. */
  orchestrator: Orchestrator | null;
  /**
   * Mission observability service (spec 00 §observability): weighted-DAG
   * progress, health/stall/loop detection, structured events, projection. Lives
   * BESIDE the controller; the controller remains authoritative. Additive.
   */
  missionObservability: MissionObservability | null;
  /**
   * Mission-level gateway resilience config (spec §resilience). Time-based
   * retry window (default 90m), 10s recovery probes, circuit breaker, and
   * auto-resume — resolved from environment with injectable defaults. Lives
   * beside the orchestrator; the orchestrator remains authoritative.
   */
  resilience: import("../resilience/config.ts").GatewayResilienceConfig;
  private readonly onPhase: ((event: RuntimePhaseEvent) => void) | null;
  /** Work item whose phases are currently being reported (status surfaces only). */
  private currentWorkItemId = "";
  private currentPhaseGoal = "";

  /**
   * Serializes git mutations that touch the shared main repo (worktree create,
   * promotion merge). Parallel DAG execution (M13) runs independent tasks'
   * worker sessions concurrently but routes every repo-mutating git operation
   * through this lock so concurrent tasks never race the shared index (the
   * index.lock race that previously forced the DAG to be sequential).
   */
  private gitLock: Promise<unknown> = Promise.resolve();

  private withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gitLock.then(fn);
    this.gitLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Publish the versioned mission snapshot file the PI WEB plugin reads
   * (spec 08). Writes `<workDir>/orchestration-snapshot.json` and returns the
   * snapshot. Never throws; callers may fire-and-forget it after any mission
   * mutation.
   */
  async publishMissionSnapshot(): Promise<MissionSnapshotFile | null> {
    if (!this.missionStore) return null;
    try {
      const missions = this.missionStore.listMissions().map((m) => ({
        mission: m,
        tasks: this.missionStore!.listTasks(m.mission_id),
        findings: this.missionStore!.listFindings(m.mission_id),
        observability: this.missionObservability?.projection(m.mission_id) ?? null,
      }));
      const snapshot = buildMissionSnapshotFile(missions);
      await writeFile(join(this.workDir, MISSION_SNAPSHOT_FILENAME), JSON.stringify(snapshot, null, 2), "utf8");
      return snapshot;
    } catch {
      return null;
    }
  }

  /** Notify status surfaces of pipeline progress. Never throws into the run. */
  private emitPhase(event: RuntimePhaseEvent): void {
    if (!this.onPhase) return;
    try {
      this.onPhase(event);
    } catch {
      // A status listener is an observer, never a participant.
    }
  }

  private constructor(opts: EngineeringRuntimeOptions) {
    this.cwd = opts.cwd;
    this.workDir = opts.workDir ?? "";
    this.worker = opts.worker ?? new PiWorkerExecutor({ model: opts.model, agentDir: opts.agentDir });
    this.reviewerWorker = opts.reviewerWorker ?? null;
    this.verifier = opts.verifier ?? new CommandVerifier();
    this.roadmapComplete = opts.roadmapComplete ?? null;
    this.onPhase = opts.onPhase ?? null;
    this.blackhole = null;
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
    this.missionStore = null;
    this.orchestrator = null;
    this.missionObservability = null;
    // Resolve the time-based gateway resilience config from environment.
    this.resilience = resolveGatewayResilienceConfig();
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
    rt.workDir = workDir;
    // Orchestration: durable mission store + orchestrator wired to the existing
    // worker/verifier/git primitives. Restart-recoverable via the JSONL store.
    // Multiple runtimes over the same repo share one orchestration store. The
    // JSONL backend is single-instance per process, so reuse an already-open
    // store for the same path (a second runtime must not open the same file).
    const orchestrationPath = join(workDir, "orchestration.jsonl");
    let orchestrationBackend = openedOrchestrationStores.get(orchestrationPath);
    if (!orchestrationBackend) {
      orchestrationBackend = await JsonlEventStore.open(orchestrationPath);
      openedOrchestrationStores.set(orchestrationPath, orchestrationBackend);
    }
    rt.missionStore = MissionStore.open(orchestrationBackend);
    // Mission observability shares the SAME durable event store as the mission
    // controller: its `mission.obs.*` events are ignored by MissionStore replay
    // and replayed by the observability service, so progress/activity/workers/
    // tests/review survive restart/reconnect (spec 01/05). Communication gate
    // is always open — the update emitter never suppresses ordinary Pi output.
    rt.missionObservability = MissionObservability.open({
      backend: orchestrationBackend,
      store: rt.missionStore,
      onUpdate: opts.onMissionObservabilityUpdate,
    });
    // Route orchestration worker roles through the capability router so per-role
    // model placement (policy.routing.roles, e.g. a pinned implementer/reviewer)
    // is honored by the mission pipeline, matching the lifecycle roleRunner
    // path. Degrades to the worker's construction-time default model when the
    // router cannot be built, so core never requires discovery or network.
    let routeModel:
      | ((role: WorkerRequest["role"]) => Promise<{ provider: string; id: string } | undefined>)
      | undefined;
    try {
      const { createRoleRouter } = await import("../capability/adapter.ts");
      const { isRoleName } = await import("../capability/roles.ts");
      const sharedRuntime = rt.worker instanceof PiWorkerExecutor ? await rt.worker.getModelRuntime() : undefined;
      const routerAdapter = await createRoleRouter({
        cwd: repoRoot,
        agentDir: opts.agentDir,
        modelRuntime: sharedRuntime,
        allowModelNetwork: false,
      });
      routeModel = async (role) => {
        if (!isRoleName(role)) return undefined;
        try {
          return await routerAdapter.route(role);
        } catch {
          return undefined;
        }
      };
    } catch {
      routeModel = undefined;
    }
    const backends = realBackends({
      worker: rt.worker,
      verifier: rt.verifier,
      artifacts: rt.artifacts,
      git: rt.git,
      cwd: repoRoot,
      routeModel,
    });
    // The default plan honours the routed workflow class. A research or
    // investigation mission MUST NOT get a repo-mutating worker: mutation is
    // derived from the workflow, never assumed. (Dogfood caught the planner
    // hardcoding mutates_repo:true, which let a read-only "why is this failing?"
    // request write to the repository.)
    const defaultPlanner: NonNullable<typeof opts.orchestrationPlanner> = async (mission) => {
      const mutates = workflowMutatesRepo(mission.workflow_class);
      return [
        {
          kind: "agent",
          role: mutates ? "implementer" : "investigator",
          objective: mission.goal,
          mutates_repo: mutates,
          write_domains: mutates ? ["**"] : [],
          isolation: mutates ? "worktree" : "none",
          depends_on: [],
          priority: 0,
          execution_requirements: {},
          max_attempts: 3,
          failure_policy: "retry",
        },
      ];
    };
    rt.orchestrator = new Orchestrator({
      store: rt.missionStore,
      backends,
      observability: rt.missionObservability,
      planner: opts.orchestrationPlanner ?? defaultPlanner,
      parentSessionId: null,
      git: rt.git,
      baseRef: rt.git ? await rt.git.headCommit() : "",
      // Mission-level gateway resilience: a worker transient-infra failure retries
      // within the (env-resolved) time-based window, parking the mission in a
      // WAITING state, and pauses (not fails) on exhaustion. When an operator sets
      // PI_GATEWAY_HEALTH_URL, a real HTTP recovery probe is used so recovery is
      // detected without burning a full worker session; otherwise the scheduler's
      // pass-through probe applies.
      resilience: rt.resilience,
      probe: buildGatewayRecoveryProbe(),
      onPhase: (mission, phase) => {
        const mapped: RuntimePhaseEvent["phase"] =
          phase === "complete" ? "settled" : phase === "classified" ? "scout" : "implement";
        rt.emitPhase({ workItemId: mission.mission_id, goal: mission.goal, phase: mapped });
        // Keep the PI WEB mission snapshot fresh as missions progress.
        void rt.publishMissionSnapshot();
      },
    });
    if (opts.blackhole) rt.blackhole = await BlackholeManager.open({ ...opts.blackhole, ledger: rt.ledger });
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
      /**
       * Blackhole session scope. Tournament candidates share a work item but
       * MUST have isolated working memory, so the memory identity keys on this
       * (the candidate id) rather than the work item id. Defaults to the work
       * item id (fine for non-tournament work).
       */
      sessionScope?: string;
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
      runId,
      workItemId: opts.wi.id,
    };
    // Open an isolated per-session memory store for this worker when Blackhole
    // is enabled. The store is keyed by a STABLE session identity (project /
    // work item / role / worker), so memory persists across fix rounds of the
    // same candidate while concurrent candidates (distinct work item/worker),
    // reviewers, and challengers (distinct role) never share working memory.
    // Disabled ⇒ no store and no recall (backward compatible).
    const sessionScope = opts.sessionScope ?? opts.wi.id;
    const sessionStore = this.blackhole?.enabled
      ? this.blackhole.openSessionFor({
          project: this.cwd,
          workItem: opts.wi.id,
          role,
          workerId: sessionScope,
          runId: sessionScope,
          sessionId: sessionScope,
        })
      : null;
    // Realize in-session recall: prior memory from earlier runs of this same
    // (work item, role, worker) is recalled and appended to the worker context,
    // so repeated work is more context-efficient instead of recomputing from
    // scratch. Strict isolation still holds because each candidate/reviewer/
    // challenger has a disjoint session identity.
    let effectiveContext = opts.context;
    if (sessionStore) {
      const recalled = sessionStore.recall(20);
      if (recalled.length > 0) {
        const memoryBlock = `\n\n[blackhole session memory]\n${recalled
          .map((e) => `[${e.priority} ${e.kind}] ${e.text}`)
          .join("\n")}`;
        effectiveContext = (effectiveContext ?? "") + memoryBlock;
        req.context = effectiveContext;
      }
    }
    // Hydrate from SHARED durable memory (OpenViking / shared file): surface
    // evidence-promoted knowledge from OTHER workers/sessions so repeated or
    // parallel engineering work is not recomputed from scratch. This is the
    // cross-worker sharing read path. Provider failure degrades to nothing.
    //
    // INVARIANT: hydration is gated to non-independent roles. The independent
    // reviewer and the clean-room challenger MUST NOT inherit prior candidate
    // memory (INV-007), so they never read shared durable memory — otherwise
    // promoted candidate knowledge (promotedFrom = candidate id) would leak
    // into contexts whose prompts forbid prior reasoning.
    if (this.blackhole?.enabled && HYDRATION_ROLES.includes(role)) {
      const query = `${opts.wi.id} ${role} ${task.slice(0, 120)}`;
      const shared = await this.blackhole.hydrate(query, 10);
      if (shared.length > 0) {
        const block = `\n\n[openviking durable memory]\n${shared
          .map((r) => `[promoted ${r.promotedAt}] ${r.text}`)
          .join("\n")}`;
        effectiveContext = (effectiveContext ?? "") + block;
        req.context = effectiveContext;
      }
    }
    const executor = opts.worker ?? this.worker;
    const run = await executor.run(req);
    // After a completed worker, record the outcome into the session store and
    // schedule a lower-priority background observer (P3) that never preempts
    // engineering work. Fire-and-forget so a memory-worker failure never fails
    // the engineering task.
    if (this.blackhole?.enabled && run.result.status === "completed" && sessionStore) {
      sessionStore.observe(run.result.summary, [runId], "P3");
      void this.blackhole
        .runMemoryWorker("observer", { project: this.cwd, workItem: opts.wi.id, role, workerId: opts.wi.id })
        .catch(() => {});
    }

    // Report the model that actually produced this phase. The executor picks
    // the model (router, fallback ladder), so it is knowable only after the
    // run — status surfaces show the session model until then.
    if (run.usage?.model && this.currentWorkItemId) {
      const phase = PHASE_FOR_ROLE[role];
      if (phase) {
        this.emitPhase({
          workItemId: this.currentWorkItemId,
          phase,
          goal: this.currentPhaseGoal || undefined,
          model: run.usage.model,
          usage: { input: run.usage.input, output: run.usage.output, cost: run.usage.cost },
        });
      }
    }

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

  /**
   * Parallel task-DAG wave computation (M13). Groups the dependency-ordered
   * tasks into waves of tasks that are (a) independent (no dependency edge)
   * and (b) write-scope-disjoint (no shared path), which may run concurrently.
   * Returns waves in dependency order.
   */
  private static computeParallelWaves(tasks: Task[]): Task[][] {
    const order = topoSort(tasks);
    const byId = new Map(order.map((t) => [t.id, t]));
    const waves: Task[][] = [];
    const waveOf = new Map<string, number>();
    for (const t of order) {
      let wave = 0;
      // This task must run after its dependencies' wave and after any
      // write-conflicting task in a later-or-equal wave.
      for (const dep of t.depends_on) {
        wave = Math.max(wave, (waveOf.get(dep) ?? -1) + 1);
      }
      for (let w = 0; w < waves.length; w++) {
        const conflict = waves[w]!.some((other) => tasksConflict(t, other));
        if (conflict) wave = Math.max(wave, w + 1);
      }
      if (wave >= waves.length) waves.length = wave + 1;
      const target = waves[wave] ?? [];
      target.push(t);
      waves[wave] = target;
      waveOf.set(t.id, wave);
    }
    return waves;
  }

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
    // Worktree creation is safe to run concurrently (each leg gets its own branch
    // + worktree); only the promotion merge into the shared main branch must be
    // serialized (see withGitLock around mergeBranch).
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
      // Blackhole isolation: each candidate gets its own memory scope.
      sessionScope: candidate.id,
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
      // Blackhole isolation: a reviewer's memory scope is the candidate under
      // review (distinct from the implementer's, and per-candidate).
      sessionScope: candidate.id,
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
    let candidate: Candidate | null = null;
    let worktreePath: string | null = null;
    let branch: string | null = null;
    try {
      const cw = await this.createCandidateWorktree(wi, null, actor);
      candidate = cw.candidate;
      worktreePath = cw.worktreePath;
      branch = candidate.branch;
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
      this.emitPhase({ workItemId: wi.id, phase: "review", goal });
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
    } catch (err) {
      // PER-LEG ERROR ISOLATION: a throwing leg must never crash the whole
      // tournament, orphan sibling legs, or leak git state (INV-003/004). We
      // record the failure as a rejected candidate + a finding, clean up any
      // created branch/worktree, and return a failed entry so the caller can
      // continue with the surviving legs.
      const msg = err instanceof Error ? err.message : String(err);
      if (!candidate) {
        candidate = await this.ledger.createCandidate(
          wi.id,
          "",
          branch ?? `pi-eng-leg-${newRunId().slice(4).toLowerCase()}`,
          null,
          "implementer",
          newRunId(),
          null,
          actor,
        );
      }
      await this.ledger.rejectCandidate(candidate.id, wi.id, `candidate leg failed: ${msg}`, actor).catch(() => {});
      if (branch && this.git) await this.git.deleteBranch(branch).catch(() => {});
      if (worktreePath && branch && this.git) {
        await this.git.removeWorktree({ path: worktreePath, branch }).catch(() => {});
      }
      await this.ledger
        .recordEntity("finding", `tournament candidate leg failed: ${msg}`, "open", actor, wi.id, {
          severity: "critical",
          candidateId: candidate.id,
        })
        .catch(() => {});
      return {
        entry: {
          candidate,
          outcome: { passed: false, failedStage: "leg-error", stages: [], evidence: [], noTargets: false },
          findings: [],
          reviewCompleted: false,
          winner: false,
        },
        evidenceIds: [],
      };
    }
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

    if (this.roadmapComplete && (await this.roadmapComplete())) {
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

    // Phase C: promote the winner via controlled merge. Serialized against other
    // repo-mutating git operations (parallel DAG / tournaments).
    const merge = this.git
      ? await this.withGitLock(() => this.git!.mergeBranch(winner.candidate.branch))
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
    if (this.roadmapComplete && (await this.roadmapComplete())) {
      const wi = await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner"));
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, this.actor(newRunId(), "planner"));
      return {
        plan_work_item: wi,
        tasks: [],
        summary: "Blocked: roadmap complete — autonomous stop (no new work invented).",
        outcome: "blocked",
        telemetry: this.telemetry,
      };
    }
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
  async executePlan(
    planWorkItemId: string,
    opts: { parallel?: boolean; concurrency?: number } = {},
  ): Promise<DagReport> {
    const actor = this.actor(newRunId(), "planner");
    const wi = this.ledger.getWorkItem(planWorkItemId);
    if (!wi) {
      throw new Error(`Unknown plan work item ${planWorkItemId}; run /plan first.`);
    }
    if (this.roadmapComplete && (await this.roadmapComplete())) {
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, actor);
      return {
        plan_work_item: wi,
        tasks: [],
        order: [],
        outcome: "blocked",
        summary: "Blocked: roadmap complete — autonomous stop (no new work invented).",
        telemetry: this.telemetry,
      };
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

    // Parallel execution (M13): run independent, write-scope-disjoint tasks
    // concurrently via the Scheduler. The git lock serializes repo mutations
    // so concurrent tasks never race the shared index. When `parallel` is
    // false, execution stays sequential (single-model-safe default).
    const runTask = async (t: Task): Promise<void> => {
      seen.add(t.id);
      // Idempotent re-execution: never re-run a task that already finished.
      if (t.status === "completed") {
        completed.push(t.id);
        summaries.push(`${t.id} already completed (skipped)`);
        return;
      }
      if (t.status === "failed" || t.status === "blocked") {
        failedSet.add(t.id);
        (t.status === "failed" ? failed : blocked).push(t.id);
        summaries.push(`${t.id} previously ${t.status} (skipped)`);
        return;
      }
      // A dependency failed (or was blocked): this task cannot run.
      if (t.depends_on.some((d) => failedSet.has(d))) {
        await this.ledger.setTaskStatus(t.id, "blocked", wi.id, actor);
        failedSet.add(t.id);
        blocked.push(t.id);
        summaries.push(`${t.id} blocked (dependency failed)`);
        return;
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
    };

    if (opts.parallel) {
      // Waves of independent, non-conflicting tasks run concurrently; waves are
      // sequential in dependency order. Bounded by the scheduler's concurrency.
      const waves = EngineeringRuntime.computeParallelWaves(tasks);
      const scheduler = new Scheduler({ concurrency: opts.concurrency ?? 2 });
      for (const wave of waves) {
        const outcomes = await scheduler.scheduleAll(
          wave.map((t) => ({ id: t.id, source: wi.id, run: () => runTask(t) })),
        );
        void outcomes;
      }
    } else {
      for (const t of order) {
        await runTask(t);
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
      emitTelemetry({ level: "warning", text: note });
      return `# Task context (0 tokens, budget ${targetTokens})
(context assembly failed; worker must rely on tools)
`;
    }
  }

  async engineer(goal: string): Promise<EngineerReport> {
    // The status surfaces must never be left showing a task that is over, so
    // "settled" is emitted from a finally — a thrown run clears the footer too.
    let workItemId = "";
    try {
      return await this.engineerInner(goal, (id, phaseGoal) => {
        workItemId = id;
        this.currentPhaseGoal = phaseGoal;
      });
    } finally {
      if (workItemId) this.emitPhase({ workItemId, phase: "settled", goal });
      this.currentWorkItemId = "";
      this.currentPhaseGoal = "";
    }
  }

  private async engineerInner(goal: string, onWorkItem: (id: string, goal: string) => void): Promise<EngineerReport> {
    // Autonomous stop: when the roadmap is complete, do NOT invent new work.
    // Completion is derived (roadmap check), never declared (roadmap spec §13).
    if (this.roadmapComplete && (await this.roadmapComplete())) {
      const wi = await this.ledger.createWorkItem(goal, "medium", [this.cwd], this.actor(newRunId(), "planner"));
      await this.ledger.updateWorkItem(wi.id, { status: "BLOCKED" }, this.actor(newRunId(), "planner"));
      return {
        work_item: wi,
        risk: "medium",
        incumbent_candidate: null,
        scout_summary: "Skipped: roadmap complete — autonomous stop (no new work invented).",
        review_summary: null,
        challenge_summary: null,
        verification: null,
        evidence_ids: [],
        rounds: 0,
        outcome: "stopped",
        telemetry: this.telemetry,
      };
    }
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
    this.currentWorkItemId = wi.id;
    onWorkItem(wi.id, goal);

    // Assemble bounded task context.
    let contextText = await this.safeContext(goal, ROLE_BUDGETS.implementer.targetTokens, []);

    // Scout (medium+).
    let scoutSummary: string | null = null;
    if (risk !== "low") {
      this.emitPhase({ workItemId: wi.id, phase: "scout", goal });
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
      this.emitPhase({ workItemId: wi.id, phase: "implement", goal });
      const impl = await this.implementIn(wi, candidate, worktreePath, implTask, contextText);

      this.emitPhase({ workItemId: wi.id, phase: "verify", goal });
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
        // verified candidate into the incumbent branch, then record it. The merge
        // is serialized through the git lock so parallel DAG legs cannot race it.
        const merge = this.git
          ? await this.withGitLock(() => this.git!.mergeBranch(candidate.branch))
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
