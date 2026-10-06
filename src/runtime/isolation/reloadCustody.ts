/**
 * Mission custody across an in-process reload.
 *
 * A Host reload stops the old generation by replaying `session_shutdown`
 * into it, which closes its EngineeringRuntime. A normal shutdown gives the
 * session's mission custody back, so between the old generation stopping and
 * the new one re-claiming, another live session's supervisor could admit (take
 * over) this session's missions. A reload is not the session ending: the same
 * session (same id, same process incarnation) continues, so custody is
 * RETAINED and the next generation re-claims it (lease custody is re-entrant
 * for the same session; file-lock custody hands its open locks over).
 *
 * Retention is bounded: whatever the next generation has not re-claimed
 * within the handback window (PI_ENGINEERING_RELOAD_CUSTODY_MS, default 30 s)
 * is released, and the Host releases it at once when a handover leaves no
 * runtime running. Otherwise a reload that never re-claims would keep renewing
 * the leases (they belong to the live session) and lock other sessions out.
 *
 * State lives on `globalThis`: the generation being stopped and the one being
 * started are different module graphs in the same process.
 */

const KEY = Symbol.for("pi-engineering.reload-shutdown.v1");

interface ReloadShutdownState {
  depth: number;
  /** Custody kept for the next generation, by key, with how to give it back. */
  retained?: Map<string, () => void>;
  timer?: ReturnType<typeof setTimeout> | null;
}

export const DEFAULT_RELOAD_CUSTODY_MS = 30_000;

function state(): ReloadShutdownState {
  const holder = globalThis as unknown as Record<symbol, ReloadShutdownState | undefined>;
  let current = holder[KEY];
  if (!current) {
    current = { depth: 0 };
    holder[KEY] = current;
  }
  return current;
}

/** Run a generation's shutdown as part of a reload: custody is kept for the session. */
export async function withReloadShutdown<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  s.depth++;
  try {
    return await fn();
  } finally {
    s.depth--;
  }
}

/** True while a reload is stopping a generation in this process. */
export function isReloadShutdown(): boolean {
  return state().depth > 0;
}

function handbackMs(): number {
  const raw = Number(process.env.PI_ENGINEERING_RELOAD_CUSTODY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RELOAD_CUSTODY_MS;
}

/** Keep `key` for the next generation; `release` gives it back if nobody re-claims it in time. */
export function retainCustody(key: string, release: () => void): void {
  const s = state();
  s.retained ??= new Map();
  s.retained.set(key, release);
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    releaseRetainedCustody();
  }, handbackMs());
  s.timer.unref?.();
}

/** The next generation took `key` over. True when it was retained. */
export function reclaimCustody(key: string): boolean {
  return state().retained?.delete(key) ?? false;
}

/** Give back everything still retained (window expired, or no runtime runs). Returns how much. */
export function releaseRetainedCustody(): number {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  const pending = [...(s.retained ?? new Map<string, () => void>()).entries()];
  s.retained?.clear();
  for (const [, release] of pending) {
    try {
      release();
    } catch {
      // A lease that cannot be released now is reclaimed once the session stops heartbeating.
    }
  }
  return pending.length;
}

export function retainedCustodyCount(): number {
  return state().retained?.size ?? 0;
}
