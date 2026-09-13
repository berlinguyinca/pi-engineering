/**
 * OpenViking — promoted durable cross-session memory provider abstraction.
 *
 * Promoted durable memory flows through this seam. OpenViking itself is external
 * infrastructure; core provides the abstraction and a dependency-free in-memory
 * durable store so promotion is testable end-to-end without the external system.
 * A real implementation can be supplied by wiring a provider that persists
 * elsewhere (the interface is the contract).
 */

export interface DurableMemoryRecord {
  id: string;
  text: string;
  sourceRefs: string[];
  promotedFrom: string; // session key or promotion candidate id
  evidenceIds: string[];
  promotedAt: string;
  promotedBy: string;
}

export interface DurableMemoryProvider {
  readonly kind: string;
  store(record: DurableMemoryRecord): Promise<void>;
  recallAll(): Promise<DurableMemoryRecord[]>;
  /** Search promoted durable memory (simple substring match by default). */
  search(query: string): Promise<DurableMemoryRecord[]>;
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
    const q = query.toLowerCase();
    return [...this.records.values()].filter(
      (r) => r.text.toLowerCase().includes(q) || r.sourceRefs.some((s) => s.toLowerCase().includes(q)),
    );
  }
}
