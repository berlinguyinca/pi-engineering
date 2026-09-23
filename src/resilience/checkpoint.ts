/**
 * Mission checkpoints (resilience spec §6).
 *
 * A checkpoint captures enough durable state that a mission can resume at its
 * exact interrupted step after a process restart or a pause. It is persisted
 * BEFORE every external LLM operation. Wall-clock timestamps (retry deadline,
 * started-at) are persisted so a restart does NOT reset the retry window.
 */

import type { RequestKey } from "./idempotency.ts";

/** Durable mission checkpoint schema. */
export interface MissionCheckpoint {
  mission_id: string;
  workflow: string;
  current_phase: string;
  current_step: string;
  /** The step's durable state (e.g. "awaiting_llm", "awaiting_tool"). */
  step_state: string;
  working_directory: string;
  repository: string;
  branch: string;
  /** The mission base commit the checkpoint is relative to. */
  base_ref: string;
  last_completed_action: string;
  pending_action: string;
  /** Request identity, stable across retries. */
  request?: RequestKey;
  /** Wall-clock retry window timestamps (NOT reset on restart). */
  retry_started_at_ms: number;
  retry_deadline_ms: number;
  /** Tool results persisted for idempotent replay. */
  tool_results: Record<string, unknown>;
  /** artifact:// refs. */
  artifacts: string[];
  /** Wall-clock checkpoint creation time. */
  created_at_ms: number;
}

/** Create a checkpoint from partial state. */
export function makeCheckpoint(input: Omit<MissionCheckpoint, "created_at_ms">): MissionCheckpoint {
  return { ...input, created_at_ms: Date.now() };
}
