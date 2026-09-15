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
import type { WorkerResult, WorkerUsage } from "../core/types.ts";
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
  private modelRuntime: ModelRuntime | undefined;
  private runtimePromise: Promise<ModelRuntime> | undefined;
  /** Aggregate recovery telemetry across all worker runs. */
  readonly recoveryTelemetry: RecoveryTelemetry = initialRecoveryTelemetry();

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
  }

  /** Inject/refresh the semantic tools bound to a runtime (scout/reviewer/implementer sessions). */
  setCustomTools(tools: ToolDefinition[]): void {
    (this as unknown as { customTools: ToolDefinition[] }).customTools = tools;
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
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

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const modelRuntime = await this.getModelRuntime();
    let model = this.model;
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
    const baseSystemPrompt = `${buildSystemPrompt(req.role, req.task, req.context)}

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
    const customTools = [...this.customTools, workerResultTool];
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

    while (true) {
      const slot = gatewayConfig.enabled ? await admission.acquire() : null;
      let outcome: Awaited<ReturnType<typeof this.runSingleAttempt>>;
      try {
        outcome = await this.runSingleAttempt(req, model, systemPrompt, modelRuntime, customTools, tools, attempt);
      } finally {
        slot?.release();
      }
      const {
        session,
        guardAborted,
        guardReason,
        guardDiagnostics,
        captured,
        toolCalls,
        budgetExhausted,
        timedOut,
        assistantError,
      } = outcome;
      if (assistantError) lastAssistantError = assistantError;

      session.dispose();

      if (captured) {
        // Success — record recovery outcome if we were in a retry.
        if (attempt > 0) {
          recordRetryOutcome(this.recoveryTelemetry, true, false);
        }
        if (gatewayConfig.enabled) admission.noteSuccess();
        const usage = this.collectUsage(this.asMessages(session.messages));
        return { result: captured, usage, toolCalls };
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
  ): Promise<{
    session: { dispose: () => void; messages: readonly unknown[] };
    guardAborted: boolean;
    guardReason?: GuardAbortReason;
    guardDiagnostics: Record<string, unknown>;
    captured?: WorkerResult;
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

    let captured: WorkerResult | undefined;
    let toolCalls = 0;
    let budgetExhausted = false;
    let timedOut = false;
    let guardAborted = false;
    let guardReason: GuardAbortReason | undefined;
    let guardDiagnostics: Record<string, unknown> = {};
    let assistantError: string | undefined;

    // Generation guard (spec §6-§12).
    const guard = new GenerationGuard(this.guardConfig);
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
      // Capture worker_result.
      if (event.type === "tool_execution_end" && event.toolName === "worker_result") {
        if (!event.isError) {
          const details = event.result?.details as WorkerResult | undefined;
          if (details?.status) captured = details;
        }
      }
      // Count tool executions and feed progress to the guard.
      if (event.type === "tool_execution_start" && event.toolName !== "worker_result") {
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
      await session.prompt(WORKER_KICKOFF);
    } catch {
      // Expected when the session is aborted by the guard or budget.
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }

    // Fallback: scan messages for the worker_result tool result.
    if (!captured && !guardAborted) {
      for (const msg of session.messages) {
        if (msg.role === "toolResult" && msg.toolName === "worker_result" && !msg.isError && msg.details) {
          const d = msg.details as WorkerResult;
          if (d?.status) captured = d;
          break;
        }
      }
    }

    return {
      session,
      guardAborted,
      guardReason,
      guardDiagnostics,
      captured,
      toolCalls,
      budgetExhausted,
      timedOut,
      assistantError,
    };
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
    // Write to stderr for observability without polluting stdout.
    // In production this would route to the telemetry exporter.
    if (process.env.PI_GUARD_TELEMETRY !== "false") {
      process.stderr.write(`[generation-guard] ${JSON.stringify(event)}\n`);
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
