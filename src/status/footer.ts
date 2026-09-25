/**
 * Footer controller — the single footer ownership point in the harness.
 *
 * This is the ONLY place that calls `ctx.ui.setFooter()`. Individual harness
 * modules must not compete with multiple `setFooter()` calls; other harness
 * functionality publishes status fragments/state to `StatusState` and this
 * controller renders it. It composes Pi's branch/status data (`footerData`)
 * rather than rediscovering git itself where Pi already provides it.
 *
 * Rendering is throttled/coalesced (never a per-token render storm) and the
 * render path never spawns git or network work (git context is cached and
 * invalidated intentionally).
 */

import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AdmissionEvent } from "../gateway/AdmissionController.ts";
import type { PanelState } from "../panel/PanelState.ts";
import { renderAmbient } from "./ambient.ts";
import type { StatusBarConfig } from "./config.ts";
import { GitContextProvider } from "./git-context.ts";
import { renderStatus } from "./layout.ts";
import { type HarnessStatusState, StatusState, type TaskState, type WaitState } from "./state.ts";
import { ThroughputTracker } from "./throughput.ts";

interface ModelInfo {
  provider?: string;
  id?: string;
}

function modelInfo(model: { provider?: string; id?: string } | undefined): ModelInfo {
  return model ? { provider: model.provider, id: model.id } : {};
}

/**
 * Countdown/spinner tick. Fast enough to animate the spinner (the layout
 * derives its frame from the clock), slow enough that a multi-minute hold is
 * not a render storm.
 */
const WAIT_TICK_MS = 250;

/** Extract streamed text from a message_update assistant event. */
function extractDelta(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const e = event as { assistantMessageEvent?: { type?: string; delta?: string } };
  const ae = e.assistantMessageEvent;
  if (!ae) return "";
  if (ae.type === "text_delta" && typeof ae.delta === "string") return ae.delta;
  return "";
}

/** Extract cumulative output tokens from a message event, defensively. */
function extractOutputTokens(event: unknown): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as {
    usage?: { output?: number };
    message?: { usage?: { output?: number } };
  };
  const v = e.usage?.output ?? e.message?.usage?.output;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export interface FooterControllerOptions {
  ctx: ExtensionContext;
  config: StatusBarConfig;
  /** Injectable monotonic clock (ms). Default Date.now. Deterministic in tests. */
  now?: () => number;
  /**
   * Resolver for the engineering state behind the ambient summary row.
   *
   * A resolver rather than a value: the footer is constructed at session start,
   * while the panel plumbing is created after an async repository lookup, so a
   * value captured here would be undefined forever.
   *
   * It lives in the footer rather than the panel because `ctx.ui.custom()`
   * takes keyboard focus and `setFooter` does not — this is the only surface
   * that can be permanently visible without costing the operator their
   * keyboard.
   */
  panelState?: () => PanelState | undefined;
  /**
   * Resolve the context window for a model id from the capability layer. Called
   * on model switch so the reading follows the model that is actually selected
   * instead of showing the window of the model the session started with.
   */
  capabilityWindow?: (modelId: string | undefined) => { windowTokens: number; note?: string } | undefined;
}

export class FooterController {
  private readonly ctx: ExtensionContext;
  private readonly config: StatusBarConfig;
  private readonly now: () => number;
  private readonly status: StatusState;
  private readonly throughput: ThroughputTracker;
  private readonly git: GitContextProvider;
  private readonly capabilityWindow?: (
    modelId: string | undefined,
  ) => { windowTokens: number; note?: string } | undefined;
  /** Window currently shown; kept so usage updates do not need the capability layer. */
  private contextWindowTokens = 0;
  private contextNote: string | undefined;

  private disposed = false;
  private renderRequest: (() => void) | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The session's own model, tracked across `model_select`. `ctx.model` is a
   * snapshot taken when the controller was constructed, so it goes stale the
   * moment the user switches models mid-session.
   */
  private sessionModel: string | undefined;
  private lastRenderAt = 0;
  private readonly unsubs: Array<() => void> = [];

  private readonly panelState: (() => PanelState | undefined) | undefined;

