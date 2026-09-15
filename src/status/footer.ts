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
}

export class FooterController {
  private readonly ctx: ExtensionContext;
  private readonly config: StatusBarConfig;
  private readonly now: () => number;
  private readonly status: StatusState;
  private readonly throughput: ThroughputTracker;
  private readonly git: GitContextProvider;

  private disposed = false;
  private renderRequest: (() => void) | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private lastRenderAt = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(opts: FooterControllerOptions) {
    this.ctx = opts.ctx;
    this.config = opts.config;
    this.now = opts.now ?? (() => Date.now());
    this.throughput = new ThroughputTracker({
      windowMs: opts.config.throughputWindowMs,
      now: this.now,
      estimateCharsPerToken: opts.config.estimateCharsPerToken,
      estimateBatchChars: opts.config.estimateBatchChars,
    });
    this.git = new GitContextProvider({ now: this.now, ttlMs: opts.config.gitCacheTtlMs });
    this.status = new StatusState({
      cwd: opts.ctx.cwd,
      throughput: { phase: "unavailable" },
    });

    const m = modelInfo(opts.ctx.model);
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
  onModelSelect(model: { provider?: string; id?: string } | undefined): void {
    if (this.disposed) return;
    const m = modelInfo(model);
    this.throughput.reset();
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
    });
  }

  /** Publish (or clear) the wait, starting or stopping the countdown tick. */
  setWait(wait: WaitState | undefined): void {
    if (this.disposed) return;
    this.status.set({ wait });
    if (wait?.untilMs != null) this.startWaitTick();
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
    this.status.set({ model: model ?? modelInfo(this.ctx.model).id });
    this.requestRender();
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
    const lines = [theme.fg("muted", line)];
    const statuses = [...footerData.getExtensionStatuses()];
    if (statuses.length > 0) {
      // Keep connection failures visible first, then preserve other extensions' order.
      statuses.sort(([a], [b]) => Number(b === "openviking") - Number(a === "openviking"));
      const extensions = statuses.map(([, text]) => text.replace(/[\r\n\t]+/g, " ")).join(" | ");
      lines.push(theme.fg("muted", truncateToWidth(extensions, Math.max(0, width), "…")));
    }
    return lines;
  }

  /** One tick per second while a deadline is live: only the countdown moves. */
  private startWaitTick(): void {
    if (this.waitTimer) return;
    this.waitTimer = setInterval(() => this.tickWait(), 1000);
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
    const g = await this.git.resolve(cwd);
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
