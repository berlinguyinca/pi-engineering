/**
 * Central registry of what the runtime is in the middle of (spec §19, §22, §23).
 *
 * `waitForSafePoint` reports exactly what it is waiting for, is cancellable,
 * and can time out. It never kills anything. The gate holds NEW work while a
 * handover is in progress (spec §21: queue, do not drop).
 */

import { randomUUID } from "node:crypto";
import type {
  ActiveRuntimeOperation,
  OperationHandle,
  RuntimeOperationType,
  SafePointOptions,
  SafePointResult,
} from "./contract.ts";

const DESCRIBE: Record<RuntimeOperationType, [string, string]> = {
  inference: ["active inference request", "active inference requests"],
  tool: ["tool execution", "tool executions"],
  verification: ["verification command", "verification commands"],
  git: ["git mutation", "git mutations"],
  deployment: ["deployment", "deployments"],
  state_transaction: ["state transaction", "state transactions"],
  command: ["running command", "running commands"],
  event: ["event handler", "event handlers"],
  migration: ["migration", "migrations"],
};

export class OperationRegistry {
  private readonly ops = new Map<string, ActiveRuntimeOperation>();
  private readonly listeners = new Set<() => void>();
  private gateReason: string | null = null;
  private gateWaiters: Array<() => void> = [];
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  begin(
    generation: number,
    type: RuntimeOperationType,
    label: string,
    opts: { interruptible?: boolean } = {},
  ): OperationHandle {
    const id = randomUUID();
    this.ops.set(id, {
      id,
      generation,
      type,
      label,
      interruptible: opts.interruptible ?? false,
      startedAt: new Date(this.now()).toISOString(),
    });
    this.changed();
    let ended = false;
    return {
      id,
      end: () => {
        if (ended) return;
        ended = true;
        this.ops.delete(id);
        this.changed();
      },
    };
  }

  /** Track a promise as an operation for its whole lifetime. */
  async track<T>(
    generation: number,
    type: RuntimeOperationType,
    label: string,
    work: () => T | Promise<T>,
    opts: { interruptible?: boolean } = {},
  ): Promise<T> {
    const handle = this.begin(generation, type, label, opts);
    try {
      return await work();
    } finally {
      handle.end();
    }
  }

  active(): ActiveRuntimeOperation[] {
    return [...this.ops.values()];
  }

  blocking(): ActiveRuntimeOperation[] {
    return this.active().filter((op) => !op.interruptible);
  }

  /** "1 active inference request", "2 tool executions", ... in a stable order. */
  summarize(ops: ActiveRuntimeOperation[]): string[] {
    const counts = new Map<RuntimeOperationType, number>();
    for (const op of ops) counts.set(op.type, (counts.get(op.type) ?? 0) + 1);
    return (Object.keys(DESCRIBE) as RuntimeOperationType[])
      .filter((type) => counts.has(type))
      .map((type) => {
        const n = counts.get(type) as number;
        const [one, many] = DESCRIBE[type];
        return `${n} ${n === 1 ? one : many}`;
      });
  }

  async waitForSafePoint(options: SafePointOptions = {}): Promise<SafePointResult> {
    const started = this.now();
    if (this.blocking().length === 0) return { reached: true, waitedMs: 0 };
    return new Promise<SafePointResult>((resolve) => {
      let lastKey = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: SafePointResult) => {
        this.listeners.delete(check);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const check = () => {
        const blocking = this.blocking();
        if (blocking.length === 0) {
          finish({ reached: true, waitedMs: this.now() - started });
          return;
        }
        const key = blocking
          .map((op) => op.id)
          .sort()
          .join(",");
        if (key !== lastKey) {
          lastKey = key;
          options.onWaiting?.(blocking);
        }
      };
      const onAbort = () =>
        finish({ reached: false, reason: "cancelled", blocking: this.blocking(), waitedMs: this.now() - started });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            finish({ reached: false, reason: "timeout", blocking: this.blocking(), waitedMs: this.now() - started }),
          options.timeoutMs,
        );
      }
      this.listeners.add(check);
      check();
    });
  }

  /** Hold new work (spec §21). */
  closeGate(reason: string): void {
    this.gateReason = reason;
  }

  openGate(): void {
    this.gateReason = null;
    const waiters = this.gateWaiters;
    this.gateWaiters = [];
    for (const wake of waiters) wake();
  }

  gateClosedReason(): string | null {
    return this.gateReason;
  }

  /** Resolves immediately when the gate is open, else when it next opens (FIFO). */
  whenOpen(): Promise<void> {
    if (this.gateReason === null) return Promise.resolve();
    return new Promise((resolve) => this.gateWaiters.push(resolve));
  }

  queued(): number {
    return this.gateWaiters.length;
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
