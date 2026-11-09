/**
 * Opt-in bounded recovery (R07): a default-off, pure decision for the one class demonstrated idempotent,
 * `incomplete_stream`. It is NOT a retry owner and never executes: `src/guard/transient.ts` already decided
 * this attempt, so `ownerGranted === true` answers `retry: false` — a grant beside the owner is the
 * duplicate-owner defect (RETRY_OWNERS.md conflicts 1 and 3) and this unit neither cancels nor adds. No
 * fallback, model switch, ladder step, status table, clock, RNG, timer, telemetry or I/O: `nowMs` arrives as
 * data, logging means returning `ResilientStreamLogEntry`, and nothing is written. Order: flag_off,
 * class_not_enrolled, owner_granted, not_replayable (R05), circuit_denied (R04), cap_reached, R03's budget.
 */
import type { TransientErrorCategory } from "../guard/transient.ts";
import { type EndpointCircuitSnapshot, evaluateEndpointCircuit } from "./endpointCircuit.ts";
import { type ToolAction, classifyReplaySafety } from "./recoverySafety.ts";
import { evaluateRetryBudget } from "./retryBudget.ts";

export const RESILIENT_STREAM_FLAG = "PI_RESILIENT_STREAM"; // absent, "", "0" or anything unknown means this unit does nothing
export const RESILIENT_STREAM_MAX_ATTEMPTS = 2; // hard ceiling on any attempt granted, however large the caller's own budget is
export const RESILIENT_STREAM_CLASS: string = "incomplete_stream"; // the one enrolled class, widened to string because transient.ts names a truncated stream "network"
const CIRCUIT_COOLDOWN_MS = 60_000; // the cooldown the R04 gate is asked at: the endpoint-health error-backoff cadence R06 also uses

/** True only for "1" / "true" (case-insensitive, trimmed) of the flag; the env arrives as a parameter. */
export function resilientStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[RESILIENT_STREAM_FLAG];
  return typeof value === "string" && ["1", "true"].includes(value.trim().toLowerCase());
}

export interface ResilientStreamInput {
  env?: NodeJS.ProcessEnv;
  ownerGranted: boolean;
  category: TransientErrorCategory;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  baseBackoffMs: number;
  nowMs: number;
  action?: ToolAction;
  circuit?: EndpointCircuitSnapshot;
  retryAfterMs?: number;
  mode?: "bootstrap" | "normal";
} // `ownerGranted` is transient.ts's own verdict; `env` carries the flag as the two resolvers in RETRY_OWNERS-adjacent code do
export type ResilientStreamReason =
  | "flag_off"
  | "class_not_enrolled"
  | "owner_granted"
  | "not_replayable"
  | "circuit_denied"
  | "budget_exhausted"
  | "cap_reached"
  | "granted"; // "granted" is the only reason that ever means retry
export interface ResilientStreamLogEntry {
  flag: typeof RESILIENT_STREAM_FLAG;
  enabled: boolean;
  class: string;
  attempt: number;
  cap: number;
  ownerGranted: boolean;
  reason: ResilientStreamReason;
  waitMs: number | null;
} // the record a caller may log; every field mirrors the decision, and nothing here writes
export interface ResilientStreamDecision {
  retry: boolean;
  waitMs: number | null;
  cap: number;
  reason: ResilientStreamReason;
  log: ResilientStreamLogEntry;
}

/** Decide whether the one enrolled class may make one more bounded attempt — or stays entirely out of the way. */
export function decideResilientStream(input: ResilientStreamInput): ResilientStreamDecision {
  const enabled = resilientStreamEnabled(input.env);
  const cap = Math.min(input.maxAttempts, RESILIENT_STREAM_MAX_ATTEMPTS);
  const out = (retry: boolean, waitMs: number | null, reason: ResilientStreamReason): ResilientStreamDecision => ({
    retry,
    waitMs,
    cap,
    reason,
    log: {
      flag: RESILIENT_STREAM_FLAG,
      enabled,
      class: input.category,
      attempt: input.attempt,
      cap,
      ownerGranted: input.ownerGranted,
      reason,
      waitMs,
    },
  });
  if (!enabled) return out(false, null, "flag_off");
  if (input.category !== RESILIENT_STREAM_CLASS) return out(false, null, "class_not_enrolled");
  if (input.ownerGranted) return out(false, null, "owner_granted");
  if (input.action !== undefined && classifyReplaySafety(input.action).replayAllowed === false)
    return out(false, null, "not_replayable");
  if (
    input.circuit !== undefined &&
    evaluateEndpointCircuit({
      snapshot: input.circuit,
      nowMs: input.nowMs,
      threshold: Math.max(1, input.circuit.consecutiveFailures),
      cooldownMs: CIRCUIT_COOLDOWN_MS,
    }).allowAttempt === false
  )
    return out(false, null, "circuit_denied");
  if (input.attempt >= cap) return out(false, null, "cap_reached");
  const budget = evaluateRetryBudget({ ...input, maxAttempts: cap });
  return budget.action === "retry" ? out(true, budget.waitMs, "granted") : out(false, null, "budget_exhausted");
}
