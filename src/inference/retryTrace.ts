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

import { createHash } from "node:crypto";
import { normalizeError } from "../incidents/errorNormalize.ts";
import { sanitizeForPersistence } from "../incidents/errorSanitize.ts";
import type { InferenceTelemetry } from "./telemetry.ts";

/** The layers that can decide the fate of a failed request, innermost first. */
export type RetryLayer =
  | "resilient-stream" // src/inference/resilientStream.ts: in-call replay ladder
  | "worker-gateway-hold" // PiWorkerExecutor: honours the gateway's advertised wait
  | "worker-transient-retry" // PiWorkerExecutor: withTransientRetry for 5xx / network / timeout
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
  /** E07: the upstream failure's occurrence id — the same on every layer observing it. */
  failure_id?: string;
  /** E07: the failure through E03+E04, reduced to normalized short-safe values (no raw text). */
  error_ref?: ErrorRef;
}

/** True when this entry is the layer acting (not deferring). */
export function actedOn(entry: RetryTrace): boolean {
  return entry.next !== "defer";
}

/** The set of layers that acted on a failure. More than one means multiplication. */
export function actingLayers(trace: readonly RetryTrace[]): RetryLayer[] {
  return [...new Set(trace.filter(actedOn).map((entry) => entry.layer))];
}

/**
 * E07: one upstream failure, one occurrence identity. `failureIdentity` digests the failure and its
 * scope (session, run, provider/model, origin layer, first attempt) — never the observing layer or
 * its attempt number — so every layer that sees the same upstream failure derives the same id, which
 * is how a trace entry correlates with the worker-failure occurrence E06 records. `errorRef` is the
 * same failure through E03's table and E04's sanitizer, reduced to normalized short-safe values: no
 * message text, paths, secrets or prompt content ever leave here.
 */

/** The failure and its scope — everything every layer observing it shares. */
export interface FailureIdentityInput {
  sessionId: string;
  runId?: string | null;
  provider?: string | null;
  model?: string | null;
  error: unknown;
  /** Where the failure originated — a property of the failure, not the observing layer. */
  originLayer: RetryLayer;
  /** First attempt, in the scope's own counting, on which it occurred — shared by all observers. */
  firstAttempt?: number;
}

/** The failure through E03+E04, reduced to values that are safe in any payload. */
export interface ErrorRef {
  code: string;
  layer: string;
  severity: string;
  summary_digest: string;
}
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const normalize = (input: FailureIdentityInput, timestamp: string) =>
  normalizeError(input.error, {
    timestamp,
    host: "",
    sessionId: input.sessionId,
    runtime: "pi-engineering-runtime",
    correlationIds: input.runId ? [`run:${input.runId}`] : [],
    runId: input.runId ?? null,
    model: input.model ?? null,
  });

/** The stable identity of the upstream failure: `sha256:<64 hex>` — deterministic without a clock; an injected clock extends the scope with its stamp. */
export function failureIdentity(input: FailureIdentityInput, clock?: () => string): string {
  const stamp = clock?.() ?? "";
  const occ = normalize(input, stamp);
  return `sha256:${sha256(JSON.stringify([input.sessionId, input.runId ?? "", input.provider ?? "", input.model ?? "", input.originLayer, input.firstAttempt ?? 0, occ.code, occ.severity, sha256(occ.summary), stamp]))}`;
}

/** The normalized safe reference for a failure — E03's code/layer/severity plus a digest of E04's summary; `null` when E04 refuses. */
export function errorRef(input: FailureIdentityInput, clock?: () => string): ErrorRef | null {
  const kept = sanitizeForPersistence(normalize(input, clock?.() ?? ""));
  return kept === null
    ? null
    : {
        code: kept.code,
        layer: kept.layer,
        severity: kept.severity,
        summary_digest: sha256(kept.summary).slice(0, 32),
      };
}

/** Append an entry and publish it on the telemetry bus (when one is given). */
export function recordRetryTrace(
  into: RetryTrace[] | undefined,
  entry: RetryTrace,
  telemetry?: InferenceTelemetry,
  identity: { mission_id?: string; worker_id?: string; role?: string } = {},
): void {
  into?.push(entry);
  telemetry?.emit("inference.retry.trace", {
    ...identity,
    attempt: entry.attempt,
    ...(entry.failure_id !== undefined ? { failure_id: entry.failure_id } : {}),
    ...(entry.error_ref !== undefined ? { error_ref: entry.error_ref } : {}),
    trace: entry,
  });
}
