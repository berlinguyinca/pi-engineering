import { homedir } from "node:os";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { AGENT_LOOP_PREVENTED_EVENT, type AgentProgressSupervisorOptions } from "../aps/supervisor.ts";
import { type AgentLoopPreventedEvent, DEFAULT_LOOP_PREVENTION } from "../aps/types.ts";
import { WorkerActivityAdapter } from "../aps/workerActivity.ts";
import type { WorkerResult, WorkerRole, WorkerUsage } from "../core/types.ts";
import type { AdmissionController } from "../gateway/AdmissionController.ts";
import { type GatewayAdmissionConfig, sharedAdmissionController, sharedGatewayConfig } from "../gateway/config.ts";
import { decideGatewayRetry, parseGatewayWait } from "../gateway/signals.ts";
import { GenerationGuard, type GuardAbortReason } from "../guard/GenerationGuard.ts";
import { TOOL_TRANSITION_RULE } from "../guard/RecoveryController.ts";
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
  classifyError,
  initialTransientTelemetry,
  recordTransientError,
  recordTransientOutcome,
  resolveTransientRetryConfig,
  withTransientRetry,
} from "../guard/transient.ts";
import { reviewResultTool } from "../lifecycle/reviewResultTool.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "./WorkerExecutor.ts";
import { registerLocalProviders } from "./localProviders.ts";
import { WORKER_KICKOFF, buildSystemPrompt } from "./prompts.ts";
import { workerResultTool } from "./workerResultTool.ts";

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
  /**
   * APS loop-detection for worker sessions (Phase 2, detect-only): tool-call
   * activity is turned into AgentAction records and fed to an
   * AgentProgressSupervisor, which emits `agent.loop_candidate` events.
   * Default `{}` (enabled with default thresholds); `false` disables.
   */
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
}

