/**
 * Deterministic parallelism rendezvous. A worker calls `arrived()` and blocks
 * until `needed` workers have entered. If the runtime really runs them in
 * parallel the gate opens however slow the host is; if it serialized them the
 * gate never opens and every waiter rejects with a clear deadlock error.
 *
 * The deadlock timer starts at the FIRST arrival (not at construction), so slow
 * setup (worktree creation, planning) on a loaded CI host cannot consume it, and
 * the budget is generous because it is only ever spent on a genuine failure.
 */
export interface ParallelBarrier {
  arrived: () => Promise<void>;
}

export function parallelBarrier(needed: number, deadlockMs = 60_000): ParallelBarrier {
  let count = 0;
  let timer: NodeJS.Timeout | undefined;
  let open!: () => void;
  let fail!: (e: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  gate.catch(() => undefined); // never an unhandled rejection if nobody awaits
  return {
    async arrived() {
      count++;
      if (count === 1) {
        timer = setTimeout(
          () =>
            fail(
              new Error(
                `parallel barrier deadlock: only ${count} of ${needed} workers arrived within ${deadlockMs}ms; the runtime did not run them in parallel`,
              ),
            ),
          deadlockMs,
        );
        timer.unref();
      }
      if (count >= needed) {
        if (timer) clearTimeout(timer);
        open();
      }
      await gate;
    },
  };
}
