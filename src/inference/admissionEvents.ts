/**
 * Admission-retry events and metrics (spec 04-telemetry).
 *
 * One event per state transition, published on a small bus. The lifecycle layer
 * forwards them to telemetry, the status bar, and the metrics aggregation; the
 * transport never knows who is listening.
 */

import type { AdmissionAction } from "./admissionContract.ts";
import type { RetryDelaySource } from "./retryDelay.ts";

export type AdmissionEventName =
  | "inference.retry.scheduled"
  | "inference.retry.waiting"
  | "inference.retry.started"
  | "inference.retry.succeeded"
  | "inference.retry.exhausted"
  | "inference.retry.cancelled"
  | "inference.fallback.triggered";

/** Names of every admission event, in lifecycle order. */
export const ADMISSION_EVENT_NAMES: readonly AdmissionEventName[] = [
  "inference.retry.scheduled",
  "inference.retry.waiting",
  "inference.retry.started",
  "inference.retry.succeeded",
  "inference.retry.exhausted",
  "inference.retry.cancelled",
  "inference.fallback.triggered",
];

/** Metric series names (Prometheus-style naming, spec 04 §3). */
export const ADMISSION_METRIC_NAMES = {
  retries: "pi_harness_inference_admission_retries_total",
  waitSeconds: "pi_harness_inference_admission_wait_seconds_total",
  successAfterRetry: "pi_harness_inference_admission_success_after_retry_total",
  exhausted: "pi_harness_inference_admission_exhausted_total",
  fallback: "pi_harness_inference_admission_fallback_total",
  cancelled: "pi_harness_inference_admission_cancelled_total",
  queueDepth: "pi_harness_inference_admission_queue_depth",
  queueLimit: "pi_harness_inference_admission_queue_limit",
  activeWorkers: "pi_harness_inference_admission_active_workers",
  workerLimit: "pi_harness_inference_admission_worker_limit",
} as const;

/** One admission lifecycle event. Field names follow spec 04 §2. */
export interface AdmissionEvent {
  name: AdmissionEventName;
  /** ISO-8601 timestamp. */
  at: string;
  provider: string;
  model: string;
  /** Harness identity for one logical inference operation, stable across attempts. */
  logicalRequestId: string;
  /** InferWeave request id for the most recent attempt, when supplied. */
  serverRequestId?: string;
  /** 1-based attempt number the event refers to. */
  attempt: number;
  maxAttempts: number;
  reason?: string;
  httpStatus?: number;
  /** Server-directed wait in ms, when one was supplied. */
  retryAfterMs?: number;
  /** Wait actually applied after clamping and jitter. */
  delayUsedMs?: number;
  delaySource?: RetryDelaySource;
  /** Cumulative waited time for this logical request. */
  elapsedWaitMs?: number;
  queueDepth?: number;
  queueLimit?: number;
  activeWorkers?: number;
  workerLimit?: number;
  classification?: AdmissionAction;
  /** Harness scope keys, filled in when known (worker runs carry all of them). */
  sessionId?: string;
  agentId?: string;
  role?: string;
  workerId?: string;
  runId?: string;
  /** Why a chain stopped (exhausted/cancelled/fallback events). */
  terminatedBy?: string;
}

/** Subset of fields a publisher must supply. */
export type AdmissionEventInput = Omit<AdmissionEvent, "at" | "name"> & { at?: string };

export type AdmissionEventListener = (event: AdmissionEvent) => void;

/** Fan-out bus. Listener failures are isolated and reported, never thrown back. */
export class AdmissionEventBus {
  private readonly listeners = new Set<AdmissionEventListener>();
  private readonly recent: AdmissionEvent[] = [];
  private readonly recentLimit: number;
  private readonly onListenerError?: (error: unknown) => void;

  constructor(recentLimit = 200, onListenerError?: (error: unknown) => void) {
    this.recentLimit = recentLimit;
    this.onListenerError = onListenerError;
  }

  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: AdmissionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(name: AdmissionEventName, input: AdmissionEventInput): AdmissionEvent {
    const event: AdmissionEvent = { ...input, at: input.at ?? new Date().toISOString(), name };
    this.recent.push(event);
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError?.(error);
      }
    }
    return event;
  }

  events(limit = 50): AdmissionEvent[] {
    return this.recent.slice(-limit);
  }

  clear(): void {
    this.recent.length = 0;
  }
}

