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
 * after the handover ended is released; while the handover is still running
 * (the new generation loading or starting) the window keeps re-arming. The
 * Host releases at once when a handover fails or rolls back. Otherwise a reload that never re-claims would keep renewing
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
  /** A Host handover is in flight: the next generation may still be loading or starting. */
  handover?: boolean;
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
  armHandback(s);
}

/**
 * (Re)start the handback window. While a handover is still in flight the new
 * generation may simply be slow to load or start (a loaded machine), so an
 * expiring window is re-armed instead of releasing; the Host releases at once
 * when the handover fails or rolls back.
 */
function armHandback(s: ReloadShutdownState): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.handover) armHandback(s);
    else releaseRetainedCustody();
  }, handbackMs());
  s.timer.unref?.();
}

/**
 * The Host reports handover start/end. At the end, whatever is still retained
 * gets one more full window (from now) for the new generation to re-claim.
 */
export function noteHandover(active: boolean): void {
  const s = state();
  s.handover = active;
  if (!active && (s.retained?.size ?? 0) > 0) armHandback(s);
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
