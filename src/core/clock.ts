/** Monotonic milliseconds for elapsed budgets and cooldown durations. */
export function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
