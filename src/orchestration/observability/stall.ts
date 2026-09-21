/**
 * Loop / stall detection (spec 03).
 *
 * Detects repeated no-progress behavior per worker: repeated reads of the same
 * file without changes, repeated identical tool calls, repeated errors, and
 * repeated model/tool cycles with no new artifact or DAG transition. Thresholds
 * are configurable per activity type because a test suite, a compile, a model
 * request, and a file edit have different normal latencies.
 *
 * A signal counts only when it is the SAME identity repeated (same path, same
 * command, same error signature). Distinct reads of different files are normal
 * work, never a loop. A legitimate repeating operation that changes state
 * resets its family; only identical no-progress repetition triggers.
 */

import type { LoopSignal, MissionObservabilityConfig } from "./types.ts";

type LoopKind = LoopSignal["kind"];

interface Counter {
  kind: LoopKind;
  detail: string;
  count: number;
}

/** Per-worker loop tracking. */
export class WorkerLoopTracker {
  private readonly config: MissionObservabilityConfig;
  private readonly counters = new Map<string, Counter>();

  constructor(config: MissionObservabilityConfig) {
    this.config = config;
  }

  private note(kind: LoopKind, detail: string): void {
    const key = `${kind}::${detail}`;
    const prev = this.counters.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      this.counters.set(key, { kind, detail, count: 1 });
    }
  }

  /** Note a read of a file (repeated identical reads accumulate). */
  readFile(path: string): void {
    this.note("repeated_file_read", path);
  }

  /** Note an identical tool invocation (canonical signature). */
  toolCall(signature: string, kind: LoopKind = "repeated_tool_call"): void {
    this.note(kind, signature);
  }

  /** Note a repeated error/retry signature. */
  error(signature: string): void {
    this.note("repeated_error", signature);
  }

  /** Note a model/tool cycle (no new artifact / DAG transition). */
  cycle(signature: string): void {
    this.note("repeated_cycle", signature);
  }

  private thresholdFor(kind: LoopKind): number {
    return this.config.loopThresholds[kind] ?? this.config.loopThresholds.default ?? 8;
  }

  /** Remove a family of counters (e.g. reads when a file actually changed). */
  reset(kind?: LoopKind): void {
    if (kind) {
      const prefix = `${kind}::`;
      for (const key of [...this.counters.keys()]) {
        if (key.startsWith(prefix)) this.counters.delete(key);
      }
    } else {
      this.counters.clear();
    }
  }

  /** The most significant loop signals above their per-kind threshold. */
  signals(): LoopSignal[] {
    const out: LoopSignal[] = [];
    for (const c of this.counters.values()) {
      if (c.count >= this.thresholdFor(c.kind)) {
        out.push({ kind: c.kind, detail: c.detail, count: c.count });
      }
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  /** True when any loop signal has crossed its threshold. */
  hasLoop(): boolean {
    return this.signals().length > 0;
  }

  /** Clear the repeated-file-read family (e.g. when the file changed). */
  fileChanged(): void {
    this.reset("repeated_file_read");
  }
}
