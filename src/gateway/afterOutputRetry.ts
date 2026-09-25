/**
 * Retrying a turn whose stream was cut AFTER partial output.
 *
 * The gateway pump (streamRetry.ts) retries a failure only while nothing has
 * reached the transcript. Once tokens are out — a linked route that drops
 * mid-answer ("Connection lost: the route serving this model ended before the
 * response did …"), a socket that dies ("terminated") — the pump must let the
 * failure through, and the turn ended. Pi's own `retryAssistantCall` would
 * discard the partial message and retry, but many users run with Pi's
 * `retry.enabled: false`, and extensions have no settings API to change that.
 *
 * Pi 0.87.1 gives extensions a supported seam instead: the
 * `agent_before_settle` boundary may append session entries and request one
 * more provider request (`continue: true`). On a retryable transport failure,
 * this module appends a `context_edit` that omits the failed partial message
 * from the model's context — exactly what Pi's own retry does — and asks Pi to
 * continue. The run comes back through the same boundary after every attempt,
 * so retrying continues until the route is back.
 *
 * The WAIT between attempts is not taken inside the boundary handler: during
 * `agent_before_settle` the run has ended, `ctx.signal` is undefined, and Esc
 * only sets a flag Pi reads after the handler returns — a minutes-long sleep
 * there would make Esc unresponsive. The pending delay is taken instead by the
 * gateway wrapper just before the continued request is sent (`beforeSend`),
 * against that request's own abort signal, so Esc ends the wait at once.
 *
 * Infrastructure outages (a model reloading, moving GPUs, a gateway restart)
 * can last hours, so there is no attempt cap: capped exponential backoff with
 * jitter, bounded by a long elapsed horizon (12h by default). The schedule is
 * a small interface so a shared long-wait policy can replace it.
 *
 * Ownership — one owner per failure, no nesting:
 * - failures BEFORE any visible output belong to the gateway pump
 *   (streamRetry.ts), which waits them out inside the provider call (with the
 *   long-wait horizon of feat/long-wait-transient-retry); this controller
 *   ignores them;
 * - failures AFTER visible output belong here;
 * - Pi's own retry (when the user enabled it) runs first — this boundary is
 *   only reached once Pi has given up — so the two never retry at once.
 *
 * The owed wait is keyed by (provider, model) and only the continued request
 * for that model takes it — never a summarization call or another model's
 * call. A model whose calls never pass the wrapper cannot be paced, so it is
 * not retried at all (with a notice) rather than retried in a tight loop.
 */

// The compat entry, not the utils/* subpaths: Pi's extension loader aliases
// "@earendil-works/pi-ai/compat" to the host's pi-ai, while a subpath would
// bind whatever copy happens to be installed next to this package.
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { isBodyTooLarge } from "../request/bodyBudget.ts";
import { isSummarizationRequest } from "../request/thinkingPolicy.ts";
import { emitTelemetry } from "../telemetry/sink.ts";
import { isGatewayLinkCut } from "./signals.ts";

// ─── Schedule ──────────────────────────────────────────────────────────────

/** How long to wait before retry `attempt` (1-based), and for how long in total. */
export interface RetrySchedule {
  delayMs(attempt: number): number;
  /** Stop retrying once this long has passed since the first failure. */
  horizonMs: number;
}

export interface LongWaitScheduleOptions {
  baseMs: number;
  capMs: number;
  /** Fraction of the delay added at random (0..1). */
  jitter: number;
  horizonMs: number;
  random?: () => number;
}

export const DEFAULT_AFTER_OUTPUT_SCHEDULE: LongWaitScheduleOptions = {
  baseMs: 2_000,
  capMs: 3 * 60 * 1000,
  jitter: 0.2,
  horizonMs: 12 * 60 * 60 * 1000,
};

export function longWaitSchedule(options: LongWaitScheduleOptions): RetrySchedule {
  const random = options.random ?? Math.random;
  return {
    horizonMs: options.horizonMs,
    delayMs(attempt) {
      const exponent = Math.min(Math.max(0, attempt - 1), 30);
      const nominal = Math.min(options.capMs, options.baseMs * 2 ** exponent);
      return Math.round(nominal + nominal * options.jitter * random());
    },
  };
}

