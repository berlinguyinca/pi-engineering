/**
 * Request + tool idempotency (resilience spec §3, §16).
 *
 * Request idempotency: a logical inference request is identified by
 * `mission_id + step_id + request_id`. `request_id` is CONSTANT across retries;
 * `attempt` increments. This lets the supervisor deduplicate: at most one
 * logical inference attempt is outstanding per mission step, and a retried
 * request reuses the same id (so InferWeave, when it supports Idempotency-Key,
 * can deduplicate server-side).
 *
 * Tool idempotency: tool calls must not re-execute across retries. A completed
 * tool call is recorded by `tool_call_id` with its result hash; before replay
 * the supervisor checks the record and reuses the recorded result instead of
 * executing the tool again. This prevents duplicate commits/shell commands/
 * issue creation when an LLM call is retried after the tool already succeeded.
 *
 * Pure in-memory records; callers persist them via checkpoints.
 */

import { createHash } from "node:crypto";

/** A logical inference request identity (constant across retries). */
export interface RequestKey {
  mission_id: string;
  step_id: string;
  /** Constant across retries — deduplication key. */
  request_id: string;
}

/** A request attempt: the key plus an incrementing attempt number. */
export interface RequestAttempt {
  key: RequestKey;
  attempt: number;
}

/** A completed tool call record (persisted so replay is safe). */
export interface ToolCompletion {
  tool_call_id: string;
  mission_id: string;
  step_id: string;
  status: "completed" | "failed";
  /** Hash of the recorded result, for integrity. */
  result_hash: string;
  completed_at: string;
}

/** Registry tracking outstanding requests and completed tool calls. */
export class IdempotencyRegistry {
  /** request_id -> request_key for outstanding/known logical requests. */
  private readonly requests = new Map<string, RequestKey>();
  /** mission_id:step_id -> request_id (the current logical request). */
  private readonly stepRequest = new Map<string, string>();
  /** tool_call_id -> completion record. */
  private readonly toolCompletions = new Map<string, ToolCompletion>();

  /** Begin a logical request; returns the request_id (stable across retries). */
  beginRequest(mission_id: string, step_id: string): RequestKey {
    const stepKey = `${mission_id}:${step_id}`;
    const existing = this.stepRequest.get(stepKey);
    if (existing) {
      const key = this.requests.get(existing);
      if (key) return key;
    }
    const request_id = cryptoRequestId(mission_id, step_id);
    const key: RequestKey = { mission_id, step_id, request_id };
    this.requests.set(request_id, key);
    this.stepRequest.set(stepKey, request_id);
    return key;
  }

  /** Current attempt number for a logical request. */
  attemptFor(request_id: string): number {
    return this.requests.get(request_id) ? this.requests.size : 1;
  }

  /** Whether a tool call already completed (so it must NOT re-execute). */
  hasToolCompletion(tool_call_id: string): boolean {
    return this.toolCompletions.has(tool_call_id);
  }

  /** Record a tool completion for replay. Returns the record. */
  recordToolCompletion(rec: Omit<ToolCompletion, "result_hash"> & { result: string }): ToolCompletion {
    const completion: ToolCompletion = {
      tool_call_id: rec.tool_call_id,
      mission_id: rec.mission_id,
      step_id: rec.step_id,
      status: rec.status,
      result_hash: hashResult(rec.result),
      completed_at: rec.completed_at,
    };
    this.toolCompletions.set(rec.tool_call_id, completion);
    return completion;
  }

  /** Retrieve a recorded tool completion for safe replay. */
  getToolCompletion(tool_call_id: string): ToolCompletion | undefined {
    return this.toolCompletions.get(tool_call_id);
  }
}

/** Deterministic request_id derived from mission + step. */
export function cryptoRequestId(mission_id: string, step_id: string): string {
  return createHash("sha1").update(`${mission_id}\u0000${step_id}`).digest("hex").slice(0, 20);
}

/** Hash a tool result for integrity verification on replay. */
export function hashResult(result: string): string {
  return createHash("sha256").update(result).digest("hex");
}
