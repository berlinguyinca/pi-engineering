/**
 * Structured inference-resilience telemetry (fault-tolerance spec §26).
 *
 * Every decision the resilient layer makes is emitted as a named, structured
 * event carrying the correlation fields the panel needs:
 *
 *   mission_id, worker_id, role, logical_model, resolved_model, fallback_model,
 *   gateway, node, worker, failure_class, retry_delay, attempt, elapsed_wait
 *
 * Raw failure details and the full InferWeave metadata (incl. unknown
 * X-InferWeave-* headers) live in the event payload — structured, never
 * console-text-only. User-visible status lines are SHORT and derived (see
 * describeRetryStatus / describeFallbackStatus / describeWaitingStatus); stack
 * traces never surface for expected transient failures.
 */

import type { ClassifiedInferenceFailure } from "./failureClassifier.ts";

export const INFERENCE_TELEMETRY_EVENTS = [
  "inference.request.started",
  "inference.request.completed",
  "inference.stream.incomplete",
  "inference.failure.classified",
  "inference.retry.scheduled",
  "inference.retry.started",
  "inference.retry.succeeded",
  "inference.retry.trace",
  "inference.model.unavailable",
  "inference.model.circuit_opened",
  "inference.model.circuit_closed",
  "inference.catalog.refreshed",
  "inference.fallback.requested",
  "inference.fallback.selected",
  "inference.fallback.exhausted",
  "inference.mission.waiting_capacity",
  "inference.mission.resumed",
] as const;

export type InferenceTelemetryEventName = (typeof INFERENCE_TELEMETRY_EVENTS)[number];

/** Correlation + decision fields shared by every event. */
export interface InferenceTelemetryData {
  mission_id?: string;
  worker_id?: string;
  role?: string;
  logical_model?: string;
  resolved_model?: string;
  fallback_model?: string;
  gateway?: string;
  node?: string;
  worker?: string;
  failure_class?: string;
  retry_delay?: number;
  attempt?: number;
  elapsed_wait?: number;
  /** Structured detail (classified failure, InferWeave metadata, ...). */
  [key: string]: unknown;
}

export interface InferenceTelemetryEvent {
  name: InferenceTelemetryEventName;
  atMs: number;
  data: InferenceTelemetryData;
}

export type InferenceTelemetryListener = (event: InferenceTelemetryEvent) => void;

const RING_SIZE = 512;

/**
 * Bounded, in-process event bus for the resilient layer. The Engineering
 * panel (and tests) subscribe; nothing here writes to the console.
 */
export class InferenceTelemetry {
  private listeners = new Set<InferenceTelemetryListener>();
  private ring: InferenceTelemetryEvent[] = [];
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  emit(name: InferenceTelemetryEventName, data: InferenceTelemetryData = {}): void {
    const event: InferenceTelemetryEvent = { name, atMs: this.now(), data };
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners are observers, never participants.
      }
    }
  }

  on(listener: InferenceTelemetryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The retained event history (bounded ring), oldest first. */
  events(): readonly InferenceTelemetryEvent[] {
    return this.ring;
  }

  eventsNamed(name: InferenceTelemetryEventName): readonly InferenceTelemetryEvent[] {
    return this.ring.filter((e) => e.name === name);
  }
}

/** "30s", "1m 42s", "8m 21s" — concise, operator-facing. */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Concise user-visible line for a scheduled retry (spec §26): no stack
 * traces, names the cause and the wait.
 */
export function describeRetryStatus(failure: ClassifiedInferenceFailure, delayMs: number): string {
  const wait = ` in ${formatDurationMs(delayMs)}`;
  switch (failure.class) {
    case "incomplete_stream":
      return `stream interrupted · retrying${wait}`;
    case "network_interruption":
      return `connection interrupted · retrying${wait}`;
    case "rate_limited":
      return `rate limited · waiting${wait}`;
    case "queue_saturated":
      return `queue saturated · waiting${wait}`;
    case "capacity_unavailable":
      return `capacity unavailable · waiting${wait}`;
    case "model_activating":
      return `model activating · waiting${wait}`;
    case "gateway_unavailable":
      return `gateway unavailable · retrying gateway${wait}`;
    case "worker_restarting":
      return `worker restarting · waiting${wait}`;
    case "routing_stale":
      return `stale route · refreshing catalog${wait}`;
    case "context_overflow":
      return `context overflow · compacting and retrying`;
    default:
      return `inference failure (${failure.class}) · retrying${wait}`;
  }
}

/** Concise fallback line: "Qwen 3.8 → DeepSeek V4.1 Flash / continuing". */
export function describeFallbackStatus(fromLabel: string, toLabel: string): string {
  return `${fromLabel} → ${toLabel} / continuing`;
}

/** Concise capacity-wait line: "Waiting for inference capacity · 8m 21s / next retry 1m 42s". */
export function describeWaitingStatus(elapsedMs: number, nextRetryMs: number): string {
  return `Waiting for inference capacity · ${formatDurationMs(elapsedMs)} / next retry ${formatDurationMs(nextRetryMs)}`;
}