  constructor(opts: FooterControllerOptions) {
    this.ctx = opts.ctx;
    this.config = opts.config;
    this.panelState = opts.panelState;
    this.now = opts.now ?? (() => Date.now());
    this.throughput = new ThroughputTracker({
      windowMs: opts.config.throughputWindowMs,
      now: this.now,
      estimateCharsPerToken: opts.config.estimateCharsPerToken,
      estimateBatchChars: opts.config.estimateBatchChars,
    });
    this.capabilityWindow = opts.capabilityWindow;
    this.git = new GitContextProvider({ now: this.now, ttlMs: opts.config.gitCacheTtlMs });
    this.status = new StatusState({
      cwd: opts.ctx.cwd,
      throughput: { phase: "unavailable" },
    });

    const m = modelInfo(opts.ctx.model);
    this.sessionModel = m.id;
    this.status.set({ model: m.id, provider: m.provider });

    // Own the footer. This is the harness's single footer ownership point.
    this.ctx.ui.setFooter((tui, theme, footerData) => {
      this.renderRequest = () => tui.requestRender();
      // Pi's own branch watcher -> invalidate our git cache + refresh.
      const un = footerData.onBranchChange(() => {
        this.git.invalidate();
        void this.refreshGit();
      });
      this.unsubs.push(un);
      return {
        render: (width: number) => this.renderLine(width, theme, footerData),
        invalidate: () => {},
        dispose: () => {},
      };
    });

    void this.refreshGit();
  }

  /** Stream start: begin a fresh generation. */
  onMessageStart(): void {
    if (this.disposed) return;
    this.throughput.beginGeneration();
    this.publishThroughput();
  }

  /** Streaming update: feed usage + delta, recompute rolling TPS. */
  onMessageUpdate(event: unknown): void {
    if (this.disposed) return;
    const tokens = extractOutputTokens(event);
    const delta = extractDelta(event);
    this.throughput.onStreamEvent({
      cumulativeOutputTokens: tokens,
      deltaText: delta,
    });
    this.publishThroughput();
  }

  /** Stream end: reconcile with authoritative final usage. */
  onMessageEnd(event: unknown): void {
    if (this.disposed) return;
    const msg = (event as { message?: { role?: string; usage?: { output?: number } } } | undefined)?.message;
    const finalTokens =
      typeof msg?.usage?.output === "number" && Number.isFinite(msg.usage.output) ? msg.usage.output : undefined;
    this.throughput.endGeneration(finalTokens);
    this.publishThroughput();
  }

  /** Model switch: rebind the model and reset TPS (no stale rate from a prior model). */
  onModelSelect(model: { provider?: string; id?: string; contextWindow?: number } | undefined): void {
    if (this.disposed) return;
    const m = modelInfo(model);
    this.sessionModel = m.id;
    this.throughput.reset();
    // The window must follow the model: a 1M -> 128K switch that keeps showing
    // 1M is how a session walks into an impossible request. When the capability
    // layer does not know the new model, fall back to Pi's own registry window
    // for it (or clear) — never to the previous model's window.
    this.applyCapabilityWindow(m.id, model?.contextWindow);
    this.status.set({
      model: m.id,
      provider: m.provider,
      throughput: this.throughput.snapshot(),
    });
    this.requestRender();
  }

  /**
   * Translate a gateway admission event into footer wait state.
   *
   * Only `wait` events carry a deadline; clamp/relax change concurrency, which
   * is not something the operator needs in the footer.
   */
  onGatewayEvent(event: AdmissionEvent): void {
    if (this.disposed) return;
    if (event.type !== "wait") return;
    const signal = event.signal;
    this.setWait({
      kind: "gateway",
      detail: signal.reason ?? signal.type ?? String(signal.status ?? 429),
      untilMs: this.now() + event.waitMs,
      // Queue depth is what the footer shows instead of the 429 body: it is
      // the one number that says whether the hold is going anywhere.
      ...(signal.queued !== undefined ? { queued: signal.queued } : {}),
      ...(signal.queueLimit !== undefined ? { queueLimit: signal.queueLimit } : {}),
      // A long outage says how long it has lasted, not only the next countdown.
      ...(signal.waitingSinceMs !== undefined ? { sinceMs: signal.waitingSinceMs } : {}),
    });
  }

