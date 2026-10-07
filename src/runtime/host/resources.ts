/**
 * Every resource a runtime generation creates belongs to that generation and
 * is disposed with it (spec §4). Disposal is idempotent, order is reverse of
 * creation, and one failing disposer never strands the rest.
 */

import type { Disposable, ResourceOwner } from "./contract.ts";

type Entry = { label: string; dispose: () => void | Promise<void> };

export class RuntimeResourceRegistry implements ResourceOwner {
  private entries: Entry[] = [];
  private disposed = false;

  add(resource: Disposable | (() => void | Promise<void>), label = "resource"): void {
    const dispose = typeof resource === "function" ? resource : () => resource.dispose();
    if (this.disposed) {
      // A late registration from a generation already torn down: dispose it
      // now rather than leak it. Asynchronously, so a caller mid-setup is not
      // re-entered.
      queueMicrotask(() => {
        void Promise.resolve()
          .then(dispose)
          .catch(() => {});
      });
      return;
    }
    this.entries.push({ label, dispose });
  }

  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      this.remove(entry);
      fn();
    }, ms);
    const entry: Entry = { label: "timeout", dispose: () => clearTimeout(handle) };
    if (this.disposed) clearTimeout(handle);
    else this.entries.push(entry);
    return handle;
  }

  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const handle = setInterval(fn, ms);
    if (this.disposed) clearInterval(handle);
    else this.entries.push({ label: "interval", dispose: () => clearInterval(handle) });
    return handle;
  }

  size(): number {
    return this.entries.length;
  }

  labels(): string[] {
    return this.entries.map((e) => e.label);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Dispose everything, newest first. Returns one line per failed disposer. */
  async disposeAll(): Promise<string[]> {
    this.disposed = true;
    const failures: string[] = [];
    while (this.entries.length > 0) {
      const entry = this.entries.pop() as Entry;
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return failures;
  }

  private remove(entry: Entry): void {
    const at = this.entries.indexOf(entry);
    if (at >= 0) this.entries.splice(at, 1);
  }
}
