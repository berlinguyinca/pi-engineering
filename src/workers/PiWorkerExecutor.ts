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
import type { AdmissionEventBus } from "../inference/admissionEvents.ts";
import type { AdmissionScope } from "../inference/admissionTransport.ts";
import { reviewResultTool } from "../lifecycle/reviewResultTool.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "./WorkerExecutor.ts";
import { type LocalAdmissionOptions, registerLocalProviders } from "./localProviders.ts";
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
  /**
   * Share an already-built ModelRuntime instead of creating one. The
   * engineering lifecycle shares its runtime so discovery and execution always
   * see the same provider inventory.
   */
  modelRuntime?: ModelRuntime;
  /**
   * Enable InferWeave admission-retry handling for locally registered nodes.
   * When supplied, admission rejections become scheduler-directed waits instead
   * of terminal failures, and admission waits are excluded from the worker's
   * wall-clock timeout budget.
   */
  admission?: LocalAdmissionOptions;
  /** Shared admission event bus (usually the harness's). */
  admissionEvents?: AdmissionEventBus;
}

/**
 * Real fresh-context worker execution backed by Pi's SDK (INV-002, AC-018).
 *
 * Every task runs in a brand-new in-memory session with a role-specific system
 * prompt and tool allowlist, so no prior reasoning is inherited. The worker must
 * finish by calling `worker_result` (or `review_result` for review roles); usage
 * is captured from assistant messages.
 *
 * The model is selected per request when `modelOverride` is supplied, which is
 * how the capability router places each role on a specific provider model.
 */
export class PiWorkerExecutor implements WorkerExecutor {
  private readonly agentDir: string;
  private readonly customTools: ToolDefinition[];
  private readonly model: Model<any> | undefined;
  private readonly allowModelNetwork: boolean;
  private readonly admission: LocalAdmissionOptions | undefined;
  private readonly admissionEvents: AdmissionEventBus | undefined;
  /** sessionId -> scope, so a shared runtime can attribute waits to the right worker. */
  private readonly activeScopes = new Map<string, AdmissionScope>();
  private modelRuntime: ModelRuntime | undefined;
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(opts: PiWorkerExecutorOptions = {}) {
    this.agentDir = opts.agentDir ?? process.env.PI_AGENT_DIR ?? "~/.pi/agent";
    this.customTools = opts.customTools ?? [];
    this.model = opts.model;
    this.allowModelNetwork = opts.allowModelNetwork ?? false;
    this.admission = opts.admission;
    this.admissionEvents = opts.admissionEvents;
    if (opts.modelRuntime) {
      this.modelRuntime = opts.modelRuntime;
      this.runtimePromise = Promise.resolve(opts.modelRuntime);
    }
  }

  /** Register the scope for a worker session so admission events carry its role. */
  private registerSessionScope(sessionId: string, scope: AdmissionScope): () => void {
    this.activeScopes.set(sessionId, scope);
    return () => this.activeScopes.delete(sessionId);
  }

