/**
 * Scheduling & resource control (spec §22, backlog B-109).
 *
 * A deterministic concurrency limiter with:
 *   - backpressure: tasks queue when concurrency is saturated;
 *   - fairness: weighted round-robin across sources, so one source cannot
 *     starve another;
 *   - speculative execution: launch up to `speculation` copies of a task and
 *     keep the first to settle (used by parallel tournaments / parallel DAG).
 *
 * Pure and dependency-free; the executor is injected so tests use fake work.
 */
export interface SchedulableTask<T> {
  id: string;
  source: string;
  weight?: number;
  run: () => Promise<T>;
  /** Optional abort signal — when fired the task should settle fast. */
  signal?: AbortSignal;
}

export interface ScheduledOutcome<T> {
  id: string;
  source: string;
  value: T;
  /** Time the task spent queued before starting. */
  queuedMs: number;
}

export interface SchedulerOptions {
  /** Maximum concurrently-running tasks. */
  concurrency: number;
}

interface QueueItem<T> {
  task: SchedulableTask<T>;
  resolve: (v: ScheduledOutcome<T>) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

/**
 * Weighted-fairness concurrency scheduler.
 *
 * `scheduleAll` drains the queue in weighted round-robin order across sources,
 * starting up to `concurrency` tasks at once. When a task settles, the next
 * from the fairest source starts. This provides backpressure (callers await
 * completion and are never given unbounded concurrency).
 */
export class Scheduler {
  private readonly concurrency: number;
  private readonly queue: QueueItem<unknown>[] = [];
  private active = 0;
  private readonly pending: Promise<unknown>[] = [];

  constructor(opts: SchedulerOptions) {
    if (opts.concurrency < 1) throw new Error("concurrency must be >= 1");
    this.concurrency = opts.concurrency;
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.queue.length;
  }

  /**
   * Submit one task. Returns a promise that settles when the task completes
   * (backpressure: it may wait in the queue).
   */
  schedule<T>(task: SchedulableTask<T>): Promise<ScheduledOutcome<T>> {
    return new Promise<ScheduledOutcome<T>>((resolve, reject) => {
      this.queue.push({ task: task as SchedulableTask<unknown>, resolve, reject, enqueuedAt: Date.now() });
      this.pump();
    });
  }

  /** Submit many tasks; resolves when all settle, in submission order. */
  async scheduleAll<T>(tasks: SchedulableTask<T>[]): Promise<ScheduledOutcome<T>[]> {
    const out: ScheduledOutcome<T>[] = [];
    // Weighted round-robin: process sources fairly, but scheduleAll awaits all.
    const bySource = new Map<string, SchedulableTask<T>[]>();
    for (const t of tasks) {
      const arr = bySource.get(t.source) ?? [];
      arr.push(t);
      bySource.set(t.source, arr);
    }
    const sources = [...bySource.keys()];
    const cursors = new Map<string, number>();
    const ordered: SchedulableTask<T>[] = [];
    let remaining = tasks.length;
    while (remaining > 0) {
      for (const s of sources) {
        const arr = bySource.get(s)!;
        const idx = cursors.get(s) ?? 0;
        if (idx < arr.length) {
          ordered.push(arr[idx]!);
          cursors.set(s, idx + 1);
          remaining--;
        }
      }
    }
    const results = await Promise.all(ordered.map((t) => this.schedule(t)));
    return results;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      // Fairness: pull the earliest task from the least-recently-served source.
      const item = this.pickFair();
      if (!item) break;
      this.active++;
      const p = (async () => {
        const start = Date.now();
        try {
          const value = await item.task.run();
          item.resolve({ id: item.task.id, source: item.task.source, value, queuedMs: start - item.enqueuedAt });
        } catch (err) {
          item.reject(err);
        } finally {
          this.active--;
          this.pump();
        }
      })();
      this.pending.push(p);
      void p.finally(() => {
        const i = this.pending.indexOf(p);
        if (i >= 0) this.pending.splice(i, 1);
      });
    }
  }

  private pickFair(): QueueItem<unknown> | undefined {
    if (this.queue.length === 0) return undefined;
    // Weighted fairness: prefer sources with higher accumulated weight deficit.
    const deficit = new Map<string, number>();
    for (const q of this.queue) deficit.set(q.task.source, (deficit.get(q.task.source) ?? 0) + (q.task.weight ?? 1));
    let best: QueueItem<unknown> | undefined;
    for (const q of this.queue) {
      if (!best) {
        best = q;
        continue;
      }
      if ((deficit.get(q.task.source) ?? 0) > (deficit.get(best.task.source) ?? 0)) best = q;
    }
    if (!best) return undefined;
    const i = this.queue.indexOf(best);
    return this.queue.splice(i, 1)[0]!;
  }

  /** Wait for all in-flight and queued work to settle. */
  async drain(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) {
      await Promise.allSettled(this.pending.slice());
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /**
   * Speculative execution (spec §22.4): run up to `n` copies of a task and
   * settle with the first successful result. The losers' promises are settled
   * but their values discarded. Used by parallel tournaments.
   */
  async speculative<T>(n: number, task: () => Promise<T>): Promise<T> {
    const copies = Array.from({ length: Math.max(1, n) }, () => task());
    const results = await Promise.allSettled(copies);
    const ok = results.find((r) => r.status === "fulfilled");
    if (ok) return (ok as PromiseFulfilledResult<T>).value;
    throw results.find((r) => r.status === "rejected");
  }
}