/**
 * Real fresh-context worker execution backed by Pi's SDK (INV-002, AC-018).
 *
 * Every task runs in a brand-new in-memory session with a role-specific system
 * prompt and tool allowlist, so no prior reasoning is inherited. The worker must
 * finish by calling `worker_result`; usage is captured from assistant messages.
 */
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
  /** APS loop-detection options for worker sessions (`false` disables). */
  private readonly aps: AgentProgressSupervisorOptions | false | undefined;
  /** APS loop-prevention options (`false` disables enforcement). */
  private readonly loopPrevention: import("../aps/types.ts").LoopPreventionOptions | false | undefined;
  private modelRuntime: ModelRuntime | undefined;
  private runtimePromise: Promise<ModelRuntime> | undefined;
  /** Aggregate recovery telemetry across all worker runs. */
  readonly recoveryTelemetry: RecoveryTelemetry = initialRecoveryTelemetry();
  /** Aggregate transient-error retry telemetry across all worker runs. */
  readonly transientTelemetry: TransientTelemetry = initialTransientTelemetry();

  constructor(opts: PiWorkerExecutorOptions = {}) {
    this.agentDir = opts.agentDir ?? process.env.PI_AGENT_DIR ?? "~/.pi/agent";
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
    this.aps = opts.aps;
    this.loopPrevention = opts.loopPrevention;
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
        authPath: joinExpand(this.agentDir, "auth.json"),
        modelsPath: joinExpand(this.agentDir, "models.json"),
        allowModelNetwork: this.allowModelNetwork,
      });
      await registerLocalProviders(rt).catch(() => {});
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

    // Build the base system prompt with the Tool Transition Rule (spec §15).
    // Specialist roles may supply their own prompt wholesale.
    const baseSystemPrompt =
      req.systemPromptOverride ??
      `${buildSystemPrompt(req.role, req.task, req.context)}

${TOOL_TRANSITION_RULE}`;

    // Run the worker with the generation guard and recovery ladder.
    return this.runWithGuard(req, model, baseSystemPrompt, modelRuntime);
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
    const terminating = req.resultTool === "review_result" ? reviewResultTool : workerResultTool;
    const customTools = [...this.customTools, terminating];
    const tools = [...new Set([...req.tools, ...customTools.map((t) => t.name)])];
    let model: Model<any> = initialModel;
    let systemPrompt: string = initialPrompt;
    let attempt = 0;
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

    // Prose-producing roles (reviewers, challenger, scout, summarizer) deliver
    // prose findings/assessments, not a tool call. The generic worker guard's
    // tight narration/no-progress budgets (600 / 1500 tokens) treated a
    // legitimate written review as "excessive narration" / "no progress" and
    // aborted it — a false failure that made independent reviews fail on a
    // token budget instead of on merit. Derive a role-adjusted guard so these
    // roles get a generous prose budget while tool-driven roles keep the
    // strict loop-mitigation defaults.
    const guardConfig = guardConfigForRole(req.role, this.guardConfig);

    while (true) {
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
      const slot = gatewayConfig.enabled ? await admission.acquire() : null;
      let transientOutcome: Awaited<
        ReturnType<typeof withTransientRetry<Awaited<ReturnType<typeof this.runSingleAttempt>>>>
      >;
      try {
        transientOutcome = await withTransientRetry({
          fn: () =>
            this.runSingleAttempt(req, model, systemPrompt, modelRuntime, customTools, tools, attempt, guardConfig),
          config: this.transientConfig,
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
        if (gatewayConfig.enabled) {
          const handover = decideGatewayRetry(detail, gatewayRetries, gatewayConfig.maxRetries);
          if (handover.action === "wait") {
            gatewayRetries++;
            await admission.noteWaitAndSleep(handover.signal);
            continue;
          }
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
            details: { transient_category: category, attempts },
            error: `transient:${category}`,
          },
          usage: null,
          error: `transient:${category}`,
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

      if (captured) {
        // Success — record recovery outcome if we were in a retry.
        if (attempt > 0) {
          recordRetryOutcome(this.recoveryTelemetry, true, false);
        }
        if (gatewayConfig.enabled) admission.noteSuccess();
        const usage = this.collectUsage(this.asMessages(session.messages));
        return { result: captured, usage, toolCalls, structured };
      }

      // Gateway saturation: honour the wait the gateway reported, hold every
      // other model caller in this process behind the same cooldown, and retry
      // the SAME attempt (no recovery-ladder escalation).
      if (gatewayConfig.enabled) {
        const decision = decideGatewayRetry(assistantError, gatewayRetries, gatewayConfig.maxRetries);
        if (decision.action === "wait") {
          gatewayRetries++;
          await admission.noteWaitAndSleep(decision.signal);
          continue;
        }
      }

      // Phase 3 enforcement outcome: the supervisor PREVENTED a sustained loop
      // and aborted the run. This is terminal for the attempt — not a guard
      // recovery-ladder case and not a transient retry. The broker preserves
      // any partial edits and does not integrate failed work.
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
        const usage = this.collectUsage(this.asMessages(session.messages));
        const detail = { loop_prevented: true, no_progress_turns: loopPreventedEvent?.metrics.noProgressTurns ?? 0 };
        return {
          result: {
            status: "failed",
            summary: `Agent loop prevented after ${detail.no_progress_turns} identical no-progress turns (${AGENT_LOOP_PREVENTED_EVENT}).`,
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

      if (!guardAborted || !this.guardConfig.enabled) {
        // Non-guard failure (timeout, budget, gateway, no-result) — no recovery ladder.
        const gateway = lastAssistantError ? parseGatewayWait({ text: lastAssistantError }) : null;
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
              ? `gateway:${gateway.reason ?? gateway.type ?? gateway.status ?? "rate-limited"}`
              : (lastAssistantError ?? "no-result");
        return {
          result: {
            status: "failed",
            summary: reason,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: gateway ? { gateway_wait: gateway, gateway_retries: gatewayRetries } : {},
            error,
          },
          usage: this.collectUsage(this.asMessages(session.messages)),
          error,
          toolCalls,
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
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
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

    const unsubscribe = session.subscribe((event) => {
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

    // Wall-clock budget.
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, req.timeoutMs ?? 300_000);

    try {
      await session.prompt(req.kickoff ?? WORKER_KICKOFF, {
        images: req.images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
        expandPromptTemplates: false,
      });
    } catch (err) {
      // Capture the error. An abort triggered by the guard/budget/timeout is
      // EXPECTED (session.abort()) and not a transport failure. A rejection
      // with none of those flags set is a real provider/transport error (503,
      // 429, network, timeout) that the transient-recovery layer retries.
      if (!guardAborted && !budgetExhausted && !timedOut) {
        promptError = err;
      }
    } finally {
      clearTimeout(timer);
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
    if (!captured && !guardAborted) {
      for (const msg of session.messages) {
        if (msg.role === "toolResult" && msg.toolName === terminatingName && !msg.isError && msg.details) {
          if (terminatingName === "worker_result") {
            const d = msg.details as WorkerResult;
            if (d?.status) captured = d;
          } else {
            structured = msg.details;
          }
          break;
        }
      }
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
      this.loopPrevention === false
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
      supervisorOptions: { ...(this.aps ?? {}), prevention },
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
  private emitTelemetry(event: import("../guard/RecoveryController.ts").DegenerationEvent): void {
    // Through the sink rather than straight to stderr: headless that still
    // writes the line, and inside Pi it becomes a notice the TUI renders
    // instead of raw JSON painted over whatever the TUI had drawn.
    if (process.env.PI_GUARD_TELEMETRY !== "false") {
      emitTelemetry({
        level: "warning",
        text: `generation guard: aborted ${event.model} · ${event.reason.replaceAll("_", " ")}`,
        detail: event,
      });
    }
  }

  private collectUsage(messages: readonly { role: string }[]): WorkerUsage | null {
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
    return { input, output, cacheRead, cacheWrite, cost, contextTokens, turns, model };
  }
}

function joinExpand(base: string, rel: string): string {
  const expanded = base.replace(/^~(?=$|\/)/, homedir());
  return expanded.endsWith("/") ? `${expanded}${rel}` : `${expanded}/${rel}`;
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
function buildCompactedWorkerPrompt(req: WorkerRequest, recoveryPrompt: string | null): string {
  const parts: string[] = [];
  parts.push(`# Task`);
  parts.push(req.task);
  parts.push("");
  parts.push(`# Role`);
  parts.push(req.role);
  parts.push("");

  // Include only a compact slice of the context (first 500 chars) to avoid
  // re-introducing the verbose context that may have contributed to the loop.
  if (req.context?.trim()) {
    const compactContext = req.context.trim();
    const sliced = compactContext.length > 500 ? `${compactContext.slice(0, 500)}… [truncated]` : compactContext;
    parts.push(`# Context (compacted)`);
    parts.push(sliced);
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
  parts.push(`- Your final action MUST be calling the worker_result tool.`);
  parts.push(`- Do not ask questions. Do not emit an assistant answer after calling worker_result.`);

  return parts.join("\n");
}
