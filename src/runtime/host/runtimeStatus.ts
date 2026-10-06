/**
 * The Host publishes its Runtime/Update status, and the Engineering panel
 * reads it (spec §44).
 *
 * The panel lives inside a runtime generation, which is a separate copy of
 * every module. A module-level variable would therefore be a different
 * variable on each side. The channel is a process-global slot under a
 * registered symbol, so it is shared. It holds one function that renders the
 * lines on demand, does no IO and never throws into a render loop.
 */

const SLOT = Symbol.for("pi-engineering.runtime-status");

interface StatusSource {
  owner: object;
  lines(nowMs: number): string[];
}

type Global = Record<symbol, StatusSource | undefined>;

/** Publish a status renderer. The returned function removes it if it is still ours. */
export function publishRuntimeStatus(owner: object, lines: (nowMs: number) => string[]): () => void {
  const g = globalThis as unknown as Global;
  g[SLOT] = { owner, lines };
  return () => {
    if (g[SLOT]?.owner === owner) g[SLOT] = undefined;
  };
}

/** The current Runtime/Update lines, or none when no Host is publishing. */
export function runtimeStatusLines(nowMs: number = Date.now()): string[] {
  const source = (globalThis as unknown as Global)[SLOT];
  if (!source) return [];
  try {
    return source.lines(nowMs);
  } catch {
    return [];
  }
}
