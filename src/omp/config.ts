import { parseDurationMs } from "../resilience/duration.ts";
import type { OmpAdapterConfig } from "./types.ts";

export const OMP_ADAPTER_ENV = "PI_ENGINEERING_OMP_ADAPTER";
export const OMP_BIN_ENV = "PI_ENGINEERING_OMP_BIN";
export const OMP_TIMEOUT_ENV = "PI_ENGINEERING_OMP_TIMEOUT_MS";
export const DEFAULT_OMP_TIMEOUT_MS = 15_000;

/** Adapter is OFF unless explicitly enabled; legacy behavior is unchanged otherwise. */
export function resolveOmpAdapterConfig(env: NodeJS.ProcessEnv): OmpAdapterConfig {
  const flag = env[OMP_ADAPTER_ENV]?.trim().toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes" || flag === "on";
  const bin = env[OMP_BIN_ENV]?.trim();
  const timeout = env[OMP_TIMEOUT_ENV] === undefined ? null : parseDurationMs(env[OMP_TIMEOUT_ENV]);
  return {
    enabled,
    launch: { command: bin ? bin : "omp", args: [] },
    timeoutMs: timeout ?? DEFAULT_OMP_TIMEOUT_MS,
  };
}
