import { homedir } from "node:os";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { WorkerResult, WorkerUsage } from "../core/types.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "./WorkerExecutor.ts";
import { buildSystemPrompt, WORKER_KICKOFF } from "./prompts.ts";
import { workerResultTool } from "./workerResultTool.ts";
import { registerLocalProviders } from "./localProviders.ts";

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
  private modelRuntime: ModelRuntime | undefined;
  private runtimePromise: Promise<ModelRuntime> | undefined;

  constructor(opts: PiWorkerExecutorOptions = {}) {
    this.agentDir = opts.agentDir ?? process.env.PI_AGENT_DIR ?? "~/.pi/agent";
    this.customTools = opts.customTools ?? [];
    this.model = opts.model;
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = (async () => {
      const rt = await ModelRuntime.create({
        authPath: joinExpand(this.agentDir, "auth.json"),
        modelsPath: joinExpand(this.agentDir, "models.json"),
        allowModelNetwork: false,
      });
      await registerLocalProviders(rt).catch(() => {});
      return rt;
    })();
    return this.runtimePromise;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const systemPrompt = buildSystemPrompt(req.role, req.task, req.context);
    const resourceLoader = roleResourceLoader(systemPrompt);

    const modelRuntime = await this.getModelRuntime();
    let model = this.model;
    if (!model) {
      const available = await modelRuntime.getAvailable();
      model = available[0] as Model<any> | undefined;
    }

    const sessionManager = SessionManager.inMemory(req.cwd);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });

    const customTools = [...this.customTools, workerResultTool];
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

    try {
      let captured: WorkerResult | undefined;
      let lastAssistantError: string | undefined;

      // Capture worker_result via tool execution events (robust to message shape).
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "worker_result") {
          if (!event.isError) {
            const details = event.result?.details as WorkerResult | undefined;
            if (details?.status) captured = details;
          }
        }
      });

      // Wall-clock budget.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, req.timeoutMs ?? 300_000);

      try {
        await session.prompt(WORKER_KICKOFF);
      } catch (err) {
        lastAssistantError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }

      // Fallback: scan messages for the worker_result tool result.
      if (!captured) {
        for (const msg of session.messages) {
          if (msg.role === "toolResult" && msg.toolName === "worker_result" && !msg.isError && msg.details) {
            const d = msg.details as WorkerResult;
            if (d?.status) captured = d;
            break;
          }
        }
      }

      const usage = this.collectUsage(session.messages);
      if (!captured) {
        return {
          result: {
            status: "failed",
            summary: timedOut ? "Worker timed out." : `Worker returned no worker_result.${lastAssistantError ? ` ${lastAssistantError}` : ""}`,
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error: lastAssistantError ?? (timedOut ? "timeout" : "no-result"),
          },
          usage,
          error: lastAssistantError ?? (timedOut ? "timeout" : "no-result"),
        };
      }
      return { result: captured, usage };
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
        | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }
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
