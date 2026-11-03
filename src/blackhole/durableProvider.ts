/**
 * Durable memory provider abstraction for promoted cross-session memory.
 *
 * Promoted durable memory flows through this seam. The shared backend is
 * Hindsight (the herdr-memory service); core provides the abstraction and a
 * dependency-free in-memory durable store so promotion is testable end-to-end
 * without the external system. Other backends can be supplied by wiring a
 * provider that persists elsewhere (the interface is the contract).
 */

export interface DurableMemoryRecord {
  id: string;
  text: string;
  sourceRefs: string[];
  promotedFrom: string; // session key or promotion candidate id
  evidenceIds: string[];
  promotedAt: string;
  promotedBy: string;
  /** Optional Hindsight-era metadata; legacy providers ignore these. */
  scope?: string; // project | global | infra | mission:<id>
  bankId?: string;
  revision?: number;
  status?: "candidate" | "verified" | "superseded" | "retracted";
  kind?: string; // verified_fact | decision | preference | hypothesis | failure | procedure
  provenance?: Record<string, unknown>;
}

export type RetainOutcome = "persisted" | "queued_durable" | "rejected";

export interface RetainResult {
  outcome: RetainOutcome;
  memoryId?: string;
  bankId?: string;
  revision?: number;
}

export interface DurableMemoryProvider {
  readonly kind: string;
  store(record: DurableMemoryRecord): Promise<void>;
  recallAll(): Promise<DurableMemoryRecord[]>;
  /** Search promoted durable memory (simple substring match by default). */
  search(query: string): Promise<DurableMemoryRecord[]>;
  /** Optional: store with an explicit outcome (never "persisted" unless acknowledged). */
  retain?(record: DurableMemoryRecord): Promise<RetainResult>;
  /** Optional: stable cache-key component (scopes + revision epoch) for recall caching. */
  cacheScope?(): string;
}

/**
 * Hindsight recall does not expose a list-all endpoint: `recallAll()` is the
 * whole-bank read used by connection checks, which Hindsight answers as a
 * best-effort semantic recall rather than a literal enumeration.
 */
export const HINDSIGHT_RECALL_ALL_QUERY = "saved memory notes";

/** Dependency-free in-memory durable store (default provider). */
export class InMemoryDurableMemory implements DurableMemoryProvider {
  readonly kind = "in-memory";
  private readonly records = new Map<string, DurableMemoryRecord>();

  async store(record: DurableMemoryRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async recallAll(): Promise<DurableMemoryRecord[]> {
    return [...this.records.values()];
  }

  async search(query: string): Promise<DurableMemoryRecord[]> {
    return searchDurable(query, [...this.records.values()]);
  }
}

/**
 * Token-based relevance matcher shared by all durable providers. A record is
 * relevant when ANY whitespace-delimited token in the query is a substring of
 * the record's text or one of its source references. Token matching is far more
 * useful than whole-string substring matching for short worker-context queries.
 */
export function searchDurable(query: string, records: DurableMemoryRecord[]): DurableMemoryRecord[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return records;
  return records.filter((r) => {
    const hay = `${r.text.toLowerCase()} ${r.sourceRefs.join(" ").toLowerCase()}`;
    return tokens.some((t) => hay.includes(t));
  });
}
