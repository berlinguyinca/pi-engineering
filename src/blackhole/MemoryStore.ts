/**
 * Session-local memory store — the built-in Blackhole provider.
 *
 * Implements Blackhole semantics without requiring the external `pi-blackhole`
 * package: a per-session store of observations/reflections/drop records, recall
 * by recency + priority, compaction (quality-degradation tested), and promotion
 * candidates. Strictly session-scoped: constructed with a SessionIdentity and
 * only ever keyed by it.
 */
import { id } from "../core/ids.ts";
import {
  type MemoryEntry,
  type MemoryPriority,
  type PromotionCandidate,
  type SessionIdentity,
  sessionKey,
} from "./types.ts";

export interface CompactionResult {
  removed: number;
  summary: string;
  compactedEntryIds: string[];
}

/**
 * Deterministic session-memory store. Injected clock for testability.
 */
export class MemoryStore {
  readonly identity: SessionIdentity;
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly promotion = new Map<string, PromotionCandidate>();
  private readonly compactionThreshold: number;
  private compactions = 0;
  private now: () => string;

  constructor(identity: SessionIdentity, opts: { compactionThreshold?: number; now?: () => string } = {}) {
    this.identity = identity;
    this.compactionThreshold = opts.compactionThreshold ?? 200;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  get key(): string {
    return sessionKey(this.identity);
  }

  /** Strict isolation: verify a foreign identity cannot address this store. */
  assertOwner(identity: SessionIdentity): void {
    if (sessionKey(identity) !== this.key) {
      throw new Error(
        `session isolation violation: identity ${sessionKey(identity)} cannot access store for ${this.key}`,
      );
    }
  }

  observe(text: string, sourceRefs: string[], priority: MemoryPriority = "P2"): MemoryEntry {
    this.assertOwner(this.identity);
    const entry: MemoryEntry = {
      id: id("mem"),
      kind: "observation",
      text,
      sourceRefs,
      createdAt: this.now(),
      priority,
      compactedInto: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  reflect(text: string, sourceRefs: string[], priority: MemoryPriority = "P3"): MemoryEntry {
    this.assertOwner(this.identity);
    const entry: MemoryEntry = {
      id: id("mem"),
      kind: "reflection",
      text,
      sourceRefs,
      createdAt: this.now(),
      priority,
      compactedInto: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  drop(text: string, sourceRefs: string[], priority: MemoryPriority = "P4"): MemoryEntry {
    this.assertOwner(this.identity);
    const entry: MemoryEntry = {
      id: id("mem"),
      kind: "drop",
      text,
      sourceRefs,
      createdAt: this.now(),
      priority,
      compactedInto: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  get all(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  get compactionCount(): number {
    return this.compactions;
  }

  /**
   * Recall: return the most recent `limit` entries, ordered by priority then
   * recency (P0 highest). This is the in-session working-memory surface.
   */
  recall(limit = 20): MemoryEntry[] {
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 } as Record<MemoryPriority, number>;
    return this.all
      .filter((e) => e.compactedInto === null)
      .sort((a, b) => rank[a.priority] - rank[b.priority] || (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, limit);
  }

  /**
   * Compaction: collapse the oldest entries (below the threshold, lowest
   * priority) into a single summary entry, retaining them for audit. This is
   * where compaction-quality degradation is measurable: repeated compaction
   * must preserve the highest-priority content.
   */
  compact(): CompactionResult {
    const all = this.all;
    if (all.length <= this.compactionThreshold) {
      return { removed: 0, summary: "", compactedEntryIds: [] };
    }
    const rank = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 } as Record<MemoryPriority, number>;
    // Keep the newest + highest-priority up to the threshold; compact the rest.
    const keep = all
      .filter((e) => e.compactedInto === null)
      .sort((a, b) => rank[a.priority] - rank[b.priority] || (a.createdAt < b.createdAt ? -1 : 1))
      .slice(0, this.compactionThreshold);
    const keepIds = new Set(keep.map((k) => k.id));
    const toCompact = all.filter((e) => e.compactedInto === null && !keepIds.has(e.id));
    if (toCompact.length === 0) return { removed: 0, summary: "", compactedEntryIds: [] };
    const summaryId = id("mem");
    const summaryText = toCompact
      .slice(-this.compactionThreshold)
      .map((e) => `[${e.priority} ${e.kind}] ${e.text}`)
      .join(" | ");
    const summaryEntry: MemoryEntry = {
      id: summaryId,
      kind: "reflection",
      text: `compacted ${toCompact.length} entries: ${summaryText}`,
      sourceRefs: toCompact.flatMap((e) => e.sourceRefs),
      createdAt: this.now(),
      priority: "P2",
      compactedInto: null,
    };
    for (const e of toCompact) {
      this.entries.set(e.id, { ...e, compactedInto: summaryId });
    }
    this.entries.set(summaryId, summaryEntry);
    this.compactions++;
    return { removed: toCompact.length, summary: summaryText, compactedEntryIds: toCompact.map((e) => e.id) };
  }

  /** Propose a promotion candidate (never auto-promoted). */
  proposePromotion(text: string, sourceRefs: string[], proposedBy: string, evidenceIds: string[]): PromotionCandidate {
    this.assertOwner(this.identity);
    const c: PromotionCandidate = {
      id: id("promo"),
      text,
      state: "proposed",
      sourceRefs,
      proposedBy,
      evidenceIds,
      proposedAt: this.now(),
      decidedAt: null,
      decidedBy: null,
    };
    this.promotion.set(c.id, c);
    // Mirror into working memory as an audit trail entry.
    this.entries.set(id("mem"), {
      id: id("mem"),
      kind: "promotion-candidate",
      text: `promotion candidate ${c.id}: ${text}`,
      sourceRefs,
      createdAt: this.now(),
      priority: "P1",
      promotion: {
        candidateId: c.id,
        state: "proposed",
        proposedBy,
        evidenceIds,
        decidedAt: null,
        decidedBy: null,
      },
      compactedInto: null,
    });
    return c;
  }

  decidePromotion(
    id: string,
    state: PromotionCandidate["state"],
    decidedBy: string,
    note?: string,
  ): PromotionCandidate | undefined {
    const c = this.promotion.get(id);
    if (!c) return undefined;
    const next: PromotionCandidate = {
      ...c,
      state,
      decidedAt: this.now(),
      decidedBy,
      note,
    };
    this.promotion.set(id, next);
    // Update the mirrored entry.
    for (const e of this.entries.values()) {
      if (e.promotion?.candidateId === id) {
        this.entries.set(e.id, { ...e, promotion: { ...e.promotion, state, decidedAt: next.decidedAt, decidedBy } });
      }
    }
    return next;
  }

  getPromotion(id: string): PromotionCandidate | undefined {
    return this.promotion.get(id);
  }

  listPromotions(): PromotionCandidate[] {
    return [...this.promotion.values()];
  }
}