  /** Publish (or clear) the wait, starting or stopping the countdown tick. */
  setWait(wait: WaitState | undefined): void {
    if (this.disposed) return;
    this.status.set({ wait });
    // Any wait ticks, not just one with a deadline. The spinner is derived from
    // the clock, so without a tick it freezes — and an indefinite wait is
    // exactly the case where a frozen spinner is worst: the operator is
    // watching a saturated gateway, and a motionless spinner reads as a hung
    // session rather than a queue being waited out.
    if (wait) this.startWaitTick();
    else this.stopWaitTick();
    this.requestRender();
  }

  /** Publish (or clear) the engineering task in flight. */
  setTask(task: TaskState | undefined): void {
    if (this.disposed) return;
    this.status.set({ task });
    this.requestRender();
  }

  /**
   * Override the displayed model with the one actually producing tokens (a
   * worker's model during an engineering run). Pass undefined to restore the
   * session model, so the footer never keeps claiming a worker's model after
   * the run is over.
   */
  setProducingModel(model: string | undefined): void {
    if (this.disposed) return;
    this.status.set({ model: model ?? this.sessionModel });
    this.requestRender();
  }

  /**
   * Clear the task, but only if `workItemId` is the one on display.
   *
   * Parallel tournament legs and DAG waves each own a runtime and each report
   * their own settle, so an unconditional clear would blank the footer the
   * moment the FIRST leg finished while the others were still running. The
   * same guard covers a second run starting before the first one settles.
   */
  clearTask(workItemId: string): void {
    if (this.disposed) return;
    if (this.status.snapshot.task?.workItemId !== workItemId) return;
    this.setTask(undefined);
  }

  /**
   * Re-render the countdown; clears the wait once it has elapsed so the footer
   * never shows a stale "0s" hold.
   */
  tickWait(): void {
    if (this.disposed) return;
    const wait = this.status.snapshot.wait;
    if (!wait) {
      this.stopWaitTick();
      return;
    }
    if (wait.untilMs != null && this.now() >= wait.untilMs) {
      this.status.set({ wait: undefined });
      this.stopWaitTick();
    }
    this.requestRender();
  }

  /** Publish the session's current context usage (tokens) for the active model. */
  setContextUsage(usedTokens: number, windowTokens?: number): void {
    if (this.disposed) return;
    if (windowTokens !== undefined && windowTokens > 0) {
      this.contextWindowTokens = windowTokens;
      this.contextNote = undefined;
    }
    if (this.contextWindowTokens <= 0) return;
    this.status.set({
      context: { usedTokens, windowTokens: this.contextWindowTokens, note: this.contextNote },
    });
    this.requestRender();
  }

  /** Publish the capability-resolved window for the active model. */
  setCapabilityWindow(windowTokens: number, note?: string): void {
    if (this.disposed) return;
    this.contextWindowTokens = windowTokens;
    this.contextNote = note;
    const used = this.status.snapshot.context?.usedTokens ?? 0;
    this.status.set({ context: { usedTokens: used, windowTokens, note } });
    this.requestRender();
  }

  private applyCapabilityWindow(modelId: string | undefined, registryWindow?: number): void {
    try {
      const resolved = this.capabilityWindow?.(modelId);
      if (resolved && resolved.windowTokens > 0) {
        this.setCapabilityWindow(resolved.windowTokens, resolved.note);
        return;
      }
    } catch {
      // A capability lookup must never break the footer.
    }
    // No capability for this model. Carrying the previous model's window would
    // show a number that is not the window Pi enforces for the current model.
    if (registryWindow && registryWindow > 0) {
      this.setCapabilityWindow(registryWindow);
      return;
    }
    this.contextWindowTokens = 0;
    this.contextNote = undefined;
    const used = this.status.snapshot.context?.usedTokens ?? 0;
    this.status.set({ context: { usedTokens: used, windowTokens: 0, note: undefined } });
    this.requestRender();
  }

  /** cwd change: re-resolve git + refresh. */
  onCwdChange(cwd: string): void {
    if (this.disposed) return;
    this.status.set({ cwd });
    this.git.invalidate();
    void this.refreshGit();
  }

