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
 * State lives on `globalThis`: the generation being stopped and the one being
 * started are different module graphs in the same process.
 */

const KEY = Symbol.for("pi-engineering.reload-shutdown.v1");

interface ReloadShutdownState {
  depth: number;
}

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
