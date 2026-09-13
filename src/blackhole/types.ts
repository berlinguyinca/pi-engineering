/**
 * Blackhole integration — core domain types.
 *
 * Memory hierarchy (per the spec):
 *   1. Blackhole = local per-session working memory (ephemeral, session-scoped);
 *   2. EventStore/PostgreSQL = authoritative system-of-record (the ledger);
 *   3. OpenViking = promoted durable cross-session memory.
 *
 * The Blackhole store is deliberately NOT the system of record: every lifecycle
 * event and every promotion is emitted to the ledger so the EventStore remains
 * authoritative. The store only accelerates in-session recall.
 */

/** Pinned Blackhole version. Not `latest` — pinned and validated (spec §2). */
export const PINNED_BLACKHOLE_VERSION = "0.5.4";

/** The version allowlist accepted by package validation. */
export const BLACKHOLE_ALLOWLIST = ["0.5.4"];

/**
 * Session identity — the strict-isolation key.
 *
 * A memory store is scoped to the FULL identity. Two workers that differ in any
 * component (work item, run, role, worker, or session) read/write disjoint
 * stores. Candidates, reviewers, and challengers therefore never share working
 * memory, satisfying the tournament isolation requirement.
 */
export interface SessionIdentity {
  project: string;
  workItem: string;
  /** One run = one fresh worker session (run_id). */
  runId: string;
  role: string;
  /** Distinguishes concurrent workers of the same role (candidate legs). */
  workerId: string;
  sessionId: string;
}

/** Canonical isolation key string for the session. */
export function sessionKey(id: SessionIdentity): string {
  return [id.project, id.workItem, id.runId, id.role, id.workerId, id.sessionId].join("/");
}

/** A single observation or reflection entry in a session's memory store. */
export interface MemoryEntry {
  id: string;
  kind: "observation" | "reflection" | "drop" | "promotion-candidate";
  text: string;
  /** Ledger event/evidence/commit reference that grounds this entry. */
  sourceRefs: string[];
  createdAt: string;
  priority: MemoryPriority;
  /** Present when this is a promotion candidate. */
  promotion?: {
    candidateId: string;
    state: PromotionState;
    proposedBy: string;
    evidenceIds: string[];
    decidedAt: string | null;
    decidedBy: string | null;
    note?: string;
  };
  /** True after compaction merged this entry into a summary (retained for audit). */
  compactedInto: string | null;
}

export type MemoryPriority = "P0" | "P1" | "P2" | "P3" | "P4";

/** Lower-priority background inference classes used for memory workers. */
export const MEMORY_WORKER_PRIORITIES = {
  observer: "P3",
  reflector: "P3",
  dropper: "P4",
} as const;

export type MemoryWorkerRole = keyof typeof MEMORY_WORKER_PRIORITIES;

/**
 * Backing store for promoted durable (shared) memory.
 *
 *  - `memory`       — single-process in-memory (default; no sharing).
 *  - `shared-file`  — append-only JSONL on a shared path; several workers on one
 *                     host share promoted memory (dependency-free, CI-friendly).
 *  - `openviking`   — the external OpenViking service for cross-machine sharing.
 */
export type DurableStoreConfig =
  | { kind: "memory" }
  | { kind: "shared-file"; file: string }
  | { kind: "openviking"; baseUrl: string; token?: string };

export type PromotionState = "proposed" | "accepted" | "rejected" | "promoted" | "superseded";

export interface PromotionCandidate {
  id: string;
  text: string;
  state: PromotionState;
  sourceRefs: string[];
  proposedBy: string;
  evidenceIds: string[];
  proposedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note?: string;
}

/** Per-session Blackhole config (defaults off — backward compatible). */
export interface BlackholeConfig {
  enabled: boolean;
  /** Pinned package version to require (see PINNED_BLACKHOLE_VERSION). */
  version: string;
  /** Route table for memory workers (capability-based, via ModelRouter). */
  routes: {
    observer: string;
    reflector: string;
    dropper: string;
  };
  /** Scheduler concurrency cap for background memory work. */
  memoryWorkerConcurrency: number;
  /** Never auto-promote speculative candidate memory (spec). */
  autoPromotion: false;
  /** Compaction threshold in entries (default 200). */
  compactionThreshold: number;
  /** Session memory retention (ms) before idle sessions are closed. */
  sessionTtlMs: number;
  /** Backing store for promoted durable (shared) memory. */
  durable: DurableStoreConfig;
  /** Bounded wait (ms) for a shared-durable provider call so a hanging provider
   *  can never stall a worker (spec: provider outage must not block engineering). */
  providerTimeoutMs: number;
}

export interface BlackholeManagerState {
  enabled: boolean;
  version: string;
  provider: "builtin" | "pi-blackhole" | "disabled";
  /** Backing store for shared durable memory ("memory" | "shared-file" | "openviking"). */
  durableKind: string;
  sessions: number;
  activeSessions: number;
  entries: number;
  compactions: number;
  promotionCandidates: number;
  promoted: number;
  memoryWorkersRun: { observer: number; reflector: number; dropper: number };
}