function positive(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Defaults, overridable with PI_AFTER_OUTPUT_RETRY_{HORIZON,CAP,BASE}_MS. The
 * horizon defaults to the one shared retry window, PI_GATEWAY_MAX_ELAPSED_MS
 * (the pump's elapsed budget), so every layer gives up at the same time.
 */
export function resolveAfterOutputSchedule(
  env: Record<string, string | undefined> = process.env,
): LongWaitScheduleOptions {
  return {
    ...DEFAULT_AFTER_OUTPUT_SCHEDULE,
    horizonMs:
      positive(env.PI_AFTER_OUTPUT_RETRY_HORIZON_MS) ??
      positive(env.PI_GATEWAY_MAX_ELAPSED_MS) ??
      DEFAULT_AFTER_OUTPUT_SCHEDULE.horizonMs,
    capMs: positive(env.PI_AFTER_OUTPUT_RETRY_CAP_MS) ?? DEFAULT_AFTER_OUTPUT_SCHEDULE.capMs,
    baseMs: positive(env.PI_AFTER_OUTPUT_RETRY_BASE_MS) ?? DEFAULT_AFTER_OUTPUT_SCHEDULE.baseMs,
  };
}

// ─── Classification ────────────────────────────────────────────────────────

interface AssistantLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown;
}

/**
 * A failed assistant turn worth replaying from the same context: a transport
 * drop or link cut (Pi's own retry patterns, plus the gateway's link-cut
 * wording). Never an abort (Esc), a context overflow (compaction's job), or a
 * request the gateway will always refuse (body size, auth, schema).
 */
export function isRetryableTransportFailure(message: AssistantLike | undefined, contextWindow = 0): boolean {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return false;
  // Before visible output the pump owns the failure (and waits it out itself).
  if (!hasVisibleOutput(message)) return false;
  const text = message.errorMessage ?? "";
  if (isBodyTooLarge(text)) return false;
  if (isContextOverflow(message as never, contextWindow)) return false;
  return isGatewayLinkCut(text) || isRetryableAssistantError(message as never);
}

/** Did the failed turn put anything on screen (text, thinking, a tool call)? */
export function hasVisibleOutput(message: AssistantLike): boolean {
  if (!Array.isArray(message.content)) return false;
  return (message.content as Array<{ type?: string; text?: string; thinking?: string; name?: string }>).some(
    (block) =>
      (block.type === "text" && (block.text ?? "").trim() !== "") ||
      (block.type === "thinking" && (block.thinking ?? "").trim() !== "") ||
      block.type === "toolCall",
  );
}

/** A short name for the failure, for the status line. */
export function failureKind(text: string): string {
  if (isGatewayLinkCut(text)) return "link cut";
  if (/terminated|socket hang up|other side closed/i.test(text)) return "connection dropped";
  return "transport error";
}

// ─── The retry controller ──────────────────────────────────────────────────

interface ProjectedEntry {
  sourceEntry: { id: string };
  messages: AssistantLike[];
}

interface BeforeSettleEvent {
  outcome: "completed" | "aborted" | "error";
  entries: unknown[];
  context: { contextEntries: ProjectedEntry[] };
}

interface ModelKey {
  provider?: string;
  id?: string;
}

function keyOf(model: ModelKey | undefined): string {
  return `${model?.provider ?? "?"}/${model?.id ?? "?"}`;
}

interface SettleContext {
  model?: { contextWindow?: number; provider?: string; id?: string };
  ui?: { setStatus?(key: string, text: string | undefined): void };
}

export interface AfterOutputRetryOptions {
  schedule?: Partial<LongWaitScheduleOptions> | RetrySchedule;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const STATUS_KEY = "pi-engineering:after-output-retry";

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatWait(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`;
}

function formatHorizon(ms: number): string {
  return ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : formatWait(ms);
}

export class AfterOutputRetry {
  private readonly schedule: RetrySchedule;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  private attempt = 0;
  private firstFailureAt: number | undefined;
  /** The wait owed before the continued request for a model is sent. */
  private readonly pending = new Map<string, { delayMs: number; attempt: number; kind: string }>();
  /** Models whose calls pass the gateway wrapper (so a wait can be taken). */
  private readonly paced = new Set<string>();
  private ui: SettleContext["ui"];

  constructor(options: AfterOutputRetryOptions = {}) {
    const schedule = options.schedule;
    this.schedule =
      schedule && "delayMs" in schedule && typeof schedule.delayMs === "function"
        ? (schedule as RetrySchedule)
        : longWaitSchedule({
            ...resolveAfterOutputSchedule(),
            ...((schedule as Partial<LongWaitScheduleOptions>) ?? {}),
          });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  /** Register on a Pi extension host (needs Pi ≥ 0.87.1 for agent_before_settle). */
  register(pi: { on(event: string, handler: (event: never, ctx: never) => unknown): void }): void {
    pi.on("agent_before_settle", ((event: BeforeSettleEvent, ctx: SettleContext) =>
      this.onBeforeSettle(event, ctx)) as never);
    pi.on("agent_settled", (() => this.reset()) as never);
  }

  private reset(): void {
    this.attempt = 0;
    this.firstFailureAt = undefined;
    this.pending.clear();
  }

  /** Record that `model`'s calls pass the wrapper. Called by beforeSend. */
  observe(model: ModelKey): void {
    this.paced.add(keyOf(model));
  }

  /** Owe a wait before `model`'s next (non-summary) call. */
  owe(model: ModelKey, delayMs: number, attempt: number, kind: string): void {
    this.pending.set(keyOf(model), { delayMs, attempt, kind });
  }

  private onBeforeSettle(event: BeforeSettleEvent, ctx: SettleContext) {
    if (event.outcome !== "error") {
      // A completed turn ends the episode; Esc (aborted) ends it too.
      this.reset();
      return undefined;
    }
    const failed = this.lastFailed(event.context.contextEntries);
    if (!failed || !isRetryableTransportFailure(failed.message, ctx.model?.contextWindow ?? 0)) {
      this.reset();
      return undefined;
    }
    const key = keyOf(ctx.model);
    if (!this.paced.has(key) || this.pending.has(key)) {
      // Either this model's calls never pass the gateway wrapper, or the last
      // owed wait was never taken (the continued request bypassed it). Retrying
      // now would be unpaced — a tight loop for hours — so stop instead.
      emitTelemetry({
        level: "warning",
        key: "after-output-retry:unpaced",
        text: `Not retrying the cut-off answer: requests to ${key} do not pass the pi-engineering gateway wrapper, so no backoff can be applied (${failed.message.errorMessage ?? "unknown error"}).`,
      });
      this.reset();
      return undefined;
    }
    const now = this.now();
    this.firstFailureAt ??= now;
    if (now - this.firstFailureAt >= this.schedule.horizonMs) {
      emitTelemetry({
        level: "warning",
        key: "after-output-retry:horizon",
        text: `Stopped retrying after ${formatHorizon(now - this.firstFailureAt)} of connection failures (limit ${formatHorizon(this.schedule.horizonMs)}): ${failed.message.errorMessage ?? "unknown error"}`,
      });
      this.reset();
      return undefined;
    }
    this.attempt++;
    const delayMs = this.schedule.delayMs(this.attempt);
    const kind = failureKind(failed.message.errorMessage ?? "");
    this.owe(ctx.model ?? {}, delayMs, this.attempt, kind);
    this.ui = ctx.ui;
    emitTelemetry({
      level: "info",
      key: "after-output-retry:attempt",
      text: `Answer cut off mid-stream (${kind}); retrying in ${formatWait(delayMs)} (attempt ${this.attempt}, for up to ${formatHorizon(this.schedule.horizonMs)}; Esc stops).`,
    });
    // Omit the failed partial answer from the model's context (Pi's own retry
    // does the same) and ask for one more provider request. Boundary results
    // REPLACE the accumulated drafts, so keep other handlers' entries.
    return {
      entries: [...(event.entries ?? []), { type: "context_edit", targetId: failed.entryId, replacement: null }],
      continue: true,
    };
  }

  private lastFailed(entries: ProjectedEntry[]): { entryId: string; message: AssistantLike } | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const assistants = (entry?.messages ?? []).filter((m) => m.role === "assistant");
      const message = assistants[assistants.length - 1];
      if (message) return message.stopReason === "error" ? { entryId: entry!.sourceEntry.id, message } : undefined;
    }
    return undefined;
  }

  /**
   * Called by the gateway wrapper before a request is sent. Takes the wait owed
   * by a pending retry against the request's own abort signal. Resolves
   * "aborted" when Esc ends the wait.
   */
  async beforeSend(
    model: ModelKey,
    signal: AbortSignal | undefined,
    context?: { systemPrompt?: string; messages: unknown[] },
  ): Promise<"go" | "aborted"> {
    this.observe(model);
    // A summary (compaction) or another model's call must not take the wait.
    if (context && isSummarizationRequest(context)) return "go";
    const key = keyOf(model);
    const pending = this.pending.get(key);
    if (!pending) return "go";
    this.pending.delete(key);
    const until = this.now() + pending.delayMs;
    const status = () =>
      this.ui?.setStatus?.(
        STATUS_KEY,
        `Answer cut off (${pending.kind}) — retrying in ${formatWait(Math.max(0, until - this.now()))} (attempt ${pending.attempt}; Esc to stop)`,
      );
    const tick = setInterval(() => {
      try {
        status();
      } catch {
        // A stale session UI must not break the retry.
      }
    }, 1000);
    try {
      status();
      await this.sleep(pending.delayMs, signal);
      return "go";
    } catch {
      this.reset();
      return "aborted";
    } finally {
      clearInterval(tick);
      try {
        this.ui?.setStatus?.(STATUS_KEY, undefined);
      } catch {
        // Ignore a stale session UI.
      }
    }
  }
}