  /** Snapshot for `/harness-status` and future telemetry consumers. */
  get state(): Readonly<HarnessStatusState> {
    return this.status.snapshot;
  }

  /** Latest throughput snapshot (independent of terminal rendering). */
  throughputSnapshot() {
    return this.throughput.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const un of this.unsubs) un();
    this.unsubs.length = 0;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.stopWaitTick();
    this.throughput.reset();
    this.git.invalidate();
    this.status.dispose();
    this.ctx.ui.setFooter(undefined); // restore Pi's default footer
  }

  private renderLine(width: number, theme: Theme, footerData: ReadonlyFooterDataProvider): string[] {
    let line = "";
    try {
      line = renderStatus(this.status.snapshot, width, this.config, this.now());
    } catch {
      line = "";
    }
    const lines = [paint(theme, line)];
    // Engineering summary before other extensions' statuses: it is the row the
    // operator is here for, and a row they have to hunt for is one they stop
    // looking at.
    if (this.panelState) {
      try {
        const snapshot = this.panelState()?.snapshot;
        const ambient = snapshot ? renderAmbient(snapshot) : undefined;
        if (ambient) lines.push(paint(theme, truncateToWidth(ambient, Math.max(0, width), "…")));
      } catch {
        // A summary is never worth failing the footer for.
      }
    }
    const statuses = [...footerData.getExtensionStatuses()];
    if (statuses.length > 0) {
      // Keep connection failures visible first, then preserve other extensions' order.
      statuses.sort(([a], [b]) => Number(b === "openviking") - Number(a === "openviking"));
      const extensions = statuses.map(([, text]) => text.replace(/[\r\n\t]+/g, " ")).join(" | ");
      lines.push(paint(theme, truncateToWidth(extensions, Math.max(0, width), "…")));
    }
    return lines;
  }

  /** One tick per second while a deadline is live: only the countdown moves. */
  private startWaitTick(): void {
    if (this.waitTimer) return;
    this.waitTimer = setInterval(() => this.tickWait(), WAIT_TICK_MS);
    this.waitTimer.unref?.();
  }

  private stopWaitTick(): void {
    if (!this.waitTimer) return;
    clearInterval(this.waitTimer);
    this.waitTimer = null;
  }

  private publishThroughput(): void {
    this.status.set({ throughput: this.throughput.snapshot() });
    this.requestRender();
  }

  /** Throttle/coalesce redraws: at most every `refreshMs`, else schedule one. */
  private requestRender(): void {
    const t = this.now();
    if (!this.renderRequest) return;
    if (t - this.lastRenderAt >= this.config.refreshMs) {
      this.lastRenderAt = t;
      this.renderRequest();
    } else if (!this.renderTimer) {
      const delay = Math.max(1, this.config.refreshMs - (t - this.lastRenderAt));
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        if (this.disposed) return;
        this.lastRenderAt = this.now();
        this.renderRequest?.();
      }, delay);
    }
  }

  private async refreshGit(): Promise<void> {
    const cwd = this.status.snapshot.cwd;
    // Detached callers (`void this.refreshGit()`) must never see a rejection:
    // a transient git failure is not fatal to the footer, and an unhandled
    // rejection here would terminate the whole Pi session. Keep the last known
    // git state on screen rather than blanking or crashing.
    let g;
    try {
      g = await this.git.resolve(cwd);
    } catch {
      return;
    }
    if (this.disposed) return;
    this.status.set({
      repositoryRoot: g.repositoryRoot,
      repository: g.repository,
      worktree: g.worktree,
      branch: g.branch,
      detachedHead: g.detachedHead,
    });
    this.requestRender();
  }
}

/**
 * Colour a footer row, or leave it uncoloured.
 *
 * The status row and the extension row called `theme.fg` outside the try that
 * guarded the row's CONTENT, so a throwing theme escaped into pi's render loop
 * — a whole session lost to a colour lookup. Found by a fresh review; the
 * ambient row was already guarded, which is what made the gap visible.
 */
function paint(theme: Theme, text: string): string {
  try {
    return theme.fg("muted", text);
  } catch {
    return text;
  }
}
