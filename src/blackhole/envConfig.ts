/**
 * OpenViking connection from the environment.
 *
 * Lets ANY pi installation that loads this package's extension connect to a
 * shared OpenViking durable-memory service without editing code — set a few
 * environment variables once and the runtime wires `blackhole` up for every
 * repository automatically.
 *
 *   PI_OPENVIKING_BASE_URL             baseUrl (presence enables the connection)
 *   PI_OPENVIKING_TOKEN                Bearer token, or:
 *   PI_OPENVIKING_TOKEN_FILE           path to a file containing the token
 *   PI_OPENVIKING_ENABLED              "0"/"false" forces the connection off
 *   PI_OPENVIKING_PROVIDER_TIMEOUT_MS  bounded provider-call wait (default 10000)
 *
 * Absent `PI_OPENVIKING_BASE_URL` ⇒ returns null and the runtime is left exactly
 * as before (backward compatible, nothing enabled by default). Fail-closed: a
 * malformed timeout falls back to the default; a missing token is allowed but
 * means the (auth-required) service will deny recall, which degrades to empty.
 */
import { readFileSync } from "node:fs";
import type { PartialBlackholeConfig } from "./config.ts";

export interface OpenVikingEnvConfig {
  baseUrl: string;
  token?: string;
  providerTimeoutMs: number;
}

export const OPENVIKING_ENV = {
  enabled: "PI_OPENVIKING_ENABLED",
  baseUrl: "PI_OPENVIKING_BASE_URL",
  token: "PI_OPENVIKING_TOKEN",
  tokenFile: "PI_OPENVIKING_TOKEN_FILE",
  timeout: "PI_OPENVIKING_PROVIDER_TIMEOUT_MS",
} as const;

const DEFAULT_TIMEOUT_MS = 10_000;

function readTokenFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Resolve the OpenViking connection from the environment, or null if unset. */
export function resolveOpenVikingFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenVikingEnvConfig | null {
  const baseUrl = env[OPENVIKING_ENV.baseUrl];
  if (!baseUrl || !baseUrl.trim()) return null;
  const explicit = env[OPENVIKING_ENV.enabled];
  if (explicit === "0" || explicit === "false") return null;

  const token = env[OPENVIKING_ENV.token]?.trim() || readTokenFile(env[OPENVIKING_ENV.tokenFile]);
  const rawTimeout = env[OPENVIKING_ENV.timeout];
  const parsed = rawTimeout ? Number(rawTimeout) : Number.NaN;
  const providerTimeoutMs = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TIMEOUT_MS;

  return { baseUrl: baseUrl.trim(), token, providerTimeoutMs };
}

/**
 * Build the `blackhole` option for `EngineeringRuntime` from the environment,
 * or `undefined` when no OpenViking base URL is configured.
 */
export function openVikingBlackholeOption(
  env: Record<string, string | undefined> = process.env,
): { config: PartialBlackholeConfig } | undefined {
  const ov = resolveOpenVikingFromEnv(env);
  if (!ov) return undefined;
  return {
    config: {
      enabled: true,
      durable: { kind: "openviking", baseUrl: ov.baseUrl, token: ov.token },
      providerTimeoutMs: ov.providerTimeoutMs,
    },
  };
}
