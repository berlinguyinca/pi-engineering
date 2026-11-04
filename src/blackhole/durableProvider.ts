/**
 * Durable memory provider abstraction — the seam promoted cross-session memory
 * flows through.
 *
 * The interface is the contract; the backends live beside it (`durable.ts` for
 * the shared-file store, `hindsight.ts` for the `herdr-memory` CLI backend).
 * This module stays dependency-free and holds the in-process store used as the
 * default and by tests, so promotion is exercisable end to end with no external
 * service. A retired backend is not silently mapped onto this interface: an
 * unknown `durable.kind` is refused by `config.ts` rather than falling back here.
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
  /** Why a rejected outcome happened when it was a transport failure (e.g. "unavailable"), not a policy refusal. */
  error?: string;
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
  /** Optional strict health probe: resolves to the saved count, rethrows transport failures (unlike best-effort reads). */
  probe?(): Promise<number>;
}

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
