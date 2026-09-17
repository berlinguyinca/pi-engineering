/**
 * Observed model performance (spec §10.3, §25).
 *
 * Observed quality is a *ranking* signal only, and only once a minimum number
 * of samples exists. It never overrides a hard capability requirement. Scores
 * use exponential recency weighting so a model that improved (or degraded)
 * recently is represented faithfully.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ModelRef, type ObservedPerformance, modelKey } from "../lifecycle/types.ts";

export interface ObservationSample {
  model: ModelRef;
  role: string;
  at: string;
  /** 0..1 — reviewer/verifier grade for the work this model produced or judged. */
  quality: number;
  ok: boolean;
  timedOut?: boolean;
  latencyMs?: number;
}

interface StoreShape {
  version: number;
  models: Record<string, ObservedPerformance & { recent: { at: string; quality: number; ok: boolean }[] }>;
}

const EMPTY: StoreShape = { version: 1, models: {} };

export class ObservedStore {
  private data: StoreShape = structuredClone(EMPTY);
  private writeChain: Promise<void> = Promise.resolve();

  private readonly file: string | undefined;

  private constructor(file: string | undefined) {
    this.file = file;
  }

  static async open(file: string | undefined): Promise<ObservedStore> {
    const store = new ObservedStore(file);
    if (file) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf-8")) as StoreShape;
        if (parsed?.models) store.data = { version: 1, models: parsed.models };
      } catch {
        // A missing or corrupt store simply starts empty.
      }
    }
    return store;
  }

  static inMemory(): ObservedStore {
    return new ObservedStore(undefined);
  }

  get(ref: ModelRef): ObservedPerformance | undefined {
    const rec = this.data.models[modelKey(ref)];
    if (!rec) return undefined;
    const { recent: _recent, ...perf } = rec;
    return perf;
  }

  /** Fold one sample in; returns the updated performance summary. */
  record(sample: ObservationSample): ObservedPerformance {
    const key = modelKey(sample.model);
    const existing = this.data.models[key] ?? {
      samples: 0,
      meanQuality: 0,
      failures: 0,
      timeouts: 0,
      recent: [],
    };
    const recent = [...existing.recent, { at: sample.at, quality: sample.quality, ok: sample.ok }].slice(-50);
    const halfLifeDays = 30;
    const now = Date.parse(sample.at);
    let weightSum = 0;
    let qualitySum = 0;
    for (const s of recent) {
      const ageDays = Math.max(0, (now - Date.parse(s.at)) / 86_400_000);
      const w = 0.5 ** (ageDays / halfLifeDays);
      weightSum += w;
      qualitySum += w * s.quality;
    }
    const latencies = recent.length
      ? [sample.latencyMs, existing.meanLatencyMs].filter((n): n is number => typeof n === "number")
      : [];
    const meanLatencyMs = latencies.length
      ? (existing.meanLatencyMs ?? sample.latencyMs ?? 0) * 0.7 +
        (sample.latencyMs ?? existing.meanLatencyMs ?? 0) * 0.3
      : undefined;
    const updated: ObservedPerformance & { recent: typeof recent } = {
      samples: existing.samples + 1,
      meanQuality: weightSum > 0 ? qualitySum / weightSum : sample.quality,
      failures: existing.failures + (sample.ok ? 0 : 1),
      timeouts: existing.timeouts + (sample.timedOut ? 1 : 0),
      lastLatencyMs: sample.latencyMs,
      meanLatencyMs,
      lastSeenAt: sample.at,
      recent,
    };
    this.data.models[key] = updated;
    this.persist();
    const { recent: _r, ...perf } = updated;
    return perf;
  }

  /** Confidence in [0,1] that observed quality is meaningful for ranking. */
  confidence(ref: ModelRef, minSamples: number): number {
    const rec = this.data.models[modelKey(ref)];
    if (!rec || rec.samples < minSamples) return 0;
    return Math.min(1, 0.5 + rec.samples / (minSamples * 6));
  }

  snapshot(): Record<string, ObservedPerformance> {
    const out: Record<string, ObservedPerformance> = {};
    for (const [key, rec] of Object.entries(this.data.models)) {
      const { recent: _recent, ...perf } = rec;
      out[key] = perf;
    }
    return out;
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const payload = JSON.stringify(this.data, null, 2);
    const op = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      // Write-then-rename keeps a crash from truncating the store.
      const tmp = `${file}.tmp`;
      await writeFile(tmp, payload, "utf-8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, file);
    });
    this.writeChain = op.catch(() => {});
    void op;
  }
}
