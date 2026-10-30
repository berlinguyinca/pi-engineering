/**
 * RetryTrace: one failure, traceable across every layer that touches it.
 *
 * Pure data (no behaviour). Each layer that decides what happens to a failed
 * inference request appends one entry; the layer that ACTS (retries, holds,
 * fails over) is the failure's single owner, and every other layer records
 * `next: "defer"` to say it saw the failure and left it alone. A trace with
 * more than one owner acting on the same failure is a retry multiplication bug.
 *
 * Entries ride the worker result's `details.retry_trace` and the shared
 * inference telemetry bus (`inference.retry.trace`).
 */

import type { InferenceTelemetry } from "./telemetry.ts";

/** The layers that can decide the fate of a failed request, innermost first. */
export type RetryLayer =
  | "resilient-stream" // src/inference/resilientStream.ts: in-call replay ladder
  | "worker-gateway-hold" // PiWorkerExecutor: honours the gateway's advertised wait
  | "model-takeover" // realBackends.runWithModelTakeover: move the run to another model
  | "scheduler-window"; // orchestration scheduler: mission-level relaunch window

/** What the layer did with the failure. */
export type RetryNext =
  | "retry" // acted: replayed the same request
  | "hold" // acted: waited out the gateway's wait, then replays
  | "failover" // acted: moved the run to another model
  | "give-up" // acted: budget spent, failure handed to the next layer up
  | "defer"; // did not act: another layer owns this failure

export interface RetryTrace {
  layer: RetryLayer;
  /** 1-based attempt this entry describes, as counted by `layer`. */
  attempt: number;
  /** Why: a short failure key such as `429:queue_timeout`. */
  reason: string;
  next: RetryNext;
  /** The layer that owns the retry for this failure. */
  owner: RetryLayer;
}

/** True when this entry is the layer acting (not deferring). */
export function actedOn(entry: RetryTrace): boolean {
  return entry.next !== "defer";
}

/** The set of layers that acted on a failure. More than one means multiplication. */
export function actingLayers(trace: readonly RetryTrace[]): RetryLayer[] {
  return [...new Set(trace.filter(actedOn).map((entry) => entry.layer))];
}

/** Append an entry and publish it on the telemetry bus (when one is given). */
export function recordRetryTrace(
  into: RetryTrace[] | undefined,
  entry: RetryTrace,
  telemetry?: InferenceTelemetry,
  identity: { mission_id?: string; worker_id?: string; role?: string } = {},
): void {
  into?.push(entry);
  telemetry?.emit("inference.retry.trace", { ...identity, attempt: entry.attempt, trace: entry });
}