/** Per `provider/model/reason` retry counters. */
export interface AdmissionRetryCounter {
  provider: string;
  model: string;
  reason: string;
  retries: number;
  waitMs: number;
}

/** Aggregated admission metrics (spec 04 §3). */
export interface AdmissionMetricsSnapshot {
  retries: number;
  waitMs: number;
  successAfterRetry: number;
  exhausted: number;
  fallback: number;
  cancelled: number;
  /** Logical requests that succeeded without ever waiting. */
  cleanSuccess: number;
  /** Longest single wait observed. */
  maxDelayMs: number;
  /** Reasons seen with counts, highest first. */
  byReason: { reason: string; retries: number; waitMs: number }[];
  /** Latest saturation values observed per provider/model. */
  saturation: {
    provider: string;
    model: string;
    queued?: number;
    queueLimit?: number;
    active?: number;
    activeLimit?: number;
  }[];
  /** Retry chains by attempt number (1 = first retry). */
  attemptsHistogram: Record<string, number>;
}

interface SaturationEntry {
  provider: string;
  model: string;
  queued?: number;
  queueLimit?: number;
  active?: number;
  activeLimit?: number;
  at: string;
}

/**
 * Streaming aggregation of admission events.
 *
 * Cumulative: a process-long tally of retry pressure, which is what answers
 * "is the fleet saturated, and which reason dominates?".
 */
export class AdmissionMetrics {
  private retries = 0;
  private waitMs = 0;
  private successAfterRetry = 0;
  private exhausted = 0;
  private fallback = 0;
  private cancelled = 0;
  private cleanSuccess = 0;
  private maxDelayMs = 0;
  private readonly perReason = new Map<string, { retries: number; waitMs: number }>();
  private readonly saturation = new Map<string, SaturationEntry>();
  private readonly histogram = new Map<number, number>();

  record(event: AdmissionEvent): void {
    switch (event.name) {
      case "inference.retry.scheduled": {
        const delay = event.delayUsedMs ?? event.retryAfterMs ?? 0;
        const reason = event.reason ?? "unknown";
        const entry = this.perReason.get(reason) ?? { retries: 0, waitMs: 0 };
        entry.retries++;
        entry.waitMs += delay;
        this.perReason.set(reason, entry);
        this.waitMs += delay;
        if (delay > this.maxDelayMs) this.maxDelayMs = delay;
        break;
      }
      case "inference.retry.started": {
        this.retries++;
        const attempt = Math.max(1, event.attempt);
        this.histogram.set(attempt, (this.histogram.get(attempt) ?? 0) + 1);
        break;
      }
      case "inference.retry.succeeded":
        if (event.attempt > 1) this.successAfterRetry++;
        else this.cleanSuccess++;
        break;
      case "inference.retry.exhausted":
        this.exhausted++;
        break;
      case "inference.retry.cancelled":
        this.cancelled++;
        break;
      case "inference.fallback.triggered":
        this.fallback++;
        break;
      default:
        break;
    }
    if (
      event.queueDepth !== undefined ||
      event.queueLimit !== undefined ||
      event.activeWorkers !== undefined ||
      event.workerLimit !== undefined
    ) {
      this.saturation.set(`${event.provider}/${event.model}`, {
        provider: event.provider,
        model: event.model,
        queued: event.queueDepth,
        queueLimit: event.queueLimit,
        active: event.activeWorkers,
        activeLimit: event.workerLimit,
        at: event.at,
      });
    }
  }

