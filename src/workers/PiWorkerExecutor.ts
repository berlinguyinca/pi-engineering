import { connect } from "node:net";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createBashToolDefinition,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_ESCALATION,
  type EscalationEvent,
  shouldEscalate as apsShouldEscalate,
  buildEscalationPrompt,
  selectEscalationModel as selectApsEscalationModel,
} from "../aps/escalation.ts";
import { ApsObservability } from "../aps/observability.ts";
import {
  isRecoverable as apsRecoverable,
  buildRecoveryPrompt as buildApsRecoveryPrompt,
  decideRecovery as decideApsRecovery,
} from "../aps/recovery.ts";
import { DEFAULT_ROLLOUT_PHASE, resolveRollout } from "../aps/rollout.ts";
import { AGENT_LOOP_PREVENTED_EVENT, type AgentProgressSupervisorOptions } from "../aps/supervisor.ts";
import { type AgentLoopPreventedEvent, DEFAULT_LOOP_PREVENTION } from "../aps/types.ts";
import { WorkerActivityAdapter } from "../aps/workerActivity.ts";
import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import type { RoleRouter } from "../capability/router.ts";
import { tunedCompactionTokens } from "../compaction/autoTune.ts";
import { normalizeAgentDir } from "../core/piAgentDir.ts";
import type { WorkerResult, WorkerRole, WorkerUsage } from "../core/types.ts";
import type { AdmissionController } from "../gateway/AdmissionController.ts";
import { type GatewayAdmissionConfig, sharedAdmissionController, sharedGatewayConfig } from "../gateway/config.ts";
import {
  type GatewayRetryDecision,
  type GatewayWaitSignal,
  advisesAlternateModel,
  decideGatewayRetry,
  decideTransientHandover,
  escalateSyntheticWait,
  gatewayFailureMarker,
  gatewayHoldScope,
  isAccountWideRefusal,
  isCapacityExhaustion,
  isTransportDrop,
  parseGatewayWait,
} from "../gateway/signals.ts";
import { MAX_ESCALATED_WAIT_MS } from "../gateway/streamRetry.ts";
import { GenerationGuard, type GuardAbortReason } from "../guard/GenerationGuard.ts";
import { GUARD_STEER_PROMPT, TOOL_TRANSITION_RULE } from "../guard/RecoveryController.ts";
import {
  type RecoveryTelemetry,
  buildCompactedContext,
  buildDegenerationEvent,
  decideRecovery,
  initialRecoveryTelemetry,
  recordAbort,
  recordRetryOutcome,
} from "../guard/RecoveryController.ts";
import { type GenerationGuardConfig, resolveGuardConfig } from "../guard/config.ts";
import { guardFeedFor } from "../guard/streamText.ts";
import {
  type BackoffConfig,
  TransientError,
  type TransientTelemetry,
  backoffDelayMs,
  classifyError,
  initialTransientTelemetry,
  isTruncatedStream,
  recordTransientError,
  recordTransientOutcome,
  resolveTransientRetryConfig,
  withTransientRetry,
} from "../guard/transient.ts";
import { currentInferenceInvocation, runWithInferenceInvocation } from "../inference/inferenceContext.ts";
import { ExecutedActionTracker } from "../inference/recovery.ts";
import { wireResilientModelRuntime } from "../inference/resilientInstall.ts";
import type { ResilientStreamScheduler } from "../inference/resilientStream.ts";
import {
  type AssistantLike,
  dropFailedTail,
  isCutStreamError,
  resolveStreamResumeMax,
} from "../inference/streamResume.ts";
import { reviewResultTool } from "../lifecycle/reviewResultTool.ts";
import { missionDepthSpawnHook } from "../orchestration/missionMode.ts";
import { type RequestBodyBudgetConfig, resolveRequestBodyBudgetConfig } from "../request/bodyBudget.ts";
import { type ThinkingOffConfig, resolveThinkingOffConfig } from "../request/thinkingPolicy.ts";
import { resolveWorktreeIdentity } from "../runtime/isolation/WorktreeIdentity.ts";
import { resolveStateRoot, worktreeRuntimeDir } from "../runtime/isolation/stateDir.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { MODEL_SUPERSEDED } from "./WorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "./WorkerExecutor.ts";
import {
  StreamingActivityThrottle,
  WAITING_FOR_INFERENCE_SUMMARY,
  activityFromSessionEvent,
  emitWorkerActivity,
} from "./activity.ts";
import { BuildCommandTimer } from "./buildActivity.ts";
import { CHECKPOINT_PROGRESS_TOOL_NAME, createCheckpointProgressTool } from "./checkpointProgressTool.ts";
import { CLAIM_DELIVERABLE_TOOL_NAME, createClaimDeliverableTool } from "./claimDeliverableTool.ts";
import {
  type ContextBudget,
  resolveCompactAt,
  resolveContextBudget,
  windowDeclared,
  workerCompactionSettings,
} from "./contextBudget.ts";
import { registerLocalProviders } from "./localProviders.ts";
import { MUTATING_ROLES, WORKER_KICKOFF, buildSystemPrompt, wantsCommitDiscipline } from "./prompts.ts";
import { guardRuntimeRequestBody } from "./requestBodyGuard.ts";
import { StreamStallWatchdog, isStalledStream } from "./streamStall.ts";
import { createNumberedReadTool, createTolerantEditTool } from "./tolerantFileTools.ts";
import { TranscriptWriter, transcriptPath, transcriptsEnabled } from "./transcriptStore.ts";
import {
  DEFAULT_BUDGET_NOTICE_EVERY,
  NUDGE_MESSAGE,
  REVIEW_NUDGE_MESSAGE,
  SILENCE_WRAP_UP_MESSAGE,
  WRAP_UP_FRACTION,
  WRAP_UP_MESSAGE,
  type WorkerClock,
  budgetLine,
  realClock,
  withBudgetNotice,
} from "./wallClockBudget.ts";
import { createWorkerResultTool } from "./workerResultTool.ts";

/**
 * Maximum APS loop-recovery attempts (Phase 4). Bounded to one: after a
 * replan/compact attempt the worker either progresses or is reported
 * loop_prevented — APS never retries a loop indefinitely.
 */
const APS_RECOVERY_MAX_ATTEMPTS = 1;

/** A minimal resource loader that supplies only the role prompt (context firewall). */
function roleResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export interface PiWorkerExecutorOptions {
  agentDir?: string;
  model?: Model<any>;
  /** Core tools (ledger, artifact, context) exposed to worker sessions. */
  customTools?: ToolDefinition[];
  allowModelNetwork?: boolean;
  /** Generation guard configuration (loop mitigation). Defaults to spec values. */
  guardConfig?: GenerationGuardConfig;
  /** Fallback model to use on the final recovery attempt. */
  fallbackModel?: Model<any>;
  /**
   * Fallback model ID (resolved from the ModelRuntime's available models).
   * Used when `fallbackModel` is not provided directly. The ID is matched
   * against `model.id` in the runtime's model list.
   */
  fallbackModelId?: string;
  /**
   * Gateway admission control. Defaults to the process-wide controller, so
   * every worker in this process shares one backoff and one concurrency clamp.
   */
  admission?: AdmissionController;
  gatewayConfig?: GatewayAdmissionConfig;
  /** Transient error retry/backoff configuration. Defaults to spec values. */
  transientConfig?: BackoffConfig;
  /** Injectable sleep for transient retries (deterministic in tests). */
  transientSleep?: (ms: number) => Promise<void>;
  /** Injectable RNG for backoff jitter (deterministic in tests). */
  transientRand?: () => number;
  /** Timer seam for the wrap-up and silence timers (tests drive it without real sleeps). */
  clock?: WorkerClock;
  /**
   * Resumes of a cut stream per execution once tool calls have executed
   * (default 3, PI_STREAM_RESUME_MAX). 0 disables resuming.
   */
  streamResumeMax?: number;
  /**
   * APS loop-detection for worker sessions (Phase 2, detect-only): tool-call
   * activity is turned into AgentAction records and fed to an
   * AgentProgressSupervisor, which emits `agent.loop_candidate` events.
   * Default `{}` (enabled with default thresholds); `false` disables.
   */
  /**
   * Request-body budget for every provider call this worker makes (see
   * src/request/bodyBudget.ts). Default: PI_MAX_REQUEST_BODY_BYTES /
   * PI_REQUEST_BODY_HEADROOM, else the gateway's advertised cap, else 10 MiB.
   */
  requestBodyBudget?: RequestBodyBudgetConfig;
  /**
   * Thinking off for Pi summaries and near-full contexts on gateways that
   * accept it (src/request/thinkingPolicy.ts). Default: PI_THINKING_OFF_* env.
   */
  thinkingPolicy?: ThinkingOffConfig;
  /**
   * Resilient-inference wiring (fault-tolerance spec §21/§23): the capability
   * registry + RoleRouter arm comparable-model fallback, the scheduler arms the
   * mission-level WAITING_FOR_INFERENCE_CAPACITY park with automatic resume,
   * and `inferenceStatus` receives the concise operator-facing status lines.
   * Omitted, the runtime is still armed with classification, same-model retry
   * on server timing, penalties and breakers (no fallback pool to select from).
   */
  capabilityRegistry?: ModelCapabilityRegistry;
  roleRouter?: RoleRouter;
  inferenceScheduler?: ResilientStreamScheduler;
  inferenceStatus?: (line: string) => void;
  aps?: AgentProgressSupervisorOptions | false;
  /**
   * APS loop PREVENTION (Phase 3, first enforcement): when the supervisor
   * detects a SUSTAINED no-progress loop (identical fingerprint, no state
   * change >= threshold) it aborts the run attempt and surfaces a
   * `loop_prevented` outcome, so a looping agent does not burn the rest of the
   * worker budget. Default `DEFAULT_LOOP_PREVENTION` (enabled, conservative);
   * `false` disables (detection only).
   */
  loopPrevention?: import("../aps/types.ts").LoopPreventionOptions | false;
  /**
   * APS escalation (Phase 5): when a loop survives recovery (Phase 4), escalate
   * to a distinct (optionally pinned) model once per run, or surface
   * `escalated_to_human`. Default `DEFAULT_ESCALATION`; `false` disables.
   */
  escalation?: import("../aps/escalation.ts").EscalationOptions | false;
  /**
   * APS rollout phase (Phase 6): progressive-enablement gate. Default
   * `DEFAULT_ROLLOUT_PHASE` (full enforcement + observability).
   */
  rolloutPhase?: import("../aps/rollout.ts").ApsRolloutPhase;
}