  private scopeFor(sessionId?: string): AdmissionScope {
    if (sessionId && this.activeScopes.has(sessionId)) {
      return this.activeScopes.get(sessionId)!;
    }
    return {};
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
      await registerLocalProviders(rt, {
        ...(this.admission ? { admission: { ...this.admission, scope: this.scopeFor.bind(this) } } : {}),
      }).catch(() => {});
      return rt;
    })();
    return this.runtimePromise;
  }

  /** The runtime used for discovery + model resolution (shared with the router). */
  async runtime(): Promise<ModelRuntime> {
    return this.getModelRuntime();
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const systemPrompt = req.systemPromptOverride ?? buildSystemPrompt(req.role, req.task, req.context);
    const resourceLoader = roleResourceLoader(systemPrompt);

    const modelRuntime = await this.getModelRuntime();
    let model = this.model;
    if (req.modelOverride) {
      const resolved = modelRuntime.getModel(req.modelOverride.provider, req.modelOverride.id) as
        | Model<any>
        | undefined;
      if (!resolved) {
        return {
          result: {
            status: "failed",
            summary: `Routed model ${req.modelOverride.provider}/${req.modelOverride.id} is not registered in this runtime.`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: "model-not-registered",
          },
          error: "model-not-registered",
          usage: null,
        };
      }
      model = resolved;
    }
    if (!model) {
      const available = await modelRuntime.getAvailable();
      model = available[0] as Model<any> | undefined;
    }

    const sessionManager = SessionManager.inMemory(req.cwd);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });

    const terminating = req.resultTool === "review_result" ? reviewResultTool : workerResultTool;
    const customTools = [...this.customTools, terminating];
    // Tool allowlist must include custom tool names to enable them.
    const tools = [...new Set([...req.tools, ...customTools.map((t) => t.name)])];

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
    const sessionId = session.sessionId ?? sessionManager.getSessionId();
    const unregisterScope = this.registerSessionScope(sessionId, {
      sessionId,
      role: req.role,
    });

    try {
      let captured: WorkerResult | undefined;
      let structured: unknown;
      let lastAssistantError: string | undefined;
      let toolCalls = 0;
      let budgetExhausted = false;

      // Capture worker_result, count tool executions, and enforce the hard
      // context-token budget (spec §10.6). Usage arrives on the final chunk of
      // a message (message_end / message_update), so we check both.
      const enforceBudget = (message: unknown): void => {
        if (!req.maxContextTokens) return;
        const m = message as { usage?: { totalTokens?: number } };
        const total = m?.usage?.totalTokens;
        if (typeof total === "number" && total > req.maxContextTokens && !budgetExhausted) {
          budgetExhausted = true;
          void session.abort();
        }
      };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === terminating.name) {
          if (!event.isError) {
            if (terminating === workerResultTool) {
              const details = event.result?.details as WorkerResult | undefined;
              if (details?.status) captured = details;
            } else {
              structured = event.result?.details;
            }
          }
        }
        if (event.type === "tool_execution_start" && event.toolName !== terminating.name) {
          toolCalls++;
        }
        if ((event.type === "message_end" || event.type === "message_update") && typeof event.message === "object") {
          enforceBudget(event.message);
        }
      });

      // Wall-clock budget. Admission waits are excluded: each scheduled wait
      // for this session extends the deadline by the same amount, so a
      // 30-second scheduler wait never burns a 5-minute worker budget.
      let timedOut = false;
      const baseTimeout = req.timeoutMs ?? 300_000;
      let deadline = Date.now() + baseTimeout;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(
          () => {
            timedOut = true;
            void session.abort();
          },
          Math.max(0, deadline - Date.now()),
        );
      };
      arm();
      const unsubWait = this.admissionEvents?.subscribe((event) => {
        if (event.sessionId !== sessionId) return;
        if (event.name !== "inference.retry.scheduled" && event.name !== "inference.retry.waiting") return;
        const waitMs = event.delayUsedMs ?? event.retryAfterMs ?? 0;
        if (waitMs <= 0) return;
        deadline += waitMs;
        arm();
      });

      try {
        await session.prompt(req.kickoff ?? WORKER_KICKOFF, {
          images: req.images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
          expandPromptTemplates: false,
        });
      } catch (err) {
        lastAssistantError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
        unsubWait?.();
        unregisterScope();
        unsubscribe();
      }

      // Fallback: scan messages for the terminating tool result.
      if (!captured && !structured) {
        for (const msg of session.messages) {
          if (msg.role === "toolResult" && msg.toolName === terminating.name && !msg.isError && msg.details) {
            if (terminating === workerResultTool) {
              const d = msg.details as WorkerResult;
              if (d?.status) captured = d;
            } else {
              structured = msg.details;
            }
            break;
          }
        }
      }

      const usage = this.collectUsage(session.messages);
      if (terminating === reviewResultTool) {
        return {
          result: {
            status: structured ? "completed" : "failed",
            summary: structured ? "Review recorded." : "Reviewer returned no review_result.",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: structured ? undefined : (lastAssistantError ?? (timedOut ? "timeout" : "no-result")),
          },
          structured,
          usage,
          error: structured ? undefined : (lastAssistantError ?? (timedOut ? "timeout" : "no-result")),
          toolCalls,
        };
      }
      if (!captured) {
        const reason = budgetExhausted
          ? "Worker exceeded the hard context-token budget."
          : timedOut
            ? "Worker timed out."
            : `Worker returned no worker_result.${lastAssistantError ? ` ${lastAssistantError}` : ""}`;
        return {
          result: {
            status: "failed",
            summary: reason,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: lastAssistantError ?? (budgetExhausted ? "budget-exhausted" : timedOut ? "timeout" : "no-result"),
          },
          usage,
          error: lastAssistantError ?? (budgetExhausted ? "budget-exhausted" : timedOut ? "timeout" : "no-result"),
          toolCalls,
        };
      }
      return { result: captured, usage, toolCalls };
    } finally {
      session.dispose();
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
