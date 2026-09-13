/**
 * Blackhole provider seam.
 *
 * `loadBlackholeAdapter` returns the real `pi-blackhole` adapter when the
 * package is installed and validated, else the built-in session-memory provider.
 * Both implement the same narrow interface the runtime needs; the adapter is
 * purely a working-memory provider and never the system of record.
 */
import { MemoryStore } from "./MemoryStore.ts";
import { type BlackholeConfig, type SessionIdentity, sessionKey } from "./types.ts";
import { tryLoadBlackholePackage } from "./versioning.ts";

export interface BlackholeAdapter {
  readonly kind: "builtin" | "pi-blackhole";
  readonly version: string;
  /** Open (or reuse) a session-local store for an identity. */
  openSession(identity: SessionIdentity): MemoryStore;
  closeSession(key: string): void;
  /** Provider-level counters for telemetry. */
  stats(): { sessions: number; entries: number };
}

/** Built-in provider: one MemoryStore per session identity. */
class BuiltinAdapter implements BlackholeAdapter {
  readonly kind = "builtin" as const;
  readonly version: string;
  private readonly stores = new Map<string, MemoryStore>();
  private readonly compactionThreshold: number;

  constructor(version: string, compactionThreshold: number) {
    this.version = version;
    this.compactionThreshold = compactionThreshold;
  }

  openSession(identity: SessionIdentity): MemoryStore {
    const key = sessionKey(identity);
    let store = this.stores.get(key);
    if (!store) {
      store = new MemoryStore(identity, { compactionThreshold: this.compactionThreshold });
      this.stores.set(key, store);
    }
    return store;
  }

  closeSession(key: string): void {
    this.stores.delete(key);
  }

  stats(): { sessions: number; entries: number } {
    let entries = 0;
    for (const s of this.stores.values()) entries += s.size;
    return { sessions: this.stores.size, entries };
  }
}

/**
 * Load the provider. When the real package is present we still wrap it in a
 * MemoryStore-compatible view only if it exposes one; otherwise we fall back to
 * the built-in store (the real package, if it exists, is validated separately).
 */
export async function loadBlackholeAdapter(config: BlackholeConfig): Promise<BlackholeAdapter> {
  const pkg = await tryLoadBlackholePackage();
  if (pkg) {
    // Real package present. We wrap it only if it exposes an openSession
    // factory returning a MemoryStore-compatible session; otherwise degrade to
    // the built-in provider under the validated version string. Version drift
    // is rejected by BlackholeManager.open (fail-closed), not here.
    const anyMod = (await import("pi-blackhole")) as unknown as {
      openSession?: (identity: SessionIdentity, opts?: unknown) => MemoryStore;
    };
    if (typeof anyMod.openSession === "function") {
      const open = anyMod.openSession;
      return {
        kind: "pi-blackhole" as const,
        version: pkg.version,
        openSession: (id: SessionIdentity) => open(id),
        closeSession: () => {},
        stats: () => ({ sessions: 0, entries: 0 }),
      };
    }
    // No usable seam — use the built-in provider under the validated version.
    return new BuiltinAdapter(pkg.version, config.compactionThreshold);
  }
  return new BuiltinAdapter(config.version, config.compactionThreshold);
}