/**
 * Real fresh-context worker execution backed by Pi's SDK (INV-002, AC-018).
 *
 * Every task runs in a brand-new in-memory session with a role-specific system
 * prompt and tool allowlist, so no prior reasoning is inherited. The worker must
 * finish by calling `worker_result`; usage is captured from assistant messages.
 */
/** How often a capacity hold checks for an operator model switch. */
const OPERATOR_SWITCH_POLL_MS = 250;

export class PiWorkerExecutor implements WorkerExecutor {
  private readonly agentDir: string;
  private readonly customTools: ToolDefinition[];
  private readonly model: Model<any> | undefined;
  private readonly allowModelNetwork: boolean;
  private readonly guardConfig: GenerationGuardConfig;
  private readonly fallbackModel: Model<any> | undefined;
  private readonly fallbackModelId: string | undefined;
  private readonly admission: AdmissionController;
  private readonly gatewayConfig: GatewayAdmissionConfig;
  private readonly transientConfig: BackoffConfig;
  private readonly transientSleep: (ms: number) => Promise<void>;
  private readonly transientRand: () => number;
  private readonly clock: WorkerClock;
  private readonly streamResumeMax: number;
  /** APS loop-detection options for worker sessions (`false` disables). */
  private readonly aps: AgentProgressSupervisorOptions | false | undefined;
  /** APS loop-prevention options (`false` disables enforcement). */
  private readonly loopPrevention: import("../aps/types.ts").LoopPreventionOptions | false | undefined;
  /** APS escalation options (`false` disables). */
  private readonly escalation: import("../aps/escalation.ts").EscalationOptions | false | undefined;
  /** APS rollout gate (Phase 6). */
  private readonly rollout: import("../aps/rollout.ts").ApsRollout;
  /** APS observability accumulator (Phase 6). */
  readonly observability: import("../aps/observability.ts").ApsObservability = new ApsObservability();
  private modelRuntime: ModelRuntime | undefined;
  private runtimePromise: Promise<ModelRuntime> | undefined;
  private readonly requestBodyBudget: RequestBodyBudgetConfig;
  private readonly thinkingPolicy: ThinkingOffConfig;
  /** Resilient-inference seams (capability registry / router / scheduler / status). */
  // Not readonly: production arming (spec §23) updates these via
  // rearmResilience() once the capability pool exists.
  private capabilityRegistry: ModelCapabilityRegistry | undefined;
  private roleRouter: RoleRouter | undefined;
  /** The mission's state worktree dir (<state>/worktrees/<id>); transcripts live under it. */
  private transcriptDir: string | undefined;
  private inferenceScheduler: ResilientStreamScheduler | undefined;
  private inferenceStatus: ((line: string) => void) | undefined;
  /** Live tracker per worker run: tool calls already executed (spec §6). */
  private readonly runActions = new Map<string, ExecutedActionTracker>();
  /** Aggregate recovery telemetry across all worker runs. */
  readonly recoveryTelemetry: RecoveryTelemetry = initialRecoveryTelemetry();
  /** Aggregate transient-error retry telemetry across all worker runs. */
  readonly transientTelemetry: TransientTelemetry = initialTransientTelemetry();

  constructor(opts: PiWorkerExecutorOptions = {}) {
    this.agentDir = normalizeAgentDir(
      opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? "~/.pi/agent",
    );
    this.customTools = opts.customTools ?? [];
    this.model = opts.model;
    this.allowModelNetwork = opts.allowModelNetwork ?? false;
    this.guardConfig = opts.guardConfig ?? resolveGuardConfig();
    this.fallbackModel = opts.fallbackModel;
    this.fallbackModelId = opts.fallbackModelId;
    this.admission = opts.admission ?? sharedAdmissionController();
    this.gatewayConfig = opts.gatewayConfig ?? sharedGatewayConfig();
    this.transientConfig = opts.transientConfig ?? resolveTransientRetryConfig();
    this.transientSleep = opts.transientSleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.transientRand = opts.transientRand ?? Math.random;
    this.clock = opts.clock ?? realClock;
    this.streamResumeMax = opts.streamResumeMax ?? resolveStreamResumeMax();
    this.aps = opts.aps;
    this.loopPrevention = opts.loopPrevention;
    this.escalation = opts.escalation;
    this.rollout = resolveRollout(opts.rolloutPhase ?? DEFAULT_ROLLOUT_PHASE);
    this.requestBodyBudget = opts.requestBodyBudget ?? resolveRequestBodyBudgetConfig();
    this.thinkingPolicy = opts.thinkingPolicy ?? resolveThinkingOffConfig();
    this.capabilityRegistry = opts.capabilityRegistry;
    this.roleRouter = opts.roleRouter;
    this.inferenceScheduler = opts.inferenceScheduler;
    this.inferenceStatus = opts.inferenceStatus;
  }

  /**
   * Arm the shared ModelRuntime with the unified resilient layer (spec §21).
   *
   * One wrap covers EVERY model invocation of EVERY worker role this executor
   * runs — planner, scout, implementer, reviewer, specialist reviewer,
   * challenge, tournament candidate, remediation worker, spec verifier and the
   * background engineering sessions — because all of them are agent-loop calls
   * through this runtime. The role/mission/worker identity of each individual
   * call is resolved from the async invocation context, so concurrent workers
   * never inherit each other's identity, and no worker implements its own
   * request-level retry.
   */
  private wireResilience(runtime: ModelRuntime): "installed" | "already-installed" | "disabled" {
    return wireResilientModelRuntime(runtime, {
      role: "worker",
      admission: this.admission,
      ...(this.capabilityRegistry ? { registry: this.capabilityRegistry } : {}),
      ...(this.roleRouter ? { router: this.roleRouter } : {}),
      ...(this.inferenceScheduler ? { scheduler: this.inferenceScheduler } : {}),
      ...(this.inferenceStatus ? { status: this.inferenceStatus } : {}),
    });
  }

  /**
   * Production arming (spec §23): the capability pool (registry + router)
   * and the mission scheduler are often built AFTER this executor, so the
   * initial arm at runtime creation carries only what existed at
   * construction. Call this once the pool is ready: the resilient install
   * is idempotent but UPDATABLE, so the new registry/router/scheduler/status
   * take effect on the live runtime without a second wrap — otherwise
   * selectFallback bails without a registry and the WAITING_FOR_
   * INFERENCE_CAPACITY park + operator status lines are unreachable in
   * production.
   */
  /** Key persisted transcripts by the orchestrator's state worktree, not the candidate cwd. */
  setTranscriptDir(dir: string | undefined): void {
    this.transcriptDir = dir;
  }

  rearmResilience(patch: {
    capabilityRegistry?: ModelCapabilityRegistry;
    roleRouter?: RoleRouter;
    inferenceScheduler?: ResilientStreamScheduler;
    inferenceStatus?: (line: string) => void;
  }): void {
    if (patch.capabilityRegistry) this.capabilityRegistry = patch.capabilityRegistry;
    if (patch.roleRouter) this.roleRouter = patch.roleRouter;
    if (patch.inferenceScheduler) this.inferenceScheduler = patch.inferenceScheduler;
    if (patch.inferenceStatus) this.inferenceStatus = patch.inferenceStatus;
    if (!this.runtimePromise) return; // the initial arm will pick the fields up
    void this.runtimePromise.then((rt) => this.wireResilience(rt)).catch(() => {});
  }

  /** The idempotency tracker of the run this session belongs to (spec §6). */
  private trackerFor(req: WorkerRequest): ExecutedActionTracker | undefined {
    return currentInferenceInvocation()?.actions ?? this.runActions.get(req.sessionId ?? req.role);
  }

  /** Tool actions this run executed across all its attempts. */
  private executedActionCount(req: WorkerRequest): number {
    return this.trackerFor(req)?.list().length ?? 0;
  }

  /** Record an executed tool call; a retry of this request must not repeat it. */
  private trackAction(req: WorkerRequest, action: { id: string; kind: string; summary: string }): void {
    this.trackerFor(req)?.record(action);
  }

  /** APS observability snapshot (Phase 6) — Grafana-ready metrics. */
  apsSnapshot(): import("../aps/observability.ts").ApsSnapshot {
    return this.observability.snapshot();
  }

  /** Inject/refresh the semantic tools bound to a runtime (scout/reviewer/implementer sessions). */
  setCustomTools(tools: ToolDefinition[]): void {
    (this as unknown as { customTools: ToolDefinition[] }).customTools = tools;
  }

