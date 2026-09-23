/**
 * APS Phase 2 — worker session activity adapter (observability + wiring).
 *
 * Turns the REAL worker/agent tool-call activity — the session events the Pi
 * SDK already emits on its existing event bus (`AgentSession.subscribe`) —
 * into `AgentAction` records and feeds them to an `AgentProgressSupervisor`,
 * so loop detection actually runs during missions. No new bus: the adapter
 * subscribes to the same session event stream the executor already consumes.
 *
 * DETECT-ONLY (Phase 2): observing never mutates the observed session, never
 * aborts it, and never throws into it. A failing supervisor degrades to
 * "no detection" for that action.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { id } from "../core/ids.ts";
import { ToolCallNormalizer, canonicalJson, semanticFingerprint } from "./fingerprint.ts";
import { AgentProgressSupervisor, type AgentProgressSupervisorOptions } from "./supervisor.ts";
import type { AgentAction } from "./types.ts";

/** Maximum length of the bounded tool-result summary fed to the fingerprint. */
const RESULT_SUMMARY_MAX_CHARS = 400;
/** Safety bound on in-flight tool calls tracked per session. */
const MAX_PENDING_TOOL_CALLS = 256;

export interface WorkerActivityAdapterOptions {
  /** Role of the acting agent (e.g. "implementer"). */
  role: string;
  /** Stable session identity. Generated when omitted. */
  sessionId?: string;
  /** Run the session belongs to, when known. */
  runId?: string;
  /** Work item the session is scoped to, if any. */
  workItemId?: string | null;
  /** Model producing the session's actions (provider + id), when known. */
  model?: { provider: string; id: string } | null;
  /** Configured context budget in tokens, when configured (context-utilization). */
  maxContextTokens?: number;
  /** Pipeline phase label for the actions. Defaults to "execute". */
  phase?: string;
  /** Normalizer override; defaults to one rooted at `rootPrefix`. */
  normalizer?: ToolCallNormalizer;
  /** Session cwd, stripped from path arguments during normalization. */
  rootPrefix?: string;
  /**
   * Supervisor to feed. A fresh per-session supervisor is created (from
   * `supervisorOptions`) when omitted, so one session's bounded window never
   * mixes with another's.
   */
  supervisor?: AgentProgressSupervisor;
  /** Options for the fresh supervisor when `supervisor` is omitted. */
  supervisorOptions?: AgentProgressSupervisorOptions;
}

/**
 * Minimal structural view of the existing session event bus: anything with
 * `subscribe(listener): unsubscribe` (Pi's `AgentSession` satisfies this).
 */
export interface SessionEventBus {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export class WorkerActivityAdapter {
  readonly supervisor: AgentProgressSupervisor;
  readonly sessionId: string;
  private readonly role: string;
  private readonly runId: string;
  private readonly workItemId: string | null;
  private readonly model: { provider: string; id: string } | null;
  private readonly maxContextTokens: number | undefined;
  private readonly phase: string;
  private readonly normalizer: ToolCallNormalizer;
  private iteration = -1;
  private inputTokens: number | undefined;
  private readonly pending = new Map<string, { tool: string; args: Record<string, unknown> }>();
  private readonly actionLog: AgentAction[] = [];

  constructor(options: WorkerActivityAdapterOptions) {
    this.role = options.role;
    this.sessionId = options.sessionId ?? id("APSSESS");
    this.runId = options.runId ?? id("RUN");
    this.workItemId = options.workItemId ?? null;
    this.model = options.model ?? null;
    this.maxContextTokens = options.maxContextTokens;
    this.phase = options.phase ?? "execute";
    this.normalizer = options.normalizer ?? new ToolCallNormalizer({ rootPrefix: options.rootPrefix });
    this.supervisor = options.supervisor ?? new AgentProgressSupervisor(options.supervisorOptions ?? {});
  }

  /**
   * Attach to the EXISTING session event bus. Returns the unsubscribe
   * function; call it when the session ends. Detect-only: subscribing has no
   * effect on the session's behaviour.
   */
  attach(bus: SessionEventBus): () => void {
    return bus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * Feed one session event. Only `tool_execution_start`, `tool_execution_end`
   * and `message_end` are relevant; everything else is ignored.
   */
  handleEvent(event: AgentSessionEvent): void {
    if (event.type === "tool_execution_start") {
      if (this.pending.size >= MAX_PENDING_TOOL_CALLS) this.pending.clear();
      this.pending.set(event.toolCallId, {
        tool: event.toolName,
        args: (event.args ?? {}) as Record<string, unknown>,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const started = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId);
      this.observeToolEnd(event.toolName, started?.args ?? {}, event.result, event.isError);
      return;
    }
    if (event.type === "message_end") {
      const message = event.message as { role?: string; usage?: { input?: number; totalTokens?: number } } | undefined;
      const usage = message?.role === "assistant" ? message.usage : undefined;
      const tokens = usage?.input ?? usage?.totalTokens;
      if (typeof tokens === "number" && Number.isFinite(tokens)) {
        this.inputTokens = tokens;
      }
    }
  }

  /** All AgentActions recorded so far, in order (for tests and inspection). */
  get actions(): readonly AgentAction[] {
    return this.actionLog;
  }

  private observeToolEnd(tool: string, args: Record<string, unknown>, result: unknown, isError: boolean): void {
    const summary = summarizeToolResult(result, isError);
    const normalizedArguments = this.normalizer.normalize({ name: tool, arguments: args }).arguments;
    const action: AgentAction = {
      role: this.role,
      iteration: ++this.iteration,
      tool,
      normalizedArguments,
      toolResultSummary: summary,
      contentFingerprint: semanticFingerprint(
        { tool, normalizedArguments, toolResultSummary: summary },
        this.normalizer,
      ),
      phase: this.phase,
      sessionId: this.sessionId,
      runId: this.runId,
      workItemId: this.workItemId,
      occurredAt: new Date().toISOString(),
      modelProvider: this.model?.provider,
      modelId: this.model?.id,
      inputTokens: this.inputTokens,
      maxContextTokens: this.maxContextTokens,
    };
    this.actionLog.push(action);
    // Detect-only and side-effect-free for the observed session: a failing
    // supervisor must never throw into (or slow down) the run.
    this.supervisor.observe(action).catch(() => {});
  }
}

/**
 * Bounded, stable summary of a tool result: identical results summarize
 * identically (so unchanged state does not look like progress), different
 * results summarize differently (so a changed state does).
 */
export function summarizeToolResult(result: unknown, isError: boolean): string {
  const prefix = isError ? "error" : "ok";
  return `${prefix}:${truncate(extractResultText(result), RESULT_SUMMARY_MAX_CHARS)}`;
}

function extractResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  const r = result as { content?: unknown; text?: unknown; output?: unknown };
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const part of r.content) {
      if (typeof part === "string") parts.push(part);
      else if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join(" ");
  }
  if (typeof r.text === "string") return r.text;
  if (typeof r.output === "string") return r.output;
  try {
    return canonicalJson(result);
  } catch {
    return String(result);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
