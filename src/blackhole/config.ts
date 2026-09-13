/**
 * Blackhole configuration parsing/validation.
 *
 * Backward-compatible: all behavior is off by default. Supplying a config (or
 * enabling it) turns on session memory only; disabling or omitting leaves the
 * runtime behaving exactly as before while still emitting lifecycle events.
 */
import {
  BLACKHOLE_ALLOWLIST,
  type BlackholeConfig,
  type DurableStoreConfig,
  type MemoryWorkerRole,
  PINNED_BLACKHOLE_VERSION,
} from "./types.ts";

export interface PartialBlackholeConfig {
  enabled?: boolean;
  version?: string;
  routes?: Partial<Record<MemoryWorkerRole, string>>;
  memoryWorkerConcurrency?: number;
  compactionThreshold?: number;
  sessionTtlMs?: number;
  /** Backing store for promoted durable (shared) memory. Defaults to in-memory. */
  durable?: DurableStoreConfig;
  /** Bounded wait for shared-durable provider calls (default 5000ms). */
  providerTimeoutMs?: number;
}

const DEFAULTS: Omit<BlackholeConfig, "version"> & { version: string } = {
  enabled: false,
  version: PINNED_BLACKHOLE_VERSION,
  routes: { observer: "memory-observer", reflector: "memory-reflector", dropper: "memory-dropper" },
  memoryWorkerConcurrency: 2,
  autoPromotion: false,
  compactionThreshold: 200,
  sessionTtlMs: 30 * 60 * 1000,
  durable: { kind: "memory" },
  providerTimeoutMs: 5000,
};

export interface ConfigResult {
  config: BlackholeConfig;
  warnings: string[];
}

/**
 * Validate and normalize a partial config. Throws on a hard-invalid version
 * (not in allowlist) so a drifted Blackhole can never silently run. Soft
 * warnings (e.g. non-default version) are surfaced but non-fatal.
 */
export function resolveBlackholeConfig(input?: PartialBlackholeConfig): ConfigResult {
  const warnings: string[] = [];
  const version = input?.version ?? DEFAULTS.version;
  if (!BLACKHOLE_ALLOWLIST.includes(version)) {
    throw new Error(
      `Blackhole version "${version}" is not in the allowed allowlist [${BLACKHOLE_ALLOWLIST.join(", ")}]. Refusing to run an unpinned/unvalidated memory provider.`,
    );
  }
  if (version !== PINNED_BLACKHOLE_VERSION) {
    warnings.push(
      `Blackhole version ${version} differs from the pinned default ${PINNED_BLACKHOLE_VERSION}; allowed but non-default.`,
    );
  }
  const routes = { ...DEFAULTS.routes, ...(input?.routes ?? {}) };
  const concurrency = input?.memoryWorkerConcurrency ?? DEFAULTS.memoryWorkerConcurrency;
  if (concurrency < 1) {
    throw new Error("memoryWorkerConcurrency must be >= 1");
  }
  const compactionThreshold = input?.compactionThreshold ?? DEFAULTS.compactionThreshold;
  if (compactionThreshold < 2) {
    throw new Error("compactionThreshold must be >= 2");
  }
  const durable = input?.durable ?? DEFAULTS.durable;
  if (durable.kind === "shared-file" && !durable.file) {
    throw new Error("durable.kind='shared-file' requires a `file` path");
  }
  if (durable.kind === "openviking" && !durable.baseUrl) {
    throw new Error("durable.kind='openviking' requires a `baseUrl`");
  }
  const providerTimeoutMs = input?.providerTimeoutMs ?? DEFAULTS.providerTimeoutMs;
  if (providerTimeoutMs < 1) {
    throw new Error("providerTimeoutMs must be >= 1");
  }
  return {
    config: {
      enabled: input?.enabled ?? DEFAULTS.enabled,
      version,
      routes,
      memoryWorkerConcurrency: concurrency,
      autoPromotion: false, // never auto-promote
      compactionThreshold,
      sessionTtlMs: input?.sessionTtlMs ?? DEFAULTS.sessionTtlMs,
      durable,
      providerTimeoutMs,
    },
    warnings,
  };
}
