/**
 * The gateway's queue state, kept long enough to outlive the wait (#418).
 *
 * While a request is actively waiting, the admission notice shows the queue
 * ("31 of 100 queued · 4 admitted") from the live `GatewayWaitSignal`. When the
 * wait ends in a park — the mission stops on capacity and its resume condition
 * is "a healthy provider probe must succeed" — that live signal is gone, and the
 * operator is left with an open-ended "waits for capacity".
 *
 * This module holds the last capacity-shaped observation so the park can persist
 * it onto the `MissionStop` and the report can state a load and an ETA. It is
 * deliberately narrow: only a genuine admission/queue wait is queue state. A
 * transport blip carries no queue facts, and recording one would show a queue
 * load the gateway never reported.
 */

import { formatDuration } from "./admissionNotice.ts";
import type { GatewayWaitSignal } from "./signals.ts";

/** The last queue facts the gateway reported, as persisted on a stop. */
export interface QueueObservation {
  /** When this was observed (epoch ms) — an ETA without an age is a guess. */
  observedAtMs: number;
  queued?: number;
  queueLimit?: number;
  /** Concurrent requests the gateway admits — the ceiling on local concurrency. */
  activeLimit?: number;
  /** The gateway's own hold-off, in ms. The ETA is derived from this, never guessed. */
  retryAfterMs?: number;
  /** Epoch ms the current run of waits began, when the gateway reported it. */
  waitingSinceMs?: number;
  /** Gateway-reported machine reason, e.g. "queue_timeout". */
  reason?: string;
  scope?: string;
  provider?: string;
  model?: string;
}

/**
 * How old an observation may be and still be presented as the queue's state.
 * Past this the queue has had time to drain or fill; showing a stale ETA would
 * be a lie about the future, so the caller shows no ETA at all.
 */
export const QUEUE_OBSERVATION_MAX_AGE_MS = 15 * 60_000;

/** An ETA is only meaningful for a horizon this far out; beyond it, say nothing. */
const ETA_MAX_HORIZON_MS = 24 * 60 * 60_000;

/** True when the wait is the inference queue being full, not a link that flapped. */
export function isCapacityWait(signal: GatewayWaitSignal): boolean {
  const facts = `${signal.reason ?? ""} ${signal.type ?? ""} ${signal.code ?? ""}`.toLowerCase();
  if (signal.queued !== undefined || signal.queueLimit !== undefined) return true;
  return /queue|admission|rate_limit|capacity|throttl|too_many/.test(facts);
}

/**
 * Keeps the most recent capacity observation. One per runtime: the queue the
 * operator is waiting behind is the one this process was told about last.
 */
export class QueueObservations {
  private last: QueueObservation | null = null;

  /** Record a capacity wait; a non-queue wait leaves the last state untouched. */
  record(signal: GatewayWaitSignal, now: () => number = Date.now): QueueObservation | null {
    if (!isCapacityWait(signal)) return null;
    const observation: QueueObservation = {
      observedAtMs: now(),
      ...(signal.queued !== undefined ? { queued: signal.queued } : {}),
      ...(signal.queueLimit !== undefined ? { queueLimit: signal.queueLimit } : {}),
      ...(signal.activeLimit !== undefined ? { activeLimit: signal.activeLimit } : {}),
      ...(signal.retryAfterMs !== undefined ? { retryAfterMs: signal.retryAfterMs } : {}),
      ...(signal.waitingSinceMs !== undefined ? { waitingSinceMs: signal.waitingSinceMs } : {}),
      ...(signal.reason ? { reason: signal.reason } : {}),
      ...(signal.scope ? { scope: signal.scope } : {}),
      ...(signal.provider ? { provider: signal.provider } : {}),
      ...(signal.model ? { model: signal.model } : {}),
    };
    this.last = observation;
    return observation;
  }

  latest(): QueueObservation | null {
    return this.last;
  }

  /** The last observation, or null when nothing was reported or it has aged out. */
  fresh(maxAgeMs: number = QUEUE_OBSERVATION_MAX_AGE_MS, now: () => number = Date.now): QueueObservation | null {
    if (!this.last) return null;
    return now() - this.last.observedAtMs <= maxAgeMs ? this.last : null;
  }

  clear(): void {
    this.last = null;
  }
}

/** "31 of 100 queued · 4 admitted", omitting whatever the gateway did not report. */
export function queueLoadText(observation: QueueObservation): string | null {
  const parts: string[] = [];
  if (observation.queued !== undefined) {
    parts.push(
      observation.queueLimit !== undefined
        ? `${observation.queued} of ${observation.queueLimit} queued`
        : `${observation.queued} queued`,
    );
  } else if (observation.queueLimit !== undefined) {
    parts.push(`queue limit ${observation.queueLimit}`);
  }
  if (observation.activeLimit !== undefined) parts.push(`${observation.activeLimit} admitted`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "ETA ~2m 05s" from the gateway's own `retry_after_ms`, or null when it has
 * aged out or was never reported. The age of the observation is subtracted, so a
 * retry-after read ten minutes ago does not promise a wait that already passed.
 */
export function queueEtaText(observation: QueueObservation, nowMs: number = Date.now()): string | null {
  if (observation.retryAfterMs === undefined) return null;
  const remaining = observation.retryAfterMs - Math.max(0, nowMs - observation.observedAtMs);
  if (remaining < 0 || remaining > ETA_MAX_HORIZON_MS) return null;
  return `ETA ~${formatDuration(remaining)}`;
}

/** Both halves of the operator line, or null when there is nothing to say. */
export function queueStateText(observation: QueueObservation | null, nowMs: number = Date.now()): string | null {
  if (!observation) return null;
  const load = queueLoadText(observation);
  const eta = queueEtaText(observation, nowMs);
  if (!load && !eta) return null;
  return [load, eta].filter(Boolean).join(" · ");
}
