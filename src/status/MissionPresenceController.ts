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

const WIDGET_KEY = "engineering-missions";
const HEADER_PREFIX = "Missions · ";
/** States worth interrupting the operator for, on top of the attention ranks. */
const NOTIFY_STATES = new Set(["FAILED", "COMPLETE"]);

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
  private readonly rows: number;
  private readonly titleEnabled: boolean;
  private readonly quiet: ((missionId: string) => void) | undefined;
  private readonly now: () => number;
  private readonly quietMs: number;
  private lastQuietAt = 0;
  private readonly live = new Map<string, Tracked>();
  private readonly attention = new Map<string, string>();
  private agentActive = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPanel: string | undefined;
  private lastMessage: string | undefined;
  private lastTitle: string | undefined;

  constructor(sink: PresenceSink, options: PresenceOptions = {}) {
    this.sink = sink;
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

  /** The agent owns the working line while it runs; presence yields it. */
  onAgentStart(): void {
    if (this.disposed) return;
    this.agentActive = true;
    this.publishWorking(undefined);
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
    this.publishWorking(undefined);
    if (this.lastPanel !== undefined) {
      this.guard(() => this.sink.setWidget?.(WIDGET_KEY, undefined));
      this.lastPanel = undefined;
    }
    if (this.lastTitle !== undefined) {
      this.guard(() => this.sink.setTitle?.(undefined));
      this.lastTitle = undefined;
    }
  }

  private publishWidget(view: PresenceView): void {
    const lines = this.live.size > 0 ? renderWidgetLines(view) : undefined;
    const serialized = lines ? lines.join("\n") : undefined;
    if (serialized === this.lastPanel) return;
    this.lastPanel = serialized;
    this.guard(() => this.sink.setWidget?.(WIDGET_KEY, lines));
  }

  private publishWorkingLine(view: PresenceView): void {
    if (this.agentActive) return;
    const sentence = view.workingMissionId ? this.live.get(view.workingMissionId)?.sentence : undefined;
    const line = sentence ? `Mission · ${view.workingMissionId} · ${sentence}` : view.workingLine;
    this.publishWorking(line ?? undefined);
  }

  private publishWorking(text: string | undefined): void {
    if (this.lastMessage === text) return;
    this.lastMessage = text;
    this.guard(() => this.sink.setWorkingMessage?.(text));
  }

  private publishTitle(view: PresenceView): void {
    if (!this.titleEnabled) return;
    const title = this.live.size > 0 ? view.header.slice(HEADER_PREFIX.length) : undefined;
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    this.guard(() => this.sink.setTitle?.(title));
  }

  /** One notification per state change; a mission cannot spam the terminal. */
  private notifyAttention(events: readonly RuntimeMissionActivityEvent[]): void {
    for (const event of events) {
      const key = `${event.state}|${event.health}`;
      const previous = this.attention.get(event.missionId);
      this.attention.set(event.missionId, key);
      if (previous === key) continue;
      const rank = presenceRank(event);
      const urgent = rank <= 1 || NOTIFY_STATES.has(event.state);
      if (!urgent) continue;
      const what =
        rank === 0 ? "needs you" : rank === 1 ? "has stopped" : event.state === "COMPLETE" ? "is complete" : "failed";
      const reason = flat(event.reason, 120);
      const next = rank <= 1 ? ` — /mission-status ${event.missionId}` : "";
      this.guard(() =>
        this.sink.notify?.(
          `Mission ${event.missionId} ${what}${reason ? `: ${reason}` : ""}${next}`,
          rank <= 1 || event.state === "FAILED" ? "warning" : "info",
        ),
      );
    }
  }

  /** A status surface is observational; a torn-down UI must never fail a mission. */
  private guard(action: () => void): void {
    try {
      action();
    } catch {
      // The surface is gone; the mission keeps running.
    }
  }
}
