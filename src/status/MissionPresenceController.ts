/**
 * Persistent mission presence: an attention-ranked strip above the editor plus
 * a working line the foreground agent can take back at any moment.
 *
 * Both surfaces are observational. A widget takes no keyboard focus and a
 * working message is a label — neither may fail a mission, so every sink call
 * is guarded and a torn-down terminal is treated as a no-op sink.
 */
import { redactSecrets } from "../platform/redact.ts";
import type { RuntimeMissionActivityEvent } from "../runtime/EngineeringRuntime.ts";
import { type PresenceBasis, type PresenceView, presenceRank, projectPresence, renderWidgetLines } from "./presence.ts";
import { StatusSurfaceBus, type SurfaceProducer } from "./surfaceBus.ts";

const WIDGET_KEY = "engineering-missions";
const HEADER_PREFIX = "Missions · ";
/** States worth interrupting the operator for, on top of the attention ranks. */
const NOTIFY_STATES = new Set(["FAILED", "COMPLETE"]);
/**
 * Below the foreground agent (100): while a turn is running the agent's own
 * line is what the operator is watching, and the strip keeps its claim queued
 * at lower priority rather than clearing it. Above nothing but an operator
 * notice, which claims 90.
 */
const PRESENCE_PRIORITY = 50;

export interface PresenceSink {
  setWorkingMessage?(text?: string): void;
  setWidget?(key: string, lines: string[] | undefined): void;
  setTitle?(title: string | undefined): void;
  notify?(text: string, level: "info" | "warning"): void;
}

export interface PresenceOptions {
  /** Rows the strip may show; the rest collapse into the overflow line. */
  rows?: number;
  /** Write the attention counts to the terminal title. Off by default. */
  title?: boolean;
  /** Ask observability for a quiet-period update, so silence proves liveness. */
  quiet?: (missionId: string) => void;
  now?: () => number;
  /** Refresh cadence; 0 lets the caller drive every tick by hand. */
  intervalMs?: number;
  /** How often to ask observability for a quiet-period summary (default 60s). */
  quietMs?: number;
  /**
   * The session's status-surface arbiter. Shared with the working-line
   * controller, so neither one has to guard the other out by hand.
   */
  bus?: StatusSurfaceBus;
}

export interface PresenceEnvOptions extends PresenceOptions {
  /** Whether the strip exists at all this session. */
  enabled: boolean;
  /** How often the strip is refreshed from durable state (rows from other processes). */
  pollMs: number;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

/**
 * Presence is observational and cheap, so it ships on: the operator's escape
 * hatch is `PI_MISSION_PRESENCE=0`. The row budget is capped because a strip
 * that pushes the editor off screen is worse than no strip.
 */
export function presenceOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): PresenceEnvOptions {
  return {
    enabled: env.PI_MISSION_PRESENCE !== "0",
    rows: boundedNumber(env.PI_MISSION_PRESENCE_ROWS, 4, 1, 10),
    title: env.PI_MISSION_TITLE === "1",
    intervalMs: 1_000,
    pollMs: boundedNumber(env.PI_MISSION_PRESENCE_POLL_MS, 5_000, 1_000, 600_000),
  };
}

interface Tracked {
  event: RuntimeMissionActivityEvent;
  basis?: PresenceBasis;
  sentence?: string;
  /** True once the runtime itself reported this mission; durable seeds may not demote it. */
  authoritative: boolean;
}

