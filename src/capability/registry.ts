/**
 * Model capability registry (spec §9.2 refresh policies, §10 registry).
 *
 * The registry is the single place that knows which models exist right now.
 * It refreshes on an interval, when provider configuration changes, on an
 * explicit operator command, and on demand when a routing query finds nothing
 * usable (a model added minutes ago must not require a restart).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelRecord, ModelRef } from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import type { DiscoveryContext, ModelSource } from "./discovery.ts";
import { mergeRecords } from "./discovery.ts";
import { hasCapability } from "./modelRecord.ts";
import { ObservedStore } from "./observed.ts";

export interface PenaltyEntry {
  ref: ModelRef;
  reason: string;
  appliedAt: number;
  /** Multiplicative score penalty in (0,1]. */
  factor: number;
}

export interface RegistryOptions {
  sources: ModelSource[];
  context: DiscoveryContext;
  /** Persistence path for penalties + last-known inventory ("" disables). */
  file?: string;
  ttlMs?: number;
  /** Penalty decay window. */
  penaltyDecayMs?: number;
}

export interface RefreshResult {
  models: number;
  at: string;
  sources: string[];
  changed: boolean;
  errors: string[];
}

interface PersistShape {
  version: number;
  updatedAt: string;
  penalties: PenaltyEntry[];
  inventory: ModelRecord[];
}

export class ModelCapabilityRegistry {
  private readonly sources: ModelSource[];
  private readonly context: DiscoveryContext;
  private readonly file: string | undefined;
  private readonly ttlMs: number;
  private readonly penaltyDecayMs: number;

  private records = new Map<string, ModelRecord>();
  private penalties = new Map<string, PenaltyEntry>();
  private lastRefresh = 0;
  private lastSignature = "";
  private refreshPromise: Promise<RefreshResult> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  readonly observed: ObservedStore;

  private constructor(opts: RegistryOptions) {
    this.sources = opts.sources;
    this.context = opts.context;
    this.file = opts.file;
    this.ttlMs = opts.ttlMs ?? 300_000;
    this.penaltyDecayMs = opts.penaltyDecayMs ?? 600_000;
    this.observed = ObservedStore.inMemory();
  }

  static async open(opts: RegistryOptions): Promise<ModelCapabilityRegistry> {
    const registry = new ModelCapabilityRegistry(opts);
    if (opts.file) {
      try {
        const parsed = JSON.parse(await readFile(opts.file, "utf-8")) as PersistShape;
        for (const rec of parsed.inventory ?? []) registry.records.set(modelKey(rec), rec);
        for (const pen of parsed.penalties ?? []) registry.penalties.set(modelKey(pen.ref), pen);
        registry.lastSignature = parsed.inventory?.length ? "restored" : "";
      } catch {
        // No usable cache: discovery will repopulate.
      }
    }
    return registry;
  }

  get size(): number {
    return this.records.size;
  }

  all(): ModelRecord[] {
    const now = Date.now();
    return [...this.records.values()].map((rec) => {
      const pen = this.penalties.get(modelKey(rec));
      const penalty = pen ? this.penaltyStrength(pen, now) : 0;
      return { ...rec, penalty, penaltyReason: penalty > 0 ? pen?.reason : undefined };
    });
  }

  get(ref: ModelRef): ModelRecord | undefined {
    return this.all().find((r) => r.provider === ref.provider && r.id === ref.id);
  }

  /** Models satisfying every hard capability, ignoring health (for diagnostics). */
  byCapability(capabilities: string[]): ModelRecord[] {
    return this.all().filter((rec) => capabilities.every((c) => hasCapability(rec, c)));
  }

  /** True when a refresh is due (TTL expired or provider config changed). */
  async isStale(): Promise<boolean> {
    if (Date.now() - this.lastRefresh > this.ttlMs) return true;
    const sig = await this.signature();
    return sig !== this.lastSignature;
  }

  private async signature(): Promise<string> {
    const parts: string[] = [];
    for (const src of this.sources) {
      parts.push(`${src.name}=${(await src.signature?.(this.context)) ?? "-"}`);
    }
    return parts.join("|");
  }

  /** Refresh when stale. Failures keep the previous inventory usable. */
  async ensureFresh(): Promise<RefreshResult | undefined> {
    if (!(await this.isStale())) return undefined;
    return this.refresh();
  }

  refresh(): Promise<RefreshResult> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const errors: string[] = [];
      const used: string[] = [];
      const batches: ModelRecord[][] = [];
      for (const src of this.sources) {
        try {
          const found = await src.discover(this.context);
          batches.push(found);
          if (found.length) used.push(src.name);
        } catch (err) {
          errors.push(`${src.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const merged = mergeRecords(batches);
      const before = [...this.records.keys()].sort().join(",");
      this.records = new Map(merged.map((rec) => [modelKey(rec), rec]));
      const after = [...this.records.keys()].sort().join(",");
      const result: RefreshResult = {
        models: this.records.size,
        at: new Date().toISOString(),
        sources: used,
        changed: before !== after,
        errors,
      };
      this.lastRefresh = Date.now();
      this.lastSignature = await this.signature();
      this.persist();
      return result;
    })().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /** Record that a model failed for a role; it stays eligible but is down-weighted. */
  penalize(ref: ModelRef, reason: string, factor = 0.5): void {
    this.penalties.set(modelKey(ref), { ref, reason, appliedAt: Date.now(), factor });
    this.persist();
  }

  clearPenalty(ref: ModelRef): void {
    this.penalties.delete(modelKey(ref));
    this.persist();
  }

  activePenalty(ref: ModelRef): PenaltyEntry | undefined {
    const pen = this.penalties.get(modelKey(ref));
    if (!pen) return undefined;
    return this.penaltyStrength(pen, Date.now()) > 0 ? pen : undefined;
  }

  /** Exponentially decaying penalty strength in (0,1). */
  private penaltyStrength(pen: PenaltyEntry, now: number): number {
    const age = now - pen.appliedAt;
    if (age > this.penaltyDecayMs * 3) return 0;
    const decayed = pen.factor * 0.5 ** (age / this.penaltyDecayMs);
    return decayed < 0.02 ? 0 : decayed;
  }

  /** Drop models a provider no longer reports, keeping operator-declared ones. */
  pruneUnknown(refs: ModelRef[]): void {
    const keep = new Set(refs.map(modelKey));
    for (const key of [...this.records.keys()]) {
      if (!keep.has(key)) this.records.delete(key);
    }
  }

  /** Record provider/model load saturation (0..1) from admission/health signals. */
  recordSaturation(ref: ModelRef, saturation: number): void {
    const rec = this.records.get(modelKey(ref));
    if (!rec) return;
    rec.load = Math.max(0, Math.min(1, saturation));
    if (saturation >= 0.95) {
      rec.available = false;
      rec.healthReason = "provider saturation: admission retries or capacity back-pressure";
    } else if (rec.healthReason?.startsWith("provider saturation")) {
      rec.healthy = true;
      rec.healthReason = undefined;
    }
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const payload: PersistShape = {
      version: 1,
      updatedAt: new Date().toISOString(),
      penalties: [...this.penalties.values()],
      inventory: [...this.records.values()].map((r) => ({ ...r, penalty: 0 })),
    };
    const text = JSON.stringify(payload, null, 2);
    const op = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, text, "utf-8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
    });
    this.writeChain = op.catch(() => {});
    void op;
  }
}