  /** Lazily-built ModelRuntime, exposed for capability-aware model discovery. */
  async getModelRuntime(): Promise<ModelRuntime> {
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const rt = await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
        allowModelNetwork: this.allowModelNetwork,
      });
      await registerLocalProviders(rt, { agentDir: this.agentDir }).catch(() => {});
      guardRuntimeRequestBody(rt, this.requestBodyBudget, this.thinkingPolicy);
      this.wireResilience(rt);
      return rt;
    })();
    return this.runtimePromise;
  }

  /**
   * Access the shared, cached ModelRuntime for capability discovery/routing.
   * This is the public surface harness uses to build a model-routing source
   * from the same runtime the workers run against.
   */
  async runtime(): Promise<ModelRuntime> {
    return this.getModelRuntime();
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    // Every provider call this run makes inherits WHO is calling (role /
    // mission / worker) and the tracker of the tool calls it already executed,
    // so the resilient layer can gate fallback by the role's envelope and
    // inject idempotency evidence into a retried request (spec §6/§23).
    const actions = new ExecutedActionTracker();
    this.runActions.set(req.sessionId ?? req.role, actions);
    try {
      return await runWithInferenceInvocation(
        {
          role: req.role,
          ...(req.runId ? { missionId: req.runId } : {}),
          ...(req.sessionId ? { workerId: req.sessionId } : {}),
          actions,
        },
        () => this.runOnce(req),
      );
    } finally {
      this.runActions.delete(req.sessionId ?? req.role);
    }
  }

  private async runOnce(req: WorkerRequest): Promise<WorkerRun> {
    const modelRuntime = await this.getModelRuntime();
    let model = this.model;
    // The capability router places a role on a specific provider model. When a
    // route is supplied it wins over the construction-time default.
    if (req.modelOverride) {
      const resolved = modelRuntime.getModel(req.modelOverride.provider, req.modelOverride.id) as
        | Model<any>
        | undefined;
      if (resolved) {
        model = resolved;
      } else {
        return {
          result: {
            status: "failed",
            summary: `Routed model ${req.modelOverride.provider}/${req.modelOverride.id} is not registered in this runtime.`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: "unknown-model",
          },
          usage: null,
          error: "unknown-model",
        };
      }
    }
    if (!model) {
      const available = await modelRuntime.getAvailable();
      model = available[0] as Model<any> | undefined;
    }
    if (!model) {
      return {
        result: {
          status: "failed",
          summary: "No model available.",
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
          error: "no-model",
        },
        usage: null,
        error: "no-model",
      };
    }

    // pi's provider-attribution (isOpenRouterModel) reads `model.baseUrl` and
    // crashes on undefined. The worker model may arrive without a gateway URL
    // (only the provider carries it), so attach it before the session's first
    // provider call to keep attribution off that crash path.
    if (model && !model.baseUrl) {
      const providerBaseUrl = (modelRuntime.getProvider(model.provider) as { baseUrl?: string } | undefined)?.baseUrl;
      if (providerBaseUrl) model = { ...model, baseUrl: providerBaseUrl };
    }

    // Build the base system prompt with the Tool Transition Rule (spec §15).
    // Specialist roles may supply their own prompt wholesale. Prose roles
    // (reviewers) deliver written findings, so a rule that says "act instead of
    // narrating" contradicts their role and is left out.
    const builtPrompt = buildSystemPrompt(req.role, req.task, workerContext(req), {
      isolatedWorktree: req.isolatedWorktree,
    });
    const baseSystemPrompt =
      req.systemPromptOverride ??
      (PROSE_ROLES.has(req.role) ? builtPrompt : `${builtPrompt}\n\n${TOOL_TRANSITION_RULE}`);

    // The budget is the role's, clamped to what the routed model can hold
    // (issue #180); the run's request carries it and the result records it.
    const declared = windowDeclared(this.agentDir, model.provider, model.id);
    const budget = resolveContextBudget(req.role, req.maxContextTokens, model.contextWindow, model.maxTokens, declared);
    if (budget.warning) {
      emitTelemetry({
        level: "warning",
        text: budget.warning,
        key: `context-budget-unknown:${model.provider}/${model.id}`,
      });
    }
    // Run the worker with the generation guard and recovery ladder.
    // max_tokens on the wire must leave the prompt budget its room in the slot.
    const maxOutputTokens = budget.contextWindow !== undefined ? budget.contextWindow - budget.tokens : undefined;
    const sized = { ...req, maxContextTokens: budget.tokens, contextBudget: budget };
    const invocation = currentInferenceInvocation();
    const run = await (invocation && maxOutputTokens !== undefined
      ? runWithInferenceInvocation({ ...invocation, maxOutputTokens }, () =>
          this.runWithGuard(sized, model, baseSystemPrompt, modelRuntime),
        )
      : this.runWithGuard(sized, model, baseSystemPrompt, modelRuntime));
    return {
      ...run,
      result: { ...run.result, details: { ...run.result.details, context_budget: budget } },
    };
  }

  /**
   * Run a worker session with the GenerationGuard active. On degeneration,
   * implements the bounded recovery ladder (spec §13).
   *
   * Each attempt uses a FRESH in-memory session, so failed output from prior
   * attempts is never visible to the model (spec §18: the bad generation MUST
   * NOT be appended to the model-visible history).
   */
  private async runWithGuard(
    req: WorkerRequest,
    initialModel: Model<any>,
    initialPrompt: string,
    modelRuntime: ModelRuntime,
  ): Promise<WorkerRun> {
    // A mutating role with a known base may not report `completed` over an
    // untouched worktree (the tool answers isError and the session continues).
    const terminating =
      req.resultTool === "review_result"
        ? reviewResultTool
        : createWorkerResultTool(
            req.baseRef && MUTATING_ROLES.has(req.role) ? { cwd: req.cwd, baseRef: req.baseRef } : undefined,
          );
    // Budgeted runs show elapsed/remaining time in bash and claim_deliverable
    // results every N of those calls (a no-op without a wall-clock budget).
    const noticeEvery = Math.max(
      1,
      req.budgetNoticeEveryToolCalls ??
        (Number.parseInt(process.env.PI_ENGINEERING_BUDGET_NOTICE_EVERY ?? "", 10) || DEFAULT_BUDGET_NOTICE_EVERY),
    );
    let noticeCalls = 0;
    const budgetNotice = (tool: ToolDefinition): ToolDefinition =>
      req.wallClock
        ? withBudgetNotice(tool, () =>
            ++noticeCalls % noticeEvery === 0 ? budgetLine(req.wallClock!, this.clock.now()) : undefined,
          )
        : tool;
    const customTools = [
      ...this.customTools,
      ...(req.tolerantFileTools ? [createNumberedReadTool(req.cwd), createTolerantEditTool(req.cwd)] : []),
      // Every worker bash command runs one mission-depth deeper (recursion
      // guard). The built-in tool is replaced by one with the same name; the
      // budget notice wraps it only for budgeted runs.
      ...(req.tools.includes("bash")
        ? [
            budgetNotice(
              createBashToolDefinition(req.cwd, { spawnHook: missionDepthSpawnHook }) as unknown as ToolDefinition,
            ),
          ]
        : []),
      ...(offersClaimDeliverable(req)
        ? [budgetNotice(createClaimDeliverableTool(req.deliverables ?? []) as unknown as ToolDefinition)]
        : []),
      ...(offersCheckpointProgress(req) ? [createCheckpointProgressTool(req.deliverables ?? [])] : []),
      terminating,
    ];
    const tools = [...new Set([...req.tools, ...customTools.map((t) => t.name)])];
    let model: Model<any> = initialModel;
    let systemPrompt: string = initialPrompt;
    let attempt = 0;
    let escalatedCount = 0;
    let escalatedToHuman = false;
    let recoveryPending = false;
    let lastGuardReason: GuardAbortReason | undefined;
    let lastGuardDiagnostics: Record<string, unknown> = {};
    let lastAssistantError: string | undefined;
    // Gateway backpressure is NOT degeneration: waiting out a reported
    // `retry_after_ms` is bounded separately from the recovery ladder, which
    // would otherwise burn attempts lowering reasoning effort and swapping
    // models in response to a queue timeout.
    const admission = this.admission;
    const gatewayConfig = this.gatewayConfig;
    let gatewayRetries = 0;
    // Cut-stream resumes spent by this execution (cap: streamResumeMax).
    const streamResumes = { count: 0 };
    // Scope every hold to the model actually called, then route it the same way
    // the interactive turn does (gatewayHoldScope). Without provider/model a
    // model-scoped signal fell back to the process-wide cooldown, and a link
    // cut must not arm any shared cooldown at all.
    //
    // A flattened refusal's wait is synthesized, so it escalates like the
    // interactive pump's: a flat 5s x maxRetries gave up on a model_activating
    // warm-up that outlasts ~40s.
    // A mission worker waits for inference capacity as long as the gateway
    // asks it to: the hold count is not a budget (only cancellation ends it).
    // Advice to move to another model is the exception — holding forever on a
    // model the gateway says to leave helps nobody, so that keeps the finite
    // count and hands the decision back to the mission.
    //
    // A model-scoped capacity hold (this model's queue is full or deadlined, a
    // comparable deployment has room) is the same kind of exception: waiting
    // forever on the one saturated model stalls a mission that the router could
    // move onto a model with free capacity. So after the finite hold count it
    // hands back too. An account-wide hold (a shared queue, a concurrency
    // ceiling) still waits out: every model is behind it, so switching would
    // only spin the same queue.
    const gatewayRetryCeiling = req.unboundedInferenceWait ? Number.POSITIVE_INFINITY : gatewayConfig.maxRetries;
    // An operator-pinned model is the exception to the exception: the operator
    // chose it, so only the operator moves the mission off it (with /model,
    // which ends the wait at the next boundary) — it is waited out.
    const withinGatewayBudget = (decision: GatewayRetryDecision): GatewayRetryDecision =>
      decision.action === "wait" &&
      req.unboundedInferenceWait &&
      !req.operatorPinned &&
      gatewayRetries >= gatewayConfig.maxRetries &&
      (advisesAlternateModel(decision.signal) ||
        (isCapacityExhaustion(decision.signal) && !isAccountWideRefusal(decision.signal)))
        ? { action: "give-up", signal: decision.signal, reason: "retries-exhausted" }
        : decision;
    // A mission waiting on an exhausted model says so, once per model, and
    // offers the way out: an operator switch the mission adopts at once.
    const capacityNoticed = new Set<string>();
    const noteCapacityWait = (signal: GatewayWaitSignal): void => {
      if (!req.unboundedInferenceWait || !isCapacityExhaustion(signal)) return;
      const key = `${model.provider}/${model.id}`;
      if (capacityNoticed.has(key)) return;
      capacityNoticed.add(key);
      emitTelemetry({
        level: "warning",
        text: `model ${key} is out of capacity (${signal.reason ?? signal.code ?? `HTTP ${signal.status ?? 429}`}); the mission keeps waiting — switch with /model to continue on another model`,
        key: `mission-capacity:${key}`,
      });
    };
    // Asking may persist the mission's adoption of the new pin; a store error
    // there must not end this run, so it reads as "not switched".
    const operatorSwitched = (): boolean => {
      try {
        return req.modelSuperseded?.() === true;
      } catch {
        return false;
      }
    };
    const superseded = (): WorkerRun => ({
      result: {
        status: "failed",
        summary: `The operator chose another model; the ${req.role} attempt on ${model.provider}/${model.id} stopped at an inference boundary.`,
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: { model: { provider: model.provider, id: model.id } },
        error: MODEL_SUPERSEDED,
      },
      usage: null,
      error: MODEL_SUPERSEDED,
    });
    const holdForGateway = (signal: GatewayWaitSignal): Promise<number> => {
      const paced = signal.flattened ? escalateSyntheticWait(signal, gatewayRetries, MAX_ESCALATED_WAIT_MS) : signal;
      const scoped = { ...paced, provider: model.provider, model: model.id };
      // Waiting for capacity is liveness: tell the owner, so the wait is
      // never mistaken for a hung worker.
      emitWorkerActivity(req, { kind: "state", summary: WAITING_FOR_INFERENCE_SUMMARY, meaningfulProgress: false });
      // A hold is an inference boundary: an operator model switch ends it at
      // once (polled), so the mission moves without sitting out the gateway's
      // whole advertised wait. The next loop pass reports the switch.
      const hold = new AbortController();
      const stop = (): void => hold.abort();
      if (req.signal?.aborted) hold.abort();
      else req.signal?.addEventListener("abort", stop, { once: true });
      const poll = req.modelSuperseded
        ? setInterval(() => {
            if (operatorSwitched()) hold.abort();
          }, OPERATOR_SWITCH_POLL_MS)
        : undefined;
      poll?.unref?.();
      const sleeping =
        gatewayHoldScope(scoped) === "caller"
          ? admission.noteCallerWaitAndSleep(scoped, { signal: hold.signal })
          : admission.noteWaitAndSleep(scoped, { signal: hold.signal });
      return sleeping.finally(() => {
        if (poll) clearInterval(poll);
        req.signal?.removeEventListener("abort", stop);
      });
    };

    // Prose-producing roles (reviewers, challenger, scout, summarizer) deliver
    // prose findings/assessments, not a tool call. The generic worker guard's
    // tight narration/no-progress budgets (600 / 1500 tokens) treated a
    // legitimate written review as "excessive narration" / "no progress" and
    // aborted it — a false failure that made independent reviews fail on a
    // token budget instead of on merit. Derive a role-adjusted guard so these
    // roles get a generous prose budget while tool-driven roles keep the
    // strict loop-mitigation defaults.
    const guardConfig = guardConfigForRole(req.role, this.guardConfig);

    // A prompt the model's window cannot hold fails identically on every
    // replay (issue #180). The first overflow compacts the prompt and retries
    // the turn once in a fresh session; the second fails with a structured
    // `context_overflow`, which recovery answers by splitting the task.
    let overflowCompacted = false;
    const onContextOverflow = (detail: string, toolCalls: number): WorkerRun | undefined => {
      if (!overflowCompacted) {
        overflowCompacted = true;
        systemPrompt = buildCompactedWorkerPrompt(
          req,
          "The previous attempt's prompt exceeded the model's context window. Work in small steps and read only what you need.",
        );
        attempt += 1;
        return undefined;
      }
      const summary = `context_overflow: the prompt still exceeds the context window of ${model.provider}/${model.id} after one compaction (budget ${req.maxContextTokens ?? "unset"} tokens): ${detail}`;
      return {
        result: {
          status: "failed",
          summary,
          claims: [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: { context_overflow: true, model: { provider: model.provider, id: model.id } },
          error: "context_overflow",
        },
        usage: null,
        error: "context_overflow",
        toolCalls: Math.max(toolCalls, this.executedActionCount(req)),
      };
    };

    while (true) {
      // Every pass of this loop starts a new inference request: the boundary
      // at which an operator's model switch takes over (never mid-stream).
      if (operatorSwitched()) return superseded();
      // Two retry layers, with a clean ownership split:
      //
      //   * the ADMISSION slot is held across the whole transient retry, because
      //     a 503 retried three times is still one worker's turn at the gateway.
      //     Re-acquiring per transient attempt would make a flaky provider look
      //     like concurrency pressure;
      //   * TRANSIENT retry (503, network, timeout, compaction) backs off
      //     exponentially inside the slot, with a fresh session per attempt;
      //   * GATEWAY saturation (429 inference_admission) is deliberately NOT a
      //     transient category — see classifyError. It is handled below, where
      //     the gateway's own advertised wait is honoured process-wide.
      // Queuing for a slot is waiting for inference capacity: the queue itself
      // tells the owner, per worker, so the wait is never mistaken for a hang.
      const slot = gatewayConfig.enabled
        ? await admission.acquire({
            onWait: () =>
              emitWorkerActivity(req, {
                kind: "state",
                summary: WAITING_FOR_INFERENCE_SUMMARY,
                meaningfulProgress: false,
              }),
          })
        : null;
      let transientOutcome: Awaited<
        ReturnType<typeof withTransientRetry<Awaited<ReturnType<typeof this.runSingleAttempt>>>>
      >;
      try {
        transientOutcome = await withTransientRetry({
          fn: async () => {
            try {
              return await this.runSingleAttempt(
                req,
                model,
                // A retry of a generation that already ran tool calls carries the
                // evidence block: the executed edits/commits are LISTED, never
                // replayed (spec §6). Nothing is re-executed by the runtime.
                attempt === 0 ? systemPrompt : withIdempotencyEvidence(systemPrompt, this.trackerFor(req)),
                modelRuntime,
                customTools,
                tools,
                attempt,
                guardConfig,
                streamResumes,
              );
            } catch (error) {
              // A pinned gate role is waited on, except when its host refuses
              // connections or does not resolve: that is not retried in-session.
              if (
                GATE_ROLES.has(req.role) &&
                req.operatorPinned &&
                classifyError(error).category === "network" &&
                (await connectRefused(model.baseUrl))
              ) {
                throw new ConnectRefusedError(error);
              }
              throw error;
            }
          },
          // An operator-pinned gate role is waited on, so it keeps the full policy.
          config:
            GATE_ROLES.has(req.role) && !req.operatorPinned
              ? { ...this.transientConfig, maxAttempts: Math.min(this.transientConfig.maxAttempts, gateRetryCap()) }
              : this.transientConfig,
          classify: (error) =>
            error instanceof ConnectRefusedError
              ? { category: "network", retryable: false, reason: "connection refused" }
              : classifyError(error),
          sleep: this.transientSleep,
          rand: this.transientRand,
        });
      } finally {
        slot?.release();
      }

      if (transientOutcome.error) {
        const te = transientOutcome.error;
        const detail = te instanceof Error ? te.message : String(te);

        // A gateway admission refusal arrives here as a NON-retryable transient
        // error (classifyError hands it over rather than backing off against a
        // wait it cannot read). Honour the wait the gateway actually reported
        // and retry the same attempt, process-wide.
        // A link cut is NOT handed over: the transient loop above already
        // owned its retries (decideTransientHandover).
        if (gatewayConfig.enabled) {
          const handover = withinGatewayBudget(decideTransientHandover(detail, gatewayRetries, gatewayRetryCeiling));
          if (handover.action === "wait") {
            gatewayRetries++;
            noteCapacityWait(handover.signal);
            await holdForGateway(handover.signal);
            continue;
          }
        }

        if (transientOutcome.category === "context_overflow") {
          const overflow = onContextOverflow(detail, 0);
          if (overflow) return overflow;
          continue;
        }

        // Transient retries were exhausted (or a non-retryable transport error).
        const category = transientOutcome.category ?? "permanent";
        recordTransientError(this.transientTelemetry, category);
        recordTransientOutcome(this.transientTelemetry, false, category);
        const attempts = transientOutcome.attempts;
        return {
          result: {
            status: "failed",
            summary: `Worker failed after ${attempts} attempt(s): ${detail}`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            // Name the model the attempt ran on: unrouted work runs on the
            // executor default, and a model takeover must mark that model.
            details: {
              transient_category: category,
              attempts,
              model: { provider: model.provider, id: model.id },
              // The connection itself failed (refused, reset, unresolvable), as
              // opposed to a stall, a timeout or a server verdict.
              ...(category === "network" && CONNECT_LEVEL.test(detail) ? { connect_level: true } : {}),
              ...(te instanceof ConnectRefusedError ? { connect_refused: true } : {}),
            },
            error: `transient:${category}`,
          },
          usage: null,
          error: `transient:${category}`,
          toolCalls: this.executedActionCount(req),
        };
      }

      const {
        session,
        guardAborted,
        guardReason,
        guardDiagnostics,
        captured,
        structured,
        toolCalls,
        budgetExhausted,
        timedOut,
        assistantError,
        loopPrevented,
        loopPreventedEvent,
      } = transientOutcome.value!;
      if (assistantError) lastAssistantError = assistantError;

      session.dispose();

      // A reviewer's terminating tool is review_result (it is never given
      // worker_result): a delivered verdict is a completed review.
      const reviewDelivered = req.resultTool === "review_result" && structured !== undefined && structured !== null;
      const result: WorkerResult | undefined =
        captured ??
        (reviewDelivered
          ? {
              status: "completed",
              summary: String((structured as { summary?: unknown }).summary ?? "").slice(0, 4000) || "Review recorded.",
              claims: [],
              evidence_refs: [],
              new_hypotheses: [],
              proposed_tasks: [],
              details: {},
            }
          : undefined);
      if (result) {
        // Success — record recovery outcome if we were in a retry.
        if (attempt > 0) {
          recordRetryOutcome(this.recoveryTelemetry, true, false);
        }
        if (recoveryPending) {
          if (this.rollout.observability) this.observability.recordRecoveryOutcome(true);
          recoveryPending = false;
        }
        if (gatewayConfig.enabled) admission.noteSuccess();
        const usage = this.collectUsage(this.asMessages(session.messages), streamResumes.count);
        return { result, usage, toolCalls, structured };
      }

      // Gateway saturation: honour the wait the gateway reported, hold every
      // other model caller in this process behind the same cooldown, and retry
      // the SAME attempt (no recovery-ladder escalation).
      if (gatewayConfig.enabled) {
        const decision = withinGatewayBudget(decideGatewayRetry(assistantError, gatewayRetries, gatewayRetryCeiling));
        if (decision.action === "wait") {
          gatewayRetries++;
          noteCapacityWait(decision.signal);
          await holdForGateway(decision.signal);
          continue;
        }
      }

      // Phase 3/4 outcome: the supervisor PREVENTED a sustained loop and aborted
      // the run. Phase 4 RECOVERY: attempt ONE conservative recovery (replan to a
      // different strategy, or compact the identical no-progress turns) via a
      // FRESH session before giving up. Bounded to one APS recovery; never loops.
      if (loopPrevented) {
        this.emitTelemetry({
          event: "model_generation_aborted",
          reason: "loop_prevented" as GuardAbortReason,
          model: (model as { id?: string }).id ?? "unknown",
          agent: req.role,
          attempt,
          reasoning_tokens: 0,
          output_tokens: this.estimateOutputTokens(session.messages),
          tokens_since_progress: loopPreventedEvent?.metrics.noProgressTurns ?? 0,
          timestamp: new Date().toISOString(),
        });
        const noProgressTurns = loopPreventedEvent?.metrics.noProgressTurns ?? 0;
        if (this.rollout.observability && loopPreventedEvent !== undefined) {
          this.observability.recordPrevented(loopPreventedEvent);
        }
        // Phase 4 recovery: one conservative replan/compact attempt via a fresh
        // session, before escalation (Phase 5). Gated by rollout.recovery.
        if (loopPreventedEvent !== undefined && this.rollout.recovery && attempt < APS_RECOVERY_MAX_ATTEMPTS) {
          const recovery = decideApsRecovery(loopPreventedEvent);
          if (apsRecoverable(recovery)) {
            if (this.rollout.observability) this.observability.recordRecovery(recovery.action);
            recoveryPending = true;
            attempt += 1;
            const recoveryPrompt = buildApsRecoveryPrompt(recovery, loopPreventedEvent);
            if (recovery.action === "compact") {
              systemPrompt = buildCompactedWorkerPrompt(req, recoveryPrompt);
            } else {
              systemPrompt = `${systemPrompt}\n\n${recoveryPrompt}`;
            }
            continue; // fresh session, replan/compact directive, one recovery only
          }
        }
        // Phase 5 escalation: the loop survived recovery. Escalate ONCE to a
        // distinct (optionally pinned) model; if none is available, surface
        // `escalated_to_human`. Bounded; never loops.
        if (
          loopPreventedEvent !== undefined &&
          this.escalation !== false &&
          this.rollout.escalation &&
          apsShouldEscalate(attempt + 1, escalatedCount, { ...DEFAULT_ESCALATION, ...(this.escalation ?? {}) })
        ) {
          const currentModelId = (model as { id?: string }).id;
          const available = (await modelRuntime.getAvailable()) as unknown as { id?: string }[];
          const escalationConfig = { ...DEFAULT_ESCALATION, ...(this.escalation ?? {}) };
          const target = selectApsEscalationModel(
            currentModelId,
            available,
            escalationConfig.preferredEscalationModelId,
          );
          const escalationEvent: EscalationEvent = {
            type: "agent.escalation",
            event_id: `aps-escalation-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            sessionId: loopPreventedEvent.sessionId,
            runId: loopPreventedEvent.runId,
            workItemId: loopPreventedEvent.workItemId,
            role: req.role,
            tier: 1,
            fromModel: currentModelId ?? "unknown",
            toModel: target === null ? null : target.id,
            reason: "loop_prevented_after_recovery",
            attempt,
            escalatedToHuman: target === null,
            humanReviewRequested: target === null,
          };
          this.emitTelemetry(escalationEvent);
          if (this.rollout.observability) this.observability.recordEscalation(escalationEvent);
          if (target !== null) {
            const escalated = available.find((m) => m.id === target.id) as Model<any> | undefined;
            if (escalated) {
              escalatedCount += 1;
              attempt += 1;
              model = escalated;
              systemPrompt = `${systemPrompt}\n\n${buildEscalationPrompt(escalationEvent.reason)}`;
              continue; // fresh session on the escalated model, once per run
            }
          }
          escalatedToHuman = true;
        }
        // A pending recovery attempt that ended unsuccessfully is a recovery
        // FAILURE for the recovery-success metric.
        if (recoveryPending) {
          if (this.rollout.observability) this.observability.recordRecoveryOutcome(false);
          recoveryPending = false;
        }
        const usage = this.collectUsage(this.asMessages(session.messages), streamResumes.count);
        const detail = {
          loop_prevented: true,
          no_progress_turns: noProgressTurns,
          recovery: loopPreventedEvent !== undefined ? decideApsRecovery(loopPreventedEvent).action : "none",
          escalated_to_human: escalatedToHuman,
        };
        return {
          result: {
            status: "failed",
            summary: `Agent loop prevented after ${noProgressTurns} identical no-progress turns (${AGENT_LOOP_PREVENTED_EVENT}).`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: detail,
            error: "loop_prevented",
          },
          usage,
          error: "loop_prevented",
          toolCalls,
        };
      }

      if (
        !guardAborted &&
        !budgetExhausted &&
        !timedOut &&
        lastAssistantError !== undefined &&
        classifyError(lastAssistantError).category === "context_overflow"
      ) {
        const overflow = onContextOverflow(lastAssistantError, toolCalls);
        if (!overflow) {
          lastAssistantError = undefined;
          continue;
        }
        return { ...overflow, usage: this.collectUsage(this.asMessages(session.messages)) };
      }

      if (!guardAborted || !this.guardConfig.enabled) {
        // Non-guard failure (timeout, budget, gateway, no-result) — no recovery ladder.
        const gateway = lastAssistantError ? parseGatewayWait({ text: lastAssistantError }) : null;
        // A 404 model_not_found usually arrives as an assistant-message error,
        // not a throw, so the transient layer never saw it. Give it the same
        // marker as the thrown path, so the mission hands the work to another
        // model instead of failing on an unclassified error text.
        const modelGone =
          !gateway &&
          lastAssistantError !== undefined &&
          classifyError(lastAssistantError).category === "model_unavailable";
        const reason = budgetExhausted
          ? "Worker exceeded the hard context-token budget."
          : timedOut
            ? "Worker timed out."
            : gateway
              ? `Model gateway refused the request after ${gatewayRetries} honoured wait(s): ${lastAssistantError}`
              : `Worker returned no worker_result.${lastAssistantError ? ` ${lastAssistantError}` : ""}`;
        const error = budgetExhausted
          ? "budget-exhausted"
          : timedOut
            ? "timeout"
            : gateway
              ? gatewayFailureMarker(gateway)
              : modelGone
                ? "transient:model_unavailable"
                : isTruncatedStream(lastAssistantError)
                  ? "truncated_after_progress"
                  : isStalledStream(lastAssistantError)
                    ? "transient:network"
                    : (lastAssistantError ?? "no-result");
        return {
          result: {
            status: "failed",
            summary: reason,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: gateway
              ? { gateway_wait: gateway, gateway_retries: gatewayRetries }
              : modelGone
                ? { model: { provider: model.provider, id: model.id } }
                : {},
            error,
          },
          usage: this.collectUsage(this.asMessages(session.messages), streamResumes.count),
          error,
          toolCalls: Math.max(toolCalls, this.executedActionCount(req)),
        };
      }

      // Guard-triggered abort — enter the recovery ladder (spec §13).
      lastGuardReason = guardReason;
      lastGuardDiagnostics = guardDiagnostics;
      recordAbort(
        this.recoveryTelemetry,
        guardReason!,
        this.estimateOutputTokens(session.messages),
        req.maxContextTokens ?? 32768,
      );

      // Emit structured telemetry (spec §21).
      const telemetryEvent = buildDegenerationEvent(
        guardReason!,
        (model as { id?: string }).id ?? "unknown",
        req.role,
        attempt,
        (guardDiagnostics.tokens_since_progress as number) ?? 0,
        this.estimateOutputTokens(session.messages),
        guardDiagnostics,
      );
      // Structured log (spec §21: one event per interrupted generation).
      this.emitTelemetry(telemetryEvent);

      const nextAttempt = attempt + 1;
      const recovery = decideRecovery(
        nextAttempt,
        this.guardConfig,
        "medium",
        (model as { id?: string }).id ?? "unknown",
        guardReason!,
        guardDiagnostics,
      );

      if (!recovery.shouldRetry) {
        // Recovery exhausted — typed error (spec §13).
        recordRetryOutcome(this.recoveryTelemetry, false, false);
        const err = recovery.error!;
        return {
          result: {
            status: "failed",
            summary: `Model degeneration: ${err.reason} after ${err.attempt} recovery attempt(s).`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: { guard_event: telemetryEvent },
            error: `degeneration:${err.reason}`,
          },
          usage: null,
          error: `degeneration:${err.reason}`,
          toolCalls,
        };
      }

      // Prepare the retry with recovery modifications.
      attempt = nextAttempt;

      if (recovery.compactContext) {
        // Spec §17: Build a compact checkpoint for attempt 2+.
        // Rebuild the system prompt from scratch (not appended to the growing
        // prior prompt) so the model gets a clean, focused context.
        systemPrompt = buildCompactedWorkerPrompt(req, recovery.recoveryPrompt);
      } else if (recovery.recoveryPrompt) {
        // Attempt 1: append the recovery prompt to the existing system prompt.
        systemPrompt = `${systemPrompt}

${recovery.recoveryPrompt}`;
      }

      // Use the fallback model if configured (spec §13, attempt 3).
      if (recovery.useFallbackModel) {
        if (this.fallbackModel) {
          model = this.fallbackModel;
        } else if (this.fallbackModelId) {
          // Resolve the fallback model by ID from the available models.
          const available = await modelRuntime.getAvailable();
          const fallback = available.find((m) => (m as { id?: string }).id === this.fallbackModelId) as
            | Model<any>
            | undefined;
          if (fallback) {
            model = fallback;
          } else {
            // No fallback model found — continue with current model rather than failing.
            // (The guard will still bound the retries.)
          }
        }
      }
      // Continue the loop — a fresh session is created on the next iteration.
    }
  }

  /**
   * Run a single worker session attempt. Returns the session (for cleanup),
   * the captured result (if any), and guard/budget/timeout state.
   */
  private async runSingleAttempt(
    req: WorkerRequest,
    model: Model<any>,
    systemPrompt: string,
    modelRuntime: ModelRuntime,
    customTools: ToolDefinition[],
    tools: string[],
    attempt: number,
    guardConfig: GenerationGuardConfig = this.guardConfig,
    streamResumes: { count: number } = { count: 0 },
  ): Promise<{
    session: { dispose: () => void; messages: readonly unknown[] };
    guardAborted: boolean;
    guardReason?: GuardAbortReason;
    loopPrevented: boolean;
    loopPreventedEvent?: AgentLoopPreventedEvent;
    guardDiagnostics: Record<string, unknown>;
    captured?: WorkerResult;
    structured?: unknown;
    toolCalls: number;
    budgetExhausted: boolean;
    timedOut: boolean;
    /** Terminal provider/gateway error text, when the model call itself failed. */
    assistantError?: string;
  }> {
    const resourceLoader = roleResourceLoader(systemPrompt);
    const sessionManager = SessionManager.inMemory(req.cwd);
    // Mission workers compact at a share of their context budget (default 60%,
    // PI_WORKER_COMPACT_AT), keeping the autotuned recent window; the summary
    // call goes through the same thinking-off request policy as every worker
    // request. Without a known window there is nothing to size against.
    const compaction = req.contextBudget
      ? workerCompactionSettings(
          req.contextBudget,
          resolveCompactAt(),
          tunedCompactionTokens(model as { contextWindow?: number; maxTokens?: number })?.keepRecentTokens,
        )
      : undefined;
    const settingsManager = SettingsManager.inMemory({
      compaction: compaction ?? { enabled: false },
      retry: { enabled: false }, // We handle retries ourselves via the recovery ladder.
    });

    const { session } = await createAgentSession({
      cwd: req.cwd,
      agentDir: this.agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      tools,
      customTools,
      // Pi-side level only; the effective switch is the mission-role policy in
      // src/request/thinkingPolicy.ts (wire fields), keyed on the invocation role.
      thinkingLevel: "off",
    });

    const terminatingName = req.resultTool === "review_result" ? "review_result" : "worker_result";
    // APS Phase 2 (detect-only): observe the session's tool-call activity on
    // the EXISTING session event bus; loop candidates become structured
    // `agent.loop_candidate` events. Never affects the run.
    const apsAdapter = this.createApsAdapter(req, model);
    const apsDetach = apsAdapter ? apsAdapter.attach(session) : undefined;
    // Phase 3 enforcement: when the supervisor PREVENTS a sustained loop, abort
    // this run attempt so the worker does not burn its remaining budget, and
    // surface a distinguishable outcome. Settable after session creation
    // because the abort handle lives on the session.
    if (apsAdapter) {
      apsAdapter.supervisor.onPrevented = (event) => {
        if (!loopPrevented) {
          loopPrevented = true;
          loopPreventedEvent = event;
          void session.abort();
        }
      };
    }
    let captured: WorkerResult | undefined;
    let structured: unknown;
    let toolCalls = 0;
    let budgetExhausted = false;
    let timedOut = false;
    let guardAborted = false;
    let guardReason: GuardAbortReason | undefined;
    let guardDiagnostics: Record<string, unknown> = {};
    let loopPrevented = false;
    let loopPreventedEvent: AgentLoopPreventedEvent | undefined;
    // Two distinct error channels, both needed: `assistantError` is the
    // assistant MESSAGE's error (stopReason "error" — where a gateway 429 body
    // arrives), `promptError` is a THROWN transport failure.
    let assistantError: string | undefined;
    let promptError: unknown = undefined;
    let ownerAborted = false;

    // Generation guard (spec §6-§12). Role-adjusted so prose-producing roles
    // (reviewer etc.) are not aborted as "excessive narration" / "no progress"
    // for writing a legitimate findings report.
    const guard = new GenerationGuard(guardConfig);
    guard.setRecoveryAttempt(attempt);

    const enforceBudget = (message: unknown): void => {
      if (!req.maxContextTokens) return;
      const m = message as { usage?: { totalTokens?: number } };
      const total = m?.usage?.totalTokens;
      if (typeof total === "number" && total > req.maxContextTokens && !budgetExhausted && !guardAborted) {
        budgetExhausted = true;
        void session.abort();
      }
    };

    // Times build commands: their end event carries the build-tool label and
    // wall-clock time (budget-exhaustion evidence).
    const buildTimer = new BuildCommandTimer();
    const streaming = new StreamingActivityThrottle();
    // Standalone callers (no owner signal) get an INACTIVITY guard, not a
    // total-duration one: every session event re-arms it. A long, busy session
    // is never cut off for being long. It runs only while THIS worker holds an
    // admission slot (its gateway waits happen between attempts, when no
    // guard is armed), so another caller queued for capacity elsewhere in the
    // process must not keep a hung session alive.
    const inactivityMs = req.timeoutMs ?? 300_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Wrap-up: one user turn near the end of an opt-in wall-clock budget, or
    // when a standalone run has been silent for 75% of its inactivity window,
    // so a timeout yields a resumable partial result. No budget, no injection.
    let wrapUpTimer: unknown;
    let wrappedUp = false;
    const injectWrapUp = (message: string): void => {
      if (wrappedUp || captured) return;
      wrappedUp = true;
      session.steer(message).catch(() => {});
    };
    if (req.wallClock) {
      const at = req.wallClock.startedAt + req.wallClock.budgetMs * WRAP_UP_FRACTION;
      wrapUpTimer = this.clock.setTimeout(() => injectWrapUp(WRAP_UP_MESSAGE), Math.max(0, at - this.clock.now()));
    }
    let silenceTimer: unknown;
    const armInactivity = (): void => {
      if (req.signal) return;
      if (timer) clearTimeout(timer);
      if (silenceTimer) this.clock.clearTimeout(silenceTimer);
      // Only an explicitly configured inactivity window earns a silence
      // wrap-up; the 300s fallback never injects anything.
      if (req.timeoutMs !== undefined) {
        silenceTimer = this.clock.setTimeout(
          () => injectWrapUp(SILENCE_WRAP_UP_MESSAGE),
          req.timeoutMs * WRAP_UP_FRACTION,
        );
      }
      timer = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, inactivityMs);
      timer.unref?.();
    };
    // Model-stream stall watchdog (defect C): the inactivity guard above
    // re-arms on session events, but a gateway that holds the connection open
    // without sending ANY data produces no events — the awaited model call
    // hangs forever and the execution zombies (observed 55+ minutes of
    // reported liveness on a request that would never produce a token). The
    // watchdog arms for each model turn (prompt start, after every tool) and
    // resets on every stream event; silence for modelStreamStallMs aborts the
    // request and surfaces a transient network failure. A long, active stream
    // never stalls; a tool run pauses the window. 0 disables the watchdog.
    const stallMs = this.gatewayConfig.modelStreamStallMs;
    let stalled = false;
    const stallWatchdog =
      stallMs > 0
        ? new StreamStallWatchdog({
            stallMs,
            onStall: () => {
              stalled = true;
              assistantError ??= `model stream stalled: no data for ${stallMs}ms`;
              emitWorkerActivity(req, { kind: "state", summary: "Model stream stalled", meaningfulProgress: false });
              void session.abort();
            },
          })
        : undefined;
    const armStall = (): void => stallWatchdog?.arm();
    const disarmStall = (): void => stallWatchdog?.disarm();
    // Persisted transcript (state dir, never the repo/candidate worktree).
    let transcript: TranscriptWriter | undefined;
    if (transcriptsEnabled()) {
      try {
        const dir =
          this.transcriptDir ??
          worktreeRuntimeDir(resolveStateRoot(), (await resolveWorktreeIdentity(req.cwd)).worktreeId);
        const executionId = req.sessionId ?? `${req.role}-${Date.now().toString(36)}-${attempt}`;
        transcript = new TranscriptWriter(
          transcriptPath(dir, req.missionId ?? req.runId ?? "unattributed", executionId),
        );
        transcript.write({ kind: "session", role: req.role, attempt, model: model.id, provider: model.provider });
      } catch {
        transcript = undefined;
      }
    }
    let turnToolErrors: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      armInactivity();
      if (transcript) {
        const t = event as unknown as Record<string, any>;
        if (t.type === "message_end" && t.message?.role !== "toolResult") {
          const m = t.message;
          const content = Array.isArray(m.content)
            ? m.content.filter((b: { type?: string }) => b?.type !== "thinking")
            : m.content;
          transcript.write({
            kind: "message",
            role: m.role,
            model: m.model,
            stopReason: m.stopReason,
            usage: m.usage
              ? { input: m.usage.input, output: m.usage.output, totalTokens: m.usage.totalTokens }
              : undefined,
            errorMessage: m.errorMessage,
            content,
          });
        } else if (t.type === "tool_execution_start") {
          transcript.write({ kind: "tool_call", tool: t.toolName, id: t.toolCallId, args: t.args });
        } else if (t.type === "tool_execution_end") {
          const text = Array.isArray(t.result?.content)
            ? t.result.content.map((b: { text?: string }) => b?.text ?? "").join("")
            : JSON.stringify(t.result ?? null);
          const category = t.isError ? classifyError(text).category : undefined;
          if (category) turnToolErrors.push(category);
          transcript.write({
            kind: "tool",
            tool: t.toolName,
            id: t.toolCallId,
            result: text,
            isError: Boolean(t.isError),
            errorCategory: category,
          });
        } else if (t.type === "turn_end") {
          const m = t.message ?? {};
          const toolErrorCategory = turnToolErrors[0] ?? "none";
          turnToolErrors = [];
          transcript.write({
            kind: "turn",
            model: m.model,
            stopReason: m.stopReason,
            toolErrorCategory,
            tokens: m.usage?.totalTokens,
          });
          emitWorkerActivity(req, {
            kind: "state",
            summary: `Turn ended: stop=${m.stopReason ?? "unknown"} tool_error=${toolErrorCategory}`,
            meaningfulProgress: false,
          });
        }
      }
      // Stream-stall liveness: stream data resets the window; a running tool
      // pauses it (the model is waiting on the tool, not stalled); tool
      // completion re-arms it for the next model turn; an assistant
      // message_end without a tool ends the turn.
      if (event.type === "message_update" && (event.message as { role?: unknown } | undefined)?.role === "assistant")
        armStall();
      else if (event.type === "tool_execution_start") disarmStall();
      else if (event.type === "tool_execution_end") armStall();
      else if (event.type === "message_end" && (event.message as { role?: unknown } | undefined)?.role === "assistant")
        disarmStall();
      const streamed = streaming.note(event as { type?: string; message?: unknown });
      if (streamed) emitWorkerActivity(req, streamed);
      const activity = buildTimer.observe(event, activityFromSessionEvent(event));
      // Idempotency (spec §6): a tool call that RAN is recorded as executed, so
      // a retried generation — request-level replay here, or a fresh session
      // after a transient failure — lists it as already done instead of
      // repeating the edit, commit, install or shell command.
      if (event.type === "tool_execution_end") {
        const id = `${event.toolName}:${toolCalls}:${attempt}`;
        this.trackAction(req, {
          id,
          kind: event.toolName,
          summary: event.isError ? "attempted and failed — verify before retrying" : "completed successfully",
        });
      }
      const activityToolName = "toolName" in event ? event.toolName : undefined;
      if (
        activity &&
        activityToolName !== terminatingName &&
        activityToolName !== CHECKPOINT_PROGRESS_TOOL_NAME &&
        activityToolName !== CLAIM_DELIVERABLE_TOOL_NAME
      ) {
        emitWorkerActivity(req, activity);
      }
      if (
        event.type === "tool_execution_end" &&
        (event.toolName === CHECKPOINT_PROGRESS_TOOL_NAME || event.toolName === CLAIM_DELIVERABLE_TOOL_NAME) &&
        !event.isError
      ) {
        const details = event.result?.details as { claims?: unknown } | undefined;
        emitWorkerActivity(req, {
          kind: "checkpoint",
          summary: "Checkpoint progress recorded",
          meaningfulProgress: true,
          claims: details?.claims as never,
        });
      }
      // Capture the terminating tool (worker_result or review_result).
      if (event.type === "tool_execution_end" && event.toolName === terminatingName) {
        if (!event.isError) {
          if (terminatingName === "worker_result") {
            const details = event.result?.details as WorkerResult | undefined;
            if (details?.status) captured = details;
          } else {
            structured = event.result?.details;
          }
        }
      }
      // Count tool executions and feed progress to the guard.
      if (event.type === "tool_execution_start" && event.toolName !== terminatingName) {
        toolCalls++;
        guard.onProgress("tool_call");
      }
      // Feed streaming text to the guard and enforce budget.
      if (
        (event.type === "message_update" || event.type === "message_end") &&
        typeof event.message === "object" &&
        event.message !== null
      ) {
        enforceBudget(event.message);
        const msg = event.message as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
        // A provider/gateway failure surfaces as a terminal assistant message
        // rather than a throw. Keep the text so the caller can tell a rate
        // limit from a degeneration.
        if (msg.role === "assistant" && msg.stopReason === "error" && msg.errorMessage) {
          assistantError = msg.errorMessage;
        }
        // `event.message` is the ACCUMULATED partial message; charge the guard
        // the incremental delta the stream event carries (see guardFeedFor).
        if (msg.role === "assistant" && !guardAborted) {
          const feed = event.type === "message_update" ? guardFeedFor(event, msg.content) : null;
          if (feed) {
            const decision = feed.kind === "delta" ? guard.feed(feed.text) : guard.feedSnapshot(feed.text);
            if (decision.abort) {
              guardAborted = true;
              guardReason = decision.reason;
              guardDiagnostics = decision.diagnostics ?? {};
              void session.abort();
            }
          }
        }
      }
    });

    // The owner signal is the sole liveness/limit authority when present (the
    // broker watches activity from before setup/worktree allocation).
    // Standalone executor callers without an owner signal keep the local
    // inactivity guard armed above.
    armInactivity();
    const abortFromOwner = (): void => {
      ownerAborted = true;
      const reason = req.signal?.reason;
      if (reason instanceof DOMException && (reason.name === "TimeoutError" || reason.name === "InactivityError")) {
        timedOut = true;
      }
      void session.abort();
    };
    req.signal?.addEventListener("abort", abortFromOwner, { once: true });

    const scanForTerminatingResult = (): void => {
      for (const msg of session.messages) {
        if (msg.role === "toolResult" && msg.toolName === terminatingName && !msg.isError && msg.details) {
          if (terminatingName === "worker_result") {
            const d = msg.details as unknown as WorkerResult;
            if (d?.status) captured = d;
          } else {
            structured = msg.details;
          }
          break;
        }
      }
    };

    try {
      emitWorkerActivity(req, { kind: "state", summary: "Worker session started", meaningfulProgress: false });
      // Covers a request that never begins streaming: armed from prompt start
      // until the first stream event (or the first tool).
      armStall();
      // Canceled while queued for a slot: aborting a session that has not
      // started prompting is a no-op, so never start it.
      if (req.signal?.aborted) abortFromOwner();
      else
        try {
          await session.prompt(req.kickoff ?? WORKER_KICKOFF, {
            images: req.images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
            expandPromptTemplates: false,
          });
        } catch (err) {
          // A guard abort rejects the prompt; the steer below handles it.
          if (!guardAborted) throw err;
        }
      // First guard trip of the run: steer inside the same session rather than
      // restarting with the context cut away. A second trip falls through to
      // the recovery ladder's fresh session.
      if (
        attempt === 0 &&
        guardAborted &&
        !captured &&
        structured === undefined &&
        !budgetExhausted &&
        !timedOut &&
        !ownerAborted &&
        !loopPrevented &&
        !req.signal?.aborted
      ) {
        guardAborted = false;
        guardReason = undefined;
        guardDiagnostics = {};
        guard.reset();
        emitWorkerActivity(req, {
          kind: "state",
          summary: "Guard tripped; steering the session",
          meaningfulProgress: false,
        });
        await session.prompt(GUARD_STEER_PROMPT, { expandPromptTemplates: false });
      }
      // A cut stream after tool calls ran: resume the same session. The
      // executed calls and their results stay in the history; only the failed
      // partial assistant message is dropped (src/inference/streamResume.ts).
      for (;;) {
        // A terminating result already delivered must not be thrown away.
        scanForTerminatingResult();
        const resumable =
          !req.signal?.aborted &&
          captured === undefined &&
          structured === undefined &&
          toolCalls > 0 &&
          !guardAborted &&
          !budgetExhausted &&
          !timedOut &&
          !ownerAborted &&
          !stalled &&
          !loopPrevented &&
          isCutStreamError(assistantError) &&
          classifyError(assistantError).category !== "context_overflow" &&
          streamResumes.count < this.streamResumeMax;
        if (!resumable) break;
        const resumeFrom = dropFailedTail(session.agent.state.messages as AssistantLike[]);
        if (!resumeFrom) break;
        streamResumes.count++;
        const delay = backoffDelayMs(streamResumes.count, this.transientConfig, this.transientRand);
        const summary = `Stream cut after tool calls (${assistantError}); resuming the session in ${Math.round(delay / 1000)}s (resume ${streamResumes.count}/${this.streamResumeMax}) · executed tool calls are kept, not replayed`;
        emitWorkerActivity(req, { kind: "state", summary, meaningfulProgress: false });
        emitTelemetry({ level: "info", key: "worker:stream-resume", text: summary });
        await this.transientSleep(delay);
        session.agent.state.messages = resumeFrom as typeof session.agent.state.messages;
        assistantError = undefined;
        await session.agent.continue();
      }
      // Order matters: guard steer, then stream resume, then (only on a clean
      // end) the nudge. A cut stream or overflow leaves assistantError set, so
      // the nudge never fires on the same turn as a resume or overflow retry.
      // The session ended cleanly without the terminating call: one nudge in
      // the SAME session (its prefix is cached, so this is cheap), counted as
      // the same attempt. Ignored, it settles as the usual no-result failure.
      if (
        captured === undefined &&
        structured === undefined &&
        !guardAborted &&
        !budgetExhausted &&
        !timedOut &&
        !ownerAborted &&
        !stalled &&
        !loopPrevented &&
        assistantError === undefined &&
        !req.signal?.aborted
      ) {
        await session.prompt(terminatingName === "worker_result" ? NUDGE_MESSAGE : REVIEW_NUDGE_MESSAGE, {
          expandPromptTemplates: false,
        });
      }
    } catch (err) {
      // Capture the error. An abort triggered by the guard/budget/timeout is
      // EXPECTED (session.abort()) and not a transport failure. A rejection
      // with none of those flags set is a real provider/transport error (503,
      // 429, network, timeout) that the transient-recovery layer retries.
      if (!guardAborted && !budgetExhausted && !timedOut && !ownerAborted && !stalled) {
        promptError = err;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (silenceTimer) this.clock.clearTimeout(silenceTimer);
      if (wrapUpTimer) this.clock.clearTimeout(wrapUpTimer);
      disarmStall();
      req.signal?.removeEventListener("abort", abortFromOwner);
      unsubscribe();
      apsDetach?.();
    }

    // Surface a retryable transport error so runWithGuard's withTransientRetry
    // loop can backoff+retry. Permanent/unknown errors fall through and are
    // reported as a failed worker below (no silent retry of non-transient bugs).
    if (promptError !== undefined) {
      const cls = classifyError(promptError);
      if (cls.retryable) {
        session.dispose();
        throw new TransientError(
          cls.category,
          promptError instanceof Error ? promptError.message : String(promptError),
          1,
          {
            cause: promptError,
          },
        );
      }
    }

    // Fallback: scan messages for the terminating tool result.
    if (!captured && !guardAborted) scanForTerminatingResult();

    // Silent stream death: the provider closed the SSE stream before any
    // finish_reason arrived (observed on the metabolomics gateway under
    // momentary load — zero tokens, sub-second session end). No exception is
    // thrown, so the promptError ladder above never sees it and the run used
    // to settle as a permanent "no worker_result" failure. Surface it as
    // retryable — but only AFTER the fallback scan, and only when the session
    // produced no terminating result of either kind (worker_result or a
    // reviewer's review_result): a run that already delivered its result must
    // not be thrown away and re-run because its final turn was cut. And only
    // before any tool ran: a fresh-session replay re-runs every tool (bash
    // included) under a new wall-clock budget, so a cut after progress settles
    // as a non-transient `truncated_after_progress` failure instead.
    if (
      captured === undefined &&
      structured === undefined &&
      toolCalls === 0 &&
      !guardAborted &&
      !budgetExhausted &&
      !timedOut &&
      !loopPrevented &&
      (isTruncatedStream(assistantError) || isTransportDrop(assistantError))
    ) {
      // A transport drop (undici "terminated": a gateway restart cut the
      // socket) arrives the same way — an assistant-message error, no throw —
      // and is retried under the same no-progress rule, as a network failure.
      session.dispose();
      throw new TransientError("network", assistantError!, 1);
    }

    // Model stream stall with no progress (defect C): the watchdog aborted a
    // request the gateway held open without data. A fresh session is cheap
    // here (no tools to re-run), so retry it as a network failure through the
    // existing transient ladder. A stall AFTER progress settles in the
    // failure path below as transient:network (isStalledStream) so the
    // scheduler's time-based resilience window — not an LLM repair task —
    // owns the wait and the retry.
    if (stalled && !guardAborted && !budgetExhausted && !timedOut && toolCalls === 0) {
      session.dispose();
      throw new TransientError("network", assistantError!, 1);
    }

    return {
      session,
      guardAborted,
      guardReason,
      guardDiagnostics,
      loopPrevented,
      loopPreventedEvent,
      captured,
      structured,
      toolCalls,
      budgetExhausted,
      timedOut,
      assistantError,
    };
  }

  /** Build the per-attempt APS activity adapter (null when detection is disabled). */
  private createApsAdapter(req: WorkerRequest, model: Model<any>): WorkerActivityAdapter | null {
    if (this.aps === false) return null;
    // Phase 3 enforcement config rides in the supervisor options: when a
    // sustained no-progress loop reaches the prevention threshold the
    // supervisor fires `onPrevented`, which the run loop wires to abort the
    // session and surface a `loop_prevented` outcome.
    const prevention =
      this.loopPrevention === false || !this.rollout.prevention
        ? { ...DEFAULT_LOOP_PREVENTION, enabled: false }
        : { ...DEFAULT_LOOP_PREVENTION, ...(this.loopPrevention ?? {}) };
    return new WorkerActivityAdapter({
      role: req.role,
      sessionId: req.sessionId,
      runId: req.runId,
      workItemId: req.workItemId,
      model: { provider: model.provider, id: model.id },
      maxContextTokens: req.maxContextTokens,
      rootPrefix: req.cwd,
      supervisorOptions: {
        ...(this.aps ?? {}),
        prevention,
        // Phase 6 observability: record detection-only loop candidates. Prevented
        // events are recorded separately via the loop_prevented path, so this
        // only captures candidates that were NOT prevented (avoids double count).
        onEvent: (event) => {
          if (this.rollout.observability && event.type !== "agent.loop_prevented") {
            this.observability.recordCandidate(event);
          }
        },
      },
    });
  }

  /** Cast session messages to the shape collectUsage expects. */
  private asMessages(messages: readonly unknown[]): readonly { role: string }[] {
    return messages as readonly { role: string }[];
  }

  /** Extract text content from a message's content field. */
  private extractMessageText(content: unknown): string | undefined {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === "object" && block !== null) {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          }
        }
      }
      return parts.length > 0 ? parts.join("") : undefined;
    }
    return undefined;
  }

  /** Estimate output tokens from session messages (for telemetry). */
  private estimateOutputTokens(messages: readonly unknown[]): number {
    let tokens = 0;
    for (const msg of messages) {
      const m = msg as { role?: string; usage?: { output?: number } };
      if (m.role === "assistant" && m.usage?.output != null) {
        tokens += m.usage.output;
      }
    }
    return tokens;
  }

  /** Emit a structured telemetry event (spec §21). */
  private emitTelemetry(event: import("../guard/RecoveryController.ts").DegenerationEvent | EscalationEvent): void {
    // Through the sink rather than straight to stderr: headless that still
    // writes the line, and inside Pi it becomes a notice the TUI renders
    // instead of raw JSON painted over whatever the TUI had drawn.
    if (process.env.PI_GUARD_TELEMETRY !== "false") {
      const isEscalation = "toModel" in event;
      emitTelemetry({
        level: "warning",
        text: isEscalation
          ? `aps escalation: ${event.role} ${event.toModel ? `-> ${event.toModel}` : "-> human"} · ${event.reason.replaceAll("_", " ")}`
          : `generation guard: aborted ${event.model} · ${event.reason.replaceAll("_", " ")}`,
        detail: event,
      });
    }
  }

  private collectUsage(messages: readonly { role: string }[], streamResumes = 0): WorkerUsage | null {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let contextTokens = 0;
    let turns = 0;
    let model = "";
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const m = msg as { usage?: Record<string, unknown>; model?: string };
      const u = m.usage as
        | {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
            cost?: { total?: number };
          }
        | undefined;
      if (!u) continue;
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
      contextTokens = Math.max(contextTokens, u.totalTokens ?? 0);
      turns++;
      if (m.model) model = m.model;
    }
    if (turns === 0) return null;
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      cost,
      contextTokens,
      turns,
      model,
      ...(streamResumes > 0 ? { streamResumes } : {}),
    };
  }
}

/**
 * Roles whose deliverable is prose (findings / assessment / summary) rather
 * than a tool call. These workers must be allowed to write a substantial
 * report; the generic worker guard's tight budgets are for tool-driven roles
 * whose only job is to call `worker_result` after acting.
 */
const PROSE_ROLES: ReadonlySet<WorkerRole> = new Set<WorkerRole>([
  "reviewer",
  "architecture-reviewer",
  "security-review",
  "performance-review",
  "clean-room-challenger",
  "scout",
  "summarizer",
]);

/**
 * Gate roles judge work and have no side effects, so a dead route must not be
 * waited on in-session: after this many transient retries the failure goes to
 * the backend, which moves the role to another route. Implementers keep the
 * full transient policy.
 */
const GATE_ROLES: ReadonlySet<WorkerRole> = new Set<WorkerRole>([
  "reviewer",
  "architecture-reviewer",
  "security-review",
  "performance-review",
  "clean-room-challenger",
]);

/** In-session transient retries a gate role gets (`PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS`, default 2). */
function gateRetryCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_GUARD_GATE_TRANSIENT_MAX_ATTEMPTS;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

const CONNECT_LEVEL = /connection error|econn(?:refused|reset)|enotfound|eai_again|fetch failed|socket hang up/i;

/** A gate role's attempt failed on a host that refuses connections or does not resolve. */
class ConnectRefusedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ConnectRefusedError";
  }
}

/** True only when a TCP connect to the provider is refused or its host does not resolve. */
function connectRefused(baseUrl: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl ?? "");
    } catch {
      resolve(false);
      return;
    }
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    });
    const done = (refused: boolean) => {
      socket.destroy();
      resolve(refused);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "EAI_AGAIN"),
    );
  });
}

/**
 * A review must inspect evidence and write concrete findings. It should never
 * be cut off for "not making progress" while it is composing its report.
 */
const PROSE_NO_PROGRESS_BUDGET = 32_000;
const PROSE_NARRATION_BUDGET = 24_000;

/**
 * Derive a role-adjusted generation-guard config.
 *
 * Tool-driven roles keep the strict defaults (loop mitigation). Prose roles get
 * generous narration and no-progress budgets so a legitimate written review is
 * not aborted as degeneration. All other detectors (repetition, recovery
 * ladder) remain active for both groups.
 */
export function guardConfigForRole(role: WorkerRole, base: GenerationGuardConfig): GenerationGuardConfig {
  if (!PROSE_ROLES.has(role)) return base;
  return {
    ...base,
    maxNarrationTokensBeforeAction: PROSE_NARRATION_BUDGET,
    maxReasoningTokensWithoutProgress: PROSE_NO_PROGRESS_BUDGET,
  };
}

/**
 * Build a compact system prompt for recovery attempt 2+ (spec §17).
 *
 * Instead of appending recovery prompts to an ever-growing system prompt,
 * this rebuilds a focused, compact checkpoint that contains only what the
 * model needs to make progress: the task, the role, and the recovery
 * instruction. Verbose context from prior attempts is deliberately excluded.
 */
export function buildCompactedWorkerPrompt(req: WorkerRequest, recoveryPrompt: string | null): string {
  const parts: string[] = [];
  parts.push(`# Task`);
  parts.push(req.task);
  parts.push("");
  parts.push(`# Role`);
  parts.push(req.role);
  parts.push("");

  // Include only a compact slice of the context (first 500 chars) to avoid
  // re-introducing the verbose context that may have contributed to the loop.
  const verifiedContext = req.context;
  if (verifiedContext?.trim()) {
    const compactContext = verifiedContext.trim();
    const sliced = compactContext.length > 500 ? `${compactContext.slice(0, 500)}… [truncated]` : compactContext;
    parts.push(`# Context (compacted)`);
    parts.push(sliced);
    parts.push("");
  }

  const durableRecovery = durableRecoveryContext(req);
  if (durableRecovery) {
    parts.push(`# Durable Recovery Context (untruncated)`);
    parts.push(durableRecovery);
    parts.push("");
  }

  // The recovery prompt is the primary instruction for this attempt.
  if (recoveryPrompt) {
    parts.push(`# Recovery Instruction`);
    parts.push(recoveryPrompt);
    parts.push("");
  }

  // Base rules (kept short — the model already knows its role).
  parts.push(`Rules:`);
  parts.push(`- Use the available tools; never guess APIs or signatures.`);
  // Same gate as the full prompt: never tell a read-only role, or a worker in
  // the user's own checkout, to commit.
  if (wantsCommitDiscipline(req.role, req)) {
    parts.push(
      "- Commit when a coherent step is done; uncommitted work is harvested automatically. Never switch branches, rebase, amend others' commits, or push.",
    );
  }
  if (offersCheckpointProgress(req)) {
    parts.push(
      `- Declared checkpoint deliverables: ${(req.deliverables ?? []).map((d) => `"${d}"`).join(", ")}. After a coherent commit, call checkpoint_progress claiming the deliverable with the EXACT declared string (no paraphrasing) plus the exact git rev-parse HEAD and committed evidence paths.`,
    );
  }
  if (offersClaimDeliverable(req)) {
    parts.push(
      `- Declared deliverables: ${(req.deliverables ?? []).map((d) => `"${d}"`).join(", ")}. When one is finished, call claim_deliverable with its name.`,
    );
  }
  parts.push(`- Your final action MUST be calling the worker_result tool.`);
  parts.push(`- Do not ask questions. Do not emit an assistant answer after calling worker_result.`);

  return parts.join("\n");
}

/**
 * Append the idempotency notice to a retried generation's prompt (spec §6).
 *
 * The notice LISTS the tool calls that already executed and forbids repeating
 * them; the runtime never replays an action. Idempotent, so a second retry does
 * not stack a second notice onto the same prompt.
 */
export function withIdempotencyEvidence(prompt: string, tracker: ExecutedActionTracker | undefined): string {
  const evidence = tracker?.evidenceForRetry();
  if (!evidence || prompt.includes(evidence)) return prompt;
  return `${prompt}\n\n${evidence}`;
}

/**
 * `checkpoint_progress` is opt-in by name. Mission workers do not get it: the
 * broker derives checkpoints from the worker branch's commits.
 */
function offersClaimDeliverable(req: WorkerRequest): boolean {
  return !!req.deliverables?.length && req.tools.includes(CLAIM_DELIVERABLE_TOOL_NAME);
}

function offersCheckpointProgress(req: WorkerRequest): boolean {
  return !!req.deliverables?.length && req.tools.includes(CHECKPOINT_PROGRESS_TOOL_NAME);
}

export function workerContext(req: WorkerRequest): string | undefined {
  const checkpoint = offersCheckpointProgress(req)
    ? `Declared checkpoint deliverables: ${(req.deliverables ?? []).map((d) => `"${d}"`).join(", ")}. After each coherent commit, run git rev-parse HEAD and call checkpoint_progress with the completed deliverable (using its EXACT declared string, no paraphrasing), that exact candidate SHA, and committed evidence paths.`
    : undefined;
  if (!req.recovery) return [req.context, checkpoint].filter(Boolean).join("\n\n") || undefined;
  const durable = durableRecoveryContext(req)!;
  return [req.context?.trim(), checkpoint, durable].filter(Boolean).join("\n\n");
}

function durableRecoveryContext(req: WorkerRequest): string | undefined {
  if (!req.recovery) return undefined;
  const recovery = req.recovery;
  const durable = [
    "Verified durable checkpoint recovery context (immutable):",
    `decision=${recovery.recoveryDecisionId}`,
    `replacementFingerprint=${recovery.expectedReplacementFingerprint}`,
    `supersession=${recovery.supersessionId}`,
    `mission=${recovery.missionId}`,
    `repository=${recovery.repoId}`,
    `missionGeneration=${recovery.missionGeneration}`,
    `candidateGeneration=${recovery.candidateGeneration}`,
    `fencingToken=${recovery.fencingToken}`,
    `resumptionGeneration=${recovery.resumptionGeneration}`,
    `checkpoint=${recovery.checkpointId}`,
    `originalTask=${recovery.originalTaskId}`,
    `originalExecution=${recovery.originalExecutionId}`,
    `candidateSha=${recovery.candidateSha}`,
    `sourceBranch=${recovery.sourceBranch}`,
    `sourceWorktree=${recovery.sourceWorktree}`,
    `committedPaths=${recovery.committedPaths.join(",")}`,
    `formerlyDirtyPaths=${recovery.formerlyDirtyPaths.join(",")}`,
    `completedDeliverables=${recovery.completedDeliverables.join(",")}`,
    `artifactRefs=${recovery.artifactRefs.join(",")}`,
    `artifactHashes=${recovery.artifactHashes.join(",")}`,
  ].join("\n");
  return durable;
}
