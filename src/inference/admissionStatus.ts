/**
 * Admission-retry status rendering (spec 04-ui-telemetry §1-2).
 *
 * Renders the waiting state once and updates it in place (a stable status-bar
 * entry plus a widget panel) rather than printing a new block per countdown
 * tick or spamming `Error: 429` lines. The controller is UI-agnostic: it talks
 * to a small sink, and the harness supplies a pi-ai `ctx.ui` adapter.
 */

import { formatDuration } from "./admissionContract.ts";
import type { AdmissionEvent, AdmissionEventBus, AdmissionEventName } from "./admissionEvents.ts";
import type { AdmissionPhase, AdmissionState } from "./admissionTransport.ts";

/** Minimal UI surface the harness provides (pi-ai `ctx.ui` implements it). */
export interface AdmissionStatusSink {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Keys used so the harness can clear or inspect them. */
export const ADMISSION_STATUS_KEY = "inference-admission";
export const ADMISSION_WIDGET_KEY = "inference-admission";

/** Compact status-bar line: `IW:waiting 30s | q:26/100 | active:4/4`. */
export function renderStatusBar(state: AdmissionState): string | undefined {
  if (state.phase === "ADMISSION_WAIT") {
    const parts = [`IW:waiting ${formatDuration(state.delayMs ?? 0)}`];
    if (state.queueDepth !== undefined || state.queueLimit !== undefined) {
      parts.push(`q:${state.queueDepth ?? "?"}/${state.queueLimit ?? "?"}`);
    }
    if (state.activeWorkers !== undefined || state.workerLimit !== undefined) {
      parts.push(`active:${state.activeWorkers ?? "?"}/${state.workerLimit ?? "?"}`);
    }
    if (state.attempt > 1) parts.push(`attempt ${state.attempt}`);
    if (state.waitedMs > 0) parts.push(`waited ${formatDuration(state.waitedMs)}`);
    return parts.join(" | ");
  }
  if (state.phase === "REQUESTING" || state.phase === "RETRYING") {
    const parts = [`IW:${state.phase === "RETRYING" ? "retrying" : "requesting"} attempt ${state.attempt}`];
    if (state.waitedMs > 0) parts.push(`waited ${formatDuration(state.waitedMs)}`);
    return parts.join(" | ");
  }
  return undefined;
}

/** Multi-line panel shown while waiting (spec 04 §1). */
export function renderWaitingPanel(state: AdmissionState): string[] {
  const lines: string[] = ["InferWeave capacity busy", ""];
  lines.push(`  Model:       ${state.model}`);
  if (state.reason) lines.push(`  Reason:      ${state.reason}`);
  if (state.activeWorkers !== undefined || state.workerLimit !== undefined) {
    lines.push(`  Active:      ${state.activeWorkers ?? "?"} / ${state.workerLimit ?? "?"}`);
  }
  if (state.queueDepth !== undefined || state.queueLimit !== undefined) {
    lines.push(`  Queue:       ${state.queueDepth ?? "?"} / ${state.queueLimit ?? "?"}`);
  }
  lines.push(`  Retry in:    ${state.delayMs !== undefined ? formatDuration(state.delayMs) : "?"}`);
  lines.push(`  Attempt:     ${state.attempt}`);
  if (state.waitedMs > 0) lines.push(`  Waited:      ${formatDuration(state.waitedMs)}`);
  lines.push("", "Waiting for inference capacity...  [Esc to cancel]");
  return lines;
}

const TERMINAL_EVENT_NOTIFY: Record<string, "warning" | "error"> = {
  "inference.retry.exhausted": "error",
  "inference.fallback.triggered": "warning",
  "inference.retry.cancelled": "warning",
};

/** Wire the admission bus + transport states to a UI sink with a live countdown. */
export class AdmissionStatusController {
  private state: AdmissionState | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private readonly sink: AdmissionStatusSink;
  private readonly onState: ((state: AdmissionState) => void) | undefined;
  private readonly unsubscribe: () => void;
  private readonly seenTerminal = new Set<string>();

