/** Live local activity in Pi's native spinner, with a persistent gateway detail panel. */
import type { AdmissionEvent } from "../gateway/AdmissionController.ts";
import { formatWaitingFor, gatewayWaitLabel, waitReasonText } from "../gateway/admissionNotice.ts";
import type { GatewayWaitSignal } from "../gateway/signals.ts";
import { activityFromSessionEvent, safeWorkerOutputPreview } from "../workers/activity.ts";
import { StatusSurfaceBus, type SurfaceProducer } from "./surfaceBus.ts";

interface WorkingSink {
  setWorkingMessage?(text?: string): void;
  setWidget?(key: string, lines: string[] | undefined): void;
}

interface ModelRoute {
  provider?: string;
  id?: string;
}
interface ToolActivity {
  summary: string;
  startedAt: number;
  lastOutputAt?: number;
}
const WIDGET_KEY = "engineering-working";
/**
 * The foreground agent owns the working line while it runs. It outranks the
 * mission strip (50) but not an operator attention notice (90), which is meant
 * to interrupt whatever is on screen.
 */
const WORKING_PRIORITY = 100;

export class WorkingStatusController {
  private readonly bus: StatusSurfaceBus;
  private readonly working: SurfaceProducer;
  private readonly widget: SurfaceProducer;
  private readonly now: () => number;
  private model: ModelRoute = {};
  private active = false;
  private disposed = false;
  private phase = "Waiting for model";
  private phaseAt = 0;
  private lastOutputAt: number | undefined;
  private readonly tools = new Map<string, ToolActivity>();
  private wait: { signal: GatewayWaitSignal; until: number; since: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(sink: WorkingSink, now: () => number = Date.now, options: { bus?: StatusSurfaceBus } = {}) {
    this.now = now;
    // One arbiter per session, shared with the mission strip. Without one the
    // controller owns a bus over its own sink, which keeps the old behaviour.
    this.bus = options.bus ?? new StatusSurfaceBus(sink, now);
    this.working = this.bus.producer("working", "working-agent");
    this.widget = this.bus.producer("widget", "working-widget", { key: WIDGET_KEY });
  }

  onModelSelect(model: ModelRoute | undefined): void {
    if (this.disposed) return;
    this.model = model ?? {};
    this.wait = undefined;
    this.tick();
  }

  onAgentStart(): void {
    if (this.disposed) return;
    this.active = true;
    this.phase = "Waiting for model";
    this.phaseAt = this.now();
    this.lastOutputAt = undefined;
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 1_000);
      this.timer.unref?.();
    }
    this.tick();
  }

  onAgentEnd(): void {
    if (this.disposed) return;
    this.active = false;
    this.wait = undefined;
    this.tools.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Release, not blank: whatever else is claiming the line (the mission strip)
    // takes it back without either controller knowing about the other.
    this.working.release();
    this.widget.release();
  }

  onGatewayEvent(event: AdmissionEvent): void {
    if (this.disposed || !this.active || event.type !== "wait") return;
    const signal = event.signal;
    // This entry point is called only by the foreground request path, never
    // the shared admission bus. Require the full route even for aliases.
    if (signal.provider !== this.model.provider) return;
    if (signal.model !== this.model.id) return;
    this.wait = {
      signal,
      until: this.now() + event.waitMs,
      since: signal.waitingSinceMs ?? this.wait?.since ?? this.now(),
    };
    this.tick();
  }

  onModelProgress(): void {
    if (this.disposed || !this.active) return;
    this.wait = undefined;
    this.lastOutputAt = this.now();
    this.tick();
  }

  onMessageUpdate(event: { assistantMessageEvent?: { type?: string } }): void {
    if (this.disposed || !this.active) return;
    const type = event.assistantMessageEvent?.type;
    if (!type || (!type.endsWith("_delta") && type !== "toolcall_start")) return;
    const phase = type.startsWith("thinking")
      ? "Model thinking"
      : type.startsWith("toolcall")
        ? "Preparing tool call"
        : "Model responding";
    if (phase !== this.phase) this.phaseAt = this.now();
    this.phase = phase;
    this.onModelProgress();
  }

  onToolEvent(event: {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    isError?: boolean;
  }): void {
    if (this.disposed || !this.active || !event.toolCallId) return;
    const id = event.toolCallId;
    if (event.type === "tool_execution_start") {
      const activity = activityFromSessionEvent({ ...event });
      if (!activity) return;
      this.tools.set(id, { summary: activity.summary, startedAt: this.now() });
    } else if (event.type === "tool_execution_update") {
      const tool = this.tools.get(id);
      if (tool) tool.lastOutputAt = this.now();
    } else if (event.type === "tool_execution_end") {
      this.tools.delete(id);
      this.phase = "Waiting for model";
      this.phaseAt = this.lastOutputAt = this.now();
    }
    this.wait = undefined;
    this.tick();
  }

  /** Clock-only redraw: never calls the model, reports progress, or notifies HerdR. */
  tick(): void {
    if (this.disposed || !this.active) return;
    const now = this.now();
    const route = safeWorkerOutputPreview([this.model.provider, this.model.id].filter(Boolean).join("/")) ?? "model";
    const tool = [...this.tools.values()].at(-1);
    const activity = tool?.summary ?? this.phase;
    const age = formatWaitingFor(now - (tool?.startedAt ?? this.phaseAt));
    const lastOutputAt = tool ? tool.lastOutputAt : this.lastOutputAt;
    const silence =
      lastOutputAt === undefined
        ? `no output yet for ${age}`
        : `last output ${formatWaitingFor(now - lastOutputAt)} ago`;
    if (this.wait) {
      const { signal, until, since } = this.wait;
      const remaining = Math.max(0, Math.ceil((until - now) / 1000));
      const retry = remaining > 0 ? `retry in ${remaining}s` : "Awaiting gateway response";
      const reason = safeWorkerOutputPreview(signal.reason || signal.type ? waitReasonText(signal) : "gateway wait");
      const load = [
        signal.queued !== undefined
          ? `${signal.queued}${signal.queueLimit !== undefined ? `/${signal.queueLimit}` : ""} queued`
          : "",
        signal.activeLimit !== undefined ? `${signal.activeLimit} admitted` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const waited = `waiting for ${formatWaitingFor(now - since)}`;
      const label = gatewayWaitLabel(signal);
      this.publish(`${remaining > 0 ? label : retry} · ${remaining > 0 ? retry : label} · ${waited} · ${route}`, [
        `${label}: ${reason} · ${load || "queue load unavailable"}`,
        `${route} · ${retry} · ${waited}`,
        `Current activity: ${activity} · Esc to cancel`,
      ]);
    } else {
      this.publish(
        `${activity} · ${age} · ${silence} · ${route}${this.tools.size > 1 ? ` · ${this.tools.size} tools running` : ""}`,
        undefined,
      );
    }
  }

  private publish(message: string | undefined, lines: string[] | undefined): void {
    this.working.publish({
      text: message !== undefined ? `Working · ${message}` : undefined,
      priority: WORKING_PRIORITY,
    });
    this.widget.publish({ lines, priority: WORKING_PRIORITY });
  }

  dispose(): void {
    this.onAgentEnd();
    this.disposed = true;
  }
}