  snapshot(): AdmissionMetricsSnapshot {
    const byReason = [...this.perReason.entries()]
      .map(([reason, v]) => ({ reason, retries: v.retries, waitMs: v.waitMs }))
      .sort((a, b) => b.retries - a.retries || b.waitMs - a.waitMs);
    const attemptsHistogram: Record<string, number> = {};
    for (const [attempt, count] of [...this.histogram.entries()].sort((a, b) => a[0] - b[0])) {
      attemptsHistogram[String(attempt)] = count;
    }
    return {
      retries: this.retries,
      waitMs: Math.round(this.waitMs),
      successAfterRetry: this.successAfterRetry,
      exhausted: this.exhausted,
      fallback: this.fallback,
      cancelled: this.cancelled,
      cleanSuccess: this.cleanSuccess,
      maxDelayMs: this.maxDelayMs,
      byReason,
      saturation: [...this.saturation.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
      attemptsHistogram,
    };
  }

  reset(): void {
    this.retries = 0;
    this.waitMs = 0;
    this.successAfterRetry = 0;
    this.exhausted = 0;
    this.fallback = 0;
    this.cancelled = 0;
    this.cleanSuccess = 0;
    this.maxDelayMs = 0;
    this.perReason.clear();
    this.saturation.clear();
    this.histogram.clear();
  }
}

/** Render the snapshot in Prometheus exposition format. */
export function renderAdmissionPrometheus(snapshot: AdmissionMetricsSnapshot): string {
  const lines: string[] = [];
  lines.push(`# HELP ${ADMISSION_METRIC_NAMES.retries} Admission-control retries scheduled`);
  lines.push(`# TYPE ${ADMISSION_METRIC_NAMES.retries} counter`);
  for (const entry of snapshot.byReason) {
    lines.push(`${ADMISSION_METRIC_NAMES.retries}{reason="${entry.reason}"} ${entry.retries}`);
  }
  lines.push(`# HELP ${ADMISSION_METRIC_NAMES.waitSeconds} Cumulative time waited on admission control`);
  lines.push(`# TYPE ${ADMISSION_METRIC_NAMES.waitSeconds} counter`);
  lines.push(`${ADMISSION_METRIC_NAMES.waitSeconds} ${(snapshot.waitMs / 1000).toFixed(3)}`);
  for (const [key, help] of [
    ["successAfterRetry", "Inferences that succeeded after at least one admission wait"],
    ["exhausted", "Inferences whose admission budget was exhausted"],
    ["fallback", "Inferences handed to model routing by admission policy"],
    ["cancelled", "Admission waits cancelled by the operator or scheduler"],
  ] as const) {
    const name = ADMISSION_METRIC_NAMES[key];
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${snapshot[key]}`);
  }
  lines.push(`# HELP ${ADMISSION_METRIC_NAMES.queueDepth} Last observed InferWeave queue depth`);
  lines.push(`# TYPE ${ADMISSION_METRIC_NAMES.queueDepth} gauge`);
  for (const s of snapshot.saturation) {
    if (s.queued === undefined) continue;
    lines.push(`${ADMISSION_METRIC_NAMES.queueDepth}{model="${s.provider}/${s.model}"} ${s.queued}`);
  }
  lines.push(`# HELP ${ADMISSION_METRIC_NAMES.activeWorkers} Last observed active workers`);
  lines.push(`# TYPE ${ADMISSION_METRIC_NAMES.activeWorkers} gauge`);
  for (const s of snapshot.saturation) {
    if (s.active === undefined) continue;
    lines.push(`${ADMISSION_METRIC_NAMES.activeWorkers}{model="${s.provider}/${s.model}"} ${s.active}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Human-readable summary lines for `/engineering admission`. */
export function summarizeAdmissionMetrics(snapshot: AdmissionMetricsSnapshot): string[] {
  const lines: string[] = [];
  lines.push(
    `retries=${snapshot.retries} waited=${Math.round(snapshot.waitMs / 1000)}s max_single_wait=${Math.round(snapshot.maxDelayMs / 1000)}s`,
  );
  lines.push(
    `succeeded_after_retry=${snapshot.successAfterRetry} clean=${snapshot.cleanSuccess} exhausted=${snapshot.exhausted} fallback=${snapshot.fallback} cancelled=${snapshot.cancelled}`,
  );
  if (snapshot.byReason.length > 0) {
    lines.push(
      `reasons: ${snapshot.byReason.map((r) => `${r.reason}=${r.retries} (${Math.round(r.waitMs / 1000)}s)`).join(", ")}`,
    );
  }
  if (Object.keys(snapshot.attemptsHistogram).length > 0) {
    lines.push(
      `attempts: ${Object.entries(snapshot.attemptsHistogram)
        .map(([a, c]) => `#${a}=${c}`)
        .join(", ")}`,
    );
  }
  for (const s of snapshot.saturation) {
    const parts: string[] = [];
    if (s.active !== undefined)
      parts.push(`active=${s.active}${s.activeLimit !== undefined ? `/${s.activeLimit}` : ""}`);
    if (s.queued !== undefined) parts.push(`queued=${s.queued}${s.queueLimit !== undefined ? `/${s.queueLimit}` : ""}`);
    if (parts.length > 0) lines.push(`saturation ${s.provider}/${s.model}: ${parts.join(" ")}`);
  }
  return lines;
}
