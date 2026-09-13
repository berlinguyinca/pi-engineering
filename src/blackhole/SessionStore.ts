/**
 * Session identity generation + strict isolation.
 *
 * Every worker session (candidate, reviewer, challenger, planner, scout,
 * memory worker) is assigned a unique SessionIdentity. The memory store is
 * keyed by the FULL identity, so no two workers ever share working memory.
 */
import { newRunId } from "../core/ids.ts";
import type { SessionIdentity } from "./types.ts";
export type { SessionIdentity };

export interface SessionContext {
  project: string;
  workItem: string;
  role: string;
  /** Distinguishes concurrent same-role workers (candidate legs). */
  workerId?: string;
  runId?: string;
}

/** Build a fresh SessionIdentity, defaulting missing components to fresh runs. */
export function newSessionIdentity(ctx: SessionContext): SessionIdentity {
  return {
    project: ctx.project,
    workItem: ctx.workItem,
    role: ctx.role,
    workerId: ctx.workerId ?? "default",
    runId: ctx.runId ?? newRunId(),
    sessionId: newRunId(),
  };
}

/**
 * Derive a deterministic session identity from a parent for a memory worker.
 * A memory worker observes a PARENT session but must not read its peer workers'
 * parent sessions; the identity here is the memory worker's OWN.
 */
export function memoryWorkerIdentity(parent: SessionIdentity, role: string): SessionIdentity {
  return {
    project: parent.project,
    workItem: parent.workItem,
    runId: parent.runId,
    role: `memory-${role}`,
    workerId: parent.workerId,
    sessionId: `${parent.sessionId}:${role}`,
  };
}

export function identityToRecord(id: SessionIdentity): Record<string, string> {
  return {
    project: id.project,
    workItem: id.workItem,
    runId: id.runId,
    role: id.role,
    workerId: id.workerId,
    sessionId: id.sessionId,
  };
}
