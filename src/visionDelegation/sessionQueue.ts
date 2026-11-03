/**
 * Per-key promise queue: calls for one key run strictly one after another, in
 * call order; different keys run independently. An earlier call that rejects
 * never blocks the next. A key's entry is dropped once it is idle, and only
 * when the map still holds that call's own tail (so a later chained call is
 * never orphaned).
 */
export class SessionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** True while a call for `key` is running or queued. */
  has(key: string): boolean {
    return this.tails.has(key);
  }

  /** Number of keys with a running or queued call. */
  get size(): number {
    return this.tails.size;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