function flat(text: string, max: number): string {
  const safe = redactSecrets(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

export class MissionPresenceController {
  private readonly sink: PresenceSink;
  private readonly bus: StatusSurfaceBus;
  private readonly ownsBus: boolean;
  private readonly strip: SurfaceProducer;
  private readonly workingLine: SurfaceProducer;
  private readonly title: SurfaceProducer;
  private readonly rows: number;
  private readonly titleEnabled: boolean;
  private readonly quiet: ((missionId: string) => void) | undefined;
  private readonly now: () => number;
  private readonly quietMs: number;
  private lastQuietAt = 0;
  private readonly live = new Map<string, Tracked>();
  private agentActive = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(sink: PresenceSink, options: PresenceOptions = {}) {
    this.sink = sink;
    this.bus = options.bus ?? new StatusSurfaceBus(sink, options.now);
    this.ownsBus = options.bus === undefined;
    this.strip = this.bus.producer("widget", "mission-strip", { key: WIDGET_KEY });
    this.workingLine = this.bus.producer("working", "presence-working");
    this.title = this.bus.producer("title", "presence-title");
    this.rows = options.rows ?? 4;
    this.titleEnabled = options.title ?? false;
    this.quiet = options.quiet;
    this.now = options.now ?? Date.now;
    this.quietMs = options.quietMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 1_000;
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.tick(), intervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * The mission's latest activity event; the strip's row for it.
   *
   * `source: "store"` is the durable backstop (a mission this session never saw
   * emit anything). It may open a row but never rewrite one the runtime already
   * reported — a seeded row would make a live mission look quieter than it is.
   */
  update(event: RuntimeMissionActivityEvent, basis?: PresenceBasis, source: "activity" | "store" = "activity"): void {
    if (this.disposed) return;
    const previous = this.live.get(event.missionId);
    if (source === "store" && previous?.authoritative) return;
    this.live.set(event.missionId, {
      event,
      basis: basis ?? previous?.basis,
      sentence: previous?.sentence,
      authoritative: source === "activity" ? true : (previous?.authoritative ?? false),
    });
  }

  /**
   * The sentence observability composed for a human ("Tests: 34 passed, 1
   * failing · 12m since last progress"). It outranks the projected activity
   * text because it is written for the operator, not derived for a row.
   */
  noteSentence(missionId: string, sentence: string): void {
    if (this.disposed) return;
    const tracked = this.live.get(missionId);
    if (!tracked) return;
    tracked.sentence = flat(sentence, 200);
  }

  /**
   * The agent owns the working line while it runs. Presence does not clear its
   * claim — it holds it at lower priority and the arbiter hands the line back
   * when the turn ends, so a strip that was mid-sentence does not restart blank.
   */
  onAgentStart(): void {
    if (this.disposed) return;
    this.agentActive = true;
  }

  onAgentEnd(): void {
    if (this.disposed) return;
    this.agentActive = false;
    this.tick();
  }

  tick(): void {
    if (this.disposed) return;
    const now = this.now();
    const events = [...this.live.values()].map((tracked) => tracked.event);
    const basis = new Map<string, PresenceBasis>();
    for (const [missionId, tracked] of this.live) {
      if (tracked.basis) basis.set(missionId, tracked.basis);
    }
    // Silence is only evidence when someone asks for it, and asking every
    // second is a summary generator running on the render path.
    if (this.quiet && events.length > 0 && now - this.lastQuietAt >= this.quietMs) {
      this.lastQuietAt = now;
      for (const missionId of this.live.keys()) this.quiet(missionId);
    }
    const view = projectPresence(events, this.rows, now, basis);
    this.publishWidget(view);
    this.publishWorkingLine(view);
    this.publishTitle(view);
    this.notifyAttention(events);
  }

  visible(): number {
    return this.live.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.agentActive = false;
    for (const missionId of this.live.keys()) this.bus.forget(missionId);
    this.strip.release();
    this.workingLine.release();
    this.title.release();
    // A bus nobody else holds must clear what it wrote, or the strip outlives
    // the session that drew it.
    if (this.ownsBus) this.bus.dispose();
  }

  private publishWidget(view: PresenceView): void {
    const lines = this.live.size > 0 ? renderWidgetLines(view) : undefined;
    this.strip.publish({ lines, priority: PRESENCE_PRIORITY });
  }

  private publishWorkingLine(view: PresenceView): void {
    const sentence = view.workingMissionId ? this.live.get(view.workingMissionId)?.sentence : undefined;
    const line = sentence ? `Mission · ${view.workingMissionId} · ${sentence}` : view.workingLine;
    this.workingLine.publish({ text: line ?? undefined, priority: PRESENCE_PRIORITY });
  }

  private publishTitle(view: PresenceView): void {
    if (!this.titleEnabled) return;
    const title = this.live.size > 0 ? view.header.slice(HEADER_PREFIX.length) : undefined;
    this.title.publish({ text: title ?? undefined, priority: PRESENCE_PRIORITY });
  }

  /** One notification per state change; a mission cannot spam the terminal. */
  private notifyAttention(events: readonly RuntimeMissionActivityEvent[]): void {
    for (const event of events) {
      const rank = presenceRank(event);
      const urgent = rank <= 1 || NOTIFY_STATES.has(event.state);
      // A quiet sighting is still a change worth remembering: the next one
      // notifies even though nothing in between interrupted the operator.
      if (!urgent) {
        this.bus.observe(event.missionId, `${event.state}|${event.health}`);
        continue;
      }
      const what =
        rank === 0 ? "needs you" : rank === 1 ? "has stopped" : event.state === "COMPLETE" ? "is complete" : "failed";
      // Cite the evidence, not the mission's own narration: a counter the
      // operator can act on beats a sentence the model wrote about itself.
      const why = event.attention ? `${event.attention.reason} (${event.attention.evidence[0]!.kind})` : event.reason;
      const reason = flat(why, 120);
      const next = rank <= 1 ? ` — /mission-status ${event.missionId}` : "";
      this.bus.notify(
        event.missionId,
        `${event.state}|${event.health}`,
        `Mission ${event.missionId} ${what}${reason ? `: ${reason}` : ""}${next}`,
        rank <= 1 || event.state === "FAILED" ? "warning" : "info",
      );
    }
  }

  /** Whether a turn is running; kept for surfaces that ask rather than observe. */
  isAgentActive(): boolean {
    return this.agentActive;
  }
}
