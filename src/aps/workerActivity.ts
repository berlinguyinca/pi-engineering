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
import { TARGET_ARGUMENT_KEYS, ToolCallNormalizer, canonicalJson, semanticFingerprint } from "./fingerprint.ts";
import { AgentProgressSupervisor, type AgentProgressSupervisorOptions } from "./supervisor.ts";
import { evaluateTaskAlignment, type AlignmentSignal, type DeclaredArtifact, type TaskAction } from "./taskAlignment.ts";
import { type AgentAction, isMutatingTool } from "./types.ts";

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
  /** Operator-declared scope/artifact contract to watch live actions against. */
  drift?: DriftWatch;
  /** Env source for the drift switch; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Sink for each newly detected drift signal (evidence only; never affects the run). */
  onDrift?: (signal: AlignmentSignal) => void;
}

/**
 * What the operator declared the task may touch and must produce. Without a
 * contract there is nothing to watch: the adapter stays silent.
 */
export interface DriftWatch {
  allowedScope: readonly string[];
  declaredTasks?: readonly string[];
  declaredArtifacts?: readonly DeclaredArtifact[];
  allowedDependencies?: readonly string[];
}

/** Affirmative-only switch: only an explicit true-ish value turns live drift signals on. */
export function driftSignalsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.PI_TASK_DRIFT_SIGNALS ?? "").trim());
}

/** Safety bound on distinct drift signals retained per session. */
const MAX_DRIFT_SIGNALS = 64;

/** One recorded action -> detector input, target taken from the canonical argument keys. */
function alignmentAction(action: AgentAction): TaskAction {
  const target = TARGET_ARGUMENT_KEYS.map((key) => action.normalizedArguments[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
  return { iteration: action.iteration, tool: action.tool, target, taskId: action.workItemId ?? undefined, mutating: isMutatingTool(action.tool) };
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
  private readonly driftWatch: DriftWatch | undefined;
  private readonly driftEnabled: boolean;
  private readonly onDrift: ((signal: AlignmentSignal) => void) | undefined;
  private readonly driftLog: AlignmentSignal[] = [];

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
    this.driftWatch = options.drift;
    this.driftEnabled = options.drift !== undefined && driftSignalsEnabled(options.env ?? process.env);
    this.onDrift = options.onDrift;
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

  /** Distinct drift signals detected so far, in first-observation order (evidence only). */
  get driftSignals(): readonly AlignmentSignal[] {
    return this.driftLog;
  }

  /** Live drift watch: evaluates one action against the declared contract, never throws. */
  private observeDrift(action: AgentAction): void {
    if (!this.driftEnabled || !this.driftWatch || this.driftLog.length >= MAX_DRIFT_SIGNALS) return;
    try {
      const signals = evaluateTaskAlignment({
        allowedScope: this.driftWatch.allowedScope,
        declaredTasks: this.driftWatch.declaredTasks ?? [],
        declaredArtifacts: this.driftWatch.declaredArtifacts ?? [],
        allowedDependencies: this.driftWatch.allowedDependencies ?? [],
        actions: [alignmentAction(action)],
      });
      for (const signal of signals) {
        if (this.driftLog.some((seen) => seen.kind === signal.kind && seen.subject === signal.subject)) continue;
        this.driftLog.push(signal);
        try { this.onDrift?.(signal); } catch { /* a failing sink never breaks the run */ }
      }
    } catch { /* evidence-only: a malformed action never breaks the session */ }
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
    this.observeDrift(action);
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