  constructor(
    sink: AdmissionStatusSink,
    events: AdmissionEventBus | undefined,
    onState?: (state: AdmissionState) => void,
  ) {
    this.sink = sink;
    this.onState = onState;
    this.unsubscribe = events ? events.subscribe((event) => this.onEvent(event)) : () => {};
  }

  /** Called by the transport for every phase change. */
  handleState(state: AdmissionState): void {
    this.state = state;
    this.onState?.(state);
    this.refresh();
  }

  private refresh(): void {
    const state = this.state;
    if (!state) return;
    this.stopTicker();
    switch (state.phase) {
      case "ADMISSION_WAIT": {
        this.sink.setStatus(ADMISSION_STATUS_KEY, renderStatusBar(state));
        this.sink.setWidget(ADMISSION_WIDGET_KEY, renderWaitingPanel(state));
        const until = state.waitUntilMs;
        if (until !== undefined) {
          this.tickTimer = setInterval(() => this.tick(until), 1000);
        }
        break;
      }
      case "REQUESTING":
      case "RETRYING":
      case "STREAMING": {
        this.sink.setStatus(ADMISSION_STATUS_KEY, renderStatusBar(state));
        this.sink.setWidget(ADMISSION_WIDGET_KEY, undefined);
        break;
      }
      case "SUCCEEDED":
        this.clear();
        break;
      case "FAILED":
      case "CANCELLED":
        this.clear();
        break;
      default:
        break;
    }
  }

  private tick(until: number): void {
    const state = this.state;
    if (!state || state.phase !== "ADMISSION_WAIT") return;
    const remaining = Math.max(0, until - Date.now());
    const updated: AdmissionState = { ...state, delayMs: remaining };
    this.sink.setStatus(ADMISSION_STATUS_KEY, renderStatusBar(updated));
    this.sink.setWidget(ADMISSION_WIDGET_KEY, renderWaitingPanel(updated));
    if (remaining <= 0) this.stopTicker();
  }

  private onEvent(event: AdmissionEvent): void {
    const level = TERMINAL_EVENT_NOTIFY[event.name];
    if (level === undefined) return;
    // Notify once per logical request, never re-spam on every tick.
    const key = `${event.logicalRequestId}:${event.name}`;
    if (this.seenTerminal.has(key)) return;
    this.seenTerminal.add(key);
    this.sink.notify(terminalNotifyText(event), level);
    this.clear();
  }

  private clear(): void {
    this.stopTicker();
    this.state = undefined;
    this.sink.setStatus(ADMISSION_STATUS_KEY, undefined);
    this.sink.setWidget(ADMISSION_WIDGET_KEY, undefined);
  }

  private stopTicker(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  dispose(): void {
    this.clear();
    this.unsubscribe();
  }
}

/** Human message for a terminal admission event. */
export function terminalNotifyText(event: AdmissionEvent): string {
  const where = `${event.provider}/${event.model}`;
  switch (event.name) {
    case "inference.retry.exhausted":
      return `InferWeave admission budget exhausted for ${where} (${event.reason ?? "unknown"}, attempt ${event.attempt}, waited ${formatDuration(event.elapsedWaitMs ?? 0)}).`;
    case "inference.fallback.triggered":
      return `InferWeave handed ${where} to model routing after ${event.reason ?? "admission"} (attempt ${event.attempt}, waited ${formatDuration(event.elapsedWaitMs ?? 0)}).`;
    case "inference.retry.cancelled":
      return `Admission wait cancelled for ${where} (attempt ${event.attempt}, waited ${formatDuration(event.elapsedWaitMs ?? 0)}).`;
    default:
      return `InferWeave admission event: ${event.name} for ${where}.`;
  }
}

/** Convenience for tests and other integrations. */
export function isAdmissionEventName(name: string): name is AdmissionEventName {
  return (
    name === "inference.retry.scheduled" ||
    name === "inference.retry.waiting" ||
    name === "inference.retry.started" ||
    name === "inference.retry.succeeded" ||
    name === "inference.retry.exhausted" ||
    name === "inference.retry.cancelled" ||
    name === "inference.fallback.triggered"
  );
}

/** Re-export the phase type so consumers can narrow without deep imports. */
export type { AdmissionPhase };
