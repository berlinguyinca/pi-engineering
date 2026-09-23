/**
 * Mission watchdog (resilience spec §18).
 *
 * Distinguishes a mission that is genuinely hung from one that is merely
 * waiting on infrastructure. A mission in WAITING_FOR_LLM with healthy
 * heartbeats is NOT hung — its process is alive and progressing its retry
 * window. Only a process that stops publishing heartbeats is hung.
 *
 * The watchdog tracks the last heartbeat time and the last LLM success / last
 * tool progress times, and can advise whether the mission is stalled.
 *
 * Pure and deterministic with an injectable clock.
 */

export interface WatchdogConfig {
  heartbeat_interval_ms: number;
  inference_stall_threshold_ms: number;
  tool_stall_threshold_ms: number;
  auto_recover: boolean;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  heartbeat_interval_ms: 10_000,
  inference_stall_threshold_ms: 5 * 60_000,
  tool_stall_threshold_ms: 10 * 60_000,
  auto_recover: true,
};

export interface WatchdogState {
  last_heartbeat_at_ms: number;
  last_llm_success_at_ms: number;
  last_tool_progress_at_ms: number;
  /** Mission state at last observation (for stall classification). */
  mission_state: string;
}

export type StallKind = "none" | "heartbeat_lost" | "inference_stalled" | "tool_stalled";

/** A process whose heartbeat is missing is hung; one that heartbeats is alive. */
export function isProcessAlive(state: WatchdogState, nowMs: number, config: WatchdogConfig): boolean {
  return nowMs - state.last_heartbeat_at_ms <= config.heartbeat_interval_ms * 3;
}

/**
 * Classify the stall kind. A mission in a WAITING_* state with healthy
 * heartbeats is NOT stalled by inference/tool thresholds — it is deliberately
 * waiting. Only a missing heartbeat means a hung process.
 */
export function classifyStall(state: WatchdogState, nowMs: number, config: WatchdogConfig): StallKind {
  if (!isProcessAlive(state, nowMs, config)) return "heartbeat_lost";
  if (state.mission_state.startsWith("WAITING_FOR")) return "none";
  if (state.mission_state === "PAUSED_INFRASTRUCTURE" || state.mission_state === "NEEDS_ATTENTION") return "none";
  if (nowMs - state.last_llm_success_at_ms > config.inference_stall_threshold_ms) return "inference_stalled";
  if (nowMs - state.last_tool_progress_at_ms > config.tool_stall_threshold_ms) return "tool_stalled";
  return "none";
}

/** Record a heartbeat. */
export function heartbeat(state: WatchdogState, nowMs: number): WatchdogState {
  return { ...state, last_heartbeat_at_ms: nowMs };
}

/** Record an LLM success. */
export function recordLlmSuccess(state: WatchdogState, nowMs: number): WatchdogState {
  return { ...state, last_llm_success_at_ms: nowMs };
}

/** Record tool progress. */
export function recordToolProgress(state: WatchdogState, nowMs: number): WatchdogState {
  return { ...state, last_tool_progress_at_ms: nowMs };
}
